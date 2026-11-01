// What the player knows, as opposed to what is true. Everything the UI shows
// about tile state flows through here.
import type { Simulation, TileState } from './engine';
import { roundTo } from './format';
import type { Rng } from './rng';
import type { Variable } from './schema';

export type Known =
  | { state: 'unknown' }
  | { state: 'estimate'; lo: number; hi: number; day: number; source: string }
  | { state: 'measured'; value: number; day: number; source: string };

interface Record_ {
  measurement?: { value: number; day: number; source: string };
  estimate?: { lo: number; hi: number; day: number; source: string };
}

export class Knowledge {
  private readonly tiles = new Map<string, Map<string, Record_>>();
  /** Variables measured at least once anywhere. Drives link discovery. */
  readonly measuredEver = new Set<string>();

  constructor(
    private readonly sim: Simulation,
    private readonly freshDays: number,
    rng: Rng,
  ) {
    // Only simulated water tiles have state to know about; land is scenery in Mission 1.
    for (const tile of sim.grid.waterTiles().map((t) => sim.tiles[t.index])) {
      const map = new Map<string, Record_>();
      this.tiles.set(tile.id, map);
      for (const v of sim.data.variables.values()) {
        const rec: Record_ = {};
        if (v.initial_knowledge === 'estimate' && v.estimate) {
          // Model estimate: the truth is inside the bounds but not at their centre.
          const x = tile.values[v.id] ?? sim.boundary[v.id];
          const lo = Math.max(v.min ?? -Infinity, x * (1 - v.estimate.spread * rng.range(0.25, 1)));
          const hi = x * (1 + v.estimate.spread * rng.range(0.25, 1));
          rec.estimate = { lo, hi, day: sim.missionDay, source: v.estimate.source };
        }
        map.set(v.id, rec);
      }
    }
    this.observe();
  }

  private rec(tileId: string, variableId: string): Record_ {
    return this.tiles.get(tileId)!.get(variableId)!;
  }

  private trueValue(tile: TileState, v: Variable): number {
    return v.kind === 'boundary' ? this.sim.boundary[v.id] : tile.values[v.id];
  }

  record(tile: TileState, v: Variable, source: string) {
    const value = roundTo(v, this.trueValue(tile, v));
    this.rec(tile.id, v.id).measurement = { value, day: this.sim.missionDay, source };
    this.measuredEver.add(v.id);
  }

  /** Free visual observation and gauges. Runs after every simulated day. */
  observe() {
    const today = this.sim.missionDay;
    for (const t of this.sim.grid.waterTiles()) {
      if (!this.tiles.has(t.id)) this.tiles.set(t.id, new Map([...this.sim.data.variables.keys()].map((id) => [id, {}])));
    }
    for (const tile of this.sim.grid.waterTiles().map((t) => this.sim.tiles[t.index])) {
      for (const v of this.sim.data.variables.values()) {
        if (v.observable === 'full') {
          this.record(tile, v, v.observe_source ?? 'Visual observation');
        } else if (v.observable === 'coarse') {
          const x = this.trueValue(tile, v);
          const bins = v.coarse_bins!;
          let i = 0;
          while (i < bins.length - 2 && x >= bins[i + 1]) i++;
          this.rec(tile.id, v.id).estimate = { lo: bins[i], hi: bins[i + 1], day: today, source: v.observe_source ?? 'Visual observation' };
        }
      }
    }
  }

  get(tileId: string, variableId: string): Known {
    if (!this.tiles.has(tileId)) return { state: 'unknown' };
    const v = this.sim.data.variables.get(variableId)!;
    if (v.inferred_from) return this.infer(tileId, v);
    if (v.kind === 'lateral') return this.lateral(tileId, v);
    const rec = this.rec(tileId, variableId);
    const today = this.sim.missionDay;
    const m = rec.measurement;
    const fresh = m && (v.observable === 'none' || today - m.day <= this.freshDays);
    if (m && fresh) return { state: 'measured', ...m };
    if (rec.estimate) return { state: 'estimate', ...rec.estimate };
    if (m) return { state: 'measured', ...m };
    return { state: 'unknown' };
  }

  /** Model-based knowledge: push the bounds of the inputs through the variable's own formula. */
  private infer(tileId: string, v: Variable): Known {
    const inputs = v.inferred_from!.map((id) => ({ id, k: this.get(tileId, id) }));
    if (inputs.some((i) => i.k.state === 'unknown')) return { state: 'unknown' };
    const ranges = inputs.map((i) => {
      const k = i.k as Exclude<Known, { state: 'unknown' }>;
      return { id: i.id, lo: k.state === 'measured' ? k.value : k.lo, hi: k.state === 'measured' ? k.value : k.hi, day: k.day };
    });
    let lo = Infinity;
    let hi = -Infinity;
    for (let mask = 0; mask < 1 << ranges.length; mask++) {
      const corner: Record<string, number> = {};
      ranges.forEach((r, i) => (corner[r.id] = mask & (1 << i) ? r.hi : r.lo));
      const x = this.sim.evalDerived(v.id, (id) => corner[id] ?? 0);
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    const names = v.inferred_from!.map((id) => this.sim.data.variables.get(id)!.name.toLowerCase());
    const source = `Calculated from ${names.join(' and ')}`;
    const day = Math.min(...ranges.map((r) => r.day));
    const allMeasured = inputs.every((i) => i.k.state === 'measured');
    if (allMeasured) return { state: 'measured', value: roundTo(v, lo), day, source };
    return { state: 'estimate', lo, hi, day, source };
  }

  /**
   * Lateral inputs are weighted sums of other tiles' values and boundary values,
   * so they are known exactly as well as all of their sources are.
   */
  private lateral(tileId: string, v: Variable): Known {
    const sim = this.sim;
    const combo = sim.lateral[sim.grid.indexOf(tileId)][v.id];
    let lo = combo.constant;
    let hi = combo.constant;
    let day = sim.missionDay;
    let allMeasured = true;
    const sources = new Set<string>();
    for (const term of combo.terms) {
      const sourceTile = term.tile === null ? tileId : sim.tiles[term.tile].id;
      const k = this.get(sourceTile, term.variable);
      const b = bounds(k);
      if (!b) return { state: 'unknown' };
      lo += term.weight * b.lo;
      hi += term.weight * b.hi;
      day = Math.min(day, (k as { day: number }).day);
      allMeasured &&= k.state === 'measured';
      sources.add(term.tile === null ? sim.data.variables.get(term.variable)!.name.toLowerCase() : sourceTile);
    }
    const source = sources.size ? `Calculated from ${[...sources].join(', ')}` : 'Calculated from the map';
    if (allMeasured) return { state: 'measured', value: roundTo(v, lo), day, source };
    return { state: 'estimate', lo, hi, day, source };
  }

  isKnown(tileId: string, variableId: string): boolean {
    return this.get(tileId, variableId).state !== 'unknown';
  }
}

/** Interval view of a knowledge entry, or null when unknown. */
export function bounds(k: Known): { lo: number; hi: number } | null {
  if (k.state === 'unknown') return null;
  if (k.state === 'measured') return { lo: k.value, hi: k.value };
  return { lo: k.lo, hi: k.hi };
}
