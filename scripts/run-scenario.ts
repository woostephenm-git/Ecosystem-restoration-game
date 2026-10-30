// Headless scenario runner for tuning: npm run sim -- <scenario> [seed]
// Prints pond means every 60 days, then final plant cover per tile.
import { loadNodeData } from '../src/data/node';
import { Game } from '../src/sim/game';

const data = loadNodeData();
const scenario = process.argv[2] ?? 'nothing';
const seed = Number(process.argv[3] ?? 1);

/** Interventions by mission day. Tile-scoped ones name their tile after a colon. */
type Plan = Record<number, string[]>;
const SHALLOWS = ['plant_submerged:A1', 'plant_submerged:A3', 'plant_submerged:C3'];
const plans: Record<string, Plan> = {
  nothing: {},
  plant: { 0: SHALLOWS },
  removal: { 0: ['carp_removal'], 40: SHALLOWS },
  solution: { 0: ['carp_removal', 'carp_barrier'], 40: SHALLOWS },
  solution_noplant: { 0: ['carp_removal', 'carp_barrier'] },
  solution_deep: { 0: ['carp_removal', 'carp_barrier'], 40: ['plant_submerged:B2', 'plant_submerged:C2', 'plant_submerged:B3'] },
  full: { 0: ['carp_removal', 'carp_barrier', 'alum_treatment'], 40: SHALLOWS },
};
const plan = plans[scenario];
if (!plan) throw new Error(`Unknown scenario ${scenario}. Try: ${Object.keys(plans).join(', ')}`);

const game = new Game(data, 'm01_clearwater_pond', seed);
const sim = game.sim;
const cols = ['carp', 'plant_cover', 'suspended_sediment', 'chla', 'total_p', 'secchi', 'light_bed', 'bottom_do', 'legacy_p'];
console.log(`scenario: ${scenario}  seed: ${seed}  (pond means)`);
console.log(['day', ...cols].map((c) => c.slice(0, 9).padStart(9)).join(' '));
const show = (x: number) => x.toFixed(x < 10 ? 2 : 0).padStart(9);
while (!game.outcome) {
  for (const entry of plan[game.day] ?? []) {
    const [id, tile] = entry.split(':');
    if (!game.intervene(id, tile ?? 'B1')) console.log(`  day ${game.day}: could not start ${entry}`);
  }
  if (game.day % 60 === 0) console.log([String(game.day).padStart(9), ...cols.map((c) => show(sim.aggregate(c)))].join(' '));
  game.advance(1);
}
console.log(`outcome: ${game.outcome.success ? 'SUCCESS' : 'fail'}  mean cover ${game.outcome.value.toFixed(1)}%  budget left $${game.budget}`);
const grid = sim.grid;
for (let r = 0; r < grid.rows; r++) {
  const row = grid.tiles.filter((t) => t.row === r).sort((a, b) => a.col - b.col);
  console.log(
    row
      .map((t) => {
        const v = sim.tiles[t.index].values;
        return `${t.id} d${v.water_depth.toFixed(1)} plants ${v.plant_cover.toFixed(0).padStart(3)}% carp ${v.carp.toFixed(0).padStart(3)} light ${v.light_bed.toFixed(0).padStart(2)}%`;
      })
      .join(' | '),
  );
}
