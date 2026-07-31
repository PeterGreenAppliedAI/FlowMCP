async function main(tools) {
  const idsResult = await tools.hn_get_top_story_ids({});
  const ids = idsResult.slice(0, 5);
  const stories = [];
  for (const id of ids) {
    const item = await tools.hn_get_item({ id });
    stories.push(item);
  }
  const lines = stories.map((s, i) => `${i+1}. "${s.title}" (score: ${s.score}, ${s.url})`);
  return lines.join('\n');
}
