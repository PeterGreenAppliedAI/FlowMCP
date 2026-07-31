import { describe, expect, it } from 'vitest';
import { evalExpr, ExprError } from '../src/expr.js';
import { interpolate, interpolateUrl, stringify } from '../src/interpolate.js';
import { executeFlow, FlowError } from '../src/engine.js';
import { flowSchema, type Flow } from '../src/flow-schema.js';

const ctx = {
  input: { city: 'Berlin', n: 3 },
  steps: {
    geo: { results: [{ latitude: 52.5, longitude: 13.4 }] },
    ids: [1, 2, 3, 4, 5, 6],
    story: { title: 'Hello', score: 42 },
  },
  env: { KEY: 'secret' },
};

describe('evalExpr', () => {
  it('resolves nested paths and indexes', () => {
    expect(evalExpr('steps.geo.results[0].latitude', ctx)).toBe(52.5);
    expect(evalExpr('input.city', ctx)).toBe('Berlin');
    expect(evalExpr('env.KEY', ctx)).toBe('secret');
  });

  it('slices arrays with [a:b], [:b], [a:]', () => {
    expect(evalExpr('steps.ids[0:2]', ctx)).toEqual([1, 2]);
    expect(evalExpr('steps.ids[:3]', ctx)).toEqual([1, 2, 3]);
    expect(evalExpr('steps.ids[4:]', ctx)).toEqual([5, 6]);
  });

  it('builds object and array literals from paths', () => {
    expect(evalExpr('{ lat: steps.geo.results[0].latitude, city: input.city }', ctx)).toEqual({
      lat: 52.5,
      city: 'Berlin',
    });
    expect(evalExpr('[input.n, "x", true]', ctx)).toEqual([3, 'x', true]);
  });

  it('compares values', () => {
    expect(evalExpr('input.n > 2', ctx)).toBe(true);
    expect(evalExpr('input.city == "Berlin"', ctx)).toBe(true);
    expect(evalExpr('input.city != "Berlin"', ctx)).toBe(false);
  });

  it('yields undefined for a missing terminal property', () => {
    expect(evalExpr('steps.story.url', ctx)).toBeUndefined();
  });

  it('throws loudly when reading through undefined', () => {
    expect(() => evalExpr('steps.geo.results[9].latitude', ctx)).toThrow(ExprError);
    expect(() => evalExpr('steps.geo.results[9].latitude', ctx)).toThrow(/cannot read 'latitude'/);
  });

  it('rejects unknown roots, listing what is available', () => {
    expect(() => evalExpr('stpes.geo', ctx)).toThrow(/unknown name 'stpes'/);
  });

  it('rejects prototype escape hatches', () => {
    expect(() => evalExpr('input.constructor', ctx)).toThrow(/forbidden/);
    expect(() => evalExpr('input["__proto__"]', ctx)).toThrow(/forbidden/);
  });

  it('rejects function-call syntax outright', () => {
    expect(() => evalExpr('input.city.toUpperCase()', ctx)).toThrow(ExprError);
  });
});

describe('interpolate', () => {
  it('substitutes paths and stringifies', () => {
    expect(interpolate('{{input.city}} has {{input.n}}', ctx)).toBe('Berlin has 3');
  });

  it('renders missing terminals as empty string (mustache-style)', () => {
    expect(interpolate('url: {{steps.story.url}}!', ctx)).toBe('url: !');
  });

  it('joins arrays with newlines', () => {
    expect(interpolate('{{steps.ids[0:3]}}', ctx)).toBe('1\n2\n3');
  });

  it('stringifies objects as JSON', () => {
    expect(stringify({ a: 1 })).toBe('{"a":1}');
  });
});

describe('interpolateUrl', () => {
  const urlCtx = { input: { q: 'Foo & Bar?' }, env: { BASE: 'http://x.test' }, steps: {} };

  it('percent-encodes interpolated values so & cannot break the query', () => {
    expect(interpolateUrl('http://x.test/search?q={{input.q}}&count=1', urlCtx)).toBe(
      'http://x.test/search?q=Foo%20%26%20Bar%3F&count=1',
    );
  });

  it('leaves a position-0 placeholder raw (the base-URL slot)', () => {
    expect(interpolateUrl('{{env.BASE}}/search?q={{input.q}}', urlCtx)).toBe(
      'http://x.test/search?q=Foo%20%26%20Bar%3F',
    );
  });
});

function makeFlow(partial: Record<string, unknown>): Flow {
  return flowSchema.parse({
    name: 'test_flow',
    description: 'WHEN TO USE: never — inline test flow.',
    input: {},
    output: '{{steps.out}}',
    ...partial,
  });
}

describe('executeFlow', () => {
  it('runs transform → template pipelines', async () => {
    const flow = makeFlow({
      input: {
        city: { type: 'string', description: 'c', required: false, default: 'Paris' },
      },
      steps: [
        { id: 'shape', kind: 'transform', expr: '{ where: input.city }' },
        { id: 'out', kind: 'template', template: 'Hello from {{steps.shape.where}}' },
      ],
    });
    expect(await executeFlow(flow, {})).toBe('Hello from Paris');
    expect(await executeFlow(flow, { city: 'Rome' })).toBe('Hello from Rome');
  });

  it('enforces required parameters and types', async () => {
    const flow = makeFlow({
      input: { city: { type: 'string', description: 'c', required: true } },
      steps: [{ id: 'out', kind: 'template', template: '{{input.city}}' }],
    });
    await expect(executeFlow(flow, {})).rejects.toThrow(/missing required parameter 'city'/);
    await expect(executeFlow(flow, { city: 7 })).rejects.toThrow(/must be a string/);
  });

  it('maps over an array with a named binding', async () => {
    const flow = makeFlow({
      steps: [
        { id: 'nums', kind: 'transform', expr: '[1, 2, 3]' },
        {
          id: 'out',
          kind: 'map',
          over: 'steps.nums',
          as: 'n',
          step: { kind: 'template', template: 'item {{n}}' },
        },
      ],
    });
    expect(await executeFlow(flow, {})).toBe('item 1\nitem 2\nitem 3');
  });

  it('rejects maps over more than 10 items', async () => {
    const flow = makeFlow({
      steps: [
        { id: 'nums', kind: 'transform', expr: '[1,2,3,4,5,6,7,8,9,10,11]' },
        {
          id: 'out',
          kind: 'map',
          over: 'steps.nums',
          step: { kind: 'template', template: '{{item}}' },
        },
      ],
    });
    const err = await executeFlow(flow, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).stepId).toBe('out');
    expect((err as FlowError).message).toMatch(/exceeds the limit of 10/);
  });

  it('takes the right branch and exposes inner step results', async () => {
    const flow = makeFlow({
      input: { n: { type: 'number', description: 'n', required: true } },
      steps: [
        {
          id: 'pick',
          kind: 'branch',
          if: 'input.n > 5',
          then: [{ id: 'msg', kind: 'template', template: 'big' }],
          else: [{ id: 'msg', kind: 'template', template: 'small' }],
        },
        { id: 'out', kind: 'template', template: '{{steps.msg}} ({{steps.pick.taken}})' },
      ],
    });
    expect(await executeFlow(flow, { n: 9 })).toBe('big (then)');
    expect(await executeFlow(flow, { n: 2 })).toBe('small (else)');
  });

  it('wraps step failures in FlowError with the step id', async () => {
    const flow = makeFlow({
      steps: [{ id: 'bad', kind: 'transform', expr: 'steps.nothing.here' }],
    });
    const err = await executeFlow(flow, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).stepId).toBe('bad');
  });
});
