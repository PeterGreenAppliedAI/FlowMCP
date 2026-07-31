// Condition B: a realistic ~35-tool "platform server" surface — the thing
// FlowMCP argues against. Weather platform + HN platform + typical utility
// noise. Mock implementations return the SAME fixture data the FlowMCP
// condition is grounded in, so both conditions are scored against identical
// ground truth.

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const OBJ = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties: props,
  ...(required.length ? { required } : {}),
});

const STR = (description: string) => ({ type: 'string', description });
const NUM = (description: string) => ({ type: 'number', description });

function tool(name: string, description: string, parameters: Record<string, unknown>): OpenAiTool {
  return { type: 'function', function: { name, description, parameters } };
}

export const PRIMITIVE_TOOLS: OpenAiTool[] = [
  // Weather platform
  tool('search_locations', 'Search for locations by name, returns coordinates', OBJ({ query: STR('Location name to search') }, ['query'])),
  tool('get_current_weather', 'Current conditions for coordinates', OBJ({ latitude: NUM('Latitude'), longitude: NUM('Longitude') }, ['latitude', 'longitude'])),
  tool('get_daily_forecast', 'Daily forecast (min/max temp, precipitation probability) for coordinates', OBJ({ latitude: NUM('Latitude'), longitude: NUM('Longitude'), days: NUM('Number of days (1-16)') }, ['latitude', 'longitude'])),
  tool('get_hourly_forecast', 'Hourly forecast for coordinates', OBJ({ latitude: NUM('Latitude'), longitude: NUM('Longitude'), hours: NUM('Number of hours') }, ['latitude', 'longitude'])),
  tool('get_air_quality', 'Air quality index for coordinates', OBJ({ latitude: NUM('Latitude'), longitude: NUM('Longitude') }, ['latitude', 'longitude'])),
  tool('get_uv_index', 'UV index for coordinates', OBJ({ latitude: NUM('Latitude'), longitude: NUM('Longitude') }, ['latitude', 'longitude'])),
  tool('get_weather_alerts', 'Active weather alerts for coordinates', OBJ({ latitude: NUM('Latitude'), longitude: NUM('Longitude') }, ['latitude', 'longitude'])),
  tool('get_marine_forecast', 'Marine/wave forecast for coastal coordinates', OBJ({ latitude: NUM('Latitude'), longitude: NUM('Longitude') }, ['latitude', 'longitude'])),
  tool('get_historical_weather', 'Historical weather for a date range', OBJ({ latitude: NUM('Latitude'), longitude: NUM('Longitude'), start_date: STR('YYYY-MM-DD'), end_date: STR('YYYY-MM-DD') }, ['latitude', 'longitude', 'start_date', 'end_date'])),
  tool('get_climate_normals', '30-year climate normals for coordinates', OBJ({ latitude: NUM('Latitude'), longitude: NUM('Longitude') }, ['latitude', 'longitude'])),
  tool('get_pollen_forecast', 'Pollen forecast for coordinates', OBJ({ latitude: NUM('Latitude'), longitude: NUM('Longitude') }, ['latitude', 'longitude'])),
  tool('get_sunrise_sunset', 'Sunrise and sunset times for coordinates', OBJ({ latitude: NUM('Latitude'), longitude: NUM('Longitude'), date: STR('YYYY-MM-DD') }, ['latitude', 'longitude'])),
  tool('get_moon_phase', 'Moon phase for a date', OBJ({ date: STR('YYYY-MM-DD') })),
  tool('list_weather_stations', 'List weather stations near coordinates', OBJ({ latitude: NUM('Latitude'), longitude: NUM('Longitude'), radius_km: NUM('Search radius in km') }, ['latitude', 'longitude'])),
  tool('get_station_metadata', 'Metadata for a weather station', OBJ({ station_id: STR('Station identifier') }, ['station_id'])),
  tool('get_precipitation_radar', 'Precipitation radar tile URL for coordinates', OBJ({ latitude: NUM('Latitude'), longitude: NUM('Longitude'), zoom: NUM('Zoom level') }, ['latitude', 'longitude'])),
  tool('get_solar_radiation', 'Solar radiation forecast for coordinates', OBJ({ latitude: NUM('Latitude'), longitude: NUM('Longitude') }, ['latitude', 'longitude'])),
  // Hacker News platform
  tool('hn_get_top_story_ids', 'IDs of current top stories on Hacker News', OBJ({})),
  tool('hn_get_new_story_ids', 'IDs of newest stories on Hacker News', OBJ({})),
  tool('hn_get_best_story_ids', 'IDs of best stories on Hacker News', OBJ({})),
  tool('hn_get_ask_story_ids', 'IDs of current Ask HN stories', OBJ({})),
  tool('hn_get_show_story_ids', 'IDs of current Show HN stories', OBJ({})),
  tool('hn_get_job_ids', 'IDs of current job postings on Hacker News', OBJ({})),
  tool('hn_get_item', 'Fetch one Hacker News item (story, comment, job) by id', OBJ({ id: NUM('Item id') }, ['id'])),
  tool('hn_get_user', 'Fetch a Hacker News user profile', OBJ({ username: STR('Username') }, ['username'])),
  tool('hn_get_max_item_id', 'The current largest item id on Hacker News', OBJ({})),
  tool('hn_get_updates', 'Recently changed items and profiles on Hacker News', OBJ({})),
  // Utility noise typical of platform servers
  tool('convert_units', 'Convert a value between units', OBJ({ value: NUM('Value'), from_unit: STR('Source unit'), to_unit: STR('Target unit') }, ['value', 'from_unit', 'to_unit'])),
  tool('get_timezone', 'Timezone for coordinates', OBJ({ latitude: NUM('Latitude'), longitude: NUM('Longitude') }, ['latitude', 'longitude'])),
  tool('format_date', 'Format a date string', OBJ({ date: STR('Input date'), format: STR('Output format') }, ['date'])),
  tool('geocode_reverse', 'Reverse geocode coordinates to a place name', OBJ({ latitude: NUM('Latitude'), longitude: NUM('Longitude') }, ['latitude', 'longitude'])),
  tool('get_elevation', 'Ground elevation for coordinates', OBJ({ latitude: NUM('Latitude'), longitude: NUM('Longitude') }, ['latitude', 'longitude'])),
  tool('get_country_info', 'Country metadata (capital, population, currency)', OBJ({ country_code: STR('ISO country code') }, ['country_code'])),
  tool('search_news', 'Search general news articles by keyword', OBJ({ query: STR('Search keywords') }, ['query'])),
  tool('get_exchange_rate', 'Currency exchange rate', OBJ({ base: STR('Base currency'), quote: STR('Quote currency') }, ['base', 'quote'])),
];

