async function main(tools) {
  // Get the current top story IDs from Hacker News
  const topIds = await tools.hn_get_top_story_ids({});
  
  // Prepare a readable list of the top stories
  let result = "Top Hacker News stories:\n";
  const limit = Math.min(10, topIds.length); // Show up to 10 stories
  
  for (let i = 0; i < limit; i++) {
    const id = topIds[i];
    const item = await tools.hn_get_item({ id });
    
    if (!item || !item.title) continue;
    
    result += `${i + 1}. ${item.title} (${item.score ?? 'N/A'} points)\n`;
    if (item.url) {
      result += `   URL: ${item.url}\n`;
    }
  }
  
  return result.trim();
}
