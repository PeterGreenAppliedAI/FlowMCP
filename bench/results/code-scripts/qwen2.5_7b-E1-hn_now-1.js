async function main(tools) {
    const topStoryIds = await tools.hn_get_top_story_ids({});
    const stories = [];
    for (let id of topStoryIds.slice(0, 5)) {
        stories.push(await tools.hn_get_item({id}));
    }
    return JSON.stringify({
        "stories": stories.map(story => ({
            "title": story.title,
            "score": story.score,
            "url": story.url
        }))
    });
}
