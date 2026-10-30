// Mission 1 scripted tests: the intended solution and the intended wrong solutions
// must produce the outcomes the design calls for (design doc section 7).
import { describe, expect, it } from 'vitest';
import { loadNodeData } from '../src/data/node';
import { Simulation } from '../src/sim/engine';
import { Game } from '../src/sim/game';

const data = loadNodeData();
const MISSION = 'm01_clearwater_pond';
const SEEDS = [1, 2, 3];
const SHALLOWS = ['plant_submerged:A1', 'plant_submerged:A3', 'plant_submerged:C3'];

/** Plays a plan of interventions (by mission day; "id:tile" for tile-scoped ones) to the deadline. */
function play(seed: number, plan: Record<number, string[]>, onDay?: (g: Game) => void): Game {
  const game = new Game(data, MISSION, seed);
  while (!game.outcome) {
    for (const entry of plan[game.day] ?? []) {
      const [id, tile] = entry.split(':');
      expect(game.intervene(id, tile ?? 'B1'), `could not start ${entry} on day ${game.day}`).toBe(true);
    }
    game.advance(1);
    onDay?.(game);
  }
  return game;
}

const cover = (g: Game) => g.sim.aggregate('plant_cover');
const at = (g: Game, tile: string) => g.sim.tile(tile).values;

