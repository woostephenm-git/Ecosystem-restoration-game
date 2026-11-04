// The bed profile drawn in the investigation view: a straight cut through the tile from its
// shallowest point to its deepest. Pure geometry from the map, so it can be tested headless.
import type { Game } from '../sim/game';
import type { Terrain } from '../sim/schema';

export interface Profile {
  /** Water depth (m) at evenly spaced points from the left end to the right; negative is dry bank. */
  depths: number[];
  /** Compass direction each end faces, e.g. 'NW' on the left and 'SE' on the right. */
  left: string;
  right: string;
  /** Whether the shallow end is on the left. */
  shallowLeft: boolean;
  /** Unit vector from the left end to the right in map coordinates (x east, z south). */
  along: { x: number; z: number };
}

interface Pt {
  x: number;
  z: number;
}

function unit(a: Pt, b: Pt): { x: number; z: number } {
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
}

const COMPASS = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];
/** Compass point of a direction in map coordinates (x east, z south). */
function compass(dx: number, dz: number): string {
  const a = Math.atan2(-dz, dx);
  return COMPASS[(Math.round(a / (Math.PI / 4)) + 8) % 8];
}

/**
 * The shallowest point goes at one end and the deepest at the other. The shallow end sits on
 * the side it lies towards, east or west: on the right if it is further east than the deep
 * point, otherwise on the left (including a tie).
 */
function orient<P extends Pt>(shallow: P, deep: P): { a: P; b: P; shallowLeft: boolean } {
  const shallowLeft = !(shallow.x > deep.x + 1e-9);
  return shallowLeft ? { a: shallow, b: deep, shallowLeft } : { a: deep, b: shallow, shallowLeft };
}

export function tileProfile(game: Game, tileId: string, n = 48): Profile {
  const grid = game.sim.grid;
  const map = grid.map;
  const rise = map.level_variable ? (game.sim.boundary[map.level_variable] ?? 0) : 0;
  const terrain = map.terrain ? game.data.terrains.get(map.terrain) : undefined;
  return terrain ? fromTerrain(terrain, grid.tiles[grid.indexOf(tileId)], rise, n) : fromNeighbours(game, tileId, rise, n);
}

/** Bed height at map coordinates (tiles; x east, z south), bilinear from the baked heightfield. */
function heightAt(t: Terrain, x: number, z: number): number {
  const g = t.size * t.resolution;
  const fx = Math.min(g, Math.max(0, (x - t.origin) * t.resolution));
  const fz = Math.min(g, Math.max(0, (z - t.origin) * t.resolution));
  const i = Math.min(g - 1, Math.floor(fx));
  const j = Math.min(g - 1, Math.floor(fz));
  const tx = fx - i;
  const tz = fz - j;
  const h = (a: number, b: number) => t.heights[b * (g + 1) + a];
  return (h(i, j) * (1 - tx) + h(i + 1, j) * tx) * (1 - tz) + (h(i, j + 1) * (1 - tx) + h(i + 1, j + 1) * tx) * tz;
}

function fromTerrain(t: Terrain, tile: { row: number; col: number }, rise: number, n: number): Profile {
  // Search a fine lattice inside the tile for its highest and lowest bed points.
  const S = 16;
  let hi: Pt & { h: number } = { x: 0, z: 0, h: -Infinity };
  let lo: Pt & { h: number } = { x: 0, z: 0, h: Infinity };
  for (let j = 0; j <= S; j++)
    for (let i = 0; i <= S; i++) {
      const x = tile.col + 0.02 + (0.96 * i) / S;
      const z = tile.row + 0.02 + (0.96 * j) / S;
      const h = heightAt(t, x, z);
      if (h > hi.h) hi = { x, z, h };
      if (h < lo.h) lo = { x, z, h };
    }
  // A flat tile has no gradient to follow: cut it west to east through the middle.
  if (hi.h - lo.h < 1e-6) {
    hi = { x: tile.col + 0.02, z: tile.row + 0.5, h: hi.h };
    lo = { x: tile.col + 0.98, z: tile.row + 0.5, h: lo.h };
  }
  const { a, b, shallowLeft } = orient(hi, lo);
  const surface = t.water_level + rise;
  const depths = Array.from({ length: n }, (_, k) => {
    const f = k / (n - 1);
    return surface - heightAt(t, a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f);
  });
  return { depths, left: compass(a.x - b.x, a.z - b.z), right: compass(b.x - a.x, b.z - a.z), shallowLeft, along: unit(a, b) };
}

/**
 * Without a heightfield a tile has one bed elevation. Each end of the cut is set halfway
 * towards the highest and the lowest neighbouring tile, so there is still a real gradient.
 */
function fromNeighbours(game: Game, tileId: string, rise: number, n: number): Profile {
  const g = game.sim.grid;
  const t = g.tiles[g.indexOf(tileId)];
  const bed = (row: number, col: number) => game.sim.tile(g.at(row, col)!.id).values.bed_elevation;
  const here = bed(t.row, t.col);
  const around = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]
    .filter(([dr, dc]) => g.at(t.row + dr, t.col + dc))
    .map(([dr, dc]) => ({ x: t.col + 0.5 + dc / 2, z: t.row + 0.5 + dr / 2, h: (here + bed(t.row + dr, t.col + dc)) / 2 }));
  if (!around.length) around.push({ x: t.col, z: t.row + 0.5, h: here }, { x: t.col + 1, z: t.row + 0.5, h: here });
  const hi = around.reduce((m, p) => (p.h > m.h ? p : m));
  let lo = around.reduce((m, p) => (p.h < m.h ? p : m));
  if (lo === hi) lo = { x: 2 * t.col + 1 - hi.x, z: 2 * t.row + 1 - hi.z, h: hi.h };
  const { a, b, shallowLeft } = orient(hi, lo);
  const surface = g.map.water_level + rise;
  // Through the tile's own elevation at the middle of the cut.
  const depths = Array.from({ length: n }, (_, k) => {
    const f = k / (n - 1);
    const h = f < 0.5 ? a.h + (here - a.h) * (f / 0.5) : here + (b.h - here) * ((f - 0.5) / 0.5);
    return surface - h;
  });
  return { depths, left: compass(a.x - b.x, a.z - b.z), right: compass(b.x - a.x, b.z - a.z), shallowLeft, along: unit(a, b) };
}
