import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import JSON5 from 'json5';
import { flowSchema, type Flow, type LeafStep, type Step } from './flow-schema.js';
import { serversSchema, type ServerConfig } from './mcp-pool.js';

export async function loadFlows(dir: string): Promise<Flow[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.flow.json5')).sort();
  } catch {
    throw new Error(`flows directory not found: ${dir}`);
  }
  if (files.length === 0) throw new Error(`no *.flow.json5 files in ${dir}`);

  const flows: Flow[] = [];
  const names = new Set<string>();
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    let raw: unknown;
    try {
      raw = JSON5.parse(text);
    } catch (e) {
      throw new Error(`${file}: invalid JSON5 — ${e instanceof Error ? e.message : e}`);
    }
    const parsed = flowSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      throw new Error(`${file}: invalid flow\n${issues}`);
    }
    const flow = parsed.data;
    if (names.has(flow.name)) throw new Error(`${file}: duplicate flow name '${flow.name}'`);
    names.add(flow.name);
    checkStepIds(file, flow);
    flows.push(flow);
  }
  return flows;
}

// Visit every step in a flow; `named` is false for a map's inner (id-less) step.
function walkSteps(flow: Flow, visit: (step: Step | LeafStep, named: boolean) => void): void {
  const walk = (steps: Step[]) => {
    for (const step of steps) {
      visit(step, true);
      if (step.kind === 'map') visit(step.step, false);
      if (step.kind === 'branch') {
        walk(step.then as Step[]);
        if (step.else) walk(step.else as Step[]);
      }
    }
  };
  walk(flow.steps);
}

function checkStepIds(file: string, flow: Flow): void {
  const ids = new Set<string>();
  walkSteps(flow, (step, named) => {
    if (!named) return;
    const id = (step as Step).id;
    if (ids.has(id)) throw new Error(`${file}: duplicate step id '${id}' in flow '${flow.name}'`);
    ids.add(id);
  });
}

// servers.json5 lives next to the flow files; absent file = no downstream servers.
export async function loadServers(dir: string): Promise<Record<string, ServerConfig>> {
  let text: string;
  try {
    text = await readFile(join(dir, 'servers.json5'), 'utf8');
  } catch {
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON5.parse(text);
  } catch (e) {
    throw new Error(`servers.json5: invalid JSON5 — ${e instanceof Error ? e.message : e}`);
  }
  const parsed = serversSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`servers.json5: invalid\n${issues}`);
  }
  return parsed.data;
}

export interface FlowEffects {
  readOnly: boolean;
  openWorld: boolean;
}

// A flow's write capability is statically knowable: only a POST http_request or
// an mcp_call to an allowlisted (i.e. non-read-only) downstream tool can write.
// Everything else the engine can execute is read-only by construction.
export function flowEffects(flow: Flow, servers: Record<string, ServerConfig>): FlowEffects {
  let write = false;
  let openWorld = false;
  walkSteps(flow, (step) => {
    if (step.kind === 'http_request') {
      openWorld = true;
      if (step.method === 'POST') write = true;
    }
    if (step.kind === 'mcp_call') {
      openWorld = true;
      if (servers[step.server]?.allow.includes(step.tool)) write = true;
    }
  });
  return { readOnly: !write, openWorld };
}

function subtreeHasWrite(step: Step | LeafStep, servers: Record<string, ServerConfig>): boolean {
  if (step.kind === 'http_request') return step.method === 'POST';
  if (step.kind === 'mcp_call') return servers[step.server]?.allow.includes(step.tool) ?? false;
  if (step.kind === 'map') return subtreeHasWrite(step.step, servers);
  if (step.kind === 'branch') {
    return [...step.then, ...(step.else ?? [])].some((s) => subtreeHasWrite(s, servers));
  }
  return false;
}

// Top-level steps that perform (or contain) a write — where the approval gate
// pauses execution. Computed, never declared.
export function topLevelWriteStepIds(flow: Flow, servers: Record<string, ServerConfig>): Set<string> {
  return new Set(flow.steps.filter((s) => subtreeHasWrite(s, servers)).map((s) => s.id));
}

export function checkServerRefs(flows: Flow[], serverNames: Set<string>): void {
  for (const flow of flows) {
    walkSteps(flow, (step) => {
      if (step.kind === 'mcp_call' && !serverNames.has(step.server)) {
        throw new Error(
          `flow '${flow.name}' calls unknown MCP server '${step.server}' — add it to servers.json5`,
        );
      }
    });
  }
}
