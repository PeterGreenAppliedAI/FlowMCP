async function main(tools) {
  const ids = await tools.hn_get_top_story_ids({});
  const topIds = ids.slice(0, 5);
  const stories = [];
  for (const id of topIds) {
    const item = await tools.hn_get_item({ id });
    stories.push(item);
  }
  const result = stories.map(s => `Title: ${s.title}\nScore: ${s.score}\nURL: ${s.url}`).join('\n\n');
  return result;
}
