async function main(tools) {
  // Step 1: search Lisbon
  const locResult = await tools.search_locations({ query: "Lisbon" });
  if (!locResult.results || locResult.results.length === 0) {
    return "No location found for Lisbon.";
  }
  const { latitude, longitude } = locResult.results[0];

  // Step 2: daily forecast for today (days=1)
  const forecast = await tools.get_daily_forecast({ latitude, longitude, days: 1 });
  const day = forecast.daily;
  const maxTemp = day.temperature_2m_max[0];
  const minTemp = day.temperature_2m_min[0];
  const precipProb = day.precipitation_probability_max[0];

  // Step 3: top story IDs
  const topIds = await tools.hn_get_top_story_ids({});
  const firstFiveIds = topIds.slice(0, 5);

  // Step 4: fetch each story
  const stories = [];
  for (const id of firstFiveIds) {
    const item = await tools.hn_get_item({ id });
    stories.push(item);
  }

  // Step 5: compose brief
  let brief = `Morning brief for Lisbon:\n`;
  brief += `Today's forecast: high ${maxTemp}°C, low ${minTemp}°C, precipitation probability ${precipProb}%.\n\n`;
  brief += `Top 5 Hacker News stories:\n`;
  for (let i = 0; i < stories.length; i++) {
    const s = stories[i];
    brief += `${i+1}. "${s.title}" - score ${s.score} - ${s.url}\n`;
  }
  return brief.trim();
}
