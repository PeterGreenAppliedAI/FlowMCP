async function main(tools) {
  // Fetch the top story IDs from Hacker News
  const topStoryIds = await tools.hn_get_top_story_ids({});

  if (!Array.isArray(topStoryIds) || topStoryIds.length === 0) {
    return "There are currently no top stories on Hacker News.";
  }

  // Fetch details for the first few top stories to provide a summary
  const itemsToFetch = topStoryIds.slice(0, 5);
  const storyDetails = [];

  for (const id of itemsToFetch) {
    const item = await tools.hn_get_item({ id });
    if (item && item.title) {
      storyDetails.push(`${item.title} (Score: ${item.score || 'N/A'})`);
    }
  }

  if (storyDetails.length === 0) {
    return "Here are some top stories on Hacker News, but details could not be retrieved.";
  }

  return "Top stories on Hacker News right now:\n" + storyDetails.join("\n");
}
