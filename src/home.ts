/** The plain homepage at `/`: what this server is, its limits, examples, and the attribution the licences require. */
import { MAX_LOCATIONS } from "./policy";

const PROVIDERS: [string, string, string][] = [
  ["European Centre for Medium-Range Weather Forecasts (ECMWF)", "https://www.ecmwf.int", "CC BY 4.0"],
  ["Deutscher Wetterdienst (DWD)", "https://www.dwd.de", "CC BY 4.0"],
  ["NOAA National Centers for Environmental Prediction", "https://www.weather.gov/ncep/", "public domain (US Government)"],
  ["Météo-France", "https://meteofrance.fr", "Licence Ouverte / Etalab"],
  ["UK Met Office", "https://www.metoffice.gov.uk/", "CC BY-SA 4.0"],
  ["Royal Netherlands Meteorological Institute (KNMI)", "https://www.knmi.nl/", "CC BY 4.0"],
  ["Danish Meteorological Institute (DMI)", "https://www.dmi.dk/", "CC BY 4.0"],
  ["Norwegian Meteorological Institute (MET Norway)", "https://www.met.no", "CC BY 4.0"],
  ["MeteoSwiss", "https://www.meteoswiss.admin.ch/", "CC BY 4.0"],
  ["ItaliaMeteo-ARPAE", "https://www.agenziaitaliameteo.it/", "CC BY 4.0"],
  ["Canadian Meteorological Centre (CMC)", "https://weather.gc.ca/", "Environment and Climate Change Canada Data Server End-use Licence"],
  ["Japan Meteorological Agency (JMA)", "https://www.jma.go.jp/", "JMA terms of use"],
  ["China Meteorological Administration (CMA)", "https://www.cma.gov.cn/en/", "CC BY 4.0"],
  ["Australian Bureau of Meteorology (BOM)", "https://www.bom.gov.au/", "CC BY 4.0"],
  ["Copernicus Climate Change Service (ERA5 reanalysis, CAMS air quality, elevation)", "https://climate.copernicus.eu", "Copernicus licence"],
  ["Copernicus Marine Service", "https://marine.copernicus.eu/", "Copernicus Marine licence"],
  ["Global Flood Awareness System (GloFAS)", "https://www.globalfloods.eu/", "CEMS licence"],
];

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

export type Limits = { allPer10Seconds: number; originPerMinute: number };

export function homePage({ origin, image, limits }: { origin: string; image: string; limits: Limits }): string {
  const examples = [
    `${origin}/v1/forecast?latitude=51.51&longitude=-0.13&hourly=temperature_2m,wind_speed_10m&models=ecmwf_ifs&timezone=Europe%2FLondon`,
    `${origin}/v1/archive?latitude=51.51&longitude=-0.13&start_date=2025-01-01&end_date=2025-12-31&daily=temperature_2m_mean&timezone=Europe%2FLondon`,
    `${origin}/v1/elevation?latitude=51.51&longitude=-0.13`,
  ];
  const providers = PROVIDERS.map(([name, url, licence]) => `<li><a href="${url}">${escape(name)}</a> – ${escape(licence)}</li>`).join("\n      ");
  return `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Weather API</title>
  <meta name="description" content="A self-hosted Open-Meteo weather API, run for Halfhour.">
  <style>
    :root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fdfdfc; --muted: #5f6368; --rule: #e3e3e0; --code: #f3f3f1; --link: #0b57d0; }
    @media (prefers-color-scheme: dark) { :root { --fg: #e8e8e6; --bg: #161616; --muted: #a0a09c; --rule: #2e2e2c; --code: #222221; --link: #8ab4f8; } }
    body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
    main { max-width: 44rem; margin: 0 auto; padding: 2.5rem 1rem 4rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
    h2 { font-size: 1.1rem; margin: 2rem 0 0.5rem; padding-top: 1rem; border-top: 1px solid var(--rule); }
    p, li { color: var(--fg); }
    .lede { color: var(--muted); margin-top: 0; }
    a { color: var(--link); }
    code { background: var(--code); padding: 0.1em 0.3em; border-radius: 4px; font-size: 0.9em; overflow-wrap: anywhere; }
    ul { padding-left: 1.2rem; }
    li { margin: 0.25rem 0; }
    small { color: var(--muted); }
  </style>
</head>
<body>
<main>
  <h1>Weather API</h1>
  <p class="lede">A self-hosted copy of the <a href="https://open-meteo.com/">Open-Meteo</a> weather API.</p>

  <p>This server runs the open-source Open-Meteo server, reading the forecast and archive data that Open-Meteo publishes as open data. It is operated for <a href="https://halfhour.tk.gg">Halfhour</a>, and anyone may use it as a free example server.</p>
  <p>There are no guarantees: it may be slow, out of date or offline, and it may change or close without notice. If you rely on weather data, run your own copy or use <a href="https://open-meteo.com/en/pricing">Open-Meteo's own API</a>.</p>

  <h2>Using it</h2>
  <p>The API is the same as Open-Meteo's, so its <a href="https://open-meteo.com/en/docs">documentation</a> applies. Replace <code>api.open-meteo.com</code> or <code>archive-api.open-meteo.com</code> with <code>${escape(new URL(origin).host)}</code>. Only <code>GET</code> requests are accepted, with up to ${MAX_LOCATIONS} locations each.</p>
  <ul>
      ${examples.map((u) => `<li><a href="${escape(u)}"><code>${escape(u)}</code></a></li>`).join("\n      ")}
  </ul>
  <p>Forecasts are cached for up to an hour (15 minutes when asking for current or 15-minutely values), archive data for up to 30 days, and elevation and climate data for 30 days.</p>
  <p>Each address may make ${limits.originPerMinute} uncached requests a minute, and about ${limits.allPer10Seconds} requests in any 10 seconds in total. Requests over the limit receive HTTP 429 with a <code>Retry-After</code> header.</p>

  <h2>Data and licences</h2>
  <p><a href="https://open-meteo.com/">Weather data by Open-Meteo.com</a>, licensed under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. Open-Meteo builds on open data from:</p>
  <ul>
      ${providers}
  </ul>
  <p>Data from UK Met Office models (<code>ukmo_*</code>, and <code>best_match</code> in the UK) is licensed under <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>: if you share or adapt it, you must do so under the same licence. Choose other models with the <code>models</code> parameter if that does not suit you.</p>
  <p>The full list of sources and their licence terms is on <a href="https://open-meteo.com/en/licence">Open-Meteo's licence page</a>.</p>

  <h2>Software</h2>
  <p>The Open-Meteo server is free software under the <a href="https://www.gnu.org/licenses/agpl-3.0.html">GNU Affero General Public Licence v3</a>. This server runs the official image without modification: <code>${escape(image)}</code>. Its source code is at <a href="https://github.com/open-meteo/open-meteo">github.com/open-meteo/open-meteo</a>.</p>
  <p>It runs in a Cloudflare Container behind a small Worker that adds caching and rate limits.</p>

  <p><small>Not affiliated with or endorsed by Open-Meteo or any of the data providers.</small></p>
</main>
</body>
</html>
`;
}
