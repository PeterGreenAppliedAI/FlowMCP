# Compiler IR v0 — derived from observed trace shapes, not designed in advance

Source: 10 diverse captured scripts (8 models × 3 tasks × E0/E1/E2), each executed
under two fixture variants with an instrumented bridge (`trace-runner.ts`), shapes
in `shapes-report.md`, raw traces in `traces/`.

## What the traces actually contain

Across 10 scripts, only **two base signatures** appear:

1. `search_locations → get_daily_forecast → hn_get_top_story_ids → hn_get_item×5`
   (the full brief — identical across 5 different models)
2. `hn_get_top_story_ids → hn_get_item×5` (the HN-only task)

plus two noise patterns layered on top:

- **duplicate idempotent calls** (llama's repair script runs every call twice;
  qwen3.5's E0 fetches three id-lists and 13 items with repeats) — same tool,
  same resolved args, same result;
- **over-fetch** (results retrieved and never used in the output).

Every argument leaf classified cleanly into exactly four kinds — no fifth kind was
observed:

| kind | evidence rule |
|---|---|
| `ref` | value appears verbatim in a prior call's result (both variants) |
| `const` | identical across variants, not found in any prior result |
| `input` | const whose value matches a task entity (e.g. the city) |
| `derived` | changes across variants but not verbatim-traceable (NOT observed in args in this sample — reserved as a refusal trigger) |

The hardcoding detector (does the variant-1 output track the variant-1 world?)
passed on every script sampled: outputs contained the changed temperatures/titles,
so the sampled corpus contains no output-hardcoding.

## The IR

```ts
interface IrProgram {
  inputs: Record<string, { example: string }>;   // promoted from input-kind leaves
  nodes: IrNode[];                                // topologically ordered
  output: IrAssemble;
}

type IrNode =
  | { id: string; kind: 'call'; tool: string;
      args: Record<string, IrValue> }             // one tool invocation
  | { id: string; kind: 'fanout'; tool: string;   // map over a slice of a prior array
      over: IrRef; slice: [number, number];
      argPath: string;                            // where each element lands in args
      extraArgs: Record<string, IrValue> };

type IrValue =
  | { kind: 'const'; value: string | number | boolean }
  | { kind: 'input'; name: string }
  | IrRef;

interface IrRef { kind: 'ref'; node: string; path: string }  // JSON path into a node's result

interface IrAssemble {                             // final answer construction
  template: string;                                // holes reference node paths
  holes: Record<string, IrRef>;
}
```

Mapping to the FlowMCP DSL is direct: `call` → `http_request`/`mcp_call`,
`fanout` → `map` over a slice expression, `ref` chains → `steps.<id>.<path>`,
`input` → flow `input` + `{{input.x}}`, `assemble` → `template` + `output`.
`transform` is only needed when a ref path requires reshaping (not observed in
this sample; the engine's path expressions covered every edge).

## Normalization passes (evidence-preserving)

1. **Dedupe**: collapse calls with identical tool + resolved args + identical
   results into one node (handles llama ×2). Equivalence must be re-proven by
   replaying the compiled flow against both variants.
2. **Dead-call elimination**: drop calls whose results contribute no ref edge and
   no assemble hole (handles qwen3.5's over-fetch). Recorded in provenance as
   removed, never silently.
3. **Fanout detection**: k consecutive calls to the same tool whose distinguishing
   arg refs positions 0..k-1 of one prior array → one `fanout` node with slice
   [0, k].

## Refusal triggers (fail-closed)

- any `derived` argument leaf (computation between calls the IR cannot represent)
- ref sources that differ between variants (unstable dataflow)
- assemble holes that cannot be matched to trace values in BOTH variants
- input candidates that cannot be confirmed by a parameter-variant run where the
  task entity changes (next instrument to build: vary the *task input*, not just
  the fixture world)

## Verdict

The 10-script sample compiles conceptually into 2 base shapes + 3 normalization
passes + 4 value kinds. No construct outside the existing FlowMCP DSL is needed.
The hard remaining problem is **assemble inference** (templatizing the final
string against trace values) and **input confirmation** (needs task-entity
variants). Both are bounded. The compiler is feasible; per the agreed plan, the
next build slice happens against ONE real workflow's traces, not more fixtures.
