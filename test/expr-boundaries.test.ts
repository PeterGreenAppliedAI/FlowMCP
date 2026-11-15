import { describe, expect, it } from 'vitest';
import { evalExpr, ExprError } from '../src/expr.js';
import { interpolate } from '../src/interpolate.js';

describe('expr boundaries', () => {
  it('renders an inherited toString as empty in interpolation', () => {
    expect(interpolate('[{{input.toString}}]', { input: {} })).toBe('[]');
  });

  it('reads only own properties', () => {
    expect(evalExpr('input.hidden', { input: Object.create({ hidden: 7 }) })).toBeUndefined();
    expect(evalExpr('input.toString', { input: { toString: 'own' } })).toBe('own');
  });

  it('resolves array indices and length', () => {
    expect(evalExpr('items[0]', { items: [7] })).toBe(7);
    expect(evalExpr('items.length', { items: [7] })).toBe(1);
  });

  it('rejects forbidden object-literal keys, quoted or unquoted', () => {
    const cases = [
      '{ __proto__: 1 }',
      '{ "__proto__": 1 }',
      "{ '__proto__': 1 }",
      '{ constructor: 1 }',
      '{ "constructor": 1 }',
      "{ 'constructor': 1 }",
      '{ prototype: 1 }',
      '{ "prototype": 1 }',
      "{ 'prototype': 1 }",
    ];
    for (const src of cases) {
      expect(() => evalExpr(src, {}), src).toThrow(ExprError);
      expect(() => evalExpr(src, {}), src).toThrow(/forbidden/);
    }
  });

  it('still builds safe object literals', () => {
    expect(evalExpr('{ safe: 7 }', {})).toEqual({ safe: 7 });
  });
});
