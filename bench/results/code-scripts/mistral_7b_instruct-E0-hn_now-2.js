async function main(tools) {
  const topStories = await tools.hn_get_top_story_ids({});
  let storyTitles = [];

  for (const id of topStories) {
    const item = await tools.hn_get_item({id});
    storyTitles.push(item.title);
  }

  return `Current Top Stories on Hacker News:\n${storyTitles.join('\n')}`;
}
