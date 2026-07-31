async function main(tools) {
    const city = "New York";
    const results = await tools.search_locations({query: city});
    const coordinates = results.results[0];
    const dailyForecast = await tools.get_daily_forecast({
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        days: 1
    });
    const topStoryIds = await tools.hn_get_top_story_ids();
    let stories = [];
    for (let i = 0; i < 5 && i < topStoryIds.length; i++) {
        const id = topStoryIds[i];
        const story = await tools.hn_get_item({id});
        stories.push(story);
    }
    return `Today in ${city} the high temperature will be ${dailyForecast.daily.temperature_2m_max[0]}°C and the low will be ${dailyForecast.daily.temperature_2m_min[0]}°C with a precipitation probability of ${dailyForecast.daily.precipitation_probability_max[0]}%. Here are the top 5 stories on Hacker News:
1. Title: "${stories[0].title}", Score: ${stories[0].score}, URL: ${stories[0].url}
2. Title: "${stories[1].title}", Score: ${stories[1].score}, URL: ${stories[1].url}
3. Title: "${stories[2].title}", Score: ${stories[2].score}, URL: ${stories[2].url}
4. Title: "${stories[3].title}", Score: ${stories[3].score}, URL: ${stories[3].url}
5. Title: "${stories[4].title}", Score: ${stories[4].score}, URL: ${stories[4].url}`;
}
