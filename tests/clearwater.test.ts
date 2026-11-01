// Mission 1 scripted tests: the intended solution and the intended wrong solutions
// must produce the outcomes the design calls for (design doc section 7).
import { describe, expect, it } from 'vitest';
import { loadNodeData } from '../src/data/node';
import { Simulation } from '../src/sim/engine';
import { Game } from '../src/sim/game';

const data = loadNodeData();
const MISSION = 'm01_clearwater_pond';
const SEEDS = [1, 2, 3];
const SHALLOWS = ['D7', 'E8', 'G9', 'H9', 'J7', 'K8'].map((t) => `plant_submerged:${t}`);
const INLET = data.maps.get(data.missions.get(MISSION)!.map)!.inlets[0].tile;

/** Plays a plan of interventions (by mission day; "id:tile" for tile-scoped ones) to the deadline. */
function play(seed: number, plan: Record<number, string[]>, onDay?: (g: Game) => void): Game {
  const game = new Game(data, MISSION, seed);
  while (!game.outcome) {
    for (const entry of plan[game.day] ?? []) {
      const [id, tile] = entry.split(':');
      expect(game.intervene(id, tile ?? INLET), `could not start ${entry} on day ${game.day}`).toBe(true);
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
    expect(at(g, 'G7').light_bed).toBeLessThan(2);
  });

  it('carp concentrate at the inlet, where upstream fish arrive', () => {
    const g = new Game(data, MISSION, 1);
    expect(at(g, INLET).carp).toBeGreaterThan(at(g, 'K8').carp + 30);
  });

  it('shallow margins get more light than the deep centre', () => {
    const g = new Game(data, MISSION, 1);
    expect(at(g, 'D7').light_bed).toBeGreaterThan(3 * at(g, 'G7').light_bed);
  });

  it.each(SEEDS)('doing nothing fails (seed %i)', (seed) => {
    expect(play(seed, {}).outcome!.success).toBe(false);
  });

  it.each(SEEDS)('planting first fails, even in the bright shallows (seed %i)', (seed) => {
    const g = new Game(data, MISSION, seed);
    for (const e of SHALLOWS) g.intervene(e.split(':')[0], e.split(':')[1]);
    g.advance(20);
    const planted = at(g, 'D7').plant_cover;
    expect(planted).toBeGreaterThan(3);
    g.advance(60);
    expect(at(g, 'D7').plant_cover).toBeLessThan(planted / 4);
    while (!g.outcome) g.advance(30);
    expect(g.outcome!.success).toBe(false);
  });

  it.each(SEEDS)('carp removal without a barrier works briefly, then carp recolonise (seed %i)', (seed) => {
    const startSecchi = new Game(data, MISSION, seed).sim.aggregate('secchi');
    let peakSecchi = 0;
    let carpLow = Infinity;
    const g = play(seed, { 0: ['carp_removal'], 40: SHALLOWS }, (game) => {
      peakSecchi = Math.max(peakSecchi, game.sim.aggregate('secchi'));
      carpLow = Math.min(carpLow, game.sim.aggregate('carp'));
    });
    // The water clears for a while...
    expect(peakSecchi).toBeGreaterThan(1.5 * startSecchi);
    // ...then fish from upstream take the pond back.
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
    expect(g.sim.aggregate('carp')).toBeLessThan(200);
  });

  it('plants spread from planted tiles to unplanted ones, nearest first', () => {
    const g = new Game(data, MISSION, 1);
    g.intervene('carp_removal', INLET);
    g.intervene('carp_barrier', INLET);
    g.advance(40);
    g.intervene('plant_submerged', 'G9');
    g.advance(500);
    expect(at(g, 'G8').plant_cover).toBeGreaterThan(5);
    expect(at(g, 'G8').plant_cover).toBeGreaterThan(at(g, 'G6').plant_cover);
  });

  it('one planted tile is not enough; several are', () => {
    const one = play(1, { 0: ['carp_removal', 'carp_barrier'], 40: ['plant_submerged:G9'] });
    expect(one.outcome!.success).toBe(false);
    const three = play(1, { 0: ['carp_removal', 'carp_barrier'], 40: ['D7', 'G9', 'J7'].map((t) => `plant_submerged:${t}`) });
    expect(three.outcome!.value).toBeGreaterThan(one.outcome!.value + 20);
  });

  it('the winning plan fits inside the budget with room for diagnosis', () => {
    const cost = ['carp_removal', 'carp_barrier', ...SHALLOWS.map((e) => e.split(':')[0])].reduce((s, id) => s + data.interventions.get(id)!.cost, 0);
    const waterTiles = new Game(data, MISSION, 1).waterTileIds().length;
    const diagnosis = ['secchi_disk', 'water_grab', 'fish_survey'].reduce((s, id) => s + data.methods.get(id)!.cost, 0);
    const budget = data.missions.get(MISSION)!.budget;
    expect(cost + diagnosis).toBeLessThanOrEqual(budget);
    // But not so much room that the player can sample every tile with every method.
    const tileMethods = [...data.methods.values()].filter((m) => m.scope === 'tile').reduce((s, m) => s + m.cost, 0);
    expect(tileMethods * waterTiles).toBeGreaterThan(budget);
  });

  it('shows hysteresis: at the same carp level, clear and turbid states both persist', { timeout: 120_000 }, () => {
    const mission = data.missions.get(MISSION)!;
    const HOLD = 200;
    const runHeld = (sim: Simulation, days: number) => {
      for (let i = 0; i < days; i++) {
        for (const i of water) sim.tiles[i].values.carp = HOLD;
        sim.step(1);
      }
    };

    // Turbid branch: start from the degraded pond and lower carp to HOLD.
    const turbid = new Simulation(data, mission, 1);
    turbid.step(mission.spinup_days);
    const water = turbid.grid.waterTiles().map((t) => t.index);
    runHeld(turbid, 3 * 365);

    // Clear branch: restore the pond fully, then raise carp to HOLD.
    const clear = new Simulation(data, mission, 1);
    clear.step(mission.spinup_days);
    clear.startIntervention(data.interventions.get('carp_removal')!);
    clear.startIntervention(data.interventions.get('carp_barrier')!);
    clear.step(40);
    for (const e of SHALLOWS) clear.startIntervention(data.interventions.get('plant_submerged')!, e.split(':')[1]);
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
