// Static map geometry: neighbours, water flow and land runoff directions.
// Pure functions of the map data and initial tile state; no simulation state.
import type { GameMap } from './schema';

export const OFF_MAP = -1;

export interface GridTile {
  index: number;
  id: string;
  row: number;
  col: number;
  description: string;
  /** Water body id, or null on land. */
  body: string | null;
  /** Part of a simulated water body. Only these tiles run the sim. */
  water: boolean;
}

/** One face-to-face water flow, as a fraction of the total inlet discharge. */
export interface Flow {
  /** Tile index, or OFF_MAP when the water leaves through an outlet. */
  to: number;
  share: number;
}

const D4 = [
  [-1, 0],
  [0, 1],
  [1, 0],
  [0, -1],
] as const;
const D8 = [...D4, [-1, 1], [1, 1], [1, -1], [-1, -1]] as const;

export class Grid {
  readonly tiles: GridTile[];
  readonly rows: number;
  readonly cols: number;
  readonly area: number;
  /** Simulated water neighbours sharing a face (used for flow, mixing and dispersal). */
  readonly neighbours4: number[][];
  /** Water leaving each tile, by face. */
  readonly outflows: Flow[][];
  /** Water entering each tile from other tiles (`to` holds the source tile). */
  readonly inflows: Flow[][];
  /** Fraction of the total inlet discharge entering each tile directly from an inlet. */
  readonly inletShare: number[];
  /** Fraction of the total inlet discharge passing through each tile. */
  readonly throughShare: number[];
  /** Net flow direction on each water tile, in tiles (x east, z south), scaled by throughShare. */
  readonly flowVector: { x: number; z: number }[];
  /** Steepest-descent (D8) neighbour that land runoff drains to; null for water, OFF_MAP for a pit. */
  readonly runoffTo: (number | null)[];
  private readonly index = new Map<string, number>();

