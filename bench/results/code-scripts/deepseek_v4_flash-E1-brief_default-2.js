async function main(tools) {
  // Step 1: search for New York
  const locResult = await tools.search_locations({ query: "New York" });
  const location = locResult.results[0];
  const lat = location.latitude;
  const lon = location.longitude;

  // Step 2: daily forecast (today)
  const forecast = await tools.get_daily_forecast({ latitude: lat, longitude: lon, days: 1 });
  const daily = forecast.daily;
  const tempMax = daily.temperature_2m_max[0];
  const tempMin = daily.temperature_2m_min[0];
  const precipProb = daily.precipitation_probability_max[0];

  // Step 3: top story IDs
  const topIds = await tools.hn_get_top_story_ids({});
  const topFiveIds = topIds.slice(0, 5);

  // Step 4: fetch each story
  const stories = [];
  for (const id of topFiveIds) {
    const item = await tools.hn_get_item({ id });
    stories.push(item);
  }

  // Step 5: compose final answer
  let result = `Morning Brief for New York:\n`;
  result += `Today's forecast: High ${tempMax}°C, Low ${tempMin}°C, Precipitation probability ${precipProb}%\n\n`;
  result += `Top 5 Hacker News stories:\n`;
  for (let i = 0; i < stories.length; i++) {
    const s = stories[i];
    result += `${i+1}. "${s.title}" (Score: ${s.score}) - ${s.url}\n`;
  }
  return result.trim();
}
