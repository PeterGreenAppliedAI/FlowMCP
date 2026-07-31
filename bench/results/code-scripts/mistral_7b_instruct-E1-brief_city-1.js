async function main(tools) {
  const city = 'Lisbon'; // Change this to any other city if needed
  const locationResult = await tools.search_locations({ query: city });
  const { latitude, longitude } = locationResult.results[0];

  const dailyForecast = await tools.get_daily_forecast({ latitude, longitude, days: 1 });
  const topStoriesIds = await tools.hn_get_top_story_ids({});
  const stories = [];

  for (let id of topStoriesIds.slice(0, 5)) {
    const story = await tools.hn_get_item({ id });
    stories.push(`${story.title} (${story.score}) - ${story.url}`);
  }

  const brief = `Morning Brief for ${city}: \nTemperature: Max ${dailyForecast.daily.temperature_2m_max[0]}°C, Min ${dailyForecast.daily.temperature_2m_min[0]}°C, Precipitation Probability: ${dailyForecast.daily.precipitation_probability_max[0]}%\nTop 5 Hacker News Stories:\n${stories.join('\n')}`;

  return brief;
}
