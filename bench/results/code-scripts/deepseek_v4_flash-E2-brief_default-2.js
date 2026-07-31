async function main(tools) {
  // 1. Search for New York (default city)
  const locResult = await tools.search_locations({ query: "New York" });
  const loc = locResult.results[0];
  const lat = loc.latitude;
  const lon = loc.longitude;

  // 2. Get today's daily forecast (days = 1)
  const forecast = await tools.get_daily_forecast({ latitude: lat, longitude: lon, days: 1 });
  const maxTemp = forecast.daily.temperature_2m_max[0];
  const minTemp = forecast.daily.temperature_2m_min[0];
  const precipProb = forecast.daily.precipitation_probability_max[0];

  // 3. Get top story IDs
  const topIds = await tools.hn_get_top_story_ids({});
  const top5Ids = topIds.slice(0, 5);

  // 4. Fetch each top story
  const stories = [];
  for (const id of top5Ids) {
    const item = await tools.hn_get_item({ id });
    stories.push({ title: item.title, score: item.score, url: item.url });
  }

  // 5. Compose final answer
  let answer = `Morning Brief for ${loc.name}, ${loc.country}:\n`;
  answer += `Today's forecast: High ${maxTemp}°C, Low ${minTemp}°C, Precipitation probability ${precipProb}%.\n\n`;
  answer += `Top 5 Hacker News stories:\n`;
  stories.forEach((story, idx) => {
    answer += `${idx + 1}. ${story.title} (Score: ${story.score}) – ${story.url}\n`;
  });
  return answer.trim();
}
