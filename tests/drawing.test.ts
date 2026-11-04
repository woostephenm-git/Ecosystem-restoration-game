import { describe, expect, it } from 'vitest';
import { loadNodeData } from '../src/data/node';
import { Game } from '../src/sim/game';
import { DRAW_W, drawTile } from '../src/ui/drawing';

const data = loadNodeData();
const game = new Game(data, 'm01_clearwater_pond', 1);
const zones = data.zones.map((z) => z.id);

/** Particle drift in the cross-section (px per second, signed), or 0 when they are not carried. */
function drift(tileId: string): number {
  const m = drawTile(game, tileId, zones, null).match(/xs-flow ([\d.]+)s[^"]*--fw:(-?\d+)px/);
  return m ? (DRAW_W / Number(m[1])) * Math.sign(Number(m[2])) : 0;
}

describe('cross-section particles', () => {
  it('drift faster where more water moves through the tile', () => {
    // Inlet channel > outlet channel > open water > a side bay > a corner no flow reaches.
    const speeds = ['A5', 'L8', 'G7', 'F9', 'L9'].map((id) => Math.abs(drift(id)));
    for (let i = 1; i < speeds.length; i++) expect(speeds[i - 1], `${speeds}`).toBeGreaterThan(speeds[i]);
    expect(speeds[speeds.length - 1]).toBe(0);
  });
});
