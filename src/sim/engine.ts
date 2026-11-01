// Headless simulation core. Evaluates the variable graph defined in data.
// No rendering, UI or DOM dependencies: this module must run under Node.
import { applyTransform, evalLink } from './functions';
import { Grid, OFF_MAP } from './grid';
import type { DataBundle, NormalLink } from './loader';
import { Rng } from './rng';
import type { BoundaryConditions, Intervention, Mission, Variable } from './schema';

export interface TileState {
  id: string;
  values: Record<string, number>;
}

/** One source of a lateral input: another tile's variable, or a boundary variable. */
export interface LateralTerm {
  tile: number | null;
  variable: string;
  weight: number;
}

/** A lateral input on one tile: constant + sum of weight × source. */
export interface LateralCombo {
  constant: number;
  terms: LateralTerm[];
}

interface ActiveEffect {
  interventionId: string;
  variable: string;
  op: 'add' | 'multiply' | 'set';
  value: number;
  duration: number;
  daysLeft: number;
  /** Tiles affected, or null for every water tile. */
  tiles: string[] | null;
}

/** Persistent changes to boundary variables, e.g. a barrier cutting immigration. */
interface BoundaryModifier {
  mul: number;
  add: number;
}

export interface EdgeFluxes {
  /** Where water and organisms arrive from. */
  from: { inlets: string[]; upstream: string[]; mixing: string[] };
  /** Where this tile's outflow goes. */
  to: string;
  /** Variables crossing into the tile, by zone. */
  inflow: Record<string, string[]>;
  /** Variables carried out of the tile, by zone. */
  outflow: Record<string, string[]>;
}

/** Tile state at a moment in time, for restoring a spun-up pond without re-running it. */
export interface SimSnapshot {
  t: number;
  values: Record<string, number>[];
}

export class Simulation {
  /** Absolute simulated day, counted from the start of spin-up. */
  t = 0;
  readonly tiles: TileState[];
  readonly grid: Grid;
  readonly boundary: Record<string, number> = {};
  /** Lateral inputs per tile, as computed by the last map pass. */
  readonly lateral: Record<string, LateralCombo>[];
  private readonly modifiers: Record<string, BoundaryModifier> = {};
  private effects: ActiveEffect[] = [];
  private readonly rng: Rng;

  private readonly stocks: Variable[];
  private readonly derivedOrder: Variable[];
  private readonly boundaryVars: Variable[];
  private readonly lateralVars: Variable[];
  private readonly linksTo = new Map<string, NormalLink[]>();
  /** Cached for the inner loop: simulated water tile indices, and each stock with its incoming links. */
  private readonly waterIdx: number[];
  private readonly stockLinks: { v: Variable; links: NormalLink[] }[];
  private readonly bc: BoundaryConditions;

  constructor(
    readonly data: DataBundle,
    readonly mission: Mission,
    readonly seed: number,
  ) {
    this.rng = new Rng(seed).fork(1);
    const map = data.maps.get(mission.map)!;
    this.bc = data.boundaryConditions.get(mission.boundary_conditions)!;

    for (const link of data.links) {
      const list = this.linksTo.get(link.to) ?? [];
      list.push(link);
      this.linksTo.set(link.to, list);
    }

    const vars = [...data.variables.values()];
    this.stocks = vars.filter((v) => v.kind === 'stock');
    this.boundaryVars = vars.filter((v) => v.kind === 'boundary');
    this.lateralVars = vars.filter((v) => v.kind === 'lateral');
    this.derivedOrder = this.sortDerived(vars.filter((v) => v.kind === 'derived'));

    // Pond defaults apply to water only; land tiles carry just their own initial values.
    this.tiles = map.tiles.map((tile) => {
      const values: Record<string, number> = {};
      for (const v of this.stocks) values[v.id] = tile.initial[v.id] ?? (tile.body ? map.defaults[v.id] : undefined) ?? 0;
      return { id: tile.id, values };
    });
    this.lateral = this.tiles.map(() => ({}));

    const depth = this.tiles.map((t) => t.values.water_depth ?? 0);
    const elevation = this.tiles.map((t) => t.values.bed_elevation ?? 0);
    this.grid = new Grid(map, depth, elevation);
    this.waterIdx = this.grid.waterTiles().map((t) => t.index);
    this.stockLinks = this.stocks.map((v) => ({ v, links: this.linksTo.get(v.id) ?? [] }));

    this.updateBoundary();
    this.mapPass();
    this.updateAllDerived();
  }

  snapshot(): SimSnapshot {
    return { t: this.t, values: this.tiles.map((t) => ({ ...t.values })) };
  }

