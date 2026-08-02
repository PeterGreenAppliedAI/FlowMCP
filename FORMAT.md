# The FlowMCP flow format — v0.6

This document specifies `.flow.json5` as a **portable contract**, independent of
the FlowMCP server that happens to execute it. The claim: a workflow worth
repeating should be a reviewable artifact — deterministic, model-agnostic,
agent-agnostic. Any agent can *author* a flow (including by distilling its own
successful tool-use trace); any runtime that implements this spec can *serve*
it; any model can *call* it. The format is the interface between those parties.

Versioning: this spec is versioned with the FlowMCP release that implements it
(currently **0.6**). Additions are backward-compatible within a major version;
a flow file needs no version marker until a breaking change ships, at which
point a top-level `format` field will be introduced.

## File

One flow per file, named `<anything>.flow.json5`, parsed as [JSON5]. A serving
runtime loads every matching file in its flows directory at startup and must
reject the whole startup — loudly, naming the file and field — if any flow is
invalid. There is no partial loading.

## Top-level fields

| field | type | rules |
|---|---|---|
| `name` | string | `snake_case` (`^[a-z][a-z0-9_]*$`); becomes the MCP tool name; unique across loaded flows |
| `description` | string | 1–300 chars. Convention: start with `WHEN TO USE:` — this is the model's entire manual |
| `input` | object | 0–3 named parameters (see below). Optional; defaults to none |
| `env` | string[] | env vars visible to `{{env.X}}`. **Least privilege**: anything undeclared resolves as absent. Optional; defaults to none |
| `steps` | step[] | ≥1, executed in order; each result becomes `steps.<id>` |
| `output` | string | template producing the tool's text result |
| `proposal` | string | optional; write flows only — template rendered as the approval proposal, with all pre-write step results available |

Parameter: `{ type: 'string'|'number'|'boolean', description (≤200 chars),
required?: boolean, default?: <matching the declared type> }`. A default whose
type contradicts `type` is a validation error.

## Step kinds

Every named step has a `snake_case` `id`, unique within the flow.

- **`http_request`** — `method` (`GET`|`POST`, default GET), `url`, `headers?`,
  `body?`, `timeoutMs?` (default 15000, max 60000). JSON responses (by
  content-type) are parsed; anything else is text. Non-2xx is a step failure.
  One automatic retry on network-level failure, **GET only** — a timed-out POST
  may have landed, so it is never retried.
- **`transform`** — `expr`: a sandboxed expression producing the step's value.
- **`template`** — `template`: a string built by interpolation.
- **`map`** — `over` (expression → array), `as?` (binding name, default
  `item`), `step` (one id-less leaf step: `http_request`, `transform`,
  `template`, or `mcp_call`). Sequential, **max 10 items** — larger inputs are
  an error, not a truncation; slice explicitly (`steps.ids[0:10]`).
- **`branch`** — `if` (expression), `then` (steps), `else?` (steps). Inner
  steps' results land in `steps.<id>` like any other. **No nested branches.**
  The branch's own result is `{ taken: 'then'|'else' }`.
- **`mcp_call`** — `server` (a name from `servers.json5`), `tool`, `args?`
  (interpolated deeply), `timeoutMs?` (default 30000 — covers spawn +
  handshake + call as one unit), `maxResultChars?` (default 8000).
  `structuredContent` is preferred over parsing JSON out of text; oversized
  results are truncated with an explicit marker.

## Expressions and interpolation

The expression language is deliberately not a programming language: paths
(`steps.geo.results[0].latitude`), array slices (`ids[0:5]`), object/array
literals, string/number/boolean/null literals, and comparisons
(`==` `!=` `>` `>=` `<` `<=`). No calls, no arithmetic, no assignment, no
prototype access. Available roots: `input`, `env` (declared vars only),
`steps`, plus the enclosing `map` binding.

`{{ expr }}` interpolates into strings. Semantics:

- A **missing terminal** property renders as `''` (mustache-style): `{{story.url}}`
  on a story without a URL is empty, not an error.
- Reading **through** `undefined`/`null` is a loud step failure with the path
  in the message: typos fail, absent data doesn't.
- Arrays join line-per-item; objects render as JSON.
- In `http_request` URLs, every interpolated value is percent-encoded —
  **except a placeholder at position 0**, which is the base-URL slot
  (`{{env.API_BASE}}/path`). You cannot inject raw query fragments mid-URL;
  that is the point.

## Execution semantics

Steps run strictly in order. Whole-flow timeout: 60s. A failed step aborts the
flow; the MCP result is `isError: true` with text naming the flow, the step id,
and the cause. Input validation (unknown parameter, missing required, type
mismatch) fails the same way, before any step runs.

## The serving contract (MCP)

A serving runtime exposes each flow as one MCP tool: `name`, `description`,
an `inputSchema` derived from `input`, and **computed** annotations — a flow
containing a POST or an `mcp_call` to an allowlisted (non-read-only) tool is
published `readOnlyHint: false, destructiveHint: true`; `openWorldHint`
reflects whether the flow touches the network. Annotations are derived from
the steps, never asserted: a doctrine claim without a mechanism that computes
it will eventually be a lie.

## Downstream servers (`servers.json5`)

Composition config lives beside the flows. Each entry uses exactly one
transport: **stdio** (`command`, `args?`, `env?`, `inheritEnv?`, `shell?`) or
**Streamable HTTP** (`url`, `headers?` — connected via the official MCP SDK's reference client transport, pinned to its v1 line — both may interpolate `{{env.X}}`, so
auth tokens live in the environment, never in files). Stdio children get a
minimal baseline environment plus configured vars (`inheritEnv: true` is an
explicit opt-in).

