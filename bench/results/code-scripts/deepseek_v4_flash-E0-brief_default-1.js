async function main(tools) {
  // 1. Search for New York location
  const locResult = await tools.search_locations({ query: "New York" });
  const first = locResult.results[0];
  const lat = first.latitude;
  const lon = first.longitude;

  // 2. Get current weather
  const current = await tools.get_current_weather({ latitude: lat, longitude: lon });
  const temp = current.temperature;
  const weather = current.weather;

  // 3. Get daily forecast for today
  const forecast = await tools.get_daily_forecast({ latitude: lat, longitude: lon, days: 1 });
  const maxTemp = forecast.daily.temperature_2m_max[0];
  const minTemp = forecast.daily.temperature_2m_min[0];
  const precipProb = forecast.daily.precipitation_probability_max[0];

  // 4. Get top Hacker News story IDs
  const topIds = await tools.hn_get_top_story_ids({});
  // Take first 5
  const ids = topIds.slice(0, 5);

  // 5. Fetch details for each story
  const stories = [];
  for (const id of ids) {
    const item = await tools.hn_get_item({ id });
    stories.push({ title: item.title, score: item.score, url: item.url });
  }

  // 6. Build the morning brief string
  let brief = `☀️ Morning Brief – New York\n\n`;
  brief += `🌡️ Current temperature: ${temp}°C, ${weather}\n`;
  brief += `📈 Today: max ${maxTemp}°C, min ${minTemp}°C, precipitation probability ${precipProb}%\n\n`;
  brief += `📰 Top Hacker News stories:\n`;
  for (const s of stories) {
    brief += `- ${s.title} (score: ${s.score})\n`;
  }
  return brief.trim();
}
