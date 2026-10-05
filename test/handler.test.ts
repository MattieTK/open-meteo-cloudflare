import { describe, expect, it } from "vitest";
import { type Deps, type EdgeCache, type Limiter, clientKey, handle } from "../src/handler";

type Fakes = Deps & { originCalls: string[]; pending: Promise<unknown>[]; store: Map<string, Response> };

function fakes(overrides: Partial<Deps> = {}): Fakes {
  const store = new Map<string, Response>();
  const cache: EdgeCache = {
    async match(key) {
      return store.get(key)?.clone();
    },
    async put(key, response) {
      store.set(key, response);
    },
  };
  const allow: Limiter = { limit: async () => ({ success: true }) };
  const originCalls: string[] = [];
  const pending: Promise<unknown>[] = [];
  return {
    cache,
    limitAll: allow,
    origin: async (path) => {
      originCalls.push(path);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json; charset=utf-8" } });
    },
    waitUntil: (p) => pending.push(p),
    now: () => new Date("2026-10-05T12:00:00Z"),
    image: "ghcr.io/open-meteo/open-meteo:test",
    limits: { allPer10Seconds: 100, originPerMinute: 60 },
    ...overrides,
    originCalls,
    pending,
    store,
  };
}

const req = (path: string, init?: RequestInit) => new Request(`https://weather.tk.gg${path}`, init);

describe("handle", () => {
  it("serves the homepage with the attribution and image", async () => {
    const res = await handle(req("/"), fakes());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Weather data by Open-Meteo.com");
    expect(html).toContain("CC BY-SA 4.0");
    expect(html).toContain("github.com/open-meteo/open-meteo");
    expect(html).toContain("ghcr.io/open-meteo/open-meteo:test");
  });

  it("proxies a miss to the container with sorted parameters, then serves the repeat from cache", async () => {
    const deps = fakes();
    const first = await handle(req("/v1/forecast?longitude=-0.13&latitude=51.5&hourly=temperature_2m"), deps);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-cache")).toBe("MISS");
    expect(first.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(first.headers.get("access-control-allow-origin")).toBe("*");
    expect(await first.json()).toEqual({ ok: true });
    await Promise.all(deps.pending);

    const second = await handle(req("/v1/forecast/?hourly=temperature_2m&latitude=51.5&longitude=-0.13"), deps);
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(await second.json()).toEqual({ ok: true });
    expect(deps.originCalls).toEqual(["/v1/forecast?hourly=temperature_2m&latitude=51.5&longitude=-0.13"]);
  });

  it("passes the client key to the container side, where uncached requests are counted", async () => {
    const keys: string[] = [];
    const deps = fakes({ origin: async (_path, key) => (keys.push(key), new Response("{}", { headers: { "content-type": "application/json" } })) });
    await handle(req("/v1/elevation?latitude=1&longitude=2", { headers: { "cf-connecting-ip": "1.2.3.4" } }), deps);
    await Promise.all(deps.pending);
    await handle(req("/v1/elevation?latitude=1&longitude=2", { headers: { "cf-connecting-ip": "1.2.3.4" } }), deps);
    expect(keys).toEqual(["1.2.3.4"]);
  });

  it("caches 400s briefly and does not cache server errors", async () => {
    const bad = fakes({ origin: async () => new Response(JSON.stringify({ error: true, reason: "bad" }), { status: 400 }) });
    const r400 = await handle(req("/v1/forecast?latitude=999"), bad);
    expect(r400.status).toBe(400);
    expect(r400.headers.get("cache-control")).toBe("public, max-age=600");
    expect(bad.pending).toHaveLength(1);

    const broken = fakes({ origin: async () => new Response("oops", { status: 500 }) });
    const r500 = await handle(req("/v1/forecast?latitude=1"), broken);
    expect(r500.status).toBe(500);
    expect(r500.headers.get("cache-control")).toBe("no-store");
    expect(broken.pending).toHaveLength(0);
  });

  it("refuses unknown paths, other methods and long URLs without reaching the container", async () => {
    const deps = fakes();
    const unknown = await handle(req("/v1/metrics"), deps);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: true });
    expect((await handle(req("/v1/forecast", { method: "POST", body: "x" }), deps)).status).toBe(405);
    expect((await handle(req(`/v1/forecast?x=${"a".repeat(5000)}`), deps)).status).toBe(414);
    expect((await handle(req("/metrics"), deps)).status).toBe(404);
    const many = await handle(req(`/v1/forecast?latitude=${Array(11).fill(51).join(",")}&longitude=${Array(11).fill(0).join(",")}`), deps);
    expect(many.status).toBe(400);
    expect(await many.json()).toMatchObject({ error: true, reason: expect.stringContaining("10 locations") });
    expect(deps.originCalls).toHaveLength(0);
  });

  it("answers CORS preflights", async () => {
    const res = await handle(req("/v1/forecast", { method: "OPTIONS" }), fakes());
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("returns 429 when the flood guard trips, without reaching the container", async () => {
    const deny: Limiter = { limit: async () => ({ success: false }) };
    const deps = fakes({ limitAll: deny });
    const res = await handle(req("/v1/forecast?latitude=1"), deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("10");
    expect(deps.originCalls).toHaveLength(0);
  });

  it("passes the container side's 429 through uncached, with its retry-after", async () => {
    const deps = fakes({
      origin: async () => new Response(JSON.stringify({ error: true, reason: "slow down" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "42" } }),
    });
    const res = await handle(req("/v1/forecast?latitude=1"), deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(deps.pending).toHaveLength(0);
  });

  it("returns 504 when the container is too slow and 502 when it fails", async () => {
    const slow = fakes({
      originTimeoutMs: 10,
      origin: (_path, _key, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    });
    expect((await handle(req("/v1/archive?latitude=1"), slow)).status).toBe(504);
    const failing = fakes({ origin: async () => Promise.reject(new Error("connection refused")) });
    expect((await handle(req("/v1/archive?latitude=1"), failing)).status).toBe(502);
  });

  it("answers HEAD without a body", async () => {
    const res = await handle(req("/v1/forecast?latitude=1", { method: "HEAD" }), fakes());
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});

describe("clientKey", () => {
  it("uses the IP, plus the calling zone for Worker subrequests", () => {
    expect(clientKey(new Request("https://w/", { headers: { "cf-connecting-ip": "1.2.3.4" } }))).toBe("1.2.3.4");
    expect(clientKey(new Request("https://w/", { headers: { "cf-connecting-ip": "2a06:98c0:3600::103", "cf-worker": "tk.gg" } }))).toBe("2a06:98c0:3600::103|tk.gg");
  });
});
