import { describe, expect, it } from 'vitest';
import { loadNodeData } from '../src/data/node';
import { Game } from '../src/sim/game';

const data = loadNodeData();
const MISSION = 'm01_clearwater_pond';

describe('debrief history', () => {
  it('records one true value per day for every pond tile', () => {
    const g = new Game(data, MISSION, 1);
    g.advance(20);
    expect(g.history.days).toEqual(Array.from({ length: 21 }, (_, i) => i));
    const series = g.historySeries('plant_cover', 'D7');
    expect(series).toHaveLength(21);
    expect(series[20]).toBe(g.sim.tile('D7').values.plant_cover);
  });

  it('the median series is the median over pond tiles each day', () => {
    const g = new Game(data, MISSION, 1);
    g.advance(5);
    const ids = g.waterTileIds();
    const today = ids.map((id) => g.sim.tile(id).values.carp).sort((a, b) => a - b);
    const mid = today.length % 2 ? today[(today.length - 1) / 2] : (today[today.length / 2 - 1] + today[today.length / 2]) / 2;
    expect(g.historySeries('carp', 'median')[5]).toBeCloseTo(mid, 9);
  });

  it('meadow flooded by the weir has no history before it was pond', () => {
    const g = new Game(data, MISSION, 1);
    g.intervene('raise_weir', 'L8');
    g.advance(60);
    const flooded = [...g.sim.flooded].map((i) => g.sim.grid.tiles[i].id);
    expect(flooded.length).toBeGreaterThan(0);
    const s = g.historySeries('plant_cover', flooded[0]);
    expect(s).toHaveLength(g.history.days.length);
    expect(Number.isNaN(s[0])).toBe(true);
    expect(Number.isFinite(s[s.length - 1])).toBe(true);
  });

  it('groups same-day interventions into one event, in time order', () => {
    const g = new Game(data, MISSION, 1);
    g.intervene('carp_removal', 'G7');
    g.advance(40);
    for (const t of ['D7', 'E8', 'G9']) g.intervene('plant_submerged', t);
    const events = g.debriefEvents();
    expect(events.map((e) => [e.id, e.day])).toEqual([
      ['carp_removal', 0],
      ['plant_submerged', 40],
    ]);
    expect(events[0].tiles).toEqual([]);
    expect(events[1].tiles).toEqual(['D7', 'E8', 'G9']);
  });
});
