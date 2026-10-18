// The trace→flow compiler's argument classification (src/compile.ts). Variant
// 1 replays every recorded result through the runner's mutate(): each string
// of 3+ characters changes, numbers and short strings do not. A string arg
// that is identical across variants therefore cannot have come from a prior
// result, even when some result happens to contain the same value.
//
// Regression for the 2026-10-18 `flowmcp author` run on GitHub REST: the script
// passed owner="modelcontextprotocol" as a literal to repos_get and pulls_list;
// pulls_list's argument matched repos_get's owner.login by value, so the
// compiler took it for a ref and refused ("unstable ref for pulls_list.owner").
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';

type Entry = { seq: number; name: string; args: Record<string, unknown>; result: unknown };
const run = (variant: number, trace: Entry[], result = 'done') => ({ variant, result, trace }) as never;

describe('compile: argument classification across variants', () => {
  it('a literal string equal to a prior result value is an input, not a ref', () => {
    const repo0 = { owner: { login: 'acme' }, full_name: 'acme/widgets', description: 'Widget lib' };
    const repo1 = { owner: { login: 'ALT acme' }, full_name: 'ALT acme/widgets', description: 'ALT Widget lib' };
    const t = (repo: unknown, pulls: unknown): Entry[] => [
      { seq: 0, name: 'repos_get', args: { owner: 'acme', repo: 'widgets' }, result: repo },
      { seq: 1, name: 'pulls_list', args: { owner: 'acme', repo: 'widgets', state: 'open' }, result: pulls },
    ];
    const { flow } = compile(
      run(0, t(repo0, [{ title: 'Fix it' }]), 'Widget lib — PR: Fix it'),
      run(1, t(repo1, [{ title: 'ALT Fix it' }]), 'ALT Widget lib — PR: ALT Fix it'),
      'repo_health', 'test',
      { server: 'github', inputHints: { owner: ['acme'], repo: ['widgets'] } },
    );
    expect(flow).not.toMatch(/steps\.n0\.owner/);
    expect(flow.match(/\{\{input\.owner\}\}/g)?.length).toBe(2);
    expect(flow.match(/\{\{input\.repo\}\}/g)?.length).toBe(2);
  });

  it('a string that follows the mutated data is still a ref', () => {
    const t = (name: string): Entry[] => [
      { seq: 0, name: 'search', args: { q: 'widgets' }, result: { items: [{ name }] } },
      { seq: 1, name: 'repos_get', args: { repo: name }, result: { description: `${name} lib` } },
    ];
    const { flow } = compile(run(0, t('widget-core'), 'widget-core lib'), run(1, t('ALT widget-core'), 'ALT widget-core lib'), 'f', 'test',
      { server: 'github', inputHints: { q: ['widgets'] } });
    expect(flow).toContain('{{steps.n0.items[0].name}}');
  });

  // Regression, same run: a release's published_at and updated_at held the
  // same timestamp; the script printed published_at, the flow read updated_at.
  // Variant 1 now tags each path apart (author-runner mutate), so it decides.
  it('two fields with the same value: the output ref follows the one variant 1 shows', () => {
    const ts = '2026-10-05T11:54:56Z';
    const rel = (v: number) => v
      ? { tag_name: 'ALTa1 v1.2.0', updated_at: `ALTb2 ${ts}`, published_at: `ALTc3 ${ts}` }
      : { tag_name: 'v1.2.0', updated_at: ts, published_at: ts };
    const t = (v: number): Entry[] => [{ seq: 0, name: 'latest_release', args: { repo: 'widgets' }, result: rel(v) }];
    const out = (v: number) => `Release ${rel(v).tag_name} on ${rel(v).published_at}`;
    const { flow } = compile(run(0, t(0), out(0)), run(1, t(1), out(1)), 'f', 'test',
      { server: 'github', inputHints: { repo: ['widgets'] } });
    expect(flow).toContain('{{steps.n0.published_at}}');
    expect(flow).not.toContain('updated_at');
  });

  it('two fields with the same value: the argument ref follows the one variant 1 shows', () => {
    const pr = (v: number) => v ? { head: 'ALTd4 feat-x', branch_hint: 'ALTe5 feat-x' } : { head: 'feat-x', branch_hint: 'feat-x' };
    const t = (v: number): Entry[] => [
      { seq: 0, name: 'pulls_get', args: { number: 7 }, result: pr(v) },
      { seq: 1, name: 'branches_get', args: { branch: pr(v).branch_hint }, result: { sha: v ? 'ALTf6 abc123' : 'abc123' } },
    ];
    const { flow } = compile(run(0, t(0), 'abc123'), run(1, t(1), 'ALTf6 abc123'), 'f', 'test', { server: 'github', inputHints: {} });
    expect(flow).toContain("branch: '{{steps.n0.branch_hint}}'");
  });

  // Regression, same flow live: five PR objects (~100K) went past the default
  // 8K cap and reached the map step as text.
  it('raises maxResultChars on a call whose recorded result is large; small ones keep the default', () => {
    const pulls = (v: number) => Array.from({ length: 5 }, (_, i) => ({ title: `${v ? 'ALTg7 ' : ''}PR ${i}`, body: 'x'.repeat(4_000) }));
    const t = (v: number): Entry[] => [
      { seq: 0, name: 'repos_get', args: { repo: 'widgets' }, result: { description: v ? 'ALTh8 Widget lib' : 'Widget lib' } },
      { seq: 1, name: 'pulls_list', args: { repo: 'widgets' }, result: pulls(v) },
    ];
    const out = (v: number) => `${v ? 'ALTh8 ' : ''}Widget lib\n` + pulls(v).map((p) => `- ${p.title}`).join('\n');
    const { flow } = compile(run(0, t(0), out(0)), run(1, t(1), out(1)), 'f', 'test', { server: 'github', inputHints: { repo: ['widgets'] } });
    expect(flow).toMatch(/tool: 'pulls_list'.*maxResultChars: 500000/);
    expect(flow).not.toMatch(/tool: 'repos_get'.*maxResultChars/);
  });

  it('a number unchanged by mutation keeps its ref (ids are not rewritten)', () => {
    const t = (v: number): Entry[] => [
      { seq: 0, name: 'issues_list', args: { q: 'bug' }, result: [{ number: 4217 }] },
      { seq: 1, name: 'issues_get', args: { issue_number: 4217 }, result: { title: v ? 'ALT Crash' : 'Crash' } },
    ];
    const { flow } = compile(run(0, t(0), 'Crash'), run(1, t(1), 'ALT Crash'), 'f', 'test', { server: 'github', inputHints: { q: ['bug'] } });
    expect(flow).toMatch(/\{\{steps\.n0\.\[0\]\.number\}\}/);
  });
});
