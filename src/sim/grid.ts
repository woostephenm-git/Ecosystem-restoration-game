// Static map geometry: neighbours, D8 flow directions and flow accumulation.
// Pure functions of the map data and initial tile state; no simulation state.
import type { GameMap } from './schema';

export const OFF_MAP = -1;

export interface GridTile {
  index: number;
  id: string;
  row: number;
  col: number;
  description: string;
  water: boolean;
}

const D8 = [
  [-1, 0],
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 1],
  [1, 1],
  [1, -1],
  [-1, -1],
] as const;

export class Grid {
  readonly tiles: GridTile[];
  readonly rows: number;
  readonly cols: number;
  readonly area: number;
  /** Water neighbours sharing a face (used for mixing and dispersal). */
  readonly neighbours4: number[][];
  /** D8 receiver of each tile's outflow: a tile index, OFF_MAP through an outlet, or null for no outflow. */
  readonly receiver: (number | null)[];
  /** Tiles that drain into each tile. */
  readonly donors: number[][];
  /** Fraction of the total inlet discharge entering each tile directly from an inlet. */
  readonly inletShare: number[];
  /** Fraction of the total inlet discharge passing through each tile. */
  readonly throughShare: number[];
  /** Tile indices ordered upstream to downstream. */
  readonly flowOrder: number[];
  private readonly index = new Map<string, number>();

  constructor(
    readonly map: GameMap,
    /** Water surface elevation of each tile, in map tile order. Water tiles have positive depth. */
    surface: number[],
    depth: number[],
  ) {
    this.rows = map.rows;
    this.cols = map.cols;
    this.area = map.tile_size_m * map.tile_size_m;
    this.tiles = map.tiles.map((t, i) => ({ index: i, id: t.id, row: t.row, col: t.col, description: t.description, water: depth[i] > 0 }));
    this.tiles.forEach((t) => this.index.set(t.id, t.index));

    const at = (r: number, c: number) => this.tiles.find((t) => t.row === r && t.col === c);
    this.neighbours4 = this.tiles.map((t) =>
      t.water ? D8.slice(0, 4).flatMap(([dr, dc]) => at(t.row + dr, t.col + dc) ?? []).filter((n) => n.water).map((n) => n.index) : [],
    );
    const neighbours8 = this.tiles.map((t) =>
      D8.flatMap(([dr, dc]) => {
        const n = at(t.row + dr, t.col + dc);
        return n?.water ? [{ index: n.index, dist: dr && dc ? Math.SQRT2 : 1 }] : [];
      }),
    );

    // Breadth-first distance to the nearest outlet across water tiles, used to route across flat water.
    const outletTiles = new Set(map.outlets.map((o) => this.index.get(o.tile)!));
    const toOutlet = this.tiles.map(() => Infinity);
    const queue = [...outletTiles];
    queue.forEach((i) => (toOutlet[i] = 0));
    while (queue.length) {
      const i = queue.shift()!;
      for (const n of neighbours8[i]) {
        if (toOutlet[n.index] === Infinity) {
          toOutlet[n.index] = toOutlet[i] + 1;
          queue.push(n.index);
        }
      }
    }

    const EPS = 1e-6;
    this.receiver = this.tiles.map((t) => {
      if (!t.water) return null;
      if (outletTiles.has(t.index)) return OFF_MAP;
      let best: number | null = null;
      let bestDrop = EPS;
      for (const n of neighbours8[t.index]) {
        const drop = (surface[t.index] - surface[n.index]) / n.dist;
        if (drop > bestDrop) {
          bestDrop = drop;
          best = n.index;
        }
      }
      if (best !== null) return best;
      // Flat water surface: step toward the outlet, preferring face neighbours over diagonals.
      const closer = neighbours8[t.index]
        .filter((n) => toOutlet[n.index] < toOutlet[t.index] && Math.abs(surface[n.index] - surface[t.index]) <= EPS)
        .sort((a, b) => toOutlet[a.index] - toOutlet[b.index] || a.dist - b.dist || a.index - b.index);
      return closer[0]?.index ?? null;
    });

    this.donors = this.tiles.map(() => []);
    this.receiver.forEach((r, i) => {
      if (r !== null && r !== OFF_MAP) this.donors[r].push(i);
    });

    this.inletShare = this.tiles.map(() => 0);
    const totalShare = map.inlets.reduce((s, i) => s + i.share, 0);
    for (const inlet of map.inlets) this.inletShare[this.index.get(inlet.tile)!] += inlet.share / totalShare;

    // Topological order over the D8 graph (it has no cycles: each step drops or moves closer to an outlet).
    const indegree = this.donors.map((d) => d.length);
    const ready = this.tiles.filter((t) => indegree[t.index] === 0).map((t) => t.index);
    this.flowOrder = [];
    while (ready.length) {
      const i = ready.shift()!;
      this.flowOrder.push(i);
      const r = this.receiver[i];
      if (r !== null && r !== OFF_MAP && --indegree[r] === 0) ready.push(r);
    }
    this.throughShare = this.tiles.map(() => 0);
    for (const i of this.flowOrder) {
      this.throughShare[i] += this.inletShare[i];
      const r = this.receiver[i];
      if (r !== null && r !== OFF_MAP) this.throughShare[r] += this.throughShare[i];
    }
  }

  indexOf(tileId: string): number {
    const i = this.index.get(tileId);
    if (i === undefined) throw new Error(`Unknown tile ${tileId}`);
    return i;
  }

  waterTiles(): GridTile[] {
    return this.tiles.filter((t) => t.water);
  }
}
