async function main(tools) {
  const city = 'New York'; // Default city if not provided
  const locationResult = await tools.search_locations({ query: city });
  const { latitude, longitude } = locationResult.results[0];

  const dailyForecast = await tools.get_daily_forecast({ latitude, longitude, days: 1 });
  const topStoryIds = await tools.hn_get_top_story_ids({});

  const stories = [];
  for (let id of topStoryIds.slice(0, 5)) {
    const story = await tools.hn_get_item({ id });
    stories.push(story);
  }

  let answer = `Today's forecast in ${city}: \n`;
  answer += `Max temperature: ${dailyForecast.daily.temperature_2m_max[0]}°C\n`;
  answer += `Min temperature: ${dailyForecast.daily.temperature_2m_min[0]}°C\n`;
  answer += `Precipitation probability: ${dailyForecast.daily.precipitation_probability_max[0]}%\n\n`;

  for (let i = 0; i < stories.length; i++) {
    const story = stories[i];
    answer += `${i + 1}. ${story.title}\nScore: ${story.score}\nURL: ${story.url}\n\n`;
  }

  return answer;
}
