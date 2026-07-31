async function main(tools) {
    const city = "Lisbon";
    
    // Step 1: Search for coordinates of the city
    const locationResult = await tools.search_locations({query: city});
    const {latitude, longitude} = locationResult.results[0];
    
    // Step 2: Get daily forecast for those coordinates
    const forecastResult = await tools.get_daily_forecast({latitude, longitude, days: 1});
    const {temperature_2m_max: maxTemp, temperature_2m_min: minTemp, precipitation_probability_max: precipProb} = forecastResult.daily;
    
    // Step 3: Get top 5 Hacker News story IDs
    const topStoryIds = await tools.hn_get_top_story_ids({});
    
    // Step 4 & 5: Fetch details for the first five stories
    let stories = [];
    for (const id of topStoryIds.slice(0, 5)) {
        const story = await tools.hn_get_item({id});
        stories.push({
            title: story.title,
            score: story.score,
            url: story.url
        });
    }
    
    // Compose the final answer
    return `Today's forecast for ${city}:
- High temperature: ${maxTemp[0]}°C
- Low temperature: ${minTemp[0]}°C
- Precipitation probability: ${precipProb[0]}%

Top 5 Hacker News stories:
1. Title: ${stories[0].title}, Score: ${stories[0].score}, URL: ${stories[0].url}
2. Title: ${stories[1].title}, Score: ${stories[1].score}, URL: ${stories[1].url}
3. Title: ${stories[2].title}, Score: ${stories[2].score}, URL: ${stories[2].url}
4. Title: ${stories[3].title}, Score: ${stories[3].score}, URL: ${stories[3].url}
5. Title: ${stories[4].title}, Score: ${stories[4].score}, URL: ${stories[4].url}`;
}
