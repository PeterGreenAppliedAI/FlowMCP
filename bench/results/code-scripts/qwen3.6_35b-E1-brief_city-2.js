async function main(tools) {
  // Step 1: Search for Lisbon's coordinates
  const locationResult = await tools.search_locations({ query: "Lisbon" });
  const location = locationResult.results[0];
  
  // Step 2: Get daily forecast for Lisbon
  const forecastResult = await tools.get_daily_forecast({ 
    latitude: location.latitude, 
    longitude: location.longitude, 
    days: 1 
  });
  
  // Step 3: Get top 5 Hacker News story IDs
  const topStoryIds = await tools.hn_get_top_story_ids({});
  const top5Ids = topStoryIds.slice(0, 5);
  
  // Step 4: Fetch details for the top 5 stories
  const stories = [];
  for (const id of top5Ids) {
    const story = await tools.hn_get_item({ id });
    stories.push(story);
  }
  
  // Step 5: Compose the final answer
  const highTemp = forecastResult.daily.temperature_2m_max[0];
  const lowTemp = forecastResult.daily.temperature_2m_min[0];
  const precipProb = forecastResult.daily.precipitation_probability_max[0];
  
  let answer = `Morning Brief for Lisbon:\n\n`;
  answer += `Weather Today:\n`;
  answer += `- High: ${highTemp}°C\n`;
  answer += `- Low: ${lowTemp}°C\n`;
  answer += `- Precipitation Probability: ${precipProb}%\n\n`;
  answer += `Top 5 Hacker News Stories:\n`;
  
  stories.forEach((story, index) => {
    answer += `${index + 1}. ${story.title} (Score: ${story.score})\n`;
    if (story.url) {
      answer += `   URL: ${story.url}\n`;
    }
  });
  
  return answer;
}
