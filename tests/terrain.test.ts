import { describe, expect, it } from 'vitest';
import { loadNodeData } from '../src/data/node';
import { Game } from '../src/sim/game';
import { TILE, channelFrom, makeHeight, type PondShape } from '../src/ui/scene/terrain';

const data = loadNodeData();

/** The 3D terrain must agree with the sim: same depths, water where the sim has water. */
describe('3D terrain from the sim map', () => {
  const g = new Game(data, 'm01_clearwater_pond', 1);
  const grid = g.sim.grid;
  const depth = Array.from({ length: grid.rows }, () => Array(grid.cols).fill(0));
  for (const t of grid.tiles) depth[t.row][t.col] = g.sim.tiles[t.index].values.water_depth;
  const shape: PondShape = { rows: grid.rows, cols: grid.cols, depth, channels: [] };
  for (const i of grid.map.inlets) {
    const t = grid.tiles[grid.indexOf(i.tile)];
    shape.channels.push(channelFrom(i.face, t.row, t.col, shape));
  }
  const H = makeHeight(shape);

  it('puts the bed at each tile centre at minus that tile’s depth', () => {
    for (const t of grid.tiles) {
      const h = H((t.col + 0.5) * TILE, (t.row + 0.5) * TILE);
      expect(h).toBeCloseTo(-depth[t.row][t.col], 1);
    }
  });

  it('keeps the whole playable square under water', () => {
    for (let x = 0.2; x < grid.cols * TILE; x += 0.5) for (let z = 0.2; z < grid.rows * TILE; z += 0.5) expect(H(x, z)).toBeLessThan(-0.2);
  });

  it('has dry land around the pond and water in the inlet channel', () => {
    expect(H(-6, -6)).toBeGreaterThan(0);
    expect(H(grid.cols * TILE + 6, grid.rows * TILE + 6)).toBeGreaterThan(0);
    // Every point along the inlet channel, out to the edge of the world, holds water.
    for (const [x, z] of shape.channels[0]) expect(H(x, z), `channel at ${x.toFixed(1)}, ${z.toFixed(1)}`).toBeLessThan(0);
  });
});
