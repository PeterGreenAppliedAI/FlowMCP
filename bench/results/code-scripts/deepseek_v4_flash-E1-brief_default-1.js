async function main(tools) {
  // Step 1: search for New York
  const locResult = await tools.search_locations({ query: "New York" });
  const loc = locResult.results[0];
  const lat = loc.latitude;
  const lon = loc.longitude;

  // Step 2: get daily forecast for today (days=1)
  const forecast = await tools.get_daily_forecast({ latitude: lat, longitude: lon, days: 1 });
  const high = forecast.daily.temperature_2m_max[0];
  const low = forecast.daily.temperature_2m_min[0];
  const precip = forecast.daily.precipitation_probability_max[0];

  // Step 3: get top story IDs
  const topIds = await tools.hn_get_top_story_ids({});
  const firstFiveIds = topIds.slice(0, 5);

  // Step 4: fetch each story
  const stories = await Promise.all(
    firstFiveIds.map(id => tools.hn_get_item({ id }))
  );

  // Step 5: compose brief
  let answer = `Good morning! Today in New York:\n`;
  answer += `High: ${high}°C, Low: ${low}°C, Precipitation probability: ${precip}%\n\n`;
  answer += `Top 5 stories on Hacker News:\n`;
  stories.forEach((story, i) => {
    answer += `${i+1}. "${story.title}" (${story.score} points) - ${story.url}\n`;
  });

  return answer.trim();
}
