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
  env: ['WEATHER_API_KEY'],       // ONLY these env vars are visible to {{env.X}} — least privilege
  steps: [ /* run in order; each result is available as steps.<id> */ ],
  output: '{{steps.render}}',     // the tool's text result
}
```

Check a directory without serving: `npm start -- --flows ./my-flows --validate` exits 0 if every flow is valid, 1 with the file and field otherwise.

### Step kinds

| kind | fields | what it does |
|------|--------|--------------|
| `http_request` | `method` (GET/POST), `url`, `headers?`, `body?`, `timeoutMs?` (default 15000) | Fetch a URL; JSON responses are parsed. One automatic retry on network error — **GET only**: a timed-out POST may have landed, so it is never retried. |
| `transform` | `expr` | Reshape prior results with a sandboxed expression — paths, object/array literals, comparisons. No code execution. |
| `template` | `template` | Mustache-style string build: `{{steps.x.y[0]}}`. Arrays join line-per-item; missing terminal values render as `''`. |
| `map` | `over`, `as?` (default `item`), `step` | Run one leaf step per array element, sequentially, **max 10 items** — slice with `steps.ids[0:5]`. |
| `branch` | `if`, `then`, `else?` | Evaluate a condition, run one of two step lists. No nested branches. |
| `mcp_call` | `server`, `tool`, `args?`, `timeoutMs?` (default 30000), `maxResultChars?` (default 8000) | Call one tool on a downstream MCP server from `servers.json5`. See Composition below. |

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

## Composition: wrapping other MCP servers

Flows can call tools on *other* MCP servers — and this is where the thesis becomes an operation instead of an opinion. Register downstream servers in a `servers.json5` next to your flow files:

```json5
{
  github: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: '{{env.GITHUB_TOKEN}}' },  // interpolated — never inline secrets
    allow: [],                                       // non-read-only tools need explicit listing
  },
}
```

Then use an `mcp_call` step like any other:

```json5
{ id: 'issue', kind: 'mcp_call', server: 'github', tool: 'get_issue',
  args: { owner: 'x', repo: 'y', issue_number: '{{input.n}}' } }
```

The key property: the wrapped server's 40 tools **never appear in FlowMCP's `tools/list`**. 40 tools in, 3 workflows out — the model's surface never grows, no matter how many servers sit behind it.

Rules of engagement:

- **Read-only by default, fail-closed.** A downstream tool is callable only if it declares `annotations.readOnlyHint: true` — or you explicitly name it in that server's `allow` list. Naming a write tool is a consent moment, on purpose — and it changes what FlowMCP advertises: annotations are **computed per flow** from its steps, so a flow containing a POST or an allowlisted write tool is published with `readOnlyHint: false, destructiveHint: true`. FlowMCP never tells a client a write-capable flow is read-only.
- **Children get a minimal environment.** Downstream servers receive a baseline (`PATH`, `HOME`, …) plus the vars you configure in their `env` block — never the whole parent environment, unless you set `inheritEnv: true` for that server.
- **One session per child, not per flow.** Downstream servers spawn lazily on first use, stay alive across calls, respawn on crash (3 attempts, then a 5s backoff), and shut down after 5 minutes idle. The client handshakes at the newest supported protocol revision and validates what comes back.
- **The step timeout covers spawn + handshake + call** as one unit, bounded by the flow's 60s deadline — a slow cold-start can't invisibly eat the budget.
- **Results are capped** at `maxResultChars` (default 8K) — downstream verbosity is not your flow's problem to inherit. `structuredContent` is preferred when the downstream tool provides it; otherwise JSON text results are parsed so later steps can path into them.

## Trust model

Flow files are **trusted programs** — treat them like code, review them like code. The expression language can't execute code, but a flow can still send data to any URL it names; what bounds the blast radius is what the flow can *see*: only the env vars it declares in `env: [...]` (never all of `process.env`), only the 0–3 inputs it declares, and only downstream MCP tools that are read-only or explicitly allowlisted. `servers.json5` is operator configuration, same trust level as the server's own command line. Don't load flow files you haven't read.

## Design constraints (on purpose)

- **Hand-rolled protocol**, ~150 lines: `initialize`, `tools/list`, `tools/call`, `ping` over newline-delimited JSON-RPC on stdio. No MCP SDK — the server is small enough to audit in one sitting.
- **Dependencies:** `zod` and `json5`. That's it.
- **Small surfaces everywhere:** few tools, ≤300-char descriptions, ≤3 params. Every token in `tools/list` is budget spent by every client on every turn.
- **v1 flows are read-only by doctrine.** Write actions need approval machinery; that's v2.
- stdout is the protocol channel; all logging goes to stderr.

## Roadmap

- Write-action flows with approval/confirm steps
- A versioned FORMAT.md — the flow file as a portable, agent-agnostic contract
- MCP conformance matrix (Inspector-based CI against current protocol revisions)
- A benchmark: FlowMCP vs. a 30–40-tool primitive server across 7B/30B/frontier models — completion rate, argument accuracy, tokens, tool-call count
- Destination allowlists and HTTPS policy for `http_request`
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
