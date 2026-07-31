async function main(tools) {
  // Get coordinates for Lisbon (fallback to New York)
  let loc = await tools.search_locations({ query: "Lisbon" });
  if (!loc.results || !loc.results.length) {
    loc = await tools.search_locations({ query: "New York" });
  }
  const { latitude, longitude } = loc.results[0];

  // Get today's daily forecast
  const forecast = await tools.get_daily_forecast({
    latitude,
    longitude,
    days: 1,
  });

  const maxTemp =
    forecast.daily && forecast.daily.temperature_2m_max
      ? forecast.daily.temperature_2m_max[0]
      : "N/A";
  const minTemp =
    forecast.daily && forecast.daily.temperature_2m_min
      ? forecast.daily.temperature_2m_min[0]
      : "N/A";
  const precipProb =
    forecast.daily && forecast.daily.precipitation_probability_max
      ? forecast.daily.precipitation_probability_max[0]
      : "N/A";

  // Get top 5 Hacker News stories
  const ids = await tools.hn_get_top_story_ids({});
  const storyIds = Array.isArray(ids) ? ids.slice(0, 5) : [];
  const stories = [];
  for (const id of storyIds) {
    const item = await tools.hn_get_item({ id });
    if (item && item.title) {
      stories.push(item);
    }
  }

  // Compose the final answer
  let result = `Morning Brief for Lisbon:\n`;
  result += `High: ${maxTemp}°C\n`;
  result += `Low: ${minTemp}°C\n`;
  result += `Precipitation Probability: ${precipProb}%\n\n`;
  result += `Top 5 Hacker News Stories:\n`;
  stories.forEach((s, idx) => {
    result += `${idx + 1}. ${s.title} (Score: ${s.score}) - ${s.url}\n`;
  });

  return result.trim();
}
