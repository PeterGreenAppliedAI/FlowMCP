async function main(tools) {
  // Step 1: get top story IDs
  const topIds = await tools.hn_get_top_story_ids({});
  // Step 2: get details for first 5 stories
  const stories = [];
  for (let i = 0; i < 5 && i < topIds.length; i++) {
    const item = await tools.hn_get_item({ id: topIds[i] });
    stories.push(item);
  }
  // Step 3: compose answer
  const lines = stories.map((s, idx) => 
    `${idx+1}. ${s.title} (score ${s.score}) - ${s.url}`
  ).join('\n');
  return `Top 5 Hacker News stories right now:\n${lines}`;
}
