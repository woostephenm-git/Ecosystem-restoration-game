import { describe, expect, it } from 'vitest';
import { loadNodeData } from '../src/data/node';
import { Game } from '../src/sim/game';
import { tileProfile } from '../src/ui/profile';

const data = loadNodeData();
const MISSION = 'm01_clearwater_pond';

/** A game where the main variables have been sampled on one tile. */
function sampled(budget = 100_000) {
  const g = new Game(data, MISSION, 1, { budget });
  for (const m of ['secchi_disk', 'water_grab', 'fish_survey', 'oxygen_profile']) g.sample(m, 'G7');
  return g;
}

describe('funding applications', () => {
  it('offers only sampled variables, plus the target', () => {
    const g = new Game(data, MISSION, 1);
    expect(g.fundingNodes()).not.toContain('carp');
    g.sample('fish_survey', 'G7');
    expect(g.fundingNodes()).toContain('carp');
    expect(g.fundingNodes()[0]).toBe('plant_cover');
  });

  it('accepts any supported two-step chain and pays out after 180 days', () => {
    for (const chain of [
      ['carp', 'suspended_sediment'],
      ['total_p', 'chla'],
      ['water_depth', 'light_bed'],
    ]) {
      const g = sampled();
      const b0 = g.budget;
      const app = g.applyForFunding([
        [chain[0], chain[1]],
        [chain[1], 'plant_cover'],
      ])!;
      expect(app.success, chain.join(' > ')).toBe(true);
      g.advance(179);
      expect(g.budget).toBe(b0);
      g.advance(1);
      expect(g.budget).toBe(b0 + 2000);
    }
  });

  it('turns down an unsupported arrow, and still uses up the 180 days', () => {
    const g = sampled();
    const b0 = g.budget;
    const app = g.applyForFunding([
      ['nitrate', 'suspended_sediment'],
      ['suspended_sediment', 'plant_cover'],
    ])!;
    expect(app.success).toBe(false);
    expect(app.problems[0]).toMatch(/nitrate drives suspended sediment/);
    expect(g.canApplyForFunding().ok).toBe(false);
    g.advance(180);
    expect(g.budget).toBe(b0);
    expect(g.canApplyForFunding().ok).toBe(true);
  });

  it('needs a chain two steps deep', () => {
    const app = sampled().applyForFunding([['light_bed', 'plant_cover']])!;
    expect(app.success).toBe(false);
    expect(app.problems[0]).toMatch(/two steps deep/);
  });

  it('pays once per relationship', () => {
    const g = sampled();
    const arrows: [string, string][] = [
      ['carp', 'suspended_sediment'],
      ['suspended_sediment', 'plant_cover'],
    ];
    expect(g.applyForFunding(arrows)!.success).toBe(true);
    g.advance(180);
    const again = g.applyForFunding(arrows)!;
    expect(again.success).toBe(false);
    expect(again.problems[0]).toMatch(/funded before/);
  });
});

describe('fish survey', () => {
  it('costs $300 and can be repeated after 90 days', () => {
    const g = new Game(data, MISSION, 1, { budget: 10_000 });
    expect(data.methods.get('fish_survey')!.cost).toBe(300);
    expect(g.sample('fish_survey', 'G7')).toBe(true);
    g.advance(30);
    expect(g.canSample('fish_survey', 'D7')).toEqual({ ok: false, reason: 'Allowed again in 60 days' });
    g.advance(60);
    expect(g.canSample('fish_survey', 'D7').ok).toBe(true);
  });
});

describe('cross-section profile', () => {
  it('runs from the shallowest point to the deepest, shallow end on its east-west side', () => {
    const g = new Game(data, MISSION, 1);
    for (const id of g.waterTileIds()) {
      const p = tileProfile(g, id);
      const ends = [p.depths[0], p.depths[p.depths.length - 1]];
      const [shallow, deep] = p.shallowLeft ? ends : ends.reverse();
      expect(shallow, id).toBeCloseTo(Math.min(...p.depths), 2);
      expect(deep, id).toBeCloseTo(Math.max(...p.depths), 2);
      // The shallow end's compass label points east only when it sits on the right.
      const shallowLabel = p.shallowLeft ? p.left : p.right;
      if (shallowLabel.includes('E')) expect(p.shallowLeft, id).toBe(false);
      if (shallowLabel.includes('W')) expect(p.shallowLeft, id).toBe(true);
    }
  });

  it('deepens with the weir', () => {
    const g = new Game(data, MISSION, 1);
    const before = Math.max(...tileProfile(g, 'G7').depths);
    g.intervene('raise_weir', 'L8');
    g.advance(40);
    expect(Math.max(...tileProfile(g, 'G7').depths)).toBeCloseTo(before + 0.3, 2);
  });
});
