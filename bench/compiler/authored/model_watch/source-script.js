async function main(tools) {
  // Search for news and discussion about Qwen from the past week
  const newsResults = await tools.searxng_search({
    q: "Qwen AI news",
    time_range: "week"
  });
  const discussionResults = await tools.searxng_search({
    q: "Qwen AI discussion",
    time_range: "week"
  });

  // Merge all results, deduplicate by URL
  const allResults = [...newsResults.results, ...discussionResults.results];
  const seen = new Set();
  const uniqueResults = [];
  for (const r of allResults) {
    if (!seen.has(r.url)) {
      seen.add(r.url);
      uniqueResults.push(r);
    }
  }

  // Build markdown report
  let md = `# Qwen AI – Latest News & Community Discussion (Past Week)\n\n`;
  if (uniqueResults.length === 0) {
    md += `No results found.\n`;
  } else {
    for (const r of uniqueResults) {
      const title = r.title || "Untitled";
      const url = r.url || "";
      const snippet = r.content ? r.content.substring(0, 200) : "No snippet available.";
      md += `- **${title}** — [Link](${url})\n  > ${snippet}\n\n`;
    }
  }

  return md;
}
