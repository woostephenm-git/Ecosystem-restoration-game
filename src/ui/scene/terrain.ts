// Terrain height field for the 3D map. Pure functions, no three.js, so it can be tested headless.
// Map coordinates: x runs east, z runs south, one sim tile spans TILE units.
// The water surface sits at height 0; the pond bed is minus the tile's measured depth.

export const TILE = 4;

export function hash2(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

export function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x: number, y: number): number {
  return 0.5 * vnoise(x, y) + 0.3 * vnoise(x * 2.1 + 5.2, y * 2.1 + 1.3) + 0.2 * vnoise(x * 4.3 + 9.1, y * 4.3 + 3.7);
}

export function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function distSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz)));
  return Math.hypot(px - ax - vx * t, pz - az - vz * t);
}

export interface PondShape {
  rows: number;
  cols: number;
  /** Water depth of each tile, indexed [row][col]. */
  depth: number[][];
  /** Channels as polylines in map coordinates, e.g. the inlet and outlet. */
  channels: [number, number][][];
}

/** Bilinear depth between tile centres, held flat beyond the outer centres. */
function pondDepth(shape: PondShape, x: number, z: number): number {
  const fc = Math.min(shape.cols - 1, Math.max(0, x / TILE - 0.5));
  const fr = Math.min(shape.rows - 1, Math.max(0, z / TILE - 0.5));
  const c0 = Math.floor(fc);
  const r0 = Math.floor(fr);
  const c1 = Math.min(shape.cols - 1, c0 + 1);
  const r1 = Math.min(shape.rows - 1, r0 + 1);
  const tc = fc - c0;
  const tr = fr - r0;
  const d = shape.depth;
  const top = d[r0][c0] + (d[r0][c1] - d[r0][c0]) * tc;
  const bottom = d[r1][c0] + (d[r1][c1] - d[r1][c0]) * tc;
  return top + (bottom - top) * tr;
}

/** Gently rolling land around the pond, adapted from the specimen bench's base terrain. */
function land(x: number, z: number): number {
  let h = 0.25 + 0.32 * fbm(x * 0.22 + 3, z * 0.22 + 7) + 0.35 * (fbm(x * 0.06 + 40, z * 0.06 + 12) - 0.45);
  h += 1.1 * Math.exp(-((x - 18) ** 2 + (z + 5) ** 2) / 30) + 0.9 * Math.exp(-((x + 7) ** 2 + (z + 4) ** 2) / 22);
  return h;
}

/** Height function H(x, z) for a pond that fills the playable square. */
export function makeHeight(shape: PondShape): (x: number, z: number) => number {
  const W = shape.cols * TILE;
  const D = shape.rows * TILE;
  return (x, z) => {
    // How far outside the playable square, with a ragged shoreline and rounded corners.
    const ox = Math.max(-x, x - W, 0);
    const oz = Math.max(-z, z - D, 0);
    const out = Math.hypot(ox, oz) + 0.55 * (fbm(x * 0.45 + 11, z * 0.45 + 2) - 0.5);
    const bed = -pondDepth(shape, x, z) + 0.06 * (vnoise(x * 1.3, z * 1.3) - 0.5);
    let h = bed + (land(x, z) - bed) * smooth(0.1, 1.4, out);
    // Carve channels (inlet, outlet) down to a shallow streambed.
    let dmin = Infinity;
    for (const C of shape.channels) for (let i = 0; i < C.length - 1; i++) dmin = Math.min(dmin, distSeg(x, z, ...C[i], ...C[i + 1]));
    const cb = smooth(0.9, 0.1, dmin + 0.15 * (vnoise(x * 1.5, z * 1.5) - 0.5));
    h += (Math.min(h, -0.32 + 0.08 * (vnoise(x * 0.7 + 3, z * 0.7) - 0.5)) - h) * cb;
    return h;
  };
}

/** A gently meandering channel from a tile face out past the edge of the world. */
export function channelFrom(face: 'N' | 'E' | 'S' | 'W', row: number, col: number, shape: PondShape, reach = 24): [number, number][] {
  const cx = (col + 0.5) * TILE;
  const cz = (row + 0.5) * TILE;
  const W = shape.cols * TILE;
  const D = shape.rows * TILE;
  const start: [number, number] = face === 'W' ? [0.6, cz] : face === 'E' ? [W - 0.6, cz] : face === 'N' ? [cx, 0.6] : [cx, D - 0.6];
  const dir: [number, number] = face === 'W' ? [-1, 0] : face === 'E' ? [1, 0] : face === 'N' ? [0, -1] : [0, 1];
  const side: [number, number] = [-dir[1], dir[0]];
  const pts: [number, number][] = [start];
  for (let s = 2; s <= reach; s += 3) {
    const wiggle = Math.sin(s * 0.45 + row * 1.7 + col) * Math.min(1.6, s * 0.12);
    pts.push([start[0] + dir[0] * s + side[0] * wiggle, start[1] + dir[1] * s + side[1] * wiggle]);
  }
  return pts;
}
