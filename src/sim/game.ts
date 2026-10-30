// Mission-level game state: budget, sampling, interventions, knowledge, objective.
// Still headless: the UI reads from and calls into this, never into the engine directly.
import { Simulation } from './engine';
import { fmtMoney, fmtRange, fmtUnit } from './format';
import { applyTransform, evalLink } from './functions';
import { Knowledge, bounds, type Known } from './knowledge';
import type { DataBundle, NormalLink } from './loader';
import { Rng } from './rng';
import type { Condition, Intervention, LimitingFactorDef, Method, Mission } from './schema';

export type FactorStatus = 'LIMITING' | 'LIKELY' | 'SUSPECTED' | 'NOT LIMITING' | 'UNKNOWN';

export interface FactorReport {
  id: string;
  name: string;
  variable: string;
  status: FactorStatus;
  text: string;
}

export interface LogEntry {
  day: number;
  kind: 'sample' | 'intervention' | 'event' | 'outcome';
  text: string;
}

export interface Outcome {
  success: boolean;
  value: number;
  target: number;
}

export interface Availability {
  ok: boolean;
  reason?: string;
}

export class Game {
  readonly sim: Simulation;
  readonly mission: Mission;
  readonly knowledge: Knowledge;
  budget: number;
  readonly log: LogEntry[] = [];
  /** Sampling done, keyed by tile then method, holding the mission day it was last done. */
  private readonly sampled = new Map<string, Map<string, number>>();
  readonly interventionsDone: { id: string; day: number; tileId: string }[] = [];
  samplesTaken = 0;
  outcome: Outcome | null = null;

  constructor(
    readonly data: DataBundle,
    missionId: string,
    seed: number,
  ) {
    const mission = data.missions.get(missionId);
    if (!mission) throw new Error(`Unknown mission ${missionId}`);
    this.mission = mission;
    this.budget = mission.budget;
    this.sim = new Simulation(data, mission, seed);
    this.sim.step(mission.spinup_days);
    this.knowledge = new Knowledge(this.sim, mission.measurement_fresh_days, new Rng(seed).fork(2));
  }

  get day(): number {
    return this.sim.missionDay;
  }

  get deadlineDay(): number {
    return Math.round(this.mission.objective.deadline_years * 365);
  }

  methods(): Method[] {
    return this.mission.methods.map((id) => this.data.methods.get(id)!);
  }

  interventions(): Intervention[] {
    return this.mission.interventions.map((id) => this.data.interventions.get(id)!);
  }

  tile(tileId: string) {
    return this.sim.tile(tileId);
  }

  /** Water tile ids in map order. */
  waterTileIds(): string[] {
    return this.sim.grid.waterTiles().map((t) => t.id);
  }

  /** Days since a method was last run on a tile, or null if never. */
  sampledDaysAgo(methodId: string, tileId: string): number | null {
    const d = this.sampled.get(tileId)?.get(methodId);
    return d === undefined ? null : this.day - d;
  }

  canSample(methodId: string, tileId: string): Availability {
    const m = this.data.methods.get(methodId)!;
    if (this.sampledDaysAgo(methodId, tileId) === 0) return { ok: false, reason: 'Done today' };
    if (m.cost > this.budget) return { ok: false, reason: 'Not enough budget' };
    return { ok: true };
  }

  sample(methodId: string, tileId: string): boolean {
    if (!this.canSample(methodId, tileId).ok) return false;
    const m = this.data.methods.get(methodId)!;
    this.budget -= m.cost;
    this.samplesTaken += 1;
    // A water-body method (e.g. a fish survey netting the whole pond) covers every water tile.
    const covered = m.scope === 'water_body' ? this.waterTileIds() : [tileId];
    for (const id of covered) {
      if (!this.sampled.has(id)) this.sampled.set(id, new Map());
      this.sampled.get(id)!.set(methodId, this.day);
      for (const v of m.reveals) this.knowledge.record(this.tile(id), this.data.variables.get(v)!, m.name);
    }
    const where = m.scope === 'water_body' ? 'across the pond' : `on ${tileId}`;
    this.log.push({ day: this.day, kind: 'sample', text: `${m.name} ${where} (${fmtMoney(m.cost)})` });
    return true;
  }

  /** Times an intervention was started, optionally only those on one tile. */
  timesDone(interventionId: string, tileId?: string): number {
    return this.interventionsDone.filter((i) => i.id === interventionId && (!tileId || i.tileId === tileId)).length;
  }

