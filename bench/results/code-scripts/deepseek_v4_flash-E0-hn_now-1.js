async function main(tools) {
  // Get top story IDs
  const topIdsResult = await tools.hn_get_top_story_ids({});
  // topIdsResult is an array of IDs (e.g., [101, 102, ...])
  const ids = topIdsResult; // assume it's the array directly

  // Fetch items for each ID (limit to maybe top 10 to keep response manageable)
  const limit = Math.min(ids.length, 10);
  const items = [];
  for (let i = 0; i < limit; i++) {
    const item = await tools.hn_get_item({ id: ids[i] });
    items.push(item);
  }

  // Format output
  let output = "Top stories on Hacker News right now:\n";
  items.forEach((item, idx) => {
    const title = item.title || "(no title)";
    const url = item.url ? ` (${item.url})` : "";
    output += `${idx + 1}. ${title}${url}\n`;
  });

  return output;
}
