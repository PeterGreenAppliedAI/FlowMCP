async function main(tools) {
  const city = "New York";
  const location = await tools.search_locations({ query: city });
  const forecast = await tools.get_daily_forecast({
    latitude: location.results[0].latitude,
    longitude: location.results[0].longitude,
    days: 1
  });
  const topStoryIds = await tools.hn_get_top_story_ids({});
  const stories = [];
  for (let i = 0; i < Math.min(topStoryIds.length, 5); i++) {
    const story = await tools.hn_get_item({ id: topStoryIds[i] });
    stories.push({
      title: story.title,
      score: story.score,
      url: story.url
    });
  }
  return JSON.stringify({
    highTemp: forecast.daily.temperature_2m_max[0],
    lowTemp: forecast.daily.temperature_2m_min[0],
    precipitationProbability: forecast.daily.precipitation_probability_max[0],
    stories: stories
  });
}

main(tools).then(result => console.log(result));
