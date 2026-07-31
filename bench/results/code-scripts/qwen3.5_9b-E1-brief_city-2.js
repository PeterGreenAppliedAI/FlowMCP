async function main(tools) {
    // Step 1: Search for Lisbon to get coordinates
    const location = await tools.search_locations({query: "Lisbon"});
    
    if (!location.results || !location.results.length) {
        return "Could not find Lisbon";
    }
    
    const coords = location.results[0];
    const latitude = coords.latitude;
    const longitude = coords.longitude;
    const cityName = coords.name;
    
    // Step 2: Get daily forecast for today (1 day)
    const forecast = await tools.get_daily_forecast({latitude, longitude, days: 1});
    
    // Step 3: Get top HN story IDs
    const hnTopIdsResult = await tools.hn_get_top_story_ids();
    
    if (!hnTopIdsResult || !Array.isArray(hnTopIdsResult)) {
        return "Could not get Hacker News stories";
    }
    
    // Take first 5 (or fewer if less than 5 available)
    const topStoryIds = hnTopIdsResult.slice(0, 5);
    
    // Step 4: Fetch details for each story
    const stories = [];
    for (const id of topStoryIds) {
        try {
            const item = await tools.hn_get_item({id});
            if (!item.note && !item.ok || item.title !== undefined) {
                // Check if it's actual data vs error note
                if (typeof item === 'object' && item.id !== undefined) {
                    stories.push(item);
                } else if (Array.isArray(item)) {
                    break;
                }
            }
        } catch (e) {}
    }
    
    // Step 5: Compose final answer
    let result = `Morning Brief for ${cityName}\n\n`;
    result += `Weather:\n`;
    
    if (forecast.daily && forecast.daily.temperature_2m_max && Array.isArray(forecast.daily.temperature_2m_max)) {
        const highTemp = forecast.daily.temperature_2m_max[0];
        result += `- High Temperature: ${highTemp}°C\n`;
    } else if (typeof forecast.high === 'number') {
        result += `- High Temperature: ${forecast.high}°C\n`;
    }
    
    if (forecast.daily && forecast.daily.temperature_2m_min && Array.isArray(forecast.daily.temperature_2m_min)) {
        const lowTemp = forecast.daily.temperature_2m_min[0];
        result += `- Low Temperature: ${lowTemp}°C\n`;
    } else if (typeof forecast.low === 'number') {
        result += `- Low Temperature: ${forecast.low}°C\n`;
    }
    
    if (forecast.daily && forecast.daily.precipitation_probability_max && Array.isArray(forecast.daily.precipitation_probability_max)) {
        const precip = forecast.daily.precipitation_probability_max[0];
        result += `- Precipitation Probability: ${precip}%\n`;
    } else if (typeof forecast.precipitation === 'number') {
        result += `- Precipitation Probability: ${forecast.precipitation}%\n`;
    }
    
    result += `\nTop 5 Hacker News Stories:\n`;
    
    for (const story of stories.slice(0, 5)) {
        if (story && typeof story === 'object' && story.title !== undefined) {
            const title = Array.isArray(story.title) ? story.title[0] : story.title;
            const score = typeof story.score === 'number' ? story.score : 'N/A';
            let url = '';
            if (story.url || story.link) {
                url = Array.isArray(story.url) ? story.url[0] : story.url || story.link || '#';
            } else if (!url && !Array.isArray(url)) {
                url = '#';
            }
            
            result += `- "${title}" (${score} points)\n${url}\n\n`;
        }
    }
    
    return result;
}

main(tools);
