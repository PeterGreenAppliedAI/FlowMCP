async function main(tools) {
  // Step 1: Search for Lisbon's coordinates
  const locationResults = await tools.search_locations({ query: "Lisbon" });
  if (!locationResults || !locationResults.results || locationResults.results.length === 0) {
    return "Could not find coordinates for Lisbon.";
  }
  const lisbon = locationResults.results[0];
  const { latitude, longitude } = lisbon;

  // Step 2: Get the daily forecast for Lisbon
  const forecastResult = await tools.get_daily_forecast({
    latitude,
    longitude,
    days: 1,
  });

  // Extract temperature and precipitation (handling potential array structure)
  let tempHigh = "N/A";
  let tempLow = "N/A";
  let precipProb = "N/A";

  if (forecastResult && forecastResult.daily) {
    tempHigh = forecastResult.daily.temperature_2m_max[0];
    tempLow = forecastResult.daily.temperature_2m_min[0];
    precipProb = forecastResult.daily.precipitation_probability_max[0];
  }

  // Step 3: Get top Hacker News story IDs
  const hnIds = await tools.hn_get_top_story_ids({});
  
  // Step 4: Fetch details for the first 5 stories
  const stories = [];
  const topFiveIds = (hnIds || []).slice(0, 5);
  for (const id of topFiveIds) {
    const item = await tools.hn_get_item({ id });
    if (item && item.title) {
      stories.push({
        title: item.title,
        score: item.score,
        url: item.url,
      });
    }
  }

  // Step 5: Compose the final answer
  let response = `Morning Brief for Lisbon\n`;
  response += `------------------------\n`;
  response += `Forecast: High ${tempHigh}°C, Low ${tempLow}°C, Precipitation Probability: ${precipProb}%\n\n`;
  response += `Top Hacker News Stories:\n`;
  stories.forEach((story, index) => {
    response += `${index + 1}. ${story.title} (Score: ${story.score}) - ${story.url}\n`;
  });

  return response;
}
