async function main(tools) {
  // Step 1: search Lisbon
  const locRes = await tools.search_locations({ query: "Lisbon" });
  if (!locRes.results || locRes.results.length === 0) {
    return "City not found";
  }
  const { latitude, longitude } = locRes.results[0];

  // Step 2: get daily forecast for today
  const forecast = await tools.get_daily_forecast({ latitude, longitude, days: 1 });
  const high = forecast.daily.temperature_2m_max[0];
  const low = forecast.daily.temperature_2m_min[0];
  const precip = forecast.daily.precipitation_probability_max[0];

  // Step 3: top story IDs
  const topIds = await tools.hn_get_top_story_ids({});
  const top5Ids = topIds.slice(0, 5);

  // Step 4: fetch each item
  const stories = [];
  for (const id of top5Ids) {
    const item = await tools.hn_get_item({ id });
    if (item && item.title) {
      stories.push({ title: item.title, score: item.score, url: item.url });
    }
  }

  // Step 5: compose answer
  let result = `Morning Brief for Lisbon:\n`;
  result += `Today's forecast: High ${high}°C, Low ${low}°C, Precipitation probability ${precip}%\n\n`;
  result += "Top 5 Hacker News stories:\n";
  stories.forEach((s, i) => {
    result += `${i+1}. ${s.title} (score: ${s.score}) - ${s.url}\n`;
  });
  return result.trim();
}
