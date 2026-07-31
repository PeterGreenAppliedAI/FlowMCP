async function main(tools) {
  // Step 1: Search Lisbon
  const locResult = await tools.search_locations({ query: "Lisbon" });
  if (!locResult.results || locResult.results.length === 0) {
    return "No location found for Lisbon.";
  }
  const loc = locResult.results[0];
  const lat = loc.latitude;
  const lon = loc.longitude;

  // Step 2: Daily forecast for today
  const forecast = await tools.get_daily_forecast({ latitude: lat, longitude: lon, days: 1 });
  const daily = forecast.daily;
  const maxTemp = daily.temperature_2m_max[0];
  const minTemp = daily.temperature_2m_min[0];
  const precipProb = daily.precipitation_probability_max[0];

  // Step 3: Top story IDs
  const topIds = await tools.hn_get_top_story_ids({});
  const idsToFetch = topIds.slice(0, 5);

  // Step 4: Fetch each story
  const stories = [];
  for (const id of idsToFetch) {
    const item = await tools.hn_get_item({ id });
    if (item && item.title && item.score !== undefined) {
      stories.push({
        title: item.title,
        score: item.score,
        url: item.url || `https://news.ycombinator.com/item?id=${id}`
      });
    }
  }

  // Step 5: Compose the brief
  let result = `Morning Brief for Lisbon:\n`;
  result += `Today's forecast: High ${maxTemp}°C, Low ${minTemp}°C, Precipitation probability ${precipProb}%.\n\n`;
  result += `Top 5 Hacker News stories:\n`;
  for (let i = 0; i < stories.length; i++) {
    const s = stories[i];
    result += `${i+1}. "${s.title}" (score: ${s.score}) - ${s.url}\n`;
  }
  return result.trim();
}
