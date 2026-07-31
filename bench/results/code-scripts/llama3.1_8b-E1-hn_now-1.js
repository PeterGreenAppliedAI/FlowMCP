async function main(tools) {
    const storyIds = await tools.hn_get_top_story_ids({});
    const topStories = [];
    for (let i = 0; i < Math.min(5, storyIds.length); i++) {
        const item = await tools.hn_get_item({ id: storyIds[i] });
        topStories.push({
            title: item.title,
            score: item.score,
            url: item.url
        });
    }
    return JSON.stringify(topStories);
}

main({
    hn_get_top_story_ids: async () => {
        // implementation of hn_get_top_story_ids
    },
    hn_get_item: async ({ id }) => {
        // implementation of hn_get_item
    }
}).then(result => console.log(result));