  constructor(
    readonly map: GameMap,
    /** Water depth of each tile, in map tile order. */
    depth: number[],
    /** Bed (ground) elevation of each tile, in map tile order. */
    elevation: number[],
    /** Land tiles the pond has flooded into; they join the simulated pond. */
    flooded: ReadonlySet<number> = new Set(),
  ) {
    this.rows = map.rows;
    this.cols = map.cols;
    this.area = map.tile_size_m * map.tile_size_m;
    const simulated = new Set(map.bodies.filter((b) => b.simulated).map((b) => b.id));
    const pondBody = map.bodies.find((b) => b.simulated)?.id ?? null;
    this.tiles = map.tiles.map((t, i) => {
      const wet = flooded.has(i);
      return {
        index: i,
        id: t.id,
        row: t.row,
        col: t.col,
        description: wet ? 'Flooded meadow' : t.description,
        body: wet ? pondBody : (t.body ?? null),
        water: (wet || (!!t.body && simulated.has(t.body))) && depth[i] > 0,
      };
    });
    this.tiles.forEach((t) => this.index.set(t.id, t.index));
    const cell = new Map(this.tiles.map((t) => [`${t.row},${t.col}`, t]));
    const at = (r: number, c: number) => cell.get(`${r},${c}`);

    this.neighbours4 = this.tiles.map((t) =>
      t.water ? D4.flatMap(([dr, dc]) => at(t.row + dr, t.col + dc) ?? []).filter((n) => n.water).map((n) => n.index) : [],
    );

    // Steady flow through the water (ported from the bench's solveSteadyFlow): solve
    // div(T grad phi) = 0 with transmissivity T = depth, phi = 1 at inlets and 0 at outlets,
    // no flow across shores. Face flux = T_face × (phi_i − phi_j), normalised to the inlet total.
    const inlet = new Set(map.inlets.map((x) => this.index.get(x.tile)!));
    const outlet = new Set(map.outlets.map((x) => this.index.get(x.tile)!));
    const phi = this.tiles.map((t) => 1 - t.col / Math.max(1, this.cols - 1));
    const trans = (i: number, j: number) => (2 * depth[i] * depth[j]) / (depth[i] + depth[j]);
    for (const i of inlet) phi[i] = 1;
    for (const i of outlet) phi[i] = 0;
    const free = this.tiles.filter((t) => t.water && !inlet.has(t.index) && !outlet.has(t.index)).map((t) => t.index);
    for (let it = 0; it < 4000; it++) {
      let change = 0;
      for (const i of free) {
        let s = 0;
        let w = 0;
        for (const j of this.neighbours4[i]) {
          const tij = trans(i, j);
          s += tij * phi[j];
          w += tij;
        }
        if (w <= 0) continue;
        const next = phi[i] + 1.85 * (s / w - phi[i]);
        change = Math.max(change, Math.abs(next - phi[i]));
        phi[i] = next;
      }
      if (change < 1e-10) break;
    }

    const raw: Flow[][] = this.tiles.map(() => []);
    for (const t of this.tiles) {
      if (!t.water) continue;
      for (const j of this.neighbours4[t.index]) {
        const f = trans(t.index, j) * (phi[t.index] - phi[j]);
        if (f > 0) raw[t.index].push({ to: j, share: f });
      }
    }
    const total = [...inlet].reduce((s, i) => s + raw[i].reduce((a, f) => a + f.share, 0), 0);
    const norm = total > 0 ? 1 / total : 0;
    this.outflows = raw.map((list) => list.map((f) => ({ to: f.to, share: f.share * norm })));
    this.inflows = this.tiles.map(() => []);
    this.outflows.forEach((list, i) => list.forEach((f) => this.inflows[f.to].push({ to: i, share: f.share })));
    // Inlets supply what leaves them; outlets pass on what reaches them.
    this.inletShare = this.tiles.map((t) => (inlet.has(t.index) ? this.outflows[t.index].reduce((s, f) => s + f.share, 0) : 0));
    for (const i of outlet) {
      const arriving = this.inflows[i].reduce((s, f) => s + f.share, 0);
      if (arriving > 0) this.outflows[i].push({ to: OFF_MAP, share: arriving });
    }
    this.throughShare = this.tiles.map((_, i) => this.inletShare[i] + this.inflows[i].reduce((s, f) => s + f.share, 0));
    this.flowVector = this.tiles.map((t, i) => {
      const v = { x: 0, z: 0 };
      for (const f of this.outflows[i]) {
        if (f.to === OFF_MAP) {
          const face = map.outlets.find((o) => o.tile === t.id)!.face;
          v.x += f.share * (face === 'E' ? 1 : face === 'W' ? -1 : 0);
          v.z += f.share * (face === 'S' ? 1 : face === 'N' ? -1 : 0);
        } else {
          v.x += f.share * (this.tiles[f.to].col - t.col);
          v.z += f.share * (this.tiles[f.to].row - t.row);
        }
      }
      if (inlet.has(i)) {
        const face = map.inlets.find((o) => o.tile === t.id)!.face;
        v.x += this.inletShare[i] * (face === 'W' ? 1 : face === 'E' ? -1 : 0);
        v.z += this.inletShare[i] * (face === 'N' ? 1 : face === 'S' ? -1 : 0);
      }
      return v;
    });

    // Land runoff: steepest descent over all eight neighbours (display only in Mission 1).
    this.runoffTo = this.tiles.map((t) => {
      if (t.body) return null;
      let best = OFF_MAP;
      let drop = 0;
      for (const [dr, dc] of D8) {
        const nb = at(t.row + dr, t.col + dc);
        if (!nb) continue;
        const d = (elevation[t.index] - elevation[nb.index]) / Math.hypot(dr, dc);
        if (d > drop) {
          drop = d;
          best = nb.index;
        }
      }
      return best;
    });
  }

  indexOf(tileId: string): number {
    const i = this.index.get(tileId);
    if (i === undefined) throw new Error(`Unknown tile ${tileId}`);
    return i;
  }

  waterTiles(): GridTile[] {
    return this.tiles.filter((t) => t.water);
  }

  /** Tile at a grid position, if any. */
  at(row: number, col: number): GridTile | undefined {
    return this.tiles.find((t) => t.row === row && t.col === col);
  }
}
