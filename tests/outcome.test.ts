import { describe, expect, it } from 'vitest';
import { loadNodeData } from '../src/data/node';
import { Game } from '../src/sim/game';
import { level, scalePos } from '../src/ui/gauge';

const data = loadNodeData();
const MISSION = 'm01_clearwater_pond';
const mission = data.missions.get(MISSION)!;

describe('budget override', () => {
  it('uses the mission budget by default', () => {
    expect(new Game(data, MISSION, 1).budget).toBe(mission.budget);
  });
  it('takes a testing budget when given one', () => {
    expect(new Game(data, MISSION, 1, { budget: 100_000 }).budget).toBe(100_000);
  });
});

describe('final survey', () => {
  it('records pond-wide means at the start and at the deadline', () => {
    const g = new Game(data, MISSION, 1);
    g.intervene('carp_removal', 'B1');
    g.intervene('carp_barrier', 'B1');
    g.advance(40);
    for (const t of ['A1', 'A3', 'C3']) g.intervene('plant_submerged', t);
    g.advance(g.deadlineDay - g.day);
    const o = g.outcome!;
    expect(o.success).toBe(true);
    expect(Object.keys(o.survey)).toEqual(mission.final_survey);
    expect(o.survey.plant_cover).toBeGreaterThan(g.startSurvey.plant_cover);
    expect(o.survey.secchi).toBeGreaterThan(g.startSurvey.secchi);
    expect(o.survey.carp).toBeLessThan(g.startSurvey.carp);
  });

  it('the success letter only uses placeholders the game can fill', () => {
    const allowed = new Set([...mission.final_survey, 'target', 'budget_left', 'date']);
    const letter = mission.success_letter!;
    const used = [...letter.paragraphs.join(' ').matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const key of used) expect(allowed.has(key), `unknown placeholder {${key}}`).toBe(true);
  });
});

describe('gauges', () => {
  const v = (id: string) => data.variables.get(id)!;
  const measured = (value: number) => ({ state: 'measured' as const, value, day: 0, source: '' });

  it('places values on linear and log scales', () => {
    expect(scalePos(v('carp'), 300)).toBeCloseTo(0.5);
    expect(scalePos(v('light_bed'), 1)).toBeCloseTo(1 / 3);
    expect(scalePos(v('carp'), 5000)).toBe(1);
  });

  it('reads low, mid and high by thirds', () => {
    expect(level(v('carp'), measured(50))).toBe('low');
    expect(level(v('carp'), measured(300))).toBe('mid');
    expect(level(v('carp'), measured(500))).toBe('high');
    expect(level(v('carp'), { state: 'unknown' })).toBeNull();
  });

  it('gives no single level when an estimate spans thirds', () => {
    expect(level(v('carp'), { state: 'estimate', lo: 50, hi: 500, day: 0, source: '' })).toBeNull();
  });

  it('every variable has a scale whose range covers its starting state', () => {
    const g = new Game(data, MISSION, 1);
    for (const variable of data.variables.values()) {
      for (const tile of g.sim.tiles) {
        const x = tile.values[variable.id] ?? g.sim.boundary[variable.id];
        if (x === undefined || variable.scale.log) continue;
        expect(x, `${variable.id} on ${tile.id}`).toBeLessThanOrEqual(variable.scale.max * 1.5);
      }
    }
  });
});
