async function main(tools) {
  const CITY = 'New York'; // Default city if not provided

  // What is on Hacker News right now
  const hnTopStoriesIds = await tools.hn_get_top_story_ids({});
  const hnTopStories = [];

  for (let id of hnTopStoriesIds.slice(0, 5)) {
    const story = await tools.hn_get_item({id});
    hnTopStories.push(`${story.title} (${story.score}) - ${story.url}`);
  }

  return `What is on Hacker News right now:\n\n${hnTopStories.join('\n')}`;
}
