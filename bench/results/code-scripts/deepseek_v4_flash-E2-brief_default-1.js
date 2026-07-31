async function main(tools) {
  // Step 1: Search for New York
  const locRes = await tools.search_locations({ query: "New York" });
  const loc = locRes.results[0];
  const lat = loc.latitude;
  const lon = loc.longitude;

  // Step 2: Get today's daily forecast
  const forecastRes = await tools.get_daily_forecast({ latitude: lat, longitude: lon, days: 1 });
  const daily = forecastRes.daily;
  const high = daily.temperature_2m_max[0];
  const low = daily.temperature_2m_min[0];
  const precip = daily.precipitation_probability_max[0];

  // Step 3: Get top story IDs
  const topIds = await tools.hn_get_top_story_ids({});
  const firstFiveIds = topIds.slice(0, 5);

  // Step 4: Fetch each story
  const stories = [];
  for (const id of firstFiveIds) {
    const item = await tools.hn_get_item({ id });
    stories.push({
      title: item.title,
      score: item.score,
      url: item.url || "(no url)"
    });
  }

  // Step 5: Compose final answer
  const forecastLine = `Today's forecast for New York: high ${high}°C, low ${low}°C, precipitation probability ${precip}%.`;
  const storiesLines = stories.map((s, i) => `${i+1}. "${s.title}" (${s.score} points) - ${s.url}`).join("\n");
  const answer = `${forecastLine}\n\nTop 5 Hacker News stories:\n${storiesLines}`;
  return answer;
}
