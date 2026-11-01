import { describe, expect, it } from 'vitest';
import { loadNodeData } from '../src/data/node';
import { Game } from '../src/sim/game';

const data = loadNodeData();
const MISSION = 'm01_clearwater_pond';
const TILE = 'G7';
const INLET = data.maps.get(data.missions.get(MISSION)!.map)!.inlets[0].tile;
const newGame = () => new Game(data, MISSION, 1);
const status = (g: Game, id: string) => g.limitingFactors(TILE).find((f) => f.id === id)!.status;

describe('knowledge model', () => {
  it('starts with the designed knowledge states', () => {
    const g = newGame();
    // Carp show only as ripples and mud plumes until surveyed: a coarse estimate.
    expect(g.known(TILE, 'carp').state).toBe('estimate');
    expect(g.known(TILE, 'water_depth').state).toBe('measured');
    expect(g.known(TILE, 'nitrate').state).toBe('estimate');
    // Secchi is coarsely visible as murky water.
    expect(g.known(TILE, 'secchi').state).toBe('estimate');
  });

  it('model estimates bracket the true value', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const g = new Game(data, MISSION, seed);
      const k = g.known(TILE, 'nitrate');
      const truth = g.sim.tile(TILE).values.nitrate;
      if (k.state !== 'estimate') throw new Error('expected an estimate');
      expect(k.lo).toBeLessThan(truth);
      expect(k.hi).toBeGreaterThan(truth);
    }
  });

  it('sampling costs budget and reveals measured values', () => {
    const g = newGame();
    const before = g.budget;
    expect(g.sample('fish_survey', TILE)).toBe(true);
    expect(g.budget).toBe(before - data.methods.get('fish_survey')!.cost);
    const k = g.known(TILE, 'carp');
    expect(k.state).toBe('measured');
    if (k.state === 'measured') expect(k.value).toBeCloseTo(g.sim.tile(TILE).values.carp, 0);
    expect(g.canSample('fish_survey', TILE)).toEqual({ ok: false, reason: 'Done today' });
    g.advance(1);
    expect(g.canSample('fish_survey', TILE).ok).toBe(true);
  });

  it('refuses sampling the budget cannot cover', () => {
    const g = newGame();
    g.budget = 10;
    expect(g.sample('secchi_disk', TILE)).toBe(false);
    expect(g.budget).toBe(10);
  });

  it('measurements are snapshots and do not follow the true state', () => {
    const g = newGame();
    g.sample('fish_survey', TILE);
    const k0 = g.known(TILE, 'carp');
    g.intervene('carp_removal', TILE);
    // Within the freshness window, so the survey still stands in for the visual estimate.
    g.advance(20);
    const k1 = g.known(TILE, 'carp');
    expect(k1).toEqual(k0);
    expect(g.sim.tile(TILE).values.carp).toBeLessThan((k0 as { value: number }).value / 2);
  });

  it('infers light at the bed from Secchi depth and water depth', () => {
    const g = newGame();
    expect(g.known(TILE, 'light_bed').state).toBe('estimate');
    g.sample('secchi_disk', TILE);
    const k = g.known(TILE, 'light_bed');
    expect(k.state).toBe('measured');
    if (k.state === 'measured') expect(k.value).toBeCloseTo(g.sim.tile(TILE).values.light_bed, 0);
  });

  it('discovers links only once their variables have been measured', () => {
    const g = newGame();
    const link = data.links.find((l) => l.id === 'carp_uproot_plants')!;
    expect(g.isDiscovered(link)).toBe(false);
    g.sample('fish_survey', TILE);
    expect(g.isDiscovered(link)).toBe(true);
  });

  it('limiting factors follow knowledge, not true state', () => {
    const g = newGame();
    expect(status(g, 'carp')).toBe('LIKELY');
    expect(status(g, 'nutrients')).toBe('UNKNOWN');
    g.sample('secchi_disk', TILE);
    expect(status(g, 'light')).toBe('LIMITING');
    g.sample('water_grab', TILE);
    expect(status(g, 'nutrients')).toBe('NOT LIMITING');
    expect(status(g, 'sediment')).toBe('LIMITING');
    g.sample('fish_survey', TILE);
    expect(status(g, 'carp')).toBe('LIMITING');
  });

  it('raises the phosphorus hint when pond P exceeds what the inflow explains', () => {
    const g = newGame();
    expect(g.hints(TILE)).toEqual([]);
    g.sample('water_grab', TILE);
    expect(g.hints(TILE).some((h) => h.includes('higher than the inflow'))).toBe(true);
    g.sample('sediment_core', TILE);
    expect(g.hints(TILE).some((h) => h.includes('higher than the inflow'))).toBe(false);
  });

  it('a fish survey covers every tile of the pond', () => {
    const g = newGame();
    g.sample('fish_survey', TILE);
    for (const id of g.waterTileIds()) expect(g.known(id, 'carp').state).toBe('measured');
  });

  it('a water grab sample covers only its own tile', () => {
    const g = newGame();
    g.sample('water_grab', TILE);
    expect(g.known('D7', 'total_p').state).toBe('unknown');
  });

  it('what flows in is known once its sources are known', () => {
    const g = newGame();
    // The inlet tile is fed by the stream (measured by regional monitoring) and mixes with its neighbours.
    const g2 = g.sim.grid;
    const neighbours = g2.neighbours4[g2.indexOf(INLET)].map((i) => g2.tiles[i].id);
    expect(g.known(INLET, 'incoming_tp').state).toBe('unknown');
    for (const t of neighbours) g.sample('water_grab', t);
    const k = g.known(INLET, 'incoming_tp');
    expect(k.state).toBe('measured');
    if (k.state === 'measured') expect(k.value).toBeCloseTo(g.sim.tile(INLET).values.incoming_tp, 0);
  });

  it('carp arriving at the inlet stays unknown until upstream immigration is measured', () => {
    const g = newGame();
    g.sample('fish_survey', TILE);
    expect(g.known(TILE, 'carp_moving_in').state).toBe('measured');
    expect(g.known(INLET, 'carp_moving_in').state).toBe('unknown');
    g.sample('inflow_fish_trap', TILE);
    expect(g.known(INLET, 'carp_moving_in').state).toBe('measured');
  });

  it('limiting factors differ between tiles: the shallows have light, the centre does not', () => {
    const g = newGame();
    g.sample('secchi_disk', 'D7');
    g.sample('secchi_disk', 'G7');
    expect(g.limitingFactors('D7').find((f) => f.id === 'light')!.status).toBe('NOT LIMITING');
    expect(g.limitingFactors('G7').find((f) => f.id === 'light')!.status).toBe('LIMITING');
  });

  it('land tiles have no pond knowledge', () => {
    expect(newGame().known('A1', 'secchi').state).toBe('unknown');
  });

  it('evaluates the objective at the deadline', () => {
    const g = newGame();
    g.advance(g.deadlineDay - 1);
    expect(g.outcome).toBeNull();
    g.advance(1);
    expect(g.outcome).not.toBeNull();
  });
});