describe('Clearwater Pond', () => {
  it('starts in a turbid, plant-free state with high carp', () => {
    const g = new Game(data, MISSION, 1);
    expect(cover(g)).toBeLessThan(1);
    expect(g.sim.aggregate('secchi')).toBeLessThan(0.6);
    expect(g.sim.aggregate('carp')).toBeGreaterThan(300);
    expect(at(g, 'B2').light_bed).toBeLessThan(2);
  });

  it('carp concentrate at the inlet, where upstream fish arrive', () => {
    const g = new Game(data, MISSION, 1);
    expect(at(g, 'B1').carp).toBeGreaterThan(at(g, 'C3').carp + 30);
  });

  it('shallow margins get more light than the deep centre', () => {
    const g = new Game(data, MISSION, 1);
    expect(at(g, 'A1').light_bed).toBeGreaterThan(3 * at(g, 'B2').light_bed);
  });

  it.each(SEEDS)('doing nothing fails (seed %i)', (seed) => {
    expect(play(seed, {}).outcome!.success).toBe(false);
  });

  it.each(SEEDS)('planting first fails, even in the bright shallows (seed %i)', (seed) => {
    const g = new Game(data, MISSION, seed);
    for (const e of SHALLOWS) g.intervene(e.split(':')[0], e.split(':')[1]);
    g.advance(20);
    const planted = at(g, 'A1').plant_cover;
    expect(planted).toBeGreaterThan(3);
    g.advance(60);
    expect(at(g, 'A1').plant_cover).toBeLessThan(planted / 4);
    while (!g.outcome) g.advance(30);
    expect(g.outcome!.success).toBe(false);
  });

  it.each(SEEDS)('carp removal without a barrier works briefly, then carp recolonise (seed %i)', (seed) => {
    let peak = 0;
    let carpLow = Infinity;
    const g = play(seed, { 0: ['carp_removal'], 40: SHALLOWS }, (game) => {
      peak = Math.max(peak, cover(game));
      carpLow = Math.min(carpLow, game.sim.aggregate('carp'));
    });
    expect(peak).toBeGreaterThan(15);
    expect(g.sim.aggregate('carp')).toBeGreaterThan(3 * carpLow);
    expect(g.outcome!.success).toBe(false);
  });

  it.each(SEEDS)('removal and barrier without planting is too slow: the seed bank is depleted (seed %i)', (seed) => {
    expect(play(seed, { 0: ['carp_removal', 'carp_barrier'] }).outcome!.success).toBe(false);
  });

  it.each(SEEDS)('removal, barrier, then planting the shallows locks in the clear state (seed %i)', (seed) => {
    const g = play(seed, { 0: ['carp_removal', 'carp_barrier'], 40: SHALLOWS });
    expect(g.outcome!.success).toBe(true);
    expect(g.sim.aggregate('secchi')).toBeGreaterThan(1.5);
    expect(g.sim.aggregate('carp')).toBeLessThan(150);
  });

  it('plants spread from planted tiles to unplanted ones', () => {
    const g = new Game(data, MISSION, 1);
    g.intervene('carp_removal', 'B1');
    g.intervene('carp_barrier', 'B1');
    g.advance(40);
    g.intervene('plant_submerged', 'A1');
    g.advance(300);
    // Neighbours colonise first, tiles two steps away later.
    expect(at(g, 'A2').plant_cover).toBeGreaterThan(10);
    expect(at(g, 'A3').plant_cover).toBeGreaterThan(1);
    expect(at(g, 'A2').plant_cover).toBeGreaterThan(at(g, 'A3').plant_cover);
  });

  it('the winning plan fits inside the budget with room for diagnosis', () => {
    const cost = ['carp_removal', 'carp_barrier', 'plant_submerged', 'plant_submerged', 'plant_submerged'].reduce((s, id) => s + data.interventions.get(id)!.cost, 0);
    const diagnosis = ['secchi_disk', 'water_grab', 'fish_survey'].reduce((s, id) => s + data.methods.get(id)!.cost, 0);
    const budget = data.missions.get(MISSION)!.budget;
    expect(cost + diagnosis).toBeLessThanOrEqual(budget);
    // But not so much room that the player can sample every tile with every method.
    const tileMethods = [...data.methods.values()].filter((m) => m.scope === 'tile').reduce((s, m) => s + m.cost, 0);
    expect(tileMethods * 9).toBeGreaterThan(budget);
  });

  it('shows hysteresis: at the same carp level, clear and turbid states both persist', () => {
    const mission = data.missions.get(MISSION)!;
    const HOLD = 200;
    const runHeld = (sim: Simulation, days: number) => {
      for (let i = 0; i < days; i++) {
        for (const t of sim.tiles) t.values.carp = HOLD;
        sim.step(1);
      }
    };

    // Turbid branch: start from the degraded pond and lower carp to HOLD.
    const turbid = new Simulation(data, mission, 1);
    turbid.step(mission.spinup_days);
    runHeld(turbid, 3 * 365);

    // Clear branch: restore the pond fully, then raise carp to HOLD.
    const clear = new Simulation(data, mission, 1);
    clear.step(mission.spinup_days);
    clear.startIntervention(data.interventions.get('carp_removal')!);
    clear.startIntervention(data.interventions.get('carp_barrier')!);
    clear.step(40);
    for (const tile of ['A1', 'A3', 'C3']) clear.startIntervention(data.interventions.get('plant_submerged')!, tile);
    clear.step(2 * 365);
    expect(clear.aggregate('plant_cover')).toBeGreaterThan(50);
    runHeld(clear, 3 * 365);

    expect(turbid.aggregate('plant_cover')).toBeLessThan(5);
    expect(clear.aggregate('plant_cover')).toBeGreaterThan(30);
    expect(clear.aggregate('secchi')).toBeGreaterThan(2 * turbid.aggregate('secchi'));
  });

  it('alum lowers phosphorus and algae (optional depth)', () => {
    const without = play(1, { 0: ['carp_removal', 'carp_barrier'], 40: SHALLOWS });
    const withAlum = play(1, { 0: ['carp_removal', 'carp_barrier', 'alum_treatment'], 40: SHALLOWS });
    expect(withAlum.sim.aggregate('total_p')).toBeLessThan(without.sim.aggregate('total_p'));
    expect(withAlum.sim.aggregate('chla')).toBeLessThan(without.sim.aggregate('chla'));
  });
});