Tool admission is fail-closed, three ways in: a tool is callable iff it
declares `annotations.readOnlyHint: true`, OR the operator attests it as a
read in `attestReadOnly: [...]` (a security assertion for the many production
servers that annotate nothing — attested tools are NOT counted write-capable;
`attestReadOnly` and `allow` must be disjoint; attested names that do not
exist on the server fail loudly at connect time; and an optional `attestHash`
pins the sha256 of the attested/allowed tools' schemas AS REVIEWED — upstream
schema drift then refuses connection until a human re-reviews and re-pins,
because an attestation is a judgment about a specific tool, not a name), OR it
is named in
`allow: [...]` (write-capable: makes containing flows non-read-only and
gated). This file is operator-trusted configuration — same trust level as the
server's own command line.

## Trust model

A flow file is a **trusted program**. The expression language cannot execute
code, but a flow can send whatever it can see to any URL it names — what
bounds the blast radius is what it can see: declared env vars, declared
inputs, and policy-gated downstream tools. Review flow files like code;
don't load flows you haven't read.

## Write flows and two-phase confirmation (v0.3)

A flow is **write-capable** when any step (at any nesting depth) is a POST
`http_request` or an `mcp_call` to a tool in that server's `allow` list. This is
computed from the steps — there is no flag to set or forget. Serving semantics:

1. A `tools/call` without `confirm` executes steps **up to the first top-level
   write step**, then pauses. The result is not an error: it carries the
   proposal text (the flow's `proposal` template, or an auto-generated summary
   of the pending write steps) and a **single-use token** with a 5-minute
   expiry, plus instructions to call the same tool again with
   `{"confirm": "<token>"}`.
2. A call with a valid `confirm` resumes execution from the paused step with a
   fresh flow timeout (deliberation time is not the flow's execution budget)
   and returns the flow's normal output. The token is single-use, expires
   silently, and is bound to its flow **and its frozen execution state** — the
   inputs and every pre-write step result are captured at pause time, so
   confirmation executes exactly what was proposed and never recomputes reads
   against changed state.
3. Write flows advertise an optional `confirm` string parameter in their
   `inputSchema` (this does not count against the 3-parameter limit) and
   `readOnlyHint: false, destructiveHint: true` annotations.

One confirmation covers one flow run: after it, the remaining steps —
including multiple writes — execute without further pauses. If per-write
granularity matters, split the flow.

**Elicitation upgrade (v0.5):** when the client declares the `elicitation`
capability at initialize, the write pause is mediated through the HOST
instead: the server sends `elicitation/create` with the proposal and an
`{approve: boolean}` schema, and only an accepted `approve: true` resumes the
writes — the model never holds a consumable token. The same mechanism asks
the user for missing required parameters (structural ask-the-user) before
execution. Honest boundary: gate quality equals host quality — the spec
intends elicitations be presented to a person, and a host that auto-answers
them reduces this to the token protocol's guarantees. Without the capability,
the v0.3 two-phase token protocol applies unchanged: a confirmation
checkpoint, not a guaranteed human gate.

## The registry (`registry.json5`) — v0.6

Optional, beside the flow files. Its **presence** opts the directory into
promotion governance; absent, every valid flow serves (pre-registry behavior).
Like `servers.json5`, it is operator-trusted, hand-edited configuration — the
runtime reads it and never writes it.

Each key is a flow name mapping to:

```json5
{
  weekly_gather: {
    state: 'active',            // candidate | reviewed | active | retired
    provenance: {               // optional — where this flow came from
      source: 'traces/weekly_gather.trace.json',
      authoredBy: 'deepseek-v4-flash',
      compiledAt: '2026-08-01',
      notes: 'compiled from the news-cron gathering phase',
    },
    review: { by: 'peter', at: '2026-08-02', notes: 'facet queries verified' },
  },
}
```

Enforcement is fail-closed both ways: only `active` flows are served (others
are skipped with a stderr note); a flow file **not listed** in the registry is
a startup error — a registry means the directory is governed, and an unlisted
flow is an unreviewed flow; an entry naming a flow that doesn't exist is
equally a startup error (a stale judgment). `--validate` checks all of this
without serving.

### The run log (`registry-log.jsonl`)

When a registry is present, the runtime appends one JSON line per completed
flow execution to `registry-log.jsonl` in the same directory. The file is an
open contract: **external emitters append to it too**, and a status reader
must skip (and count) malformed lines rather than fail. Record kinds:

```jsonc
// runtime-emitted: one flow execution (loud failures carry the step + cause)
{"ts":"2026-08-02T03:10:00Z","flow":"weekly_gather","kind":"run","ok":true,"ms":4521}
{"ts":"…","flow":"weekly_gather","kind":"run","ok":false,"ms":810,"error":"step 'sweep': …"}

// consumer-emitted: an editorial staleness observation. `lenses` names the
// thin parts of the output so persistence is detectable across runs.
{"ts":"…","flow":"weekly_gather","kind":"signal","source":"gap_check","lenses":["china","edge"]}

// harness-emitted: a shadow-replay comparison against the specialist path
{"ts":"…","flow":"weekly_gather","kind":"shadow","ok":false,"note":"digest diverged on facet 2"}
```

`--status` computes per-flow health from the log and prints advisory
**nominations** — it never mutates the registry: 3+ consecutive failed runs →
needs review; the same lens present in each of the last 3 signals from one
source → recompile candidate; a failed latest shadow record → needs review.
The rationale: loud runtime failure and schema-drift refusal catch shape rot
for free; consumer-side signals catch **stale-but-well-formed** output at zero
marginal cost; shadow replay is the paid tier above both.

## Reserved for future versions

- `format` field (introduced only on the first breaking change)
- Flow-level effect declarations beyond the computed annotations
- A shadow-replay harness emitting `shadow` records (the contract above)
