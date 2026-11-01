// Times the simulation core: npx tsx scripts/profile-sim.ts
import { loadNodeData } from '../src/data/node';
import { Simulation } from '../src/sim/engine';

const data = loadNodeData();
const mission = data.missions.get('m01_clearwater_pond')!;
const sim = new Simulation(data, mission, 1);
sim.step(30);
console.log('substeps per day:', sim.substeps(), ' water tiles:', sim.grid.waterTiles().length);
const t0 = performance.now();
sim.step(365);
console.log(`one simulated year: ${(performance.now() - t0).toFixed(0)} ms`);
