async function main(tools) {
  const CITY = 'New York'; // Default city if not provided

  // Step 1: Search for location by name and get coordinates
  const { results } = await tools.search_locations({ query: CITY });
  const { latitude, longitude } = results[0];

  // Step 2: Get daily forecast for the coordinates
  const dailyForecast = await tools.get_daily_forecast({ latitude, longitude });

  // Step 3: Get top 5 Hacker News stories
  const storyIds = await tools.hn_get_top_story_ids({});
  const stories = [];
  for (let i = 0; i < Math.min(5, storyIds.length); i++) {
    const item = await tools.hn_get_item({ id: storyIds[i] });
    stories.push(item);
  }

  // Step 5: Compose the final answer with the temperatures and all five stories
  let answer = `Morning Brief for ${CITY}:\n\n`;
  answer += `Temperature Forecast:\nMax: ${dailyForecast.daily.temperature_2m_max[0]}°C\nMin: ${dailyForecast.daily.temperature_2m_min[0]}°C\nPrecipitation Probability: ${dailyForecast.daily.precipitation_probability_max[0]}%\n\n`;
  answer += 'Top 5 Hacker News Stories:\n';
  for (let i = 0; i < stories.length; i++) {
    const story = stories[i];
    answer += `${i + 1}. ${story.title}\nScore: ${story.score}\nURL: ${story.url}\n\n`;
  }

  return answer;
}
