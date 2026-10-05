import { describe, expect, it } from "vitest";
import { WindowCounter, cacheKey, endpointFor, locationCount, ttlSeconds } from "../src/policy";

const now = new Date("2026-10-05T12:00:00Z");
const q = (s: string) => new URLSearchParams(s);

describe("cacheKey", () => {
  it("sorts parameters by name and keeps repeated values in order", () => {
    const a = cacheKey(new URL("https://weather.tk.gg/v1/forecast?longitude=-0.13&hourly=b&latitude=51.5&hourly=a"));
    const b = cacheKey(new URL("https://weather.tk.gg/v1/forecast?hourly=b&hourly=a&latitude=51.5&longitude=-0.13"));
    expect(a).toBe(b);
    expect(a).toBe("https://weather.tk.gg/v1/forecast?hourly=b&hourly=a&latitude=51.5&longitude=-0.13");
  });

  it("does not round coordinates or otherwise change values", () => {
    expect(cacheKey(new URL("https://weather.tk.gg/v1/forecast?latitude=51.50741&longitude=-0.12782"))).toContain("latitude=51.50741&longitude=-0.12782");
  });

  it("keeps different values apart", () => {
    expect(cacheKey(new URL("https://w/v1/forecast?hourly=a,b"))).not.toBe(cacheKey(new URL("https://w/v1/forecast?hourly=b,a")));
  });

  it("handles no query", () => {
    expect(cacheKey(new URL("https://weather.tk.gg/v1/elevation"))).toBe("https://weather.tk.gg/v1/elevation");
  });
});

describe("endpointFor", () => {
  it("accepts known endpoints with or without a trailing slash", () => {
    expect(endpointFor("/v1/forecast")).toBe("forecast");
    expect(endpointFor("/v1/archive/")).toBe("archive");
    expect(endpointFor("/v1/air-quality")).toBe("air-quality");
  });

  it("rejects anything else", () => {
    expect(endpointFor("/v1/metrics")).toBeNull();
    expect(endpointFor("/metrics")).toBeNull();
    expect(endpointFor("/v1/forecast/extra")).toBeNull();
    expect(endpointFor("/v1/constructor")).toBeNull();
    expect(endpointFor("/v1/__proto__")).toBeNull();
  });
});

describe("ttlSeconds", () => {
  it("keeps forecasts for an hour, or 15 minutes with current or 15-minutely values", () => {
    expect(ttlSeconds("forecast", q("hourly=temperature_2m"), now)).toBe(3600);
    expect(ttlSeconds("forecast", q("current=temperature_2m"), now)).toBe(900);
    expect(ttlSeconds("forecast", q("minutely_15=temperature_2m"), now)).toBe(900);
  });

  it("keeps archive data longer the older its end date", () => {
    expect(ttlSeconds("archive", q("end_date=2026-10-01"), now)).toBe(3600);
    expect(ttlSeconds("archive", q("end_date=2026-09-20"), now)).toBe(86400);
    expect(ttlSeconds("archive", q("end_date=2026-06-01"), now)).toBe(30 * 86400);
  });

  it("falls back to an hour for archive requests without a usable end date", () => {
    expect(ttlSeconds("archive", q(""), now)).toBe(3600);
    expect(ttlSeconds("archive", q("end_date=yesterday"), now)).toBe(3600);
    expect(ttlSeconds("archive", q("end_date=2026-13-45"), now)).toBe(3600);
  });

  it("keeps static data for 30 days and daily runs for 6 hours", () => {
    expect(ttlSeconds("static", q(""), now)).toBe(30 * 86400);
    expect(ttlSeconds("daily", q(""), now)).toBe(6 * 3600);
  });
});

describe("locationCount", () => {
  it("counts comma-separated coordinates", () => {
    expect(locationCount(q("latitude=51.5&longitude=0"))).toBe(1);
    expect(locationCount(q("latitude=51.5,52,53&longitude=0,1,2"))).toBe(3);
    expect(locationCount(q("hourly=temperature_2m"))).toBe(1);
  });
});

describe("WindowCounter", () => {
  it("allows up to the limit per window and key, then resets", () => {
    const counter = new WindowCounter(2, 60_000);
    expect(counter.take("a", 0)).toBe(true);
    expect(counter.take("a", 1000)).toBe(true);
    expect(counter.take("a", 2000)).toBe(false);
    expect(counter.retryAfter("a", 2000)).toBe(58);
    expect(counter.take("b", 2000)).toBe(true);
    expect(counter.take("a", 60_000)).toBe(true);
  });

  it("stays within its key budget", () => {
    const counter = new WindowCounter(1, 60_000, 3);
    for (const key of ["a", "b", "c", "d", "e"]) expect(counter.take(key, 0)).toBe(true);
    expect((counter as unknown as { windows: Map<string, unknown> }).windows.size).toBeLessThanOrEqual(3);
  });
});
