import { describe, expect, it } from 'vitest';
import { loadNodeData } from '../src/data/node';
import { Simulation } from '../src/sim/engine';
import { Grid, OFF_MAP } from '../src/sim/grid';
import type { GameMap } from '../src/sim/schema';

const data = loadNodeData();
const mission = data.missions.get('m01_clearwater_pond')!;
const map0 = data.maps.get(mission.map)!;

/** A small all-water map: rows A.., columns 1.., one inlet and one outlet. */
function map(rows: number, cols: number, inlet: string, outlet: string, land: string[] = []): GameMap {
  const tiles = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const id = `${'ABCDEF'[c]}${r + 1}`;
      tiles.push({ id, row: r, col: c, description: '', initial: {}, ...(land.includes(id) ? {} : { body: 'p' }) });
    }
  return {
    id: 'm',
    name: 'm',
    rows,
    cols,
    tile_size_m: 10,
    water_level: 10,
    mixing_m2_per_day: 0,
    bodies: [{ id: 'p', name: 'P', simulated: true }],
    defaults: {},
    tiles,
    inlets: [{ tile: inlet, face: 'W', name: 'In', share: 1 }],
    outlets: [{ tile: outlet, face: 'E', name: 'Out' }],
  };
}

const sumShare = (flows: { share: number }[]) => flows.reduce((s, f) => s + f.share, 0);

describe('grid and steady flow', () => {
  it('sends all inlet water through a straight channel to the outlet', () => {
    const m = map(1, 3, 'A1', 'C1');
    const g = new Grid(m, [1, 1, 1], [9, 9, 9]);
    expect(g.inletShare[g.indexOf('A1')]).toBeCloseTo(1);
    expect(g.throughShare.map((x) => +x.toFixed(6))).toEqual([1, 1, 1]);
    expect(g.outflows[g.indexOf('C1')]).toEqual([{ to: OFF_MAP, share: expect.closeTo(1, 6) }]);
  });

  it('conserves water: what enters every free tile leaves it', () => {
    const m = map(3, 3, 'A2', 'C2');
    const g = new Grid(m, [0.5, 1, 0.5, 1, 2, 1, 0.5, 1, 0.5], Array(9).fill(9));
    for (const t of g.tiles) {
      const out = sumShare(g.outflows[t.index]);
      expect(out, t.id).toBeCloseTo(g.throughShare[t.index], 6);
    }
  });

  it('spreads flow across a basin instead of one path, and favours deep water', () => {
    const m = map(3, 3, 'A2', 'C2');
    const g = new Grid(m, [0.5, 1, 0.5, 1, 2, 1, 0.5, 1, 0.5], Array(9).fill(9));
    // The side rows still carry some flow.
    expect(g.throughShare[g.indexOf('B1')]).toBeGreaterThan(0.01);
    // The deep middle carries more than the shallow side.
    expect(g.throughShare[g.indexOf('B2')]).toBeGreaterThan(g.throughShare[g.indexOf('B1')]);
  });

  it('lists face neighbours only within simulated water', () => {
    const m = map(3, 3, 'A2', 'C2', ['A3']);
    const g = new Grid(m, [1, 1, 0, 1, 1, 1, 1, 1, 1], Array(9).fill(9));
    expect(g.neighbours4[g.indexOf('B2')].length).toBe(4);
    expect(g.neighbours4[g.indexOf('A2')].map((i) => g.tiles[i].id).sort()).toEqual(['A1', 'B2']);
    expect(g.tiles[g.indexOf('A3')].water).toBe(false);
  });

  it('drains land runoff to the steepest downhill neighbour', () => {
    const m = map(2, 2, 'A1', 'B2', ['A1', 'B1', 'A2', 'B2']);
    const g = new Grid(m, [0, 0, 0, 0], [10, 9.5, 9.5, 9]);
    expect(g.runoffTo[g.indexOf('A1')]).toBe(g.indexOf('B2'));
    expect(g.runoffTo[g.indexOf('B2')]).toBe(OFF_MAP);
  });
});

describe('Clearwater map', () => {
  const sim = new Simulation(data, mission, 1);
  const g = sim.grid;
  const inlet = map0.inlets[0].tile;
  const outlet = map0.outlets[0].tile;

  it('has one simulated pond joining the inlet to the outlet, and scenery elsewhere', () => {
    expect(g.tiles[g.indexOf(inlet)].water).toBe(true);
    expect(g.tiles[g.indexOf(outlet)].water).toBe(true);
    expect(g.waterTiles().length).toBeGreaterThan(20);
    expect(g.tiles.some((t) => t.body && !t.water)).toBe(true);
    expect(g.tiles.filter((t) => !t.body).length).toBeGreaterThan(80);
  });

  it('delivers all inlet water to the outlet', () => {
    const leaving = sumShare(g.outflows[g.indexOf(outlet)].filter((f) => f.to === OFF_MAP));
    expect(leaving).toBeCloseTo(1, 4);
    expect(sim.edgeFluxes(inlet).from.inlets).toEqual(['West inlet channel']);
    expect(sim.edgeFluxes(outlet).to).toContain('East outlet channel');
  });

  it('incoming concentration weights sum to one on every water tile', () => {
    for (const t of g.waterTiles()) {
      const combo = sim.lateral[t.index].incoming_tp;
      expect(combo.terms.reduce((s, x) => s + x.weight, 0), t.id).toBeCloseTo(1);
    }
  });

  it('nitrate decreases downstream from the inlet', () => {
    const s = new Simulation(data, mission, 1);
    s.step(1500);
    const inflow = s.boundary.inflow_no3;
    for (const t of s.grid.waterTiles()) expect(s.tiles[t.index].values.nitrate).toBeLessThan(inflow);
    expect(s.tile(inlet).values.nitrate).toBeGreaterThan(s.tile(outlet).values.nitrate);
  });

  it('tile-scoped interventions act on one tile only', () => {
    const s = new Simulation(data, mission, 1);
    const before = s.tile('C6').values.plant_cover;
    s.startIntervention(data.interventions.get('plant_submerged')!, 'J7');
    s.step(14);
    expect(s.tile('J7').values.plant_cover).toBeGreaterThan(5);
    expect(s.tile('C6').values.plant_cover).toBeLessThan(before + 1);
  });

  it('land tiles hold no pond state', () => {
    const s = new Simulation(data, mission, 1);
    s.step(30);
    expect(s.tile('A1').values.carp).toBe(0);
    expect(s.tile('A1').values.secchi).toBeUndefined();
  });
});
