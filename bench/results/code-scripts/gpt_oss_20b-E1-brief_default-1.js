async function main(tools) {
  // 1. Get coordinates for New York (default city)
  const locRes = await tools.search_locations({ query: "New York" });
  const { latitude, longitude } = locRes.results[0];

  // 2. Get today's daily forecast
  const forecastRes = await tools.get_daily_forecast({
    latitude,
    longitude,
    days: 1,
  });

  const highTemp =
    forecastRes.daily && forecastRes.daily.temperature_2m_max
      ? forecastRes.daily.temperature_2m_max[0]
      : "N/A";
  const lowTemp =
    forecastRes.daily && forecastRes.daily.temperature_2m_min
      ? forecastRes.daily.temperature_2m_min[0]
      : "N/A";
  const precipProb =
    forecastRes.daily && forecastRes.daily.precipitation_probability_max
      ? forecastRes.daily.precipitation_probability_max[0]
      : "N/A";

  // 3. Get top Hacker News story IDs
  const topIds = await tools.hn_get_top_story_ids({});

  // 4. Fetch details for the first five stories
  const stories = [];
  for (let i = 0; i < 5 && i < topIds.length; i++) {
    const item = await tools.hn_get_item({ id: topIds[i] });
    stories.push(item);
  }

  // 5. Compose final answer
  let answer = `Morning Brief for New York:\n`;
  answer += `Today's forecast: High ${highTemp}°C, Low ${lowTemp}°C, Precipitation probability ${precipProb}%.\n\n`;
  answer += `Top 5 Hacker News stories:\n`;
  stories.forEach((s, idx) => {
    answer += `${idx + 1}. ${s.title}\n   Score: ${s.score}\n   URL: ${s.url}\n`;
  });

  return answer;
}
