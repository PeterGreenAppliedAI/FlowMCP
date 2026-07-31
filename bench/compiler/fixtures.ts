// Shared fixture worlds for the compiler toolchain: the trace runner and the
// primitives MCP server must agree on both variants exactly.
export interface Variant {
  place: { name: string; country: string; latitude: number; longitude: number };
  daily: { max: number; min: number; precip: number };
  ids: number[];
  title: (id: number) => string;
  rate: number;
  moon: { phase: string; illumination: number };
}

export const VARIANTS: Variant[] = [
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

export function execute(name: string, args: Record<string, unknown>, v: Variant): unknown {
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

