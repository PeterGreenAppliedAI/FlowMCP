async function main(tools) {
    // Step 1: Search for New York location
    const locations = await tools.search_locations({query: "New York"});
    
    if (!locations.results || locations.results.length === 0) {
        return "Could not find coordinates for the city.";
    }
    
    const loc = locations.results[0];
    const lat = loc.latitude;
    const lon = loc.longitude;
    
    // Step 2: Get daily forecast (1 day should be enough for today's brief)
    const forecast = await tools.get_daily_forecast({latitude: lat, longitude: lon, days: 1});
    
    // Step 3: Get top story IDs from Hacker News
    const hnTopIds = await tools.hn_get_top_story_ids();
    
    if (!hnTopIds || !Array.isArray(hnTopIds) || hnTopIds.length === 0) {
        return "Could not fetch Hacker News stories.";
    }
    
    // Step 4: Get details for first 5 top stories
    const storyDetails = [];
    for (let i = 0; i < Math.min(5, hnTopIds.length); i++) {
        const item = await tools.hn_get_item({id: hnTopIds[i]});
        if (item && !item.note) { // Check it's not a note/error response
            storyDetails.push(item);
        } else if (!storyDetails.some(s => s.id === hnTopIds[i])) {
            const item = await tools.hn_get_item({id: hnTopIds[i]});
            if (item && !item.note) {
                storyDetails.push(item);
            }
        }
    }
    
    // Step 5: Compose final answer with temperatures and stories
    let result = `Morning Brief for ${loc.name || 'New York'}\n\n`;
    result += `Daily Forecast:\n`;
    if (forecast.daily && forecast.daily.temperature_2m_max) {
        const highTemp = forecast.daily.temperature_2m_max[0];
        result += `- High Temperature: ${highTemp}°C\n`;
    } else {
        result += `- No temperature data available\n`;
    }
    
    if (forecast.daily && forecast.daily.temperature_2m_min) {
        const lowTemp = forecast.daily.temperature_2m_min[0];
        result += `- Low Temperature: ${lowTemp}°C\n`;
    } else {
        result += `- No temperature data available\n`;
    }
    
    if (forecast.daily && forecast.daily.precipitation_probability_max) {
        const precip = forecast.daily.precipitation_probability_max[0];
        result += `- Precipitation Probability: ${precip}%\n`;
    } else {
        result += `- No precipitation data available\n`;
    }
    
    result += `\nTop 5 Hacker News Stories:\n`;
    storyDetails.forEach((story, index) => {
        if (story.title && !story.note) {
            result += `${index + 1}. ${story.title} (${story.score || 'N/A'} points)\n   URL: ${story.url}\n\n`;
        } else if (!result.includes(`Top 5 Hacker News Stories:`)) {
            // If no stories found, add a note
            result += `No top stories available.\n`;
        }
    });
    
    return result;
}

main(tools);
