import { describe, expect, it } from 'vitest';
import { applyTransform, evalLink, logistic, shape } from '../src/sim/functions';
import type { NormalLink } from '../src/sim/loader';

const base = { id: 'l', to: 't', label: '', strength: 'weak' as const, discovered_by: [] };
const values: Record<string, number> = { a: 4, b: 10 };
const get = (id: string) => values[id];

describe('logistic', () => {
  it('is 0.5 at the threshold and approaches 0 and 1', () => {
    expect(logistic(3, 3, 1)).toBeCloseTo(0.5);
    expect(logistic(-10, 3, 1)).toBeLessThan(0.001);
    expect(logistic(20, 3, 1)).toBeGreaterThan(0.999);
  });
  it('is a hard step at width 0', () => {
    expect(logistic(2.99, 3, 0)).toBe(0);
    expect(logistic(3, 3, 0)).toBe(1);
  });
});

describe('link functions', () => {
  it('linear', () => {
    const l: NormalLink = { ...base, from: ['a'], function: 'linear', params: { k: -0.5 } };
    expect(evalLink(l, get)).toBe(-2);
  });
  it('saturating (Michaelis-Menten) reaches half of k at the half-saturation constant', () => {
    const l: NormalLink = { ...base, from: ['a'], function: 'saturating', params: { k: 2, half: 4 } };
    expect(evalLink(l, get)).toBeCloseTo(1);
  });
  it('threshold above and below are complements', () => {
    const above: NormalLink = { ...base, from: ['a'], function: 'threshold', params: { k: 1, at: 4, width: 0.5, direction: 'above' } };
    const below: NormalLink = { ...base, from: ['a'], function: 'threshold', params: { k: 1, at: 4, width: 0.5, direction: 'below' } };
    expect(evalLink(above, get)).toBeCloseTo(0.5);
    expect(evalLink(above, get) + evalLink(below, get)).toBeCloseTo(1);
  });
  it('exponential decay', () => {
    const l: NormalLink = { ...base, from: ['a'], function: 'exponential_decay', params: { k: 3, rate: 0.25 } };
    expect(evalLink(l, get)).toBeCloseTo(3 * Math.exp(-1));
  });
  it('product multiplies shaped factors', () => {
    const l: NormalLink = {
      ...base,
      from: ['a', 'b'],
      function: 'product',
      params: { k: 2 },
      factors: [
        { var: 'a', shape: 'identity' },
        { var: 'b', shape: 'complement', cap: 20 },
      ],
    };
    expect(evalLink(l, get)).toBeCloseTo(2 * 4 * 0.5);
  });
});

describe('factor shapes', () => {
  it('power', () => expect(shape({ var: 'a', shape: 'power', p: -1 }, 4)).toBeCloseTo(0.25));
  it('saturating', () => expect(shape({ var: 'a', shape: 'saturating', half: 4 }, 4)).toBeCloseTo(0.5));
  it('decay', () => expect(shape({ var: 'a', shape: 'decay', rate: 0.5 }, 2)).toBeCloseTo(Math.exp(-1)));
  it('complement floors at zero', () => expect(shape({ var: 'a', shape: 'complement', cap: 10 }, 15)).toBe(0));
  it('threshold below', () => expect(shape({ var: 'a', shape: 'threshold', at: 1, width: 0, direction: 'below' }, 0)).toBe(1));
});

describe('derived transforms', () => {
  it('reciprocal', () => expect(applyTransform({ fn: 'reciprocal', k: 1.7 }, 3.4)).toBeCloseTo(0.5));
  it('exp_neg', () => expect(applyTransform({ fn: 'exp_neg', k: 100 }, Math.log(2))).toBeCloseTo(50));
  it('none', () => expect(applyTransform({ fn: 'none' }, 7)).toBe(7));
});