  /** Continue from a snapshot. Boundary noise comes from this simulation's own seed from here on. */
  restore(s: SimSnapshot) {
    this.t = s.t;
    s.values.forEach((v, i) => Object.assign(this.tiles[i].values, v));
    this.updateBoundary();
    this.mapPass();
    this.updateAllDerived();
  }

  /** Days since the player-facing mission clock started (negative during spin-up). */
  get missionDay(): number {
    return this.t - this.mission.spinup_days;
  }

  /** Calendar day of year (0-364), aligned so the mission starts on its configured day. */
  get dayOfYear(): number {
    return mod(this.mission.start.day_of_year - this.mission.spinup_days + this.t, 365);
  }

  tile(tileId: string): TileState {
    return this.tiles[this.grid.indexOf(tileId)];
  }

  /** Derived variables can depend on each other, so evaluate them in dependency order. */
  private sortDerived(derived: Variable[]): Variable[] {
    const ids = new Set(derived.map((v) => v.id));
    const order: Variable[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (v: Variable, path: string[]) => {
      if (state.get(v.id) === 'done') return;
      if (state.get(v.id) === 'visiting') throw new Error(`Derived variables form a cycle: ${[...path, v.id].join(' -> ')}`);
      state.set(v.id, 'visiting');
      for (const link of this.linksTo.get(v.id) ?? []) {
        for (const src of link.from) if (ids.has(src) && src !== v.id) visit(this.data.variables.get(src)!, [...path, v.id]);
      }
      state.set(v.id, 'done');
      order.push(v);
    };
    derived.forEach((v) => visit(v, []));
    return order;
  }

  lookup(tile: TileState): (id: string) => number {
    return (id) => tile.values[id] ?? this.boundary[id] ?? 0;
  }

  /** Evaluate one derived variable against arbitrary inputs. Used for model-based estimates. */
  evalDerived(variableId: string, get: (id: string) => number): number {
    const v = this.data.variables.get(variableId)!;
    let sum = v.derived!.base;
    for (const link of this.linksTo.get(v.id) ?? []) sum += evalLink(link, get);
    return clamp(v, applyTransform(v.derived!.transform, sum));
  }

  /** Derived variables only mean something on simulated water tiles. */
  private updateAllDerived() {
    for (const i of this.waterIdx) this.updateDerived(this.tiles[i]);
  }

  private updateDerived(tile: TileState) {
    const get = this.lookup(tile);
    for (const v of this.derivedOrder) tile.values[v.id] = this.evalDerived(v.id, get);
  }

  private updateBoundary() {
    for (const v of this.boundaryVars) {
      const spec = this.bc.values[v.id];
      let value = 0;
      if (spec?.type === 'constant') value = spec.value;
      else if (spec?.type === 'seasonal') {
        const phase = (2 * Math.PI * (this.dayOfYear - spec.peak_day)) / spec.period_days;
        value = spec.mean + spec.amplitude * Math.cos(phase) + spec.noise * this.rng.normal();
      }
      const mod = this.modifiers[v.id];
      if (mod) value = value * mod.mul + mod.add;
      this.boundary[v.id] = clamp(v, value);
    }
  }

  /** Contribution of each link into `variableId` on a tile, for diagnostics and the UI. */
  linkTerms(tile: TileState, variableId: string): { link: NormalLink; value: number }[] {
    const get = this.lookup(tile);
    return (this.linksTo.get(variableId) ?? []).map((link) => ({ link, value: evalLink(link, get) }));
  }

  /**
   * Map-scale pass (design doc 3.1): solve processes that depend on neighbours,
   * then hand the results to tiles as lateral input variables.
   */
  private mapPass() {
    const g = this.grid;
    const perTile = (diffusivity: number) => diffusivity / g.area;
    const m = perTile(g.map.mixing_m2_per_day);
    const volume = this.tiles.map((t) => g.area * Math.max(t.values.water_depth ?? 0, 1e-3));
    const nWater = g.waterTiles().length;

    for (const tile of g.tiles) {
      const i = tile.index;
      const out = this.lateral[i];
      if (!tile.water) {
        for (const v of this.lateralVars) out[v.id] = { constant: 0, terms: [] };
        continue;
      }
      const nb = g.neighbours4[i];
      for (const v of this.lateralVars) {
        const lat = v.lateral!;
        switch (lat.process) {
          case 'water_exchange':
            out[v.id] = { constant: m * nb.length, terms: [{ tile: null, variable: lat.discharge, weight: g.throughShare[i] / volume[i] }] };
            break;
          case 'incoming_concentration': {
            const q = this.boundary[lat.discharge] ?? 0;
            const exchange = (q * g.throughShare[i]) / volume[i] + m * nb.length;
            if (exchange <= 0) {
              out[v.id] = { constant: 0, terms: [{ tile: i, variable: lat.of, weight: 1 }] };
              break;
            }
            const terms: LateralTerm[] = [];
            for (const f of g.inflows[i]) terms.push({ tile: f.to, variable: lat.of, weight: (q * f.share) / volume[i] / exchange });
            // Inlet water without a boundary concentration is clean: it dilutes but adds nothing.
            if (g.inletShare[i] > 0 && lat.boundary) terms.push({ tile: null, variable: lat.boundary, weight: (q * g.inletShare[i]) / volume[i] / exchange });
            for (const k of nb) terms.push({ tile: k, variable: lat.of, weight: m / exchange });
            out[v.id] = { constant: 0, terms };
            break;
          }
          case 'dispersal_in': {
            const terms: LateralTerm[] = nb.map((k) => ({ tile: k, variable: lat.of, weight: perTile(lat.diffusivity_m2_per_day) }));
            // Pond-wide immigration all arrives at the inlets, so concentrate it there.
            if (g.inletShare[i] > 0 && lat.boundary) terms.push({ tile: null, variable: lat.boundary, weight: g.inletShare[i] * nWater });
            out[v.id] = { constant: 0, terms };
            break;
          }
          case 'neighbour_count':
            out[v.id] = { constant: perTile(lat.diffusivity_m2_per_day) * nb.length, terms: [] };
            break;
          case 'neighbour_sum':
            out[v.id] = { constant: 0, terms: nb.map((k) => ({ tile: k, variable: lat.of, weight: perTile(lat.diffusivity_m2_per_day) })) };
            break;
        }
      }
    }

    this.evalLateral();
  }

  /** Re-evaluate lateral inputs from the current tile state, all from the same snapshot. */
  private evalLateral() {
    const values = this.waterIdx.map((i) => this.lateralVars.map((v) => clamp(v, this.evalCombo(this.lateral[i][v.id]))));
    this.waterIdx.forEach((i, k) => this.lateralVars.forEach((v, j) => (this.tiles[i].values[v.id] = values[k][j])));
  }

  evalCombo(c: LateralCombo): number {
    let x = c.constant;
    for (const term of c.terms) x += term.weight * (term.tile === null ? (this.boundary[term.variable] ?? 0) : this.tiles[term.tile].values[term.variable]);
    return x;
  }

  step(days = 1) {
    for (let i = 0; i < days; i++) this.tick();
  }

  /**
   * Explicit Euler needs rate × dt well below 1. Lateral exchange on small tiles can reach
   * a few per day, so daily stocks are integrated in as many substeps as the fastest exchange needs.
   */
  substeps(): number {
    let fastest = 0;
    for (const v of this.lateralVars) {
      const p = v.lateral!.process;
      if (p !== 'water_exchange' && p !== 'neighbour_count') continue;
      for (const i of this.waterIdx) fastest = Math.max(fastest, this.tiles[i].values[v.id] ?? 0);
    }
    // 0.8 keeps every decay term monotone (1 − rate × dt > 0) without wasting substeps.
    return Math.min(48, Math.max(1, Math.ceil(fastest / 0.8)));
  }

  private tick() {
    // Boundary conditions (and their random noise) advance once per day, so a seed gives
    // the same run whatever the substep count.
    this.updateBoundary();
    this.mapPass();
    const n = this.substeps();
    for (let s = 0; s < n; s++) {
      // The weights only change with the daily boundary values; the inputs change every substep.
      if (s > 0) this.evalLateral();
      const next = new Array<number>(this.stockLinks.length);
      for (const i of this.waterIdx) {
        const tile = this.tiles[i];
        this.updateDerived(tile);
        const get = this.lookup(tile);
        for (let k = 0; k < this.stockLinks.length; k++) {
          const { v, links } = this.stockLinks[k];
          const interval = v.update_interval_days;
          // Slow stocks take one full step on their interval; daily stocks take n substeps.
          if (interval > 1 && (s > 0 || this.t % interval !== 0)) {
            next[k] = tile.values[v.id];
            continue;
          }
          const dt = interval > 1 ? interval : 1 / n;
          let r = 0;
          for (let l = 0; l < links.length; l++) r += evalLink(links[l], get);
          next[k] = clamp(v, tile.values[v.id] + dt * r);
        }
        for (let k = 0; k < this.stockLinks.length; k++) tile.values[this.stockLinks[k].v.id] = next[k];
      }
    }
    this.applyEffects();
    this.updateAllDerived();
    this.t += 1;
  }

  /** Start an intervention. Tile-scoped interventions need the tile they act on. */
  startIntervention(intervention: Intervention, tileId?: string) {
    if (intervention.scope === 'tile' && !tileId) throw new Error(`${intervention.id} acts on one tile; pass its id`);
    for (const e of intervention.effects) {
      this.effects.push({
        interventionId: intervention.id,
        variable: e.variable,
        op: e.op,
        value: e.value,
        duration: intervention.duration_days,
        daysLeft: intervention.duration_days,
        tiles: intervention.scope === 'tile' ? [tileId!] : null,
      });
    }
  }

  /** Running interventions as "id@tile" (or "id@*" for water-body scope), for completion tracking. */
  activeKeys(): string[] {
    return [...new Set(this.effects.map((e) => `${e.interventionId}@${e.tiles?.join(',') ?? '*'}`))];
  }

  /** How far a running intervention has got, 0 to 1, or null when it is not running. */
  interventionProgress(interventionId: string): number | null {
    const e = this.effects.find((x) => x.interventionId === interventionId);
    return e ? 1 - e.daysLeft / e.duration : null;
  }

  activeInterventions(tileId?: string): string[] {
    const relevant = this.effects.filter((e) => !tileId || !e.tiles || e.tiles.includes(tileId));
    return [...new Set(relevant.map((e) => e.interventionId))];
  }

  /** Effects are spread over their duration: multiplications geometrically, additions linearly. */
  private applyEffects() {
    for (const e of this.effects) {
      const v = this.data.variables.get(e.variable)!;
      const last = e.daysLeft === 1;
      if (v.kind === 'boundary') {
        const mod = (this.modifiers[v.id] ??= { mul: 1, add: 0 });
        if (e.op === 'multiply') mod.mul *= Math.pow(e.value, 1 / e.duration);
        else if (e.op === 'add') mod.add += e.value / e.duration;
        else if (last) {
          mod.mul = 0;
          mod.add = e.value;
        }
      } else {
        for (const [i, tile] of this.tiles.entries()) {
          if (!this.grid.tiles[i].water || (e.tiles && !e.tiles.includes(tile.id))) continue;
          const x = tile.values[v.id];
          if (e.op === 'multiply') tile.values[v.id] = clamp(v, x * Math.pow(e.value, 1 / e.duration));
          else if (e.op === 'add') tile.values[v.id] = clamp(v, x + e.value / e.duration);
          else if (last) tile.values[v.id] = clamp(v, e.value);
        }
      }
      e.daysLeft -= 1;
    }
    this.effects = this.effects.filter((e) => e.daysLeft > 0);
  }

  /** What crosses a tile's faces, grouped by zone, with where it comes from and goes. */
  edgeFluxes(tileId: string): EdgeFluxes {
    const g = this.grid;
    const i = g.indexOf(tileId);
    const map = g.map;
    const from = {
      inlets: map.inlets.filter((x) => x.tile === tileId).map((x) => x.name),
      upstream: g.inflows[i].map((f) => g.tiles[f.to].id),
      mixing: g.neighbours4[i].map((k) => g.tiles[k].id),
    };
    const dest = g.outflows[i].map((f) => (f.to === OFF_MAP ? map.outlets.find((x) => x.tile === tileId)!.name : g.tiles[f.to].id));
    const to = dest.length ? dest.join(', ') : 'No through-flow';
    const inflow: Record<string, string[]> = {};
    const outflow: Record<string, string[]> = {};
    for (const v of this.lateralVars) {
      if (v.lateral!.process === 'neighbour_count') continue;
      (inflow[v.zone] ??= []).push(v.id);
      if (v.lateral!.process === 'incoming_concentration') {
        const carried = this.data.variables.get(v.lateral!.of)!;
        (outflow[carried.zone] ??= []).push(carried.id);
      }
    }
    // Climate forcings reach every tile through the air.
    for (const v of this.boundaryVars) if (v.zone === 'air') (inflow.air ??= []).push(v.id);
    return { from, to, inflow, outflow };
  }

  /** Area-weighted mean of a variable over water tiles (tiles are equal in area). */
  aggregate(variableId: string): number {
    const water = this.grid.waterTiles();
    if (!water.length) return 0;
    return water.reduce((s, t) => s + this.tiles[t.index].values[variableId], 0) / water.length;
  }
}

export function clamp(v: Variable, x: number): number {
  if (!Number.isFinite(x)) return v.min ?? 0;
  if (v.min !== undefined && x < v.min) return v.min;
  if (v.max !== undefined && x > v.max) return v.max;
  return x;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
