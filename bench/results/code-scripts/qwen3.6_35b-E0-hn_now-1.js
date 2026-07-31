async function main(tools) {
  const topStoryIds = await tools.hn_get_top_story_ids({});
  
  if (!topStoryIds || !Array.isArray(topStoryIds) || topStoryIds.length === 0) {
    return "No top stories found.";
  }

  const stories = [];
  const limit = Math.min(topStoryIds.length, 5); // Fetch top 5 for brevity

  for (let i = 0; i < limit; i++) {
    const id = topStoryIds[i];
    const item = await tools.hn_get_item({ id });
    if (item) {
      stories.push(item);
    }
  }

  let output = "Top stories on Hacker News:\n\n";
  stories.forEach((story, index) => {
    output += `${index + 1}. ${story.title}\n`;
    output += `   Score: ${story.score} | Comments: ${story.descendants || 0}\n`;
    if (story.url) {
      output += `   URL: ${story.url}\n`;
    } else if (story.text) {
      output += `   Type: Ask HN\n`;
    }
    output += "\n";
  });

  return output;
}