  lastDone(interventionId: string): number | null {
    const done = this.interventionsDone.filter((i) => i.id === interventionId);
    return done.length ? done[done.length - 1].day : null;
  }

  /** `tileId` is the tile a tile-scoped intervention would act on. */
  canIntervene(interventionId: string, tileId?: string): Availability {
    const iv = this.data.interventions.get(interventionId)!;
    if (iv.scope === 'tile' && !tileId) return { ok: false, reason: 'Select a tile' };
    if (!iv.repeatable && this.timesDone(interventionId) > 0) return { ok: false, reason: 'Already in place' };
    const scope = iv.scope === 'tile' ? tileId : undefined;
    if (this.sim.activeInterventions(scope).includes(interventionId)) return { ok: false, reason: 'In progress' };
    if (iv.cost > this.budget) return { ok: false, reason: 'Not enough budget' };
    return { ok: true };
  }

  intervene(interventionId: string, tileId: string): boolean {
    if (!this.canIntervene(interventionId, tileId).ok) return false;
    const iv = this.data.interventions.get(interventionId)!;
    this.budget -= iv.cost;
    this.sim.startIntervention(iv, tileId);
    this.interventionsDone.push({ id: iv.id, day: this.day, tileId });
    const where = iv.scope === 'tile' ? ` on ${tileId}` : '';
    this.log.push({ day: this.day, kind: 'intervention', text: `${iv.name}${where} started (${fmtMoney(iv.cost)}, ${iv.duration_days} days)` });
    return true;
  }

  advance(days: number) {
    for (let i = 0; i < days; i++) {
      const active = this.sim.activeKeys();
      this.sim.step(1);
      const still = new Set(this.sim.activeKeys());
      for (const key of active) {
        if (still.has(key)) continue;
        const [id, where] = key.split('@');
        const on = where === '*' ? '' : ` on ${where}`;
        this.log.push({ day: this.day, kind: 'event', text: `${this.data.interventions.get(id)!.name}${on} completed` });
      }
      this.knowledge.observe();
      if (!this.outcome && this.day >= this.deadlineDay) this.evaluateOutcome();
    }
  }

  private evaluateOutcome() {
    const o = this.mission.objective;
    const value = this.sim.aggregate(o.variable);
    this.outcome = { success: value >= o.target, value, target: o.target };
    const v = this.data.variables.get(o.variable)!;
    this.log.push({
      day: this.day,
      kind: 'outcome',
      text: this.outcome.success
        ? `Deadline reached. Final survey: ${fmtUnit(v, value)} ${v.name.toLowerCase()}. Objective met.`
        : `Deadline reached. Final survey: ${fmtUnit(v, value)} ${v.name.toLowerCase()}. Objective not met.`,
    });
  }

  /** Measured anywhere, ever. Inferred variables count once all their inputs have been. */
  measuredEver(variableId: string): boolean {
    const v = this.data.variables.get(variableId)!;
    if (v.inferred_from) return v.inferred_from.every((id) => this.measuredEver(id));
    return this.knowledge.measuredEver.has(variableId);
  }

  isDiscovered(link: NormalLink): boolean {
    return link.discovered_by.every((id) => this.measuredEver(id));
  }

  /** Variables shown in this mission: enabled layers, not boundary inputs. */
  visibleVariables() {
    const layers = new Set(this.mission.layers_enabled);
    return [...this.data.variables.values()].filter((v) => (v.kind === 'stock' || v.kind === 'derived') && layers.has(v.layer));
  }

  known(tileId: string, variableId: string): Known {
    return this.knowledge.get(tileId, variableId);
  }

  limitingFactors(tileId: string): FactorReport[] {
    return this.mission.limiting_factors.factors.map((f) => this.factorReport(tileId, f));
  }

