// Side-view drawing of a tile, west to east. Built only from what the player can
// observe or has measured (design doc 4.3): it must never leak hidden state.
import type { Game } from '../sim/game';
import { bounds } from '../sim/knowledge';

export const DRAW_W = 240;
export const ZONE_H: Record<string, number> = { air: 130, water: 290, sediment: 150, bedrock: 90 };

export function zoneTop(zoneId: string, zoneOrder: string[]): number {
  let y = 0;
  for (const z of zoneOrder) {
    if (z === zoneId) return y;
    y += ZONE_H[z];
  }
  return y;
}

/** Deterministic pseudo-random sequence so the drawing does not flicker between renders. */
function jitter(i: number): number {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const c = pa.map((x, i) => Math.round(x + (pb[i] - x) * Math.min(1, Math.max(0, t))));
  return `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

function mid(game: Game, tileId: string, id: string): number | null {
  const b = bounds(game.known(tileId, id));
  return b ? (b.lo + b.hi) / 2 : null;
}

export function drawTile(game: Game, tileId: string, zoneOrder: string[], selected: string | null): string {
  const W = DRAW_W;
  const top = (z: string) => zoneTop(z, zoneOrder);
  const airY = top('air');
  const waterY = top('water');
  const sedY = top('sediment');
  const rockY = top('bedrock');
  const H = rockY + ZONE_H.bedrock;
  const bedY = sedY;

  // Water colour from what the player can see: murky brown when clarity is poor, blue-green when clear.
  const secchi = mid(game, tileId, 'secchi') ?? 0.5;
  const clarity = Math.min(1, Math.max(0, (secchi - 0.2) / 2.2));
  const water = mix('#4B4630', '#173A4E', clarity);
  const waterDeep = mix('#3A3424', '#0F2A3A', clarity);

  const depthKnown = game.known(tileId, 'water_depth');
  const depth = depthKnown.state === 'measured' ? depthKnown.value : null;

  const parts: string[] = [];
  parts.push(`<defs>
    <linearGradient id="wgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${water}"/><stop offset="1" stop-color="${waterDeep}"/></linearGradient>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#D6E2E3"/><stop offset="1" stop-color="#EFE6CF"/></linearGradient>
  </defs>`);
  parts.push(`<rect x="0" y="${airY}" width="${W}" height="${ZONE_H.air}" fill="url(#sky)"/>`);
  // Western margin trees and reeds (always visible from the bank).
  parts.push(`<circle cx="-10" cy="${airY + 48}" r="58" fill="#5E7E4E"/><circle cx="34" cy="${airY + 22}" r="32" fill="#6F8F5A"/>`);
  parts.push(`<rect x="0" y="${waterY}" width="${W}" height="${ZONE_H.water}" fill="url(#wgrad)"/>`);

  // Suspended particles: drawn only as a visual impression of murk, scaled by visible clarity.
  const specks = Math.round((1 - clarity) * 34);
  const speckParts: string[] = [];
  for (let i = 0; i < specks; i++) {
    const x = 8 + jitter(i) * (W - 16);
    const y = waterY + 10 + jitter(i + 100) * (ZONE_H.water - 30);
    speckParts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(1 + jitter(i + 200) * 1.2).toFixed(1)}"/>`);
  }
  parts.push(`<g fill="#A08C62" opacity="0.5">${speckParts.join('')}</g>`);

  // Sediment and bedrock.
  parts.push(`<rect x="0" y="${sedY}" width="${W}" height="${ZONE_H.sediment}" fill="#4E3A28"/>`);
  parts.push(`<rect x="0" y="${sedY}" width="${W}" height="16" fill="#2E231A"/>`);
  parts.push(`<rect x="0" y="${sedY + 90}" width="${W}" height="${ZONE_H.sediment - 90}" fill="#5C4632"/>`);
  const pebbles = [30, 84, 150, 198, 112].map((x, i) => `<circle cx="${x}" cy="${sedY + 106 + (i % 3) * 12}" r="${3 + (i % 3)}"/>`);
  parts.push(`<g fill="#7A6550">${pebbles.join('')}</g>`);
  parts.push(`<rect x="0" y="${rockY}" width="${W}" height="${ZONE_H.bedrock}" fill="#5E5E66"/>`);
  parts.push(
    `<g stroke="#7A7A83" stroke-width="1"><path d="M0 ${rockY + 24} H${W}"/><path d="M0 ${rockY + 52} H${W}"/><path d="M0 ${rockY + 76} H${W}"/><path d="M60 ${rockY} V${rockY + 24}"/><path d="M150 ${rockY + 24} V${rockY + 52}"/><path d="M96 ${rockY + 52} V${rockY + 76}"/></g>`,
  );

  // Reeds at the margin.
  const reeds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const x = 10 + i * 11;
    const tipY = airY + 70 + jitter(i + 300) * 30;
    reeds.push(`<path d="M${x} ${waterY + 60 + i * 6} V${tipY}"/>`);
  }
  parts.push(`<g stroke="#6E8F4A" stroke-width="2" stroke-linecap="round">${reeds.join('')}</g>`);

  // Submerged plants: as many stems as the visible cover suggests.
  const cover = mid(game, tileId, 'plant_cover') ?? 0;
  const stems = Math.round((cover / 100) * 40);
  const stemParts: string[] = [];
  for (let i = 0; i < stems; i++) {
    const x = 66 + jitter(i + 400) * (W - 80);
    const h = 30 + jitter(i + 500) * 90 * (0.4 + cover / 160);
    const bend = (jitter(i + 600) - 0.5) * 14;
    stemParts.push(`<path d="M${x.toFixed(1)} ${bedY} Q${(x + bend).toFixed(1)} ${(bedY - h / 2).toFixed(1)} ${(x - bend / 2).toFixed(1)} ${(bedY - h).toFixed(1)}"/>`);
  }
  parts.push(`<g stroke="#5FA35A" stroke-width="1.8" fill="none" stroke-linecap="round">${stemParts.join('')}</g>`);

  // Carp are only drawn once a fish survey has measured them.
  const carp = game.known(tileId, 'carp');
  if (carp.state === 'measured') {
    const n = Math.min(7, Math.round(carp.value / 70));
    const fish: string[] = [];
    for (let i = 0; i < n; i++) {
      const x = 80 + jitter(i + 700) * (W - 120);
      const y = bedY - 14 - jitter(i + 800) * 50;
      const rot = (jitter(i + 900) - 0.5) * 30;
      fish.push(
        `<g transform="rotate(${rot.toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)})"><path d="M${x - 20} ${y} Q${x - 2} ${y - 9} ${x + 18} ${y} Q${x - 2} ${y + 8} ${x - 20} ${y} Z"/><path d="M${x + 17} ${y} L${x + 27} ${y - 7} L${x + 26} ${y + 7} Z"/></g>`,
      );
    }
    parts.push(`<g fill="#B0915A">${fish.join('')}</g>`);
    if (n > 0) parts.push(`<ellipse cx="${W / 2 + 10}" cy="${bedY - 4}" rx="70" ry="12" fill="#6B5A40" opacity="0.45"/>`);
  }

  // Surface line and depth scale.
  parts.push(`<path d="M0 ${waterY} H${W}" stroke="#6FA3C7" stroke-width="1.5"/>`);
  const scaleX = W - 6;
  const ticks: string[] = [];
  const labels: string[] = [];
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const y = waterY + (ZONE_H.water * i) / steps;
    ticks.push(`<path d="M${scaleX - 4} ${y} H${scaleX}"/>`);
    const text = depth === null ? '' : `${((depth * i) / steps).toFixed(1)}${i === steps ? ' m' : ''}`;
    labels.push(`<text x="${scaleX - 7}" y="${(y + (i === 0 ? 10 : i === steps ? -3 : 3)).toFixed(0)}">${text}</text>`);
  }
  parts.push(`<g stroke="#C9D3CF" stroke-width="1"><path d="M${scaleX} ${waterY} V${bedY}"/>${ticks.join('')}</g>`);
  parts.push(`<g fill="#C9D3CF" font-family="IBM Plex Mono, monospace" font-size="9" text-anchor="end">${labels.join('')}</g>`);
  parts.push(`<g fill="#6A5434" font-family="IBM Plex Sans, sans-serif" font-size="10" font-weight="600"><text x="80" y="${airY + 14}">W</text><text x="${W - 16}" y="${airY + 14}">E</text></g>`);

  // Sampling marks for methods run on this tile in the last week.
  for (const m of game.methods()) {
    const ago = game.sampledDaysAgo(m.id, tileId);
    if (ago === null || ago > 7) continue;
    parts.push(sampleMark(game, tileId, m.mark.kind, m.mark.label, { waterY, bedY, sedY, depth }));
  }

  if (selected) {
    const v = game.data.variables.get(selected);
    if (v && ZONE_H[v.zone] !== undefined) {
      const x = v.pin.x * W;
      const y = top(v.zone) + v.pin.y * ZONE_H[v.zone];
      const color = game.data.layers.get(v.layer)!.color;
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="${color}" stroke="#FFFFFF" stroke-width="2"/>`);
    }
  }

  const label = `Side view of tile ${tileId} from west to east. Water depth ${depth ?? 'unknown'} m, ${clarity < 0.3 ? 'murky' : clarity < 0.6 ? 'fairly clear' : 'clear'} water, ${cover < 2 ? 'almost no' : cover < 25 ? 'sparse' : 'dense'} submerged plants.`;
  return `<svg class="drawing" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">${parts.join('')}</svg>`;
}

function sampleMark(
  game: Game,
  tileId: string,
  kind: string,
  label: string,
  g: { waterY: number; bedY: number; sedY: number; depth: number | null },
): string {
  const tag = (x: number, y: number) =>
    `<g><rect x="${x}" y="${y - 10}" width="${label.length * 5.6 + 10}" height="14" rx="3" fill="#E8EEEB"/><text x="${x + 5}" y="${y + 1}" font-size="9.5" font-weight="600" fill="#0F1416" font-family="IBM Plex Sans, sans-serif">${label}</text></g>`;
  const line = 'stroke="#E8EEEB" stroke-width="1.2"';
  switch (kind) {
    case 'secchi': {
      const k = game.known(tileId, 'secchi');
      const depthM = k.state === 'measured' ? k.value : 0.5;
      const frac = g.depth ? Math.min(1, depthM / g.depth) : 0.3;
      const y = g.waterY + frac * (g.bedY - g.waterY);
      return `<path d="M88 ${g.waterY - 20} V${y}" ${line}/><rect x="79" y="${y - 2}" width="18" height="5" rx="2" fill="#E8EEEB"/><path d="M60 ${y + 0.5} H120" stroke="#E8EEEB" stroke-dasharray="3 3" stroke-width="1"/>${tag(100, y - 6)}`;
    }
    case 'bottle':
      return `<path d="M120 ${g.waterY - 20} V${g.waterY + 60}" ${line}/><rect x="114" y="${g.waterY + 56}" width="12" height="20" rx="3" fill="none" stroke="#E8EEEB" stroke-width="1.4"/>${tag(130, g.waterY + 70)}`;
    case 'probe':
      return `<path d="M200 ${g.waterY - 20} V${g.bedY - 8}" ${line}/><rect x="197" y="${g.bedY - 14}" width="7" height="12" rx="2" fill="#E8EEEB"/>${tag(146, g.bedY - 26)}`;
    case 'net':
      return `<path d="M70 ${g.waterY + 140} Q120 ${g.waterY + 200} 180 ${g.waterY + 140}" fill="none" stroke="#E8EEEB" stroke-dasharray="2 3" stroke-width="1.2"/>${tag(84, g.waterY + 132)}`;
    case 'trap':
      return `<rect x="4" y="${g.bedY - 56}" width="22" height="16" rx="2" fill="none" stroke="#E8EEEB" stroke-width="1.4"/>${tag(30, g.bedY - 46)}`;
    case 'core':
      return `<rect x="140" y="${g.sedY - 8}" width="12" height="110" rx="2" fill="none" stroke="#E8EEEB" stroke-width="1.5"/>${tag(156, g.sedY + 40)}`;
  }
  return '';
}
