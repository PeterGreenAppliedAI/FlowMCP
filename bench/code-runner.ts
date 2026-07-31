// Code-mode sandbox runner. Executed as a DISPOSABLE CHILD PROCESS per attempt —
// the process boundary is the isolation mechanism (node:vm is explicitly not a
// security boundary per Node docs). The parent launches this with: a minimal
// environment (no inherited secrets), SANDBOX_DIR pointing at an empty temp
// directory (we chdir there before touching model code), a hard wall-clock
// timeout with process-tree kill, and capped output. The only capability
// exposed to the generated script is the mocked tool bridge below, with an
// API-call budget.
import { readFileSync } from 'node:fs';
import { executePrimitiveTool, PRIMITIVE_TOOLS } from './primitive-tools.js';

const API_CALL_LIMIT = 30;

const scriptPath = process.argv[2];
if (!scriptPath) {
  console.error('SCRIPT_ERROR: no script path');
  process.exit(1);
}
const code = readFileSync(scriptPath, 'utf8');

if (process.env.SANDBOX_DIR) process.chdir(process.env.SANDBOX_DIR);

let apiCalls = 0;
const tools: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {};
for (const t of PRIMITIVE_TOOLS) {
  tools[t.function.name] = async (args = {}) => {
    if (++apiCalls > API_CALL_LIMIT) throw new Error(`API call limit (${API_CALL_LIMIT}) exceeded`);
    return JSON.parse(executePrimitiveTool(t.function.name, args));
  };
}

(async () => {
  // new Function inside the disposable child — the process is the boundary.
  const factory = new Function(`${code}\n;return typeof main === 'function' ? main : null;`);
  const main = factory() as null | ((t: typeof tools) => Promise<unknown>);
  if (!main) {
    console.error('SCRIPT_ERROR: script did not define async function main(tools)');
    process.exit(1);
  }
  const result = await main(tools);
  console.log('<<<RESULT>>>' + JSON.stringify({ result: String(result), apiCalls }));
  process.exit(0);
})().catch((e: unknown) => {
  console.error('SCRIPT_ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
