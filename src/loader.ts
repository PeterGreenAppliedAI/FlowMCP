import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import JSON5 from 'json5';
import { flowSchema, type Flow, type Step } from './flow-schema.js';

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

function checkStepIds(file: string, flow: Flow): void {
  const ids = new Set<string>();
  const add = (id: string) => {
    if (ids.has(id)) throw new Error(`${file}: duplicate step id '${id}' in flow '${flow.name}'`);
    ids.add(id);
  };
  const walk = (steps: Step[]) => {
    for (const step of steps) {
      add(step.id);
      if (step.kind === 'branch') {
        walk(step.then as Step[]);
        if (step.else) walk(step.else as Step[]);
      }
    }
  };
  walk(flow.steps);
}