// Mock execution grounded in the same fixture values as test/helpers.ts.
export function executePrimitiveTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'search_locations':
      return JSON.stringify({
        results: [{ name: String(args.query ?? 'Unknown'), country: 'Testland', latitude: 1.5, longitude: 2.5 }],
      });
    case 'get_daily_forecast':
      return JSON.stringify({
        daily: { temperature_2m_max: [30.1], temperature_2m_min: [20.2], precipitation_probability_max: [15] },
      });
    case 'get_current_weather':
      return JSON.stringify({ temperature: 25.4, weather: 'partly cloudy' });
    case 'hn_get_top_story_ids':
    case 'hn_get_best_story_ids':
      return JSON.stringify([101, 102, 103, 104, 105, 106, 107]);
    case 'hn_get_new_story_ids':
      return JSON.stringify([201, 202, 203]);
    case 'hn_get_item': {
      const id = Number(args.id ?? 0);
      return JSON.stringify({ id, title: `Story ${id}`, score: id, url: `https://example.com/${id}` });
    }
    case 'get_timezone':
      return JSON.stringify({ timezone: 'Etc/UTC' });
    case 'geocode_reverse':
      return JSON.stringify({ name: 'Testville', country: 'Testland' });
    default:
      // Plausible-but-useless responses for the noise tools.
      return JSON.stringify({ ok: true, note: `${name} returned no relevant data` });
  }
}

export const PRIMITIVE_TOOL_NAMES = new Set(PRIMITIVE_TOOLS.map((t) => t.function.name));
