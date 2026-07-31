async function main(tools) {
  const topIds = await tools.hn_get_top_story_ids({});
  // topIds is an array of IDs, e.g. [101,102,...]
  const items = [];
  for (const id of topIds.slice(0, 10)) { // limit to top 10 for readability
    const item = await tools.hn_get_item({ id });
    items.push(item);
  }
  const lines = items.map(item => {
    const score = item.score !== undefined ? item.score : '?';
    const title = item.title || '(no title)';
    return `- ${title} (${score} points)`;
  });
  return `Top stories on Hacker News right now:\n${lines.join('\n')}`;
}
