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

## Conditions C and D (run 2026-07-31, wave 4)

- **C — primitives behind tool search** (`search_tools` + `call_tool`, defs load
  on demand): the prediction on record — search fixes token cost, not
  orchestration reliability — **held exactly**. Success 5/48, identical to
  condition B's 5/48, at roughly half the tokens (12.9K → 6.0K avg/run).
  Discovery is not sequencing.
- **D — the mixed surface** (2 flows + 35 primitives together, adding
  partial-match and decline tasks): 53/80 (66%). Strong façade models stayed
  perfect (qwen2.5:7b, gemma4:12b, qwen3.6:35b — 10/10 each, including
  flow + primitive composition). **Zero façade misuse across all 16 decline
  runs** — no model ever called a flow when none applied. Honest casualty:
  mistral:7b-instruct made zero tool calls in all ten D runs — 37 definitions
  pushed it past its capability cliff (it managed 4/6 with two tools).
- DeepSeek v4-flash (largest model tested): A 5/6 @1.5K tok · B 1/6 @37K tok ·
  C 1/6 @18K tok · D 7/10 @10K tok.

Raw per-run results and full wave-4 transcripts are committed in
`bench/results/`. Harness commits: waves 1–2 `cf56b01`, wave 3 `5ce273e`,
wave 4 `847bbf8`. Remaining untested strong baseline: **code mode** (model
writes a script against the API) — designed, not built.

One sentence: *search can expose capabilities, but only a workflow can encode
the deliverable.*
