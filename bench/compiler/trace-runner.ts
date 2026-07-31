// Instrumented sandbox runner for the script→flow compiler.
//
// Executes a captured code-mode script with a recording tool bridge and a
// selectable FIXTURE VARIANT. Running the same script under variant 0 and
// variant 1 separates dataflow from constants: an argument that tracks the
// variant's changed upstream values is a reference edge; one that stays fixed
// is a constant baked into the script. The observed trace is the compiler's
// evidence; the script text is only a hint.
//
//   npx tsx bench/compiler/trace-runner.ts <script.js> [--variant 0|1]
//
// Output (stdout): one JSON object { variant, result, trace } where trace is
// [{ seq, name, args, result }] in call order.

import { readFileSync } from 'node:fs';

interface Variant {
  place: { name: string; country: string; latitude: number; longitude: number };
  daily: { max: number; min: number; precip: number };
  ids: number[];
  title: (id: number) => string;
  rate: number;
  moon: { phase: string; illumination: number };
}

const VARIANTS: Variant[] = [
  {
    place: { name: 'ECHO_QUERY', country: 'Testland', latitude: 1.5, longitude: 2.5 },
    daily: { max: 30.1, min: 20.2, precip: 15 },
    ids: [101, 102, 103, 104, 105, 106, 107],
    title: (id) => `Story ${id}`,
    rate: 1.0842,
    moon: { phase: 'waxing gibbous', illumination: 0.82 },
  },
  {
    place: { name: 'ECHO_QUERY', country: 'Altland', latitude: 44.25, longitude: -63.75 },
    daily: { max: 11.3, min: 2.9, precip: 80 },
    ids: [901, 902, 903, 904, 905, 906, 907],
    title: (id) => `Item ${id}`,
    rate: 1.4421,
    moon: { phase: 'new moon', illumination: 0.01 },
  },
];

function execute(name: string, args: Record<string, unknown>, v: Variant): unknown {
  switch (name) {
    case 'search_locations':
      return { results: [{ name: String(args.query ?? 'Unknown'), country: v.place.country, latitude: v.place.latitude, longitude: v.place.longitude }] };
    case 'get_daily_forecast':
      return { daily: { temperature_2m_max: [v.daily.max], temperature_2m_min: [v.daily.min], precipitation_probability_max: [v.daily.precip] } };
    case 'get_current_weather':
      return { temperature: v.daily.max - 4.7, weather: 'partly cloudy' };
    case 'hn_get_top_story_ids':
    case 'hn_get_best_story_ids':
      return [...v.ids];
    case 'hn_get_new_story_ids':
      return v.ids.slice(0, 3);
    case 'hn_get_item': {
      const id = Number(args.id ?? 0);
      return { id, title: v.title(id), score: id, url: `https://example.com/${id}` };
    }
    case 'get_timezone':
      return { timezone: 'Etc/UTC' };
    case 'geocode_reverse':
      return { name: 'Testville', country: v.place.country };
    case 'get_exchange_rate':
      return { base: String(args.base ?? 'EUR'), quote: String(args.quote ?? 'USD'), rate: v.rate };
    case 'get_moon_phase':
      return { phase: v.moon.phase, illumination: v.moon.illumination };
    default:
      return { ok: true, note: `${name} returned no relevant data` };
  }
}

const TOOL_NAMES = [
  'search_locations', 'get_current_weather', 'get_daily_forecast', 'get_hourly_forecast',
  'get_air_quality', 'get_uv_index', 'get_weather_alerts', 'get_marine_forecast',
  'get_historical_weather', 'get_climate_normals', 'get_pollen_forecast', 'get_sunrise_sunset',
  'get_moon_phase', 'list_weather_stations', 'get_station_metadata', 'get_precipitation_radar',
  'get_solar_radiation', 'hn_get_top_story_ids', 'hn_get_new_story_ids', 'hn_get_best_story_ids',
  'hn_get_ask_story_ids', 'hn_get_show_story_ids', 'hn_get_job_ids', 'hn_get_item',
  'hn_get_user', 'hn_get_max_item_id', 'hn_get_updates', 'convert_units', 'get_timezone',
  'format_date', 'geocode_reverse', 'get_elevation', 'get_country_info', 'search_news',
  'get_exchange_rate',
];

const scriptPath = process.argv[2];
const variantIdx = Number(process.argv[process.argv.indexOf('--variant') + 1] || 0) || 0;
const variant = VARIANTS[variantIdx]!;
const code = readFileSync(scriptPath!, 'utf8');

interface TraceEntry { seq: number; name: string; args: unknown; result: unknown }
const trace: TraceEntry[] = [];
let seq = 0;

const tools: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {};
for (const name of TOOL_NAMES) {
  tools[name] = async (args = {}) => {
    if (trace.length > 60) throw new Error('trace call limit exceeded');
    const result = execute(name, args, variant);
    trace.push({ seq: seq++, name, args: JSON.parse(JSON.stringify(args)), result });
    return result;
  };
}

// Model scripts often console.log; keep stdout clean for our JSON envelope.
console.log = console.info = console.warn = ((...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n')) as typeof console.log;
const emit = (s: string) => process.stdout.write(s + '\n');

(async () => {
  const moduleStub = { exports: {} as Record<string, unknown> };
  const factory = new Function('module', 'exports', 'tools',
    `${code}\n;return typeof main === 'function' ? main : (typeof module.exports === 'function' ? module.exports : null);`);
  const main = factory(moduleStub, moduleStub.exports, tools) as null | ((t: typeof tools) => Promise<unknown>);
  if (!main) throw new Error('no main(tools)');
  const result = await main(tools);
  emit(JSON.stringify({ variant: variantIdx, result: String(result), trace }, null, 1));
})().catch((e: unknown) => {
  emit(JSON.stringify({ variant: variantIdx, error: e instanceof Error ? e.message : String(e), trace }, null, 1));
  process.exit(1);
});
