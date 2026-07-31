# FlowMCP benchmark

An A/B test of the repo's central claim. **Condition A** exposes the real FlowMCP
server (spawned as a child process, spoken to over stdio JSON-RPC): two tools,
`morning_brief(city?)` and `hn_top()`. **Condition B** exposes a realistic 35-tool
"platform server" surface (17 weather endpoints, 10 Hacker News endpoints, 8
utility tools) where the model must orchestrate the workflow itself:
`search_locations → get_daily_forecast → hn_get_top_story_ids → hn_get_item ×5`.

Everything else is held constant: same tasks, same models, same system prompt,
same scoring — and the same ground truth. Condition B's mocked tools return
exactly the fixture data FlowMCP's flows fetch, so a failure in B is an
orchestration failure, never missing data. Scoring is outcome-based: the final
answer must contain the true temperatures and ≥3 of the 5 story titles.

## Results (2026-07-31, self-hosted models via an OpenAI-compatible gateway)

Three tasks × 2 trials per cell. Aggregate over the 7 models that can
function-call: **façade 79% vs primitive surface 10%** (42 runs each), at
**9.2× the tokens per run** — roughly **75× per successful task**.

| model | A success | right tool | A calls | A tokens | B success | B calls | B tokens |
|---|---|---|---|---|---|---|---|
| qwen2.5:7b | **6/6** | 100% | 1.0 | 878 | 0/6 | 3.2 | 6,768 |
| mistral:7b-instruct | 4/6 | 33% | 1.0 | 778 | 0/6 | 0.0 | 2,952 |
| llama3.1:8b | 2/6 | 100% | 2.0 | 1,184 | 0/6 | 1.0 | 2,316 |
| qwen3.5:9b | **6/6** | 100% | 1.0 | 1,504 | 0/6 | 7.7 | 14,759 |
| gemma4:12b | **6/6** | 100% | 1.0 | 962 | 2/6 | 6.3 | 10,419 |
| gpt-oss:20b | 5/6 | 83% | 0.8 | 789 | 0/6 | 5.0 | 11,099 |
| qwen3.6:35b | 4/6 | 67% | 0.7 | 1,056 | 2/6 | 13.0 | 17,415 |

The aggregate is the claim; per-model cells are n=6 and should be read as
texture, not a leaderboard. Excluded with cause: gemma3:4b and phi4:14b (their
Ollama builds reject the `tools` parameter — cannot function-call at all).

**Frontier probe** (indicative — different scaffold): a fresh-context frontier
model (Claude Fable 5) ran all six cells once. Façade 3/3, one call each.
Primitive surface 1/3 — it orchestrated flawlessly (parallel batches, correct
sequencing, zero distractor calls) and failed anyway: one run produced a
polished *weather-only* brief and never touched Hacker News; another delivered
three HN stories and asked which city you're in. Nothing in 35 primitive tools
says what a "morning brief" *is* — that knowledge lives in the workflow.
**Capability doesn't recover specification.**

## Reproduce

```sh
GATEWAY=http://your-gateway:8001 npx tsx bench/run.ts \
  [--models a,b] [--trials N] [--tasks brief_city,hn_now,brief_default] \
  [--conditions A,B] [--max-tokens 2048]
```

Any OpenAI-compatible endpoint with function calling works. Results land in
`bench/results/` (gitignored); a markdown summary prints on completion. The
fixture HTTP server and the FlowMCP child process are managed by the harness —
no keys, no network beyond your gateway.

## Planned conditions

- **C — the strong baseline:** flows vs *tool search* (surface loads on demand)
  and vs *code mode* (model writes a script against the API). Prediction on
  record: tool search fixes token cost, not orchestration reliability.
- **D — the mixed surface:** flows and primitives exposed together, with
  partial-match tasks (flow + one extra call) and decline tasks (no flow
  matches — does the model correctly ignore the façade?).
