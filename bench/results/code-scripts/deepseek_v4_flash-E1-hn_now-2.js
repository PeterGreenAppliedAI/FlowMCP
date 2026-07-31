async function main(tools) {
  const ids = await tools.hn_get_top_story_ids({});
  const top5 = ids.slice(0, 5);
  const items = await Promise.all(top5.map(id => tools.hn_get_item({id})));
  const stories = items.map(item => `- "${item.title}" (score: ${item.score}) <${item.url}>`).join('\n');
  return `Top 5 Hacker News stories right now:\n${stories}`;
}
