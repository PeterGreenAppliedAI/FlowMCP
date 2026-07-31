async function main(tools) {
  // Step 1: Search Lisbon
  const locResult = await tools.search_locations({ query: "Lisbon" });
  const loc = locResult.results[0];
  const lat = loc.latitude;
  const lon = loc.longitude;

  // Step 2: Get daily forecast for today (1 day)
  const forecast = await tools.get_daily_forecast({ latitude: lat, longitude: lon, days: 1 });
  const maxTemp = forecast.daily.temperature_2m_max[0];
  const minTemp = forecast.daily.temperature_2m_min[0];
  const precipProb = forecast.daily.precipitation_probability_max[0];

  // Step 3: Get top story IDs
  const topIds = await tools.hn_get_top_story_ids({});

  // Step 4: Fetch first 5 stories
  const storyPromises = topIds.slice(0, 5).map(id => tools.hn_get_item({ id }));
  const stories = await Promise.all(storyPromises);

  // Step 5: Compose answer
  let result = `Morning brief for Lisbon:\n`;
  result += `Today's forecast: high ${maxTemp}°C, low ${minTemp}°C, precipitation probability ${precipProb}%.\n`;
  result += `Top 5 Hacker News stories:\n`;
  stories.forEach((story, i) => {
    result += `${i+1}. ${story.title} (score: ${story.score}) - ${story.url}\n`;
  });
  return result.trim();
}
