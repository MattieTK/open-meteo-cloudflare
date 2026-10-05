# weather.tk.gg

A self-hosted copy of the [Open-Meteo](https://open-meteo.com/) weather API, run for Halfhour and open to anyone as a free example server: https://weather.tk.gg

Open-Meteo's hosted API is for non-commercial use only. Open-Meteo also publishes all of its processed model data as open data in an AWS bucket (`s3://openmeteo`, us-west-2), and its open-source server can read that bucket directly, keeping a local block cache. So we run the official server ourselves, with no downloaders and no persistent storage, and Halfhour calls it instead of `api.open-meteo.com`.

Responses are the same as Open-Meteo's: on 5 October 2026, Halfhour's 7-day London forecast and its 5-year daily archive query returned identical values from both.

## How it works

```
client ─▶ Worker (weather.tk.gg) ─▶ edge cache ─▶ Durable Object "primary" ─▶ Container (open-meteo server) ─▶ s3://openmeteo
          homepage, limits           hit: done      uncached limit, 8 in flight     lite, WNAM                     open data
```

- **Worker** (`src/index.ts`, `src/handler.ts`): serves the homepage (`src/home.ts`) and `robots.txt`, accepts `GET`/`HEAD` (and CORS preflights) on `/v1/<endpoint>` for every endpoint the server registers, and answers anything else itself, so `/metrics` and unknown paths never reach the container.
- **Edge cache** (Cache API, per Cloudflare location): the key is the canonical path plus the query parameters sorted by name. Values are not changed; in particular coordinates are not rounded, because Open-Meteo uses the exact point for elevation downscaling. Clients that want more hits should round their own coordinates (Halfhour rounds to two decimals). Lifetimes (`src/policy.ts`):

  | Data | Kept for |
  | --- | --- |
  | Forecasts (`forecast`, `dwd-icon`, `gfs`, `ecmwf`, `ensemble`, `marine`, `air-quality`, …) | 1 hour; 15 minutes with `current` or `minutely_15` |
  | `seasonal`, `flood` | 6 hours |
  | `archive`, `era5` ending more than 90 days ago | 30 days (ERA5T is replaced by final ERA5 after 2–3 months) |
  | … ending 8–90 days ago | 1 day |
  | … ending within the last week | 1 hour |
  | `elevation`, `climate` | 30 days |
  | 400 errors | 10 minutes |

  Other statuses are not cached. Cache hits never reach the Durable Object or the container: the handler returns before calling them (checked in the Workers logs, where hits show no `OpenMeteoServer` event).
- **Durable Object** (`OpenMeteoServer`, from `@cloudflare/containers`): one instance named `primary`, so every miss shares the container's block cache. It counts uncached requests per client exactly (see Limits) and returns 503 when 8 requests are already in flight.
- **Container**: the official image, unmodified, on a `lite` instance (1/16 vCPU, 256 MiB, 2 GB disk) with `REMOTE_DATA_DIRECTORY=https://openmeteo.s3.amazonaws.com/data/` and `CACHE_SIZE=1GB`. The cache file is allocated in full at start, and the disk also holds the image, so 1 GB is about the most `lite` allows. It is constrained to western North America, next to the bucket: a cold read makes hundreds of sequential range requests, so it is much quicker to cross the Atlantic once per API request than once per range request. Giving the container more CPU made no difference to cold reads in testing.
- **Keeping it warm**: the disk, and with it the block cache, is wiped when the container sleeps, and a cold container takes 15–35 seconds to answer. A cron trigger requests Halfhour's London forecast every 10 minutes and `sleepAfter` is 25 minutes, so the container stays up and the current UK model run stays cached.

## Limits

- Uncached requests: 60 a minute per client, counted in the Durable Object, which sees every miss worldwide, so the limit is exact. Over it, the response is 429 with `Retry-After`.
- All API requests: about 100 per 10 seconds per client, using the Workers rate limiting binding. It counts per Cloudflare location and lets bursts through (about 2,000 requests in 15 seconds passed a 600-a-minute setting in testing), so it is only a flood guard.
- A client is its IP address, plus the `CF-Worker` header when present. Every Worker on Cloudflare reaches us from the same egress addresses, and Cloudflare sets `CF-Worker` to the calling zone, so Halfhour's Worker gets its own bucket rather than sharing one with every other Worker.
- At most 10 locations per request (Open-Meteo allows 1000; the pinned image has no setting for it, so the Worker checks), URLs up to 4096 characters, `GET` only.
- The Worker waits 60 seconds for the container before answering 504, and keeps the request alive with `waitUntil`, so an answer that arrives after the client gave up is still cached.

The limits are set in `cloudflare.config.ts` (`LIMITS`) and in `src/policy.ts`, and the homepage reads them from there.

## Measured on 5 October 2026 (from London)

| Request | Time |
| --- | --- |
| Edge cache hit | 0.08–0.13 s |
| Forecast, container warm, new location | 1.2–2.2 s |
| Forecast, container warm, already read | about 0.4 s |
| Archive, 5 years daily, new location (container in WNAM) | 12–30 s (26 s with the container in Madrid) |
| Archive, 1 year, new location | 8–17 s |
| Archive, 1 day, new location | 0.9–1.7 s |
| First request after the container starts | 15–35 s |

Halfhour waits up to 30 seconds for archive requests for this reason.

## Cost

Containers need the Workers Paid plan, which the account already has. Memory and disk are billed for as long as the instance runs, CPU only when used (pricing as of October 2026):

| Item | Per month, always on |
| --- | --- |
| Memory: 0.25 GiB × 730 h at $0.0000025/GiB-s | $1.64 |
| Disk: 2 GB × 730 h at $0.00000007/GB-s | $0.37 |
| CPU: active use only, at $0.00002/vCPU-s | cents at Halfhour's volume |
| Worker and Durable Object requests | within the plan's allowance |

So about $2–2.50 a month, less while the plan's included container allowance (25 GiB-hours of memory, 200 GB-hours of disk, 375 vCPU-minutes) is not used by other Containers on the account. Durable Object duration could add up to about $4 a month if the object were billed as active around the clock and the account's 400,000 GB-s allowance were used elsewhere. Egress is small JSON, within the 1 TB included for North America and Europe.

Trade-offs considered:

- Letting it sleep between requests would save most of this, but every request after a quiet spell would take 15–35 seconds and lose the block cache.
- `basic` (1/4 vCPU, 1 GiB, 4 GB) would allow a 3 GB cache but costs about four times as much for memory; cold reads are network-bound, so it would not make them faster.
- `maxInstances: 1` caps the cost and matches the single Durable Object name. The price is about a minute of 503s when a configuration change moves or replaces the instance (seen when the region constraint was added).

## Deploying

From the repository root, signed in with the cf CLI and with Docker running. If your login can see more than one Cloudflare account, put `CLOUDFLARE_ACCOUNT_ID=<your account id>` in a `.env` file here (it is git-ignored) (the Dockerfile is rebuilt and pushed to Cloudflare's registry):

```bash
pnpm install
```

```bash
pnpm test && pnpm typecheck
```

```bash
pnpm run deploy
```

`cf deploy` builds the Worker with Vite, builds the image from `Dockerfile`, pushes it to `registry.cloudflare.com` when it changed, updates the Container application `halfhour-weather-open-meteo` and deploys the Worker `halfhour-weather` with its custom domain and cron trigger. Use `pnpm exec cf deploy --containers-rollout none` for Worker-only changes, so the running container (and its cache) is left alone.

The cf CLI handles Containers in `cloudflare.config.ts` (`defineContainer` and a Durable Object export with `container`), so this repository does not use wrangler.

Local development: `pnpm dev` builds the image and starts the Worker on port 8788, but on this machine (WSL2, Docker 28) the container never started under `cf dev`: the egress proxy sidecar came up and workerd timed out waiting for the container. The tests cover the handler and policy with fakes, and the image itself can be run directly:

```bash
docker run --rm -p 127.0.0.1:8090:8080 -e REMOTE_DATA_DIRECTORY=https://openmeteo.s3.amazonaws.com/data/ -e CACHE_SIZE=1GB ghcr.io/open-meteo/open-meteo:1.6.0
```

### Running your own copy

Change `domains` in `cloudflare.config.ts` to a hostname on a zone in your Cloudflare account (or remove it and turn on `workersDev`), and rename the Worker and container if you like. Containers need the Workers Paid plan. The homepage text in `src/home.ts` describes this server; edit it to describe yours.

## Updating the Open-Meteo image

The image is pinned by tag and digest in two places: the `FROM` line in `Dockerfile` and `OPEN_METEO_IMAGE` in `src/image.ts` (shown on the homepage, as the AGPL notice).

1. Find the new release at https://github.com/open-meteo/open-meteo/pkgs/container/open-meteo and its digest, for example `docker buildx imagetools inspect ghcr.io/open-meteo/open-meteo:1.6.1` (use the index digest, not a platform one).
2. Update both places, then run the image locally (above) and compare a forecast and an archive query with `api.open-meteo.com`.
3. Check that the routes in `src/policy.ts` (`ENDPOINTS`) still match the server's `ForecastapiController.swift`.
4. `pnpm run deploy`. The new image replaces the running container, so expect a minute of 503s and a cold cache afterwards.

## Licences

- **Data**: Open-Meteo's API data is [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit "Weather data by Open-Meteo.com" with a link wherever it is shown. The upstream providers are listed on the homepage and on [Open-Meteo's licence page](https://open-meteo.com/en/licence). Most are CC BY 4.0 or similar; **UK Met Office** data (`ukmo_*` models, and `best_match` over the UK) is **CC BY-SA 4.0**, which the homepage states. Halfhour requests `models=ecmwf_ifs` for forecasts so that it does not use Met Office data; the archive's default blend (ERA5, ERA5-Land, IFS analysis) has none.
- **Software**: the Open-Meteo server is AGPL-3.0. We run the official image unmodified (the rebuilt image has the same image ID as upstream), so there are no changes to publish; the homepage still links to the source and names the exact image. This repository's own code (the Worker, the Dockerfile and the docs) is under the MIT licence in `LICENSE`; the Open-Meteo server it runs keeps its AGPL-3.0 licence.
- Not affiliated with Open-Meteo or any data provider.
