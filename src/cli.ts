#!/usr/bin/env node
// The `flowmcp` CLI — one entry point for the whole loop:
//
//   flowmcp serve    [--flows <dir>]        serve flows as MCP tools over stdio (default)
//   flowmcp validate [--flows <dir>]        check flows + servers + registry, exit 0/1
//   flowmcp status   [--flows <dir>]        registry health + nominations
//   flowmcp explain  [--flows <dir>]        print a routing preamble for LLM hosts
//   flowmcp author   --servers-dir <dir> …  model-authored flow from an intent (see --help)
//   flowmcp compile  <run.v0.json> …        compile a recorded trace into a flow
//   flowmcp detect   <executions.jsonl> …   nominate flows from execution logs
//
// Legacy flag style (`flowmcp --flows x --validate`) still works: no
// subcommand means serve, and serve reads the same flags it always did.

const USAGE = `flowmcp — workflows are the tools

  flowmcp serve    [--flows <dir>]           serve flows as MCP tools over stdio (default)
  flowmcp validate [--flows <dir>]           check flows + servers.json5 + registry.json5, exit 0/1
  flowmcp status   [--flows <dir>]           registry health and advisory nominations
  flowmcp explain  [--flows <dir>]           print a routing preamble for LLM hosts
  flowmcp author   --servers-dir <dir> --name <flow> --model <id> [--gateway <url>] "<intent>"
                                             author a flow with a model, under observation
  flowmcp compile  <run.v0.json> [outDir] [flowName] [serverName]
                                             compile a recorded trace into a candidate flow
  flowmcp detect   <executions.jsonl> [--min-runs N] [--min-success R] [--min-tokens N]
                                             nominate recurring procedures from execution logs
  flowmcp shadow   <flow> --flows <dir> --agent '<cmd>' [--judge '<cmd>']
                                             shadow-verify a flow against a host-supplied agent

Flow directory: --flows, or FLOWMCP_FLOWS_DIR, or ./flows.
Format spec: FORMAT.md · https://github.com/PeterGreenAppliedAI/FlowMCP
`;

const sub = process.argv[2];

async function main(): Promise<void> {
  switch (sub) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return;
    case 'validate':
    case 'status':
    case 'explain':
      process.argv.splice(2, 1, `--${sub}`);
      await import('./server.js');
      return;
    case 'serve':
      process.argv.splice(2, 1);
      await import('./server.js');
      return;
    case 'author':
      process.argv.splice(2, 1);
      await (await import('./author.js')).authorCli();
      return;
    case 'compile':
      process.argv.splice(2, 1);
      (await import('./compile.js')).compileCli();
      return;
    case 'detect':
      process.argv.splice(2, 1);
      (await import('./detect.js')).detectCli();
      return;
    case 'shadow':
      process.argv.splice(2, 1);
      await (await import('./shadow.js')).shadowCli();
      return;
    default:
      if (sub !== undefined && !sub.startsWith('--')) {
        process.stderr.write(`flowmcp: unknown command '${sub}'\n\n${USAGE}`);
        process.exit(1);
      }
      // no subcommand (bare or legacy flags) → serve
      await import('./server.js');
  }
}

main().catch((e) => {
  process.stderr.write(`flowmcp: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
