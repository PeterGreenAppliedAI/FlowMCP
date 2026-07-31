import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flowEffects, loadFlows } from '../src/loader.js';
import { flowSchema } from '../src/flow-schema.js';
import { serversSchema } from '../src/mcp-pool.js';
import { projectRoot } from './helpers.js';

async function flowDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'flowmcp-test-'));
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(dir, name), text);
  }
  return dir;
}

const validFlow = (name: string) => `{
  name: '${name}',
  description: 'WHEN TO USE: test.',
  input: {},
  steps: [{ id: 'out', kind: 'template', template: 'hi' }],
  output: '{{steps.out}}',
}`;

describe('loadFlows', () => {
  it('loads the shipped flows', async () => {
    const flows = await loadFlows(join(projectRoot, 'flows'));
    expect(flows.map((f) => f.name)).toEqual(['hn_top', 'morning_brief']);
  });

  it('rejects an invalid flow, naming file and field', async () => {
    const dir = await flowDir({ 'bad.flow.json5': `{ name: 'bad', steps: [] }` });
    await expect(loadFlows(dir)).rejects.toThrow(/bad\.flow\.json5/);
    await expect(loadFlows(dir)).rejects.toThrow(/description/);
  });

  it('rejects malformed JSON5', async () => {
    const dir = await flowDir({ 'oops.flow.json5': `{ name: ` });
    await expect(loadFlows(dir)).rejects.toThrow(/oops\.flow\.json5: invalid JSON5/);
  });

  it('rejects duplicate flow names across files', async () => {
    const dir = await flowDir({
      'a.flow.json5': validFlow('same'),
      'b.flow.json5': validFlow('same'),
    });
    await expect(loadFlows(dir)).rejects.toThrow(/duplicate flow name 'same'/);
  });

  it('rejects duplicate step ids inside a flow', async () => {
    const dir = await flowDir({
      'dup.flow.json5': `{
        name: 'dup',
        description: 'WHEN TO USE: test.',
        input: {},
        steps: [
          { id: 'x', kind: 'template', template: 'a' },
          { id: 'x', kind: 'template', template: 'b' },
        ],
        output: '{{steps.x}}',
      }`,
    });
    await expect(loadFlows(dir)).rejects.toThrow(/duplicate step id 'x'/);
  });

  it('rejects a default whose type contradicts the declared type', async () => {
    const dir = await flowDir({
      'mismatch.flow.json5': `{
        name: 'mismatch',
        description: 'WHEN TO USE: test.',
        input: { n: { type: 'string', description: 'n', default: 42 } },
        steps: [{ id: 'out', kind: 'template', template: '{{input.n}}' }],
        output: '{{steps.out}}',
      }`,
    });
    await expect(loadFlows(dir)).rejects.toThrow(/default value must match the declared type/);
  });

  it('rejects a missing directory', async () => {
    await expect(loadFlows('/nonexistent/flows')).rejects.toThrow(/not found/);
  });
});

describe('flowEffects', () => {
  const servers = serversSchema.parse({ m: { command: 'x', allow: ['write_it'] } });
  const base = {
    name: 'fx',
    description: 'WHEN TO USE: test.',
    input: {},
    output: '{{steps.s}}',
  };

  it('marks GET-only and template flows read-only; template-only is closed-world', () => {
    const httpFlow = flowSchema.parse({
      ...base,
      steps: [{ id: 's', kind: 'http_request', url: 'http://x' }],
    });
    expect(flowEffects(httpFlow, servers)).toEqual({ readOnly: true, openWorld: true });
    const templateFlow = flowSchema.parse({
      ...base,
      steps: [{ id: 's', kind: 'template', template: 'hi' }],
    });
    expect(flowEffects(templateFlow, servers)).toEqual({ readOnly: true, openWorld: false });
  });

  it('marks POST and allowlisted mcp_call flows write-capable', () => {
    const postFlow = flowSchema.parse({
      ...base,
      steps: [{ id: 's', kind: 'http_request', method: 'POST', url: 'http://x' }],
    });
    expect(flowEffects(postFlow, servers).readOnly).toBe(false);
    const writeCall = flowSchema.parse({
      ...base,
      steps: [{ id: 's', kind: 'mcp_call', server: 'm', tool: 'write_it' }],
    });
    expect(flowEffects(writeCall, servers).readOnly).toBe(false);
    const readCall = flowSchema.parse({
      ...base,
      steps: [{ id: 's', kind: 'mcp_call', server: 'm', tool: 'read_it' }],
    });
    expect(flowEffects(readCall, servers).readOnly).toBe(true);
  });
});
