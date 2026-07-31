async function main(tools) {
  // Step 1: Search for New York coordinates
  const locationResult = await tools.search_locations({ query: "New York" });
  const lat = locationResult.results[0].latitude;
  const lon = locationResult.results[0].longitude;

  // Step 2: Get daily forecast for New York
  const forecast = await tools.get_daily_forecast({ latitude: lat, longitude: lon });
  const highTemp = forecast.daily.temperature_2m_max[0];
  const lowTemp = forecast.daily.temperature_2m_min[0];
  const precipProb = forecast.daily.precipitation_probability_max[0];

  // Step 3: Get top 5 Hacker News story IDs
  const topIds = await tools.hn_get_top_story_ids({});
  const top5Ids = topIds.slice(0, 5);

  // Step 4: Get details for each of the top 5 stories
  const stories = [];
  for (const id of top5Ids) {
    const item = await tools.hn_get_item({ id });
    stories.push(item);
  }

  // Step 5: Compose the final answer
  let answer = "Morning Brief for New York\n\n";
  answer += `Today's Forecast:\n`;
  answer += `High: ${highTemp}°C\n`;
  answer += `Low: ${lowTemp}°C\n`;
  answer += `Precipitation Probability: ${precipProb}%\n\n`;
  answer += "Top 5 Hacker News Stories:\n";
  stories.forEach((story, index) => {
    answer += `${index + 1}. ${story.title} (Score: ${story.score}) - ${story.url}\n`;
  });

  return answer;
}
