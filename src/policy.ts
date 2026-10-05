/**
 * Which Open-Meteo paths are served, how cache keys are built and how long each response is kept.
 *
 * Pure functions only, so they are unit tested without the Workers runtime.
 */

/** How often the data behind an endpoint changes, which decides its edge cache lifetime. */
export type Kind = "forecast" | "archive" | "daily" | "static";

/**
 * The `/v1/<name>` routes registered by the Open-Meteo server (Sources/App/Controllers/ForecastapiController.swift),
 * checked against the pinned image. Anything else is answered by this Worker with a 404 and never reaches the container.
 */
export const ENDPOINTS: Readonly<Record<string, Kind>> = {
  forecast: "forecast",
  "dwd-icon": "forecast",
  gfs: "forecast",
  meteofrance: "forecast",
  jma: "forecast",
  metno: "forecast",
  gem: "forecast",
  ecmwf: "forecast",
  cma: "forecast",
  bom: "forecast",
  arpae: "forecast",
  ensemble: "forecast",
  marine: "forecast",
  "air-quality": "forecast",
  // Seasonal (ECMWF SEAS5) and flood (GloFAS) runs arrive at most daily.
  seasonal: "daily",
  flood: "daily",
  archive: "archive",
  era5: "archive",
  // The elevation model and the CMIP6 climate projections do not change.
  elevation: "static",
  climate: "static",
};

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Requests longer than this are refused before they reach the container. */
export const MAX_URL_LENGTH = 4096;

/**
 * Coordinates per request. Open-Meteo accepts up to 1000 comma-separated locations, which would tie up this
 * small container for minutes; the image in use has no setting for it, so the Worker enforces it.
 */
export const MAX_LOCATIONS = 10;

/** The number of comma-separated locations a request asks for (at least 1). */
export function locationCount(params: URLSearchParams): number {
  return Math.max(1, ...["latitude", "longitude"].map((name) => (params.get(name) ?? "").split(",").length));
}

/** Query parameters that ask for values that move faster than the hourly model runs. */
const SUB_HOURLY = ["current", "minutely_15"];

/**
 * Cache lifetime in seconds for a successful response.
 *
 * Forecast models run at most hourly, so an hour is the longest a forecast is kept; requests for current
 * conditions or 15-minute data are kept for 15 minutes. ERA5 lags real time by about five days and the
 * preliminary ERA5T values are replaced by the final ones two to three months later, so archive responses
 * ending more than 90 days ago are kept for 30 days, those ending more than a week ago for a day, and
 * anything more recent (which the archive fills from the IFS analysis) for an hour.
 */
export function ttlSeconds(kind: Kind, params: URLSearchParams, now: Date): number {
  switch (kind) {
    case "static":
      return 30 * DAY;
    case "daily":
      return 6 * HOUR;
    case "forecast":
      return SUB_HOURLY.some((p) => params.has(p)) ? 15 * MINUTE : HOUR;
    case "archive": {
      const end = params.get("end_date");
      if (!end || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return HOUR;
      const ageDays = (now.getTime() - Date.parse(`${end}T00:00:00Z`)) / (DAY * 1000);
      if (Number.isNaN(ageDays)) return HOUR;
      if (ageDays > 90) return 30 * DAY;
      if (ageDays > 7) return DAY;
      return HOUR;
    }
  }
}

/** 400 responses depend only on the URL, so they are cached briefly to keep repeated bad requests off the container. */
export const ERROR_TTL_SECONDS = 10 * MINUTE;

/**
 * The cache key for a request: the same path with its query parameters sorted by name.
 *
 * The sort is stable, so repeated parameters (`hourly=a&hourly=b`) keep their relative order, which decides the
 * order of the columns in the response. Values are left exactly as sent; coordinates are not rounded, because
 * Open-Meteo uses the exact point for elevation-based downscaling and rounding would change the answer.
 * Clients that want more cache hits should round their own coordinates.
 */
export function cacheKey(url: URL): string {
  const entries = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = new URLSearchParams(entries).toString();
  return `${url.origin}${url.pathname}${query ? `?${query}` : ""}`;
}

/** The endpoint name for a `/v1/<name>` path, or null if the path is not one the server answers. */
export function endpointFor(pathname: string): string | null {
  const match = /^\/v1\/([a-z0-9-]+)\/?$/.exec(pathname);
  if (!match) return null;
  return Object.hasOwn(ENDPOINTS, match[1]) ? match[1] : null;
}
