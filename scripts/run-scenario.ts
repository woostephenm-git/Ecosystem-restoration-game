// Headless scenario runner for tuning: npm run sim -- <scenario> [seed]
// Prints pond means every 90 days, then a map of final plant cover.
import { loadNodeData } from '../src/data/node';
import { Game } from '../src/sim/game';

const data = loadNodeData();
const scenario = process.argv[2] ?? 'nothing';
const seed = Number(process.argv[3] ?? 1);

/** Interventions by mission day. Tile-scoped ones name their tile after a colon. */
type Plan = Record<number, string[]>;
const plant = (...tiles: string[]) => tiles.map((t) => `plant_submerged:${t}`);
const SHALLOWS = plant('D7', 'E8', 'G9', 'H9', 'J7', 'K8');
const DEEP = plant('F7', 'G7', 'H7', 'G8', 'H8', 'G6');
const plans: Record<string, Plan> = {
  nothing: {},
  plant: { 0: SHALLOWS },
  removal: { 0: ['carp_removal'], 40: SHALLOWS },
  solution: { 0: ['carp_removal', 'carp_barrier'], 40: SHALLOWS },
  solution_noplant: { 0: ['carp_removal', 'carp_barrier'] },
  solution3: { 0: ['carp_removal', 'carp_barrier'], 40: plant('D7', 'G9', 'J7') },
  solution1: { 0: ['carp_removal', 'carp_barrier'], 40: plant('G9') },
  solution_deep: { 0: ['carp_removal', 'carp_barrier'], 40: DEEP },
  full: { 0: ['carp_removal', 'carp_barrier', 'alum_treatment'], 40: SHALLOWS },
  herrings: { 0: ['barley_straw', 'algaecide', 'nitrate_agreement', 'raise_weir'] },
  herrings_planted: { 0: ['barley_straw', 'algaecide', 'nitrate_agreement'], 40: SHALLOWS },
  solution3_weir: { 0: ['carp_removal', 'carp_barrier', 'raise_weir'], 40: plant('D7', 'G9', 'J7') },
};
const plan = plans[scenario];
if (!plan) throw new Error(`Unknown scenario ${scenario}. Try: ${Object.keys(plans).join(', ')}`);

const t0 = performance.now();
const game = new Game(data, 'm01_clearwater_pond', seed);
const spinupMs = performance.now() - t0;
const sim = game.sim;
const cols = ['carp', 'plant_cover', 'suspended_sediment', 'chla', 'total_p', 'secchi', 'light_bed', 'bottom_do', 'legacy_p'];
console.log(`scenario: ${scenario}  seed: ${seed}  spin-up ${spinupMs.toFixed(0)} ms  (pond means)`);
console.log(['day', ...cols].map((c) => c.slice(0, 9).padStart(9)).join(' '));
const show = (x: number) => x.toFixed(x < 10 ? 2 : 0).padStart(9);
while (!game.outcome) {
  for (const entry of plan[game.day] ?? []) {
    const [id, tile] = entry.split(':');
    if (!game.intervene(id, tile ?? game.sim.grid.map.inlets[0].tile)) console.log(`  day ${game.day}: could not start ${entry}`);
  }
  if (game.day % 90 === 0) console.log([String(game.day).padStart(9), ...cols.map((c) => show(sim.aggregate(c)))].join(' '));
  game.advance(1);
}
console.log(`outcome: ${game.outcome.success ? 'SUCCESS' : 'fail'}  mean cover ${game.outcome.value.toFixed(1)}%  budget left $${game.budget}`);

// Final plant cover on each pond tile; land is '.', scenery water '~'.
const g = sim.grid;
console.log('plant cover %   ' + Array.from({ length: g.cols }, (_, c) => 'ABCDEFGHIJKL'[c].padStart(4)).join(''));
for (let r = 0; r < g.rows; r++) {
  const row = Array.from({ length: g.cols }, (_, c) => {
    const t = g.at(r, c)!;
    if (!t.water) return (t.body ? '~' : '.').padStart(4);
    return sim.tiles[t.index].values.plant_cover.toFixed(0).padStart(4);
  });
  if (row.some((x) => x.trim() !== '.')) console.log(`${String(r + 1).padStart(15)} ${row.join('')}`);
}
