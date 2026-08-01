# Detection — nominating flows from repeated agent success

The authoring loop's missing trigger: notice that an agent has repeatedly
solved the same task at inference prices, and nominate the procedure for
compilation. Repetition is both the trigger **and** the evidence: what stays
constant across real repetitions is contract, what varies is input, what
tracks upstream results is dataflow — the same discrimination the compiler
otherwise needs synthetic variants for.

## Execution log contract

Any agent runtime (LocalClaw, this repo's harness, anything) emits one JSON
line per completed task execution:

```json
{ "id": "run-123", "task": "news digest", "agent": "deepseek-v4-flash",
  "ts": "2026-08-01T00:00:00Z", "success": true, "tokens": 12345,
  "calls": [ { "name": "searxng_search", "args": { "q": "..." } } ] }
```

`calls` is the ordered tool-call sequence. Results are not required for
detection (only for compilation); a runtime that also records results enables
zero-extra-work compilation from the same log.

## Detector (detect.ts)

1. **Normalize** each execution to a shape signature: the tool-name sequence
   with consecutive repeats collapsed (`searxng_search×4`).
2. **Cluster** by exact signature (v0; normalization passes — dedupe of
   idempotent repeats, fanout-count abstraction — are future work and mirror
   the compiler's passes).
3. **Score** each cluster: `count × avgTokens × successRate`, with shape
   stability implied by exact-signature clustering.
4. **Nominate** clusters over thresholds (defaults: ≥3 runs, ≥80% success,
   ≥2,000 avg tokens), reporting: spend to date, projected per-run saving,
   and **input discovery** — for every argument leaf across the cluster,
   all-equal → constant, varying → input candidate with its observed values.

A nomination is a pointer to accumulated evidence, not a compiled artifact:
the hand-off is "these N traces, this signature, these input candidates —
run the compiler over them."

## Demonstrated on real data

`extract-executions.ts` converts the benchmark's committed wave-4/5
transcripts (agentic conditions, 8 models, real repeated task executions)
into the log format above; `detect.ts` run on that corpus nominates the
morning-brief and HN procedures unprompted and derives `city` as the input
from Lisbon/New York cross-run variance. See the committed nomination output.
