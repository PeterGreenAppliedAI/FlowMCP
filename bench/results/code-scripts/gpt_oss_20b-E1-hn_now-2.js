async function main(tools) {
    // Step 3: Get the current top story IDs from Hacker News
    const topIds = await tools.hn_get_top_story_ids({});
    
    // Take only the first five IDs (or fewer if less are returned)
    const idsToFetch = Array.isArray(topIds) ? topIds.slice(0, 5) : [];
    
    // Step 4: Fetch each story's details
    const stories = await Promise.all(
        idsToFetch.map(async id => {
            const item = await tools.hn_get_item({ id });
            return {
                title: item.title || 'No title',
                score: typeof item.score === 'number' ? item.score : 0,
                url: item.url || 'No URL'
            };
        })
    );
    
    // Step 5: Compose the final answer string
    const lines = stories.map((s, idx) => {
        return `${idx + 1}. ${s.title}\n   Score: ${s.score}\n   URL: ${s.url}`;
    });
    
    return lines.join('\n\n');
}
