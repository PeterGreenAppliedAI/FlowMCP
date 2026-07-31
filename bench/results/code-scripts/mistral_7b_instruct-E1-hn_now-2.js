async function main(tools) {
  const city = 'New York'; // Use New York if no city is provided
  const locationResult = await tools.search_locations({ query: city });
  const { latitude, longitude } = locationResult.results[0];

  const topStoryIds = await tools.hn_get_top_story_ids({});
  const stories = [];
  for (let id of topStoryIds.slice(0, 5)) {
    const story = await tools.hn_get_item({ id });
    stories.push(`${story.title} (${story.score}) - ${story.url}`);
  }

  return `What is on Hacker News right now:\n\n${stories.join('\n')}`;
}
