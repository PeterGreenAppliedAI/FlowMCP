// compilePaths (src/compile.ts): one recording per input set; a call that is
// "not found" for one set becomes an `absent` step with a branch, and the flow
// must reproduce what the script printed for every set and both variants.
//
// Phase 2 of `absent`: the authored repo_health flow only got its absent step
// and "No published release" branch by hand, because `author` recorded one
// input and never saw the 404. Each test drives a small script against fake
// tools, the way author-runner records and replays.
import { describe, expect, it } from 'vitest';
import JSON5 from 'json5';
import { compilePaths, type Path } from '../src/compile.js';
import { executeFlow } from '../src/engine.js';
import { flowSchema } from '../src/flow-schema.js';
import { HTTP_STATUS } from '../src/downstream.js';

type CallError = { kind: 'status' | 'isError' | 'thrown'; status?: number; text: string };
type Entry = { seq: number; name: string; args: Record<string, unknown>; result: unknown; error?: CallError };
type Tools = Record<string, (args: Record<string, unknown>) => Promise<any>>;
type Script = (tools: Tools, input: Record<string, string>) => Promise<string>;
type Data = Record<string, (args: Record<string, unknown>) => unknown | CallError>;

// variant 1 as the runner makes it: strings of 3+ chars change, tagged by path
const mutate = (v: unknown, at: string): unknown =>
  typeof v === 'string' ? (v.length >= 3 ? `ALT${at.length.toString(36)} ${v}` : v)
    : Array.isArray(v) ? v.map((x, i) => mutate(x, `${at}.${i}`))
      : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mutate(x, `${at}.${k}`)])) : v;
const isError = (v: unknown): v is CallError => v !== null && typeof v === 'object' && 'kind' in v && 'text' in v;

async function record(script: Script, data: Data, input: Record<string, string>, variant: 0 | 1) {
  const trace: Entry[] = [];
  const tools: Tools = Object.fromEntries(Object.entries(data).map(([name, fn]) => [name, async (args: Record<string, unknown>) => {
    const out = fn(args);
    const seq = trace.length;
    if (isError(out)) {
      trace.push({ seq, name, args, result: null, error: out });
      throw new Error(`${name} error: ${out.text}`);
    }
    const result = variant ? mutate(out, name) : out;
    trace.push({ seq, name, args, result });
    return result;
  }]));
  return { variant, result: await script(tools, input), trace } as never;
}
const paths = async (script: Script, data: Data, inputs: Array<Record<string, string>>): Promise<Path[]> =>
  Promise.all(inputs.map(async (input) => ({ input, v0: await record(script, data, input, 0), v1: await record(script, data, input, 1) })));

const notFound: CallError = { kind: 'status', status: 404, text: 'HTTP 404: Not Found' };
const repos: Record<string, { stars: number; tag?: string }> = { widgets: { stars: 10, tag: 'v1.2.3' }, gadgets: { stars: 77 } };
const data = (release: (repo: string) => unknown | CallError = (r) => (repos[r]!.tag ? { tag_name: repos[r]!.tag } : notFound)): Data => ({
  repos_get: (a) => ({ full_name: `acme/${a.repo}`, stargazers_count: repos[String(a.repo)]!.stars }),
  release: (a) => release(String(a.repo)),
});
const health: Script = async (tools, input) => {
  const repo = await tools.repos_get!({ owner: 'acme', repo: input.repo });
  let rel = '';
  try {
    rel = `- Tag: ${(await tools.release!({ owner: 'acme', repo: input.repo })).tag_name}`;
  } catch {
    rel = '- No published release';
  }
  return `# ${repo.full_name}\n- Stars: ${repo.stargazers_count}\n\n## Latest release\n${rel}\n\n## End`;
};
const opts = { server: 'github', inputHints: { repo: ['widgets', 'gadgets'] }, description: 'WHEN TO USE: repo health.' };
const both = [{ repo: 'widgets' }, { repo: 'gadgets' }];

