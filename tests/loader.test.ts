import { describe, expect, it } from 'vitest';
import { readRawFiles } from '../src/data/node';
import { DataError, loadData } from '../src/sim/loader';

describe('data loader', () => {
  it('loads the shipped data without problems', () => {
    const data = loadData(readRawFiles());
    expect(data.missions.has('m01_clearwater_pond')).toBe(true);
    expect(data.variables.size).toBeGreaterThan(10);
  });

  it('fills explicit identity factors for product links that omit them', () => {
    const data = loadData(readRawFiles());
    const link = data.links.find((l) => l.id === 'inflow_brings_p')!;
    expect(link.factors?.map((f) => f.var)).toEqual(['water_exchange', 'incoming_tp']);
  });

  it('reports unknown variable references', () => {
    const files = readRawFiles();
    const links = structuredClone(files['links.json']) as { from: string[] }[];
    links[0].from = ['no_such_variable'];
    expect(() => loadData({ ...files, 'links.json': links })).toThrow(/unknown variable "no_such_variable"/);
  });

  it('reports schema errors with file and path', () => {
    const files = readRawFiles();
    const vars = structuredClone(files['variables.json']) as { kind: string }[];
    vars[0].kind = 'banana';
    try {
      loadData({ ...files, 'variables.json': vars });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DataError);
      expect((e as DataError).problems.some((p) => p.startsWith('variables.json at 0.kind'))).toBe(true);
    }
  });

  it('rejects links that target boundary variables', () => {
    const files = readRawFiles();
    const links = structuredClone(files['links.json']) as { to: string }[];
    links[0].to = 'wind';
    expect(() => loadData({ ...files, 'links.json': links })).toThrow(/boundary variables cannot be link targets/);
  });
});
