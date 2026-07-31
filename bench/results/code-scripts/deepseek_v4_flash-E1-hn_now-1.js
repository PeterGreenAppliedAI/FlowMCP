async function main(tools) {
  const ids = await tools.hn_get_top_story_ids({});
  // ids is an array like [101,102,103,104,105,106,107]
  const top5 = ids.slice(0, 5);
  const stories = [];
  for (const id of top5) {
    const item = await tools.hn_get_item({ id });
    stories.push(item);
  }
  let result = "Here are the top 5 stories on Hacker News right now:\n\n";
  for (let i = 0; i < stories.length; i++) {
    const s = stories[i];
    result += `${i+1}. ${s.title} (score: ${s.score})\n   ${s.url}\n\n`;
  }
  return result.trim();
}
