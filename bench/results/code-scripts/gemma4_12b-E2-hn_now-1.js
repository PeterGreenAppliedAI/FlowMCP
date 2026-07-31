async function main(tools) {
  const topStoryIds = await tools.hn_get_top_story_ids({});
  const firstFiveIds = topStoryIds.slice(0, 5);

  let results = "";
  for (let i = 0; i < firstFiveIds.length; i++) {
    const item = await tools.hn_get_item({ id: firstFiveIds[i] });
    results += `Story ${i + 1}: ${item.title} (Score: ${item.score}, URL: ${item.url})\n`;
  }

  return results;
}