  private factorReport(tileId: string, f: LimitingFactorDef): FactorReport {
    const v = this.data.variables.get(f.variable)!;
    const k = this.known(tileId, f.variable);
    const b = bounds(k);
    const fill = (template: string) =>
      template
        .replace('{value}', k.state === 'measured' ? fmtUnit(v, k.value) : '')
        .replace('{lo}', b ? fmtUnit(v, b.lo) : '')
        .replace('{hi}', b ? fmtUnit(v, b.hi) : '')
        .replace('{limit}', fmtUnit(v, f.threshold));
    const violates = (x: number) => (f.limiting_when === 'above' ? x > f.threshold : x < f.threshold);
    let status: FactorStatus;
    let key: keyof LimitingFactorDef['text'];
    if (!b) {
      const suspected = f.suspect_when?.length && f.suspect_when.every((c) => this.check(tileId, c));
      status = suspected ? 'SUSPECTED' : 'UNKNOWN';
      key = suspected ? 'suspected' : 'unknown';
    } else if (k.state === 'measured') {
      status = violates(k.value) ? 'LIMITING' : 'NOT LIMITING';
      key = violates(k.value) ? 'limiting' : 'not_limiting';
    } else if (violates(b.lo) && violates(b.hi)) {
      status = 'LIKELY';
      key = 'likely';
    } else if (!violates(b.lo) && !violates(b.hi)) {
      status = 'NOT LIMITING';
      key = 'not_limiting';
      // An estimate that clears the threshold reads as a range, not a single value.
      return { id: f.id, name: f.name, variable: f.variable, status, text: `Estimated ${fmtRange(v, b.lo, b.hi)} ${v.unit}. Probably not limiting.` };
    } else {
      status = 'SUSPECTED';
      key = 'suspected';
    }
    const age = k.state === 'unknown' ? 0 : this.day - k.day;
    const stale = age > this.mission.measurement_fresh_days ? ` Based on data from ${age} days ago.` : '';
    return { id: f.id, name: f.name, variable: f.variable, status, text: fill(f.text[key]) + stale };
  }

  /** True when a known value is older than the mission's freshness window. */
  isStale(k: Known): boolean {
    return k.state !== 'unknown' && this.day - k.day > this.mission.measurement_fresh_days;
  }

  /** Evaluate a mission condition against what the player knows (never true state). */
  check(tileId: string, c: Condition): boolean {
    if ('known' in c) return this.knowledge.isKnown(tileId, c.var) === c.known;
    if ('done' in c) return this.timesDone(c.intervention) > 0 === c.done;
    if ('days_since_intervention' in c) {
      const last = this.lastDone(c.days_since_intervention);
      return last !== null && this.day - last > c.gt;
    }
    const b = bounds(this.known(tileId, c.var));
    if (!b) return false;
    let ref: { lo: number; hi: number } | null;
    if ('ratio_of' in c) {
      const r = bounds(this.known(tileId, c.ratio_of));
      ref = r && { lo: r.lo * c.factor, hi: r.hi * c.factor };
    } else ref = { lo: c.value, hi: c.value };
    if (!ref) return false;
    return c.op === '>' ? b.lo > ref.hi : b.hi < ref.lo;
  }

  hints(tileId: string): string[] {
    return this.mission.hints.filter((h) => h.when.every((c) => this.check(tileId, c))).map((h) => h.text);
  }

  /**
   * Direction of a link's effect: +1 if raising the source raises the target, -1 if it lowers it.
   * Isolates the one link, and passes it through the target's transform for derived targets.
   */
  linkDirection(tileId: string, link: NormalLink, sourceId: string): number {
    const sim = this.sim;
    const base = sim.lookup(this.tile(tileId));
    const x = base(sourceId);
    const dx = Math.max(Math.abs(x) * 0.05, 1e-3);
    const up = (id: string) => (id === sourceId ? x + dx : base(id));
    const target = this.data.variables.get(link.to)!;
    const delta = evalLink(link, up) - evalLink(link, base);
    if (target.kind !== 'derived') return Math.sign(delta);
    const sum = target.derived!.base + sim.linkTerms(this.tile(tileId), target.id).reduce((s, t) => s + t.value, 0);
    return Math.sign(applyTransform(target.derived!.transform, sum + delta) - applyTransform(target.derived!.transform, sum));
  }

  /** The player's view of a pond-wide mean, from knowledge only: the mean of each tile's bounds. */
  knownMean(variableId: string): Known {
    const ks = this.waterTileIds().map((id) => this.known(id, variableId));
    if (ks.some((k) => k.state === 'unknown')) return { state: 'unknown' };
    const bs = ks.map((k) => bounds(k)!);
    const lo = bs.reduce((s, b) => s + b.lo, 0) / bs.length;
    const hi = bs.reduce((s, b) => s + b.hi, 0) / bs.length;
    const day = Math.min(...ks.map((k) => (k as { day: number }).day));
    if (ks.every((k) => k.state === 'measured')) return { state: 'measured', value: lo, day, source: 'Mean of all tiles' };
    return { state: 'estimate', lo, hi, day, source: 'Mean of all tiles' };
  }

  /** The player's view of objective progress, from knowledge only. */
  objectiveKnown(tileId: string): Known {
    return this.known(tileId, this.mission.objective.variable);
  }
}
