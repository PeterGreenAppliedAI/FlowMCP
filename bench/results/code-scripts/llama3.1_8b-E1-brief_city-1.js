async function main(tools) {
    const city = "Lisbon";
    const coordinates = await tools.search_locations({ query: city });
    const dailyForecast = await tools.get_daily_forecast({
        latitude: coordinates.results[0].latitude,
        longitude: coordinates.results[0].longitude,
        days: 1
    });
    const topStoryIds = await tools.hn_get_top_story_ids({});
    const stories = [];
    for (let i = 0; i < Math.min(topStoryIds.length, 5); i++) {
        const story = await tools.hn_get_item({ id: topStoryIds[i] });
        stories.push({
            title: story.title,
            score: story.score,
            url: story.url
        });
    }
    return JSON.stringify({
        city: city,
        highTemp: dailyForecast.daily.temperature_2m_max[0],
        lowTemp: dailyForecast.daily.temperature_2m_min[0],
        precipitationProbability: dailyForecast.daily.precipitation_probability_max[0],
        stories: stories
    });
}

main(tools).then(result => console.log(result));
