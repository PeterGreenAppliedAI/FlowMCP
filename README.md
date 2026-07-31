# FlowMCP

Most MCP servers wrap an entire platform: every endpoint becomes a tool, the model gets a 40-tool surface, and orchestration is outsourced to sampling — then everyone blames the model. FlowMCP inverts that: **workflows are the tools.** Each MCP tool is one known, named workflow; a deterministic engine executes the steps; the model's only job is picking the flow and filling 2–3 parameters. Small models (7–30B) can drive this reliably, because there is almost nothing to get wrong.

## Quickstart (60 seconds)

```sh
git clone https://github.com/PeterGreenAppliedAI/FlowMCP.git && cd FlowMCP
npm install
npm test          # hermetic — no network needed
npm start         # serves MCP over stdio
```

Point any MCP client at it. Claude Desktop / Claude Code / anything MCP:

```json
{
  "mcpServers": {
    "flowmcp": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/flowmcp/src/server.ts"]
    }
  }
}
```

Your client will list **two** tools — `morning_brief` and `hn_top` — not forty. Both run against keyless public APIs (Open-Meteo, Hacker News), so they work on a fresh clone with zero configuration.

```
> morning_brief city="Lisbon"

# Morning brief — Lisbon, Portugal

## Weather today
High 29.4°C / low 19.3°C, 0% chance of rain.

## Top of Hacker News
- **…** — 330 points https://…
```

## Flow file format

Flows are data, not code. The server loads every `flows/*.flow.json5` at startup and exposes each as one MCP tool. An invalid flow is a loud startup error naming the file and field.

```json5
{
  name: 'morning_brief',          // becomes the MCP tool name (snake_case)
  description: 'WHEN TO USE: …',  // ≤300 chars — this is the model's entire manual
  input: {                        // 0–3 parameters, no more
    city: { type: 'string', description: 'City for the weather', required: false, default: 'New York' },
  },
  steps: [ /* run in order; each result is available as steps.<id> */ ],
  output: '{{steps.render}}',     // the tool's text result
}
```

### Step kinds

| kind | fields | what it does |
|------|--------|--------------|
| `http_request` | `method` (GET/POST), `url`, `headers?`, `body?`, `timeoutMs?` (default 15000) | Fetch a URL; JSON responses are parsed. One automatic retry on network error. |
| `transform` | `expr` | Reshape prior results with a sandboxed expression — paths, object/array literals, comparisons. No code execution. |
| `template` | `template` | Mustache-style string build: `{{steps.x.y[0]}}`. Arrays join line-per-item; missing terminal values render as `''`. |
| `map` | `over`, `as?` (default `item`), `step` | Run one leaf step per array element, sequentially, **max 10 items** — slice with `steps.ids[0:5]`. |
| `branch` | `if`, `then`, `else?` | Evaluate a condition, run one of two step lists. No nested branches. |

Everything downstream of a step sees `input.*`, `env.*` (for `{{env.API_KEY}}` — never put secrets in flow files), and `steps.<id>`. A failed step aborts the flow and returns a structured `isError` result naming the step. Whole-flow timeout: 60s.

### Writing your own flow

Drop a file in a flows directory, restart the server — that's the whole workflow. The server reads `flows/` in the repo by default; point it anywhere with `--flows` (or the `FLOWMCP_FLOWS_DIR` env var), which is how you keep private flows out of a public checkout:

```sh
npm start -- --flows ~/my-flows
```

```json5
// flows/cat_fact.flow.json5
{
  name: 'cat_fact',
  description: 'WHEN TO USE: the user wants a random cat fact.',
  input: {},
  steps: [
    { id: 'fact', kind: 'http_request', url: 'https://catfact.ninja/fact' },
    { id: 'render', kind: 'template', template: 'Cat fact: {{steps.fact.fact}}' },
  ],
  output: '{{steps.render}}',
}
```

## Design constraints (on purpose)

- **Hand-rolled protocol**, ~150 lines: `initialize`, `tools/list`, `tools/call`, `ping` over newline-delimited JSON-RPC on stdio. No MCP SDK — the server is small enough to audit in one sitting.
- **Dependencies:** `zod` and `json5`. That's it.
- **Small surfaces everywhere:** few tools, ≤300-char descriptions, ≤3 params. Every token in `tools/list` is budget spent by every client on every turn.
- **v1 flows are read-only by doctrine.** Write actions need approval machinery; that's v2.
- stdout is the protocol channel; all logging goes to stderr.

## Roadmap (deliberately not in v1)

- Write-action flows with approval/confirm steps
- Flows that call **other MCP servers** as steps — composition
- HTTP transport for the server itself
- Flow hot-reload

## Development

```sh
npm test            # vitest: spawns the real server, speaks JSON-RPC, mocks only outbound HTTP
npm run typecheck   # strict TS, no emit
npm run build       # emits dist/ — the `flowmcp` bin entry points there
```

CI runs typecheck + tests on Node 20 and 22 for every push. Engineering log — what worked, what didn't, what the fix was — lives in [DECISIONS.md](DECISIONS.md).

MIT license.
