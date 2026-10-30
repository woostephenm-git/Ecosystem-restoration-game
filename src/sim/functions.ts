// Link function library. Every link evaluates to one number: a rate (per day)
// for stock targets, or an additive term inside a derived variable's transform.
import type { Factor, Transform } from './schema';
import type { NormalLink } from './loader';

/** Smooth step from 0 to 1 around `at`. Width 0 gives a hard step. */
export function logistic(x: number, at: number, width: number): number {
  if (width === 0) return x >= at ? 1 : 0;
  return 1 / (1 + Math.exp(-(x - at) / width));
}

export function shape(f: Factor, x: number): number {
  switch (f.shape) {
    case 'identity':
      return x;
    case 'power':
      return Math.pow(Math.max(x, 1e-9), f.p);
    case 'saturating':
      return x / (f.half + x);
    case 'threshold':
      return f.direction === 'above' ? logistic(x, f.at, f.width) : 1 - logistic(x, f.at, f.width);
    case 'decay':
      return Math.exp(-f.rate * x);
    case 'complement':
      return Math.max(0, 1 - x / f.cap);
  }
}

export type ValueLookup = (variableId: string) => number;

export function evalLink(link: NormalLink, get: ValueLookup): number {
  switch (link.function) {
    case 'linear':
      return link.params.k * get(link.from[0]);
    case 'saturating': {
      const x = get(link.from[0]);
      return (link.params.k * x) / (link.params.half + x);
    }
    case 'threshold': {
      const { k, at, width, direction } = link.params;
      const s = logistic(get(link.from[0]), at, width);
      return k * (direction === 'above' ? s : 1 - s);
    }
    case 'exponential_decay':
      return link.params.k * Math.exp(-link.params.rate * get(link.from[0]));
    case 'product': {
      let out = link.params.k;
      for (const f of link.factors!) out *= shape(f, get(f.var));
      return out;
    }
  }
}

export function applyTransform(t: Transform, sum: number): number {
  switch (t.fn) {
    case 'none':
      return sum;
    case 'reciprocal':
      return t.k / Math.max(sum, 1e-9);
    case 'exp_neg':
      return t.k * Math.exp(-sum);
  }
}