describe('compilePaths: a "not found" seen for one input becomes absent + branch', () => {
  it('emits absent: [404] and a branch, and the flow prints what the script did for both repos', async () => {
    const { flow, provenance } = await compilePaths(await paths(health, data(), both), 'repo_health', 'test', opts);
    expect(flow).toContain("tool: 'release', args: { owner: 'acme', repo: '{{input.repo}}' }, absent: [404] }");
    expect(flow).toContain("if: 'steps.n1 == null'");
    expect(flow).toContain('"- No published release"');
    expect(provenance.absent).toEqual([{ step: 'n1', tool: 'release', absent: [404], input: { repo: 'gadgets' } }]);
    // and live, through the engine's own absent handling
    const parsed = flowSchema.parse(JSON5.parse(flow));
    const pool = { has: () => true, call: async (_s: string, tool: string, a: Record<string, unknown>) => {
      if (tool === 'release') return { isError: true, content: [{ type: 'text', text: 'nf' }], [HTTP_STATUS]: 404 };
      return { content: [], structuredContent: { full_name: `acme/${a.repo}`, stargazers_count: 5 } };
    } };
    const run = await executeFlow(parsed, { repo: 'nothing' }, { mcp: pool as never });
    expect(run).toEqual({ status: 'complete', absent: ['n1'],
      text: '# acme/nothing\n- Stars: 5\n\n## Latest release\n- No published release\n\n## End' });
  });

  it('order does not matter: the run with every result is the base', async () => {
    const { flow } = await compilePaths(await paths(health, data(), [...both].reverse()), 'repo_health', 'test', opts);
    expect(flow).toContain('absent: [404]');
  });

  it('one input set compiles as before: no absent, no branch', async () => {
    const { flow, provenance } = await compilePaths(await paths(health, data(), [both[0]!]), 'repo_health', 'test', opts);
    expect(flow).not.toContain('absent');
    expect(flow).not.toContain('branch');
    expect(provenance.absent).toEqual([]);
  });

  it("an MCP tool error with no status becomes 'any-error'", async () => {
    const soft = data((r) => (repos[r]!.tag ? { tag_name: repos[r]!.tag } : { kind: 'isError', text: 'no release' }));
    const { flow } = await compilePaths(await paths(health, soft, both), 'repo_health', 'test', opts);
    expect(flow).toContain('absent: "any-error"');
  });
});

describe('compilePaths: refuses what it cannot prove', () => {
  const refuses = async (script: Script, d: Data, re: RegExp, inputs = both) =>
    expect(compilePaths(await paths(script, d, inputs), 'f', 'test', opts)).rejects.toThrow(re);

  it('an outage or an auth failure is never compiled as absent', async () => {
    await refuses(health, data((r) => (repos[r]!.tag ? { tag_name: repos[r]!.tag } : { kind: 'status', status: 500, text: 'down' })), /HTTP 500.*only a "not found"/);
    await refuses(health, data((r) => (repos[r]!.tag ? { tag_name: repos[r]!.tag } : { kind: 'status', status: 401, text: 'bad creds' })), /HTTP 401/);
    await refuses(health, data((r) => (repos[r]!.tag ? { tag_name: repos[r]!.tag } : { kind: 'thrown', text: 'ECONNRESET' })), /thrown/);
  });

  it('needs one input set where every call succeeded', async () => {
    await refuses(health, data(() => notFound), /no input set ran without a failed call/);
  });

  it('refuses when a later call reads the absent result', async () => {
    const chained: Script = async (tools, input) => {
      const repo = await tools.repos_get!({ owner: 'acme', repo: input.repo });
      try {
        const rel = await tools.release!({ owner: 'acme', repo: input.repo });
        const notes = await tools.notes!({ tag: rel.tag_name });
        return `# ${repo.full_name}\n${notes.body}`;
      } catch {
        return `# ${repo.full_name}\nnone`;
      }
    };
    await refuses(chained, { ...data(), notes: (a) => ({ body: `notes for ${a.tag}` }) }, /later steps read its result/);
  });

  it('refuses a fallback that prints other tool data', async () => {
    const leaky: Script = async (tools, input) => {
      const repo = await tools.repos_get!({ owner: 'acme', repo: input.repo });
      let rel;
      try { rel = `- Tag: ${(await tools.release!({ owner: 'acme', repo: input.repo })).tag_name}`; } catch { rel = `- No release for ${repo.full_name}`; }
      return `# ${repo.full_name}\n${rel}\n\n## End`;
    };
    await refuses(leaky, data(), /depends on other tool data/);
    // a number survives variant 1 unchanged, so it is caught by value
    const counted: Script = async (tools, input) => {
      const repo = await tools.repos_get!({ owner: 'acme', repo: input.repo });
      let rel;
      try { rel = `- Tag: ${(await tools.release!({ owner: 'acme', repo: input.repo })).tag_name}`; } catch { rel = `- No release (${repo.stargazers_count} stars)`; }
      return `# ${repo.full_name}\n${rel}\n\n## End`;
    };
    await refuses(counted, data(), /depends on other tool data \(77\)/);
  });

  it('refuses when the other run prints something the flow would not', async () => {
    const extra: Script = async (tools, input) => {
      const out = await health(tools, input);
      return input.repo === 'gadgets' ? `${out}\n(archived)` : out;
    };
    await refuses(extra, data(), /differs from what the script printed|fallback/);
  });
});
