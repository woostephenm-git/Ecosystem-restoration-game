import { describe, expect, it } from 'vitest';
import { readRawFiles } from '../src/data/node';
import { Simulation } from '../src/sim/engine';
import { loadData } from '../src/sim/loader';

const files = readRawFiles();
const data = loadData(files);
const mission = data.missions.get('m01_clearwater_pond')!;

const stub = { observable: 'none', initial_knowledge: 'unknown', display_decimals: 2, scale: { min: 0, max: 1 }, pin: { x: 0, y: 0 } };
const none = { fn: 'none' };

/** A tiny world: a decaying stock, a slow stock, and two chained derived variables. */
function toyData() {
  const vars = [
    { ...stub, id: 'x', name: 'X', layer: 'chemistry', zone: 'water', unit: 'u', kind: 'stock', update_interval_days: 1 },
    { ...stub, id: 'water_depth', name: 'Depth', layer: 'hydrology', zone: 'water', unit: 'm', kind: 'stock', update_interval_days: 1 },
    { ...stub, id: 'slow', name: 'Slow', layer: 'soil', zone: 'sediment', unit: 'u', kind: 'stock', update_interval_days: 10 },
    { ...stub, id: 'z', name: 'Z', layer: 'chemistry', zone: 'water', unit: 'u', kind: 'derived', derived: { base: 1, transform: none }, update_interval_days: 1 },
    { ...stub, id: 'y', name: 'Y', layer: 'chemistry', zone: 'water', unit: 'u', kind: 'derived', derived: { base: 0, transform: none }, update_interval_days: 1 },
  ];
  const link = { label: '', strength: 'weak', discovered_by: [], function: 'linear' };
  const links = [
    { ...link, id: 'decay', from: ['x'], to: 'x', params: { k: -0.1 } },
    { ...link, id: 'grow', from: ['slow'], to: 'slow', params: { k: 0.01 } },
    { ...link, id: 'zy', from: ['y'], to: 'z', params: { k: 1 } },
    { ...link, id: 'double', from: ['x'], to: 'y', params: { k: 2 } },
  ];
  const toyMission = {
    ...mission,
    id: 'toy',
    spinup_days: 0,
    map: 'maps/toy.json',
    boundary_conditions: 'bc/toy.json',
    objective: { ...mission.objective, variable: 'x' },
    final_survey: ['x'],
    success_letter: undefined,
    limiting_factors: { title: '', factors: [] },
    hints: [],
    methods: [],
    interventions: [],
  };
  const d = loadData({
    'layers.json': files['layers.json'],
    'zones.json': files['zones.json'],
    'variables.json': vars,
    'links.json': links,
    'methods.json': [],
    'interventions.json': [],
    'missions/toy.json': toyMission,
    'maps/toy.json': {
      id: 'toy',
      name: 'Toy',
      rows: 1,
      cols: 1,
      tile_size_m: 10,
      water_level: 10,
      mixing_m2_per_day: 0,
      bodies: [{ id: 'p', name: 'P', simulated: true }],
      defaults: {},
      tiles: [{ id: 'A', row: 0, col: 0, description: '', body: 'p', initial: { x: 10, slow: 1, water_depth: 1 } }],
      inlets: [{ tile: 'A', face: 'W', name: 'In', share: 1 }],
      outlets: [{ tile: 'A', face: 'E', name: 'Out' }],
    },
    'bc/toy.json': { id: 'toy', values: {} },
  });
  return { d, m: d.missions.get('toy')! };
}

describe('simulation engine', () => {
  it('integrates stocks with explicit Euler steps', () => {
    const { d, m } = toyData();
    const sim = new Simulation(d, m, 1);
    sim.step(1);
    expect(sim.tiles[0].values.x).toBeCloseTo(9);
    sim.step(1);
    expect(sim.tiles[0].values.x).toBeCloseTo(8.1);
  });

  it('evaluates derived variables in dependency order, whatever order the data lists them', () => {
    const { d, m } = toyData();
    const sim = new Simulation(d, m, 1);
    expect(sim.tiles[0].values.y).toBeCloseTo(20);
    expect(sim.tiles[0].values.z).toBeCloseTo(21);
  });

  it('updates slow stocks only on their interval, with dt equal to the interval', () => {
    const { d, m } = toyData();
    const sim = new Simulation(d, m, 1);
    sim.step(1);
    expect(sim.tiles[0].values.slow).toBeCloseTo(1.1);
    sim.step(9);
    expect(sim.tiles[0].values.slow).toBeCloseTo(1.1);
    sim.step(1);
    expect(sim.tiles[0].values.slow).toBeCloseTo(1.21);
  });

  it('is deterministic for a given seed', () => {
    const a = new Simulation(data, mission, 42);
    const b = new Simulation(data, mission, 42);
    a.step(500);
    b.step(500);
    expect(a.tiles.map((t) => t.values)).toEqual(b.tiles.map((t) => t.values));
  });

  it('different seeds change stochastic boundary forcing', () => {
    const a = new Simulation(data, mission, 1);
    const b = new Simulation(data, mission, 2);
    a.step(30);
    b.step(30);
    expect(a.boundary.wind).not.toBe(b.boundary.wind);
  });

  it('spreads multiplicative interventions over their duration', () => {
    const sim = new Simulation(data, mission, 1);
    sim.step(mission.spinup_days);
    sim.startIntervention(data.interventions.get('carp_removal')!);
    const before = sim.aggregate('carp');
    sim.step(15);
    const mid = sim.aggregate('carp');
    sim.step(15);
    const after = sim.aggregate('carp');
    expect(mid).toBeLessThan(before);
    expect(after).toBeLessThan(mid);
    expect(after / before).toBeGreaterThan(0.1);
    expect(after / before).toBeLessThan(0.25);
    expect(sim.activeInterventions()).toEqual([]);
  });

  it('reports how far a running intervention has got', () => {
    const sim = new Simulation(data, mission, 1);
    const weir = data.interventions.get('raise_weir')!;
    expect(sim.interventionProgress('raise_weir')).toBeNull();
    sim.startIntervention(weir);
    sim.step(weir.duration_days / 2);
    expect(sim.interventionProgress('raise_weir')).toBeCloseTo(0.5);
    sim.step(weir.duration_days);
    expect(sim.interventionProgress('raise_weir')).toBeNull();
  });

  it('applies boundary interventions as persistent modifiers', () => {
    const sim = new Simulation(data, mission, 1);
    const base = sim.boundary.carp_immigration;
    sim.startIntervention(data.interventions.get('carp_barrier')!);
    sim.step(400);
    expect(sim.boundary.carp_immigration).toBeCloseTo(base * 0.05);
  });
});
