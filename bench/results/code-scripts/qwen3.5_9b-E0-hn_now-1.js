async function main(tools) {
  const topStoryIds = await tools.hn_get_top_story_ids({});
  const newStoryIds = await tools.hn_get_new_story_ids({});
  const bestStoryIds = await tools.hn_get_best_story_ids({});
  
  let stories = [];
  
  // Get details for top stories
  if (Array.isArray(topStoryIds) && topStoryIds.length > 0) {
    for (const id of topStoryIds.slice(0, 5)) {
      const item = await tools.hn_get_item({id});
      if (item && !item.note) {
        stories.push(item);
      }
    }
  }
  
  // Get details for new stories
  if (Array.isArray(newStoryIds) && newStoryIds.length > 0) {
    for (const id of newStoryIds.slice(0, 5)) {
      const item = await tools.hn_get_item({id});
      if (item && !item.note) {
        stories.push(item);
      }
    }
  }
  
  // Get details for best stories
  if (Array.isArray(bestStoryIds) && bestStoryIds.length > 0) {
    for (const id of bestStoryIds.slice(0, 5)) {
      const item = await tools.hn_get_item({id});
      if (item && !item.note) {
        stories.push(item);
      }
    }
  }
  
  // Remove duplicates based on ID
  const uniqueStories = [...new Map(stories.map(item => [item.id, item])).values()];
  
  return JSON.stringify(uniqueStories.slice(0, 10));
}
