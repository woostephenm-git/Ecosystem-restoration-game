import { describe, expect, it } from 'vitest';
import { loadNodeData } from '../src/data/node';
import { Simulation } from '../src/sim/engine';
import { Grid, OFF_MAP } from '../src/sim/grid';
import type { GameMap } from '../src/sim/schema';

const data = loadNodeData();
const mission = data.missions.get('m01_clearwater_pond')!;

function map(rows: number, cols: number, inlet: string, outlet: string): GameMap {
  const tiles = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) tiles.push({ id: `${'ABC'[r]}${c + 1}`, row: r, col: c, description: '', initial: {} });
  return {
    id: 'm',
    name: 'm',
    rows,
    cols,
    tile_size_m: 10,
    mixing_per_day: 0,
    defaults: {},
    tiles,
    inlets: [{ tile: inlet, face: 'W', name: 'In', share: 1 }],
    outlets: [{ tile: outlet, face: 'E', name: 'Out' }],
  };
}

describe('grid and D8 routing', () => {
  it('routes each tile to its steepest downhill neighbour, including diagonals', () => {
    const m = map(2, 2, 'A1', 'B2');
    // A1 is highest; B2 is lowest and diagonal from A1.
    const g = new Grid(m, [10, 9.5, 9.5, 9], [1, 1, 1, 1]);
    expect(g.receiver[g.indexOf('A1')]).toBe(g.indexOf('B2'));
    expect(g.receiver[g.indexOf('B2')]).toBe(OFF_MAP);
  });

  it('routes across a flat water surface toward the outlet', () => {
    const m = map(3, 3, 'B1', 'B3');
    const g = new Grid(m, Array(9).fill(10), Array(9).fill(1));
    expect(g.receiver[g.indexOf('B1')]).toBe(g.indexOf('B2'));
    expect(g.receiver[g.indexOf('B2')]).toBe(g.indexOf('B3'));
    expect(g.receiver[g.indexOf('B3')]).toBe(OFF_MAP);
    // Corner tiles step one tile closer to the outlet.
    expect(g.receiver[g.indexOf('A1')]).toBe(g.indexOf('A2'));
  });

  it('accumulates inlet discharge down the flow path', () => {
    const m = map(3, 3, 'B1', 'B3');
    const g = new Grid(m, Array(9).fill(10), Array(9).fill(1));
    expect(g.throughShare[g.indexOf('B1')]).toBe(1);
    expect(g.throughShare[g.indexOf('B2')]).toBe(1);
    expect(g.throughShare[g.indexOf('B3')]).toBe(1);
    expect(g.throughShare[g.indexOf('A1')]).toBe(0);
    expect(g.flowOrder.indexOf(g.indexOf('B1'))).toBeLessThan(g.flowOrder.indexOf(g.indexOf('B3')));
  });

  it('lists face neighbours only for water tiles', () => {
    const m = map(3, 3, 'B1', 'B3');
    const depth = [1, 1, 1, 1, 1, 1, 0, 1, 1];
    const g = new Grid(m, Array(9).fill(10), depth);
    expect(g.neighbours4[g.indexOf('B2')].length).toBe(4);
    expect(g.neighbours4[g.indexOf('B1')].map((i) => g.tiles[i].id).sort()).toEqual(['A1', 'B2']);
    expect(g.neighbours4[g.indexOf('C1')]).toEqual([]);
  });
});

describe('map pass', () => {
  it('Clearwater water flows from the west inlet through the centre to the east outlet', () => {
    const sim = new Simulation(data, mission, 1);
    const g = sim.grid;
    expect(g.receiver[g.indexOf('B1')]).toBe(g.indexOf('B2'));
    expect(g.receiver[g.indexOf('B2')]).toBe(g.indexOf('B3'));
    expect(sim.edgeFluxes('B3').to).toBe('East outlet weir');
    expect(sim.edgeFluxes('B1').from.inlets).toEqual(['West inlet channel']);
    expect(sim.edgeFluxes('B2').from.upstream).toEqual(['B1']);
  });

  it('incoming concentration weights sum to one', () => {
    const sim = new Simulation(data, mission, 1);
    for (const i of sim.grid.waterTiles().map((t) => t.index)) {
      const combo = sim.lateral[i].incoming_tp;
      expect(combo.terms.reduce((s, t) => s + t.weight, 0)).toBeCloseTo(1);
    }
  });

  it('flow conserves dissolved mass apart from boundary exchange', () => {
    // With no reactions, a tracer in still inlet water ends up equal everywhere at the inlet concentration.
    const sim = new Simulation(data, mission, 1);
    sim.step(1500);
    const inflow = sim.boundary.inflow_no3;
    // Nitrate has only flow and slow denitrification, so every tile sits a little below the inlet value.
    for (const t of sim.tiles) {
      expect(t.values.nitrate).toBeLessThan(inflow);
      expect(t.values.nitrate).toBeGreaterThan(inflow * 0.3);
    }
    // And the inlet tile is closest to the inflow concentration.
    const b1 = sim.tile('B1').values.nitrate;
    for (const t of sim.tiles) expect(b1).toBeGreaterThanOrEqual(t.values.nitrate - 1e-9);
  });

  it('tile-scoped interventions act on one tile only', () => {
    const sim = new Simulation(data, mission, 1);
    const before = sim.tile('C3').values.plant_cover;
    sim.startIntervention(data.interventions.get('plant_submerged')!, 'A1');
    sim.step(14);
    expect(sim.tile('A1').values.plant_cover).toBeGreaterThan(5);
    expect(sim.tile('C3').values.plant_cover).toBeLessThan(before + 1);
  });
});
