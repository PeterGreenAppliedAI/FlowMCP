async function main(tools) {
  const storyIds = await tools.hn_get_top_story_ids({});
  
  if (!storyIds || !Array.isArray(storyIds)) {
    return "No top stories available";
  }
  
  // Take first five IDs or fewer if less than 5 exist
  const idsToFetch = storyIds.slice(0, 5);
  
  const stories = [];
  for (const id of idsToFetch) {
    try {
      const item = await tools.hn_get_item({id});
      if (item && !item.note || item.title !== undefined) {
        stories.push(item);
      }
    } catch (e) {
      // Skip failed fetches
    }
  }
  
  return JSON.stringify(stories, null, 2);
}
