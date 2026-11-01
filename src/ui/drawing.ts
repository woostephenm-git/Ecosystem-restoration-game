// Side-view drawing of a tile along its own bed profile. Built only from what the player can
// observe or has measured (design doc 4.3): it must never leak hidden state.
import type { Game } from '../sim/game';
import { bounds } from '../sim/knowledge';
import { tileProfile } from './profile';

export const DRAW_W = 240;
export const ZONE_H: Record<string, number> = { air: 130, water: 330, sediment: 140, bedrock: 90 };

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

/**
 * Inline style for a looping CSS animation that carries on across re-renders. The page is
 * rebuilt on every sim tick; a negative delay taken from one shared clock starts each new
 * element exactly where the old one was.
 */
function loop(name: string, seconds: number, offset: number, extra = ''): string {
  const now = typeof performance === 'undefined' ? 0 : performance.now() / 1000;
  const delay = -((now + offset) % seconds);
  return `animation:${name} ${seconds.toFixed(2)}s ${extra} infinite;animation-delay:${delay.toFixed(2)}s;`;
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

  // Water colour from what the player can see: murky brown when clarity is poor, blue-green when clear.
  const secchi = mid(game, tileId, 'secchi') ?? 0.5;
  const clarity = Math.min(1, Math.max(0, (secchi - 0.2) / 2.2));
  const water = mix('#4B4630', '#173A4E', clarity);
  const waterDeep = mix('#3A3424', '#0F2A3A', clarity);

  const depthKnown = game.known(tileId, 'water_depth');
  const depth = depthKnown.state === 'measured' ? depthKnown.value : null;

  // The bed follows this tile's own profile, shallowest end to deepest. The deepest point
  // meets the top of the sediment zone; dry bank rises into the air zone.
  const prof = tileProfile(game, tileId);
  const n = prof.depths.length;
  const dmax = Math.max(0.3, ...prof.depths);
  const pxPerM = (sedY - waterY) / dmax;
  const yOfDepth = (d: number) => Math.max(airY + 36, waterY + d * pxPerM);
  const at = (x: number) => {
    const f = (Math.min(W, Math.max(0, x)) / W) * (n - 1);
    const k = Math.min(n - 2, Math.floor(f));
    return prof.depths[k] + (prof.depths[k + 1] - prof.depths[k]) * (f - k);
  };
  const bedAt = (x: number) => yOfDepth(at(x));
  const px = (k: number) => (k / (n - 1)) * W;
  const shallowX = prof.shallowLeft ? 0 : W;
  const deepX = W - shallowX;

  const parts: string[] = [];
  parts.push(`<defs>
    <linearGradient id="wgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${water}"/><stop offset="1" stop-color="${waterDeep}"/></linearGradient>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#D6E2E3"/><stop offset="1" stop-color="#EFE6CF"/></linearGradient>
  </defs>`);
  parts.push(`<rect x="0" y="${airY}" width="${W}" height="${ZONE_H.air}" fill="url(#sky)"/>`);
  // Trees on the bank when the shallow end reaches the shore.
  if (Math.min(prof.depths[0], prof.depths[n - 1]) < 0.15) {
    const sx = (x: number) => Math.abs(shallowX - x);
    parts.push(`<circle cx="${sx(-10)}" cy="${airY + 48}" r="58" fill="#5E7E4E"/><circle cx="${sx(34)}" cy="${airY + 22}" r="32" fill="#6F8F5A"/>`);
  }
  // Waves: the surface rides higher and lower with the wind, which the player can see.
  const wind = mid(game, tileId, 'wind') ?? 3;
  const amp = Math.min(4, 1.2 + wind * 0.35);
  const waveLen = 36;
  parts.push(`<rect x="0" y="${waterY + amp}" width="${W}" height="${sedY - waterY - amp}" fill="url(#wgrad)"/>`);
  let wave = `M${-waveLen} ${waterY} Q${-waveLen * 0.75} ${waterY - 2 * amp} ${-waveLen / 2} ${waterY}`;
  for (let x = 0; x <= W + waveLen; x += waveLen / 2) wave += ` T${x} ${waterY}`;
  parts.push(
    `<g class="anim" style="${loop('xs-wave', Math.max(1.6, 4.5 - wind * 0.3), 0, 'linear')}--wl:${waveLen}px">` +
      `<path d="${wave} V${waterY + amp + 1} H${-waveLen} Z" fill="${water}"/>` +
      `<path d="${wave}" fill="none" stroke="#6FA3C7" stroke-width="1.5"/></g>`,
  );

  // The water itself as a clip region, from above the wave crests down to this tile's bed.
  const bedLine = prof.depths.map((d, k) => `${px(k).toFixed(1)},${yOfDepth(d).toFixed(1)}`).reverse();
  parts.push(`<clipPath id="xs-water"><polygon points="0,${waterY - 2 * amp} ${W},${waterY - 2 * amp} ${bedLine.join(' ')}"/></clipPath>`);

  // Suspended particles: drawn only as a visual impression of murk, scaled by visible clarity.
  // Each one wanders slowly in the water.
  const specks = Math.round((1 - clarity) * 34);
  const speckParts: string[] = [];
  for (let i = 0; i < specks; i++) {
    const x = 8 + jitter(i) * (W - 16);
    const y = waterY + 10 + jitter(i + 100) * (bedAt(x) - waterY - 20);
    if (y < waterY + 6) continue;
    const sx = ((jitter(i + 1000) - 0.5) * 22).toFixed(1);
    const sy = ((jitter(i + 1100) - 0.5) * 14).toFixed(1);
    const style = `${loop('xs-drift', 5 + jitter(i + 1200) * 6, jitter(i + 1300) * 10, 'ease-in-out alternate')}--sx:${sx}px;--sy:${sy}px`;
    speckParts.push(`<circle class="anim" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(1 + jitter(i + 200) * 1.2).toFixed(1)}" style="${style}"/>`);
  }
  parts.push(`<g fill="#A08C62" opacity="0.5" clip-path="url(#xs-water)">${speckParts.join('')}</g>`);

  // Rings spreading on the surface now and then.
  const rings: string[] = [];
  for (let i = 0; i < 3; i++) {
    const x = 30 + jitter(i + 1400) * (W - 60);
    if (at(x) < 0.05) continue;
    rings.push(
      `<ellipse class="anim" cx="${x.toFixed(1)}" cy="${waterY + 1}" rx="2" ry="0.7" style="${loop('xs-ring', 4.2, i * 1.4, 'ease-out')}transform-origin:${x.toFixed(1)}px ${waterY + 1}px"/>`,
    );
  }
  parts.push(`<g fill="none" stroke="#CFE3EE" stroke-width="1" vector-effect="non-scaling-stroke">${rings.join('')}</g>`);

  // Sediment under the bed profile with a dark surface layer, then bedrock.
  const bedPts = prof.depths.map((d, k) => `${px(k).toFixed(1)},${yOfDepth(d).toFixed(1)}`);
  const crustPts = prof.depths.map((d, k) => `${px(k).toFixed(1)},${(yOfDepth(d) + 16).toFixed(1)}`).reverse();
  parts.push(`<polygon points="${bedPts.join(' ')} ${W},${rockY} 0,${rockY}" fill="#4E3A28"/>`);
  parts.push(`<polygon points="${bedPts.join(' ')} ${crustPts.join(' ')}" fill="#2E231A"/>`);
  parts.push(`<rect x="0" y="${sedY + 90}" width="${W}" height="${ZONE_H.sediment - 90}" fill="#5C4632"/>`);
  const pebbles = [30, 84, 150, 198, 112].map((x, i) => `<circle cx="${x}" cy="${sedY + 106 + (i % 3) * 12}" r="${3 + (i % 3)}"/>`);
  parts.push(`<g fill="#7A6550">${pebbles.join('')}</g>`);
  parts.push(`<rect x="0" y="${rockY}" width="${W}" height="${ZONE_H.bedrock}" fill="#5E5E66"/>`);
  parts.push(
    `<g stroke="#7A7A83" stroke-width="1"><path d="M0 ${rockY + 24} H${W}"/><path d="M0 ${rockY + 52} H${W}"/><path d="M0 ${rockY + 76} H${W}"/><path d="M60 ${rockY} V${rockY + 24}"/><path d="M150 ${rockY + 24} V${rockY + 52}"/><path d="M96 ${rockY + 52} V${rockY + 76}"/></g>`,
  );
  // Grass along any dry bank.
  const grass = prof.depths
    .map((d, k) => (d < 0 ? `${k && prof.depths[k - 1] < 0 ? 'L' : 'M'}${px(k).toFixed(1)} ${yOfDepth(d).toFixed(1)}` : ''))
    .join('');
  if (grass) parts.push(`<path d="${grass}" stroke="#6E8F4A" stroke-width="3" fill="none" stroke-linecap="round"/>`);

  // Reeds where the margin is shallow (up to about 45 cm of water).
  const reeds: string[] = [];
  for (let i = 0; i < 16 && reeds.length < 6; i++) {
    const x = Math.abs(shallowX - (6 + i * 9));
    const d = at(x);
    if (d < -0.05 || d > 0.45) continue;
    const tipY = airY + 70 + jitter(i + 300) * 30;
    const base = bedAt(x);
    reeds.push(
      `<path class="anim" d="M${x} ${base.toFixed(1)} V${Math.min(tipY, waterY - 12).toFixed(1)}" style="${loop('xs-reed', 3.4 + jitter(i + 1500), x / 50, 'ease-in-out alternate')}transform-origin:${x}px ${base.toFixed(1)}px"/>`,
    );
  }
  parts.push(`<g stroke="#6E8F4A" stroke-width="2" stroke-linecap="round">${reeds.join('')}</g>`);

  // Submerged plants: as many stems as the visible cover suggests, rooted wherever there is water.
  const cover = mid(game, tileId, 'plant_cover') ?? 0;
  const stems = Math.round((cover / 100) * 40);
  const stemParts: string[] = [];
  for (let i = 0; i < stems; i++) {
    const x = 8 + jitter(i + 400) * (W - 16);
    const by = bedAt(x);
    const room = by - waterY;
    if (at(x) < 0.12 || room < 20) continue;
    const h = Math.min(room - 6, 30 + jitter(i + 500) * 90 * (0.4 + cover / 160));
    const bend = (jitter(i + 600) - 0.5) * 14;
    // Swaying from the root; the phase follows x, so a gentle current seems to pass through.
    stemParts.push(
      `<path class="anim" d="M${x.toFixed(1)} ${by.toFixed(1)} Q${(x + bend).toFixed(1)} ${(by - h / 2).toFixed(1)} ${(x - bend / 2).toFixed(1)} ${(by - h).toFixed(1)}" style="${loop('xs-sway', 3 + jitter(i + 1600) * 1.4, x / 45, 'ease-in-out alternate')}transform-origin:${x.toFixed(1)}px ${by.toFixed(1)}px"/>`,
    );
  }
  parts.push(`<g stroke="#5FA35A" stroke-width="1.8" fill="none" stroke-linecap="round">${stemParts.join('')}</g>`);

  // Carp are only drawn once a fish survey has measured them, where the water is deep enough.
  const carp = game.known(tileId, 'carp');
  if (carp.state === 'measured') {
    const count = Math.min(7, Math.round(carp.value / 70));
    const fish: string[] = [];
    for (let i = 0; i < count; i++) {
      const x0 = 30 + jitter(i + 700) * (W - 60);
      const room = bedAt(x0) - waterY;
      if (room < 30) continue;
      const y = bedAt(x0) - 12 - jitter(i + 800) * Math.min(50, room - 26);
      // The stretch of water deep enough to swim along at this height.
      const deep = (x: number) => bedAt(x) - y > 12;
      let lo = x0;
      let hi = x0;
      while (lo > 4 && deep(lo - 2)) lo -= 2;
      while (hi < W - 4 && deep(hi + 2)) hi += 2;
      // The fish faces left (tail on the right): it starts at the right end of its stretch,
      // swims left, turns, and swims back.
      const left = Math.min(x0, lo + 22);
      const x = Math.max(left, hi - 28);
      const dx = left - x;
      const rot = (jitter(i + 900) - 0.5) * 16;
      const tail = `<path class="anim" d="M${x + 17} ${y} L${x + 27} ${y - 7} L${x + 26} ${y + 7} Z" style="${loop('xs-tail', 0.45, i * 0.13, 'ease-in-out alternate')}transform-origin:${x + 17}px ${y}px"/>`;
      const body = `<g transform="rotate(${rot.toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)})"><path d="M${x - 20} ${y} Q${x - 2} ${y - 9} ${x + 18} ${y} Q${x - 2} ${y + 8} ${x - 20} ${y} Z"/>${tail}</g>`;
      const swim = Math.abs(dx) > 16 ? loop('xs-swim', (2 * Math.abs(dx)) / (14 + jitter(i + 1700) * 10), jitter(i + 1800) * 20, 'linear') : '';
      fish.push(`<g class="anim" style="${swim}--dx:${dx.toFixed(1)}px;transform-origin:${x.toFixed(1)}px ${y.toFixed(1)}px">${body}</g>`);
    }
    parts.push(`<g fill="#B0915A" clip-path="url(#xs-water)">${fish.join('')}</g>`);
    // Stirred-up mud towards the deep end, where carp feed.
    const mx = Math.abs(deepX - 70);
    if (fish.length)
      parts.push(`<ellipse class="anim" cx="${mx}" cy="${(bedAt(mx) - 4).toFixed(1)}" rx="60" ry="10" fill="#6B5A40" opacity="0.45" style="${loop('xs-murk', 5, 0, 'ease-in-out alternate')}"/>`);
  }

  // Depth scale at the deep end (labelled once depth has been measured).
  const deepRight = prof.shallowLeft;
  const scaleX = deepRight ? W - 6 : 6;
  const tickDir = deepRight ? -4 : 4;
  const ticks: string[] = [];
  const labels: string[] = [];
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const y = waterY + ((sedY - waterY) * i) / steps;
    ticks.push(`<path d="M${scaleX + tickDir} ${y} H${scaleX}"/>`);
    const text = depth === null ? '' : `${((dmax * i) / steps).toFixed(1)}${i === steps ? ' m' : ''}`;
    labels.push(`<text x="${scaleX + tickDir * 1.75}" y="${(y + (i === 0 ? 10 : i === steps ? -3 : 3)).toFixed(0)}">${text}</text>`);
  }
  parts.push(`<g stroke="#C9D3CF" stroke-width="1"><path d="M${scaleX} ${waterY} V${sedY}"/>${ticks.join('')}</g>`);
  parts.push(`<g fill="#C9D3CF" font-family="IBM Plex Mono, monospace" font-size="9" text-anchor="${deepRight ? 'end' : 'start'}">${labels.join('')}</g>`);
  parts.push(
    `<g fill="#46351C" stroke="#EFE6CF" stroke-width="3" paint-order="stroke" font-family="IBM Plex Sans, sans-serif" font-size="10" font-weight="600"><text x="6" y="${airY + 14}">${prof.left}</text><text x="${W - 6}" y="${airY + 14}" text-anchor="end">${prof.right}</text></g>`,
  );

  // Sampling marks for methods run on this tile in the last week.
  for (const m of game.methods()) {
    const ago = game.sampledDaysAgo(m.id, tileId);
    if (ago === null || ago > 7) continue;
    parts.push(sampleMark(game, tileId, m.mark.kind, m.mark.label, { waterY, pxPerM, bedAt }));
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

  const ends = prof.shallowLeft ? `${prof.left} (shallow) to ${prof.right} (deep)` : `${prof.left} (deep) to ${prof.right} (shallow)`;
  const label = `Side view of tile ${tileId}, cut from ${ends}. Water depth ${depth ?? 'unknown'} m, ${clarity < 0.3 ? 'murky' : clarity < 0.6 ? 'fairly clear' : 'clear'} water, ${cover < 2 ? 'almost no' : cover < 25 ? 'sparse' : 'dense'} submerged plants.`;
  return `<svg class="drawing" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">${parts.join('')}</svg>`;
}

function sampleMark(
  game: Game,
  tileId: string,
  kind: string,
  label: string,
  g: { waterY: number; pxPerM: number; bedAt: (x: number) => number },
): string {
  const tag = (x: number, y: number) =>
    `<g><rect x="${x}" y="${y - 10}" width="${label.length * 5.6 + 10}" height="14" rx="3" fill="#E8EEEB"/><text x="${x + 5}" y="${y + 1}" font-size="9.5" font-weight="600" fill="#0F1416" font-family="IBM Plex Sans, sans-serif">${label}</text></g>`;
  const line = 'stroke="#E8EEEB" stroke-width="1.2"';
  switch (kind) {
    case 'secchi': {
      const k = game.known(tileId, 'secchi');
      const depthM = k.state === 'measured' ? k.value : 0.5;
      const y = Math.min(g.waterY + depthM * g.pxPerM, g.bedAt(88) - 4);
      return `<path d="M88 ${g.waterY - 20} V${y}" ${line}/><rect x="79" y="${y - 2}" width="18" height="5" rx="2" fill="#E8EEEB"/><path d="M60 ${y + 0.5} H120" stroke="#E8EEEB" stroke-dasharray="3 3" stroke-width="1"/>${tag(100, y - 6)}`;
    }
    case 'bottle':
      return `<path d="M120 ${g.waterY - 20} V${g.waterY + 30}" ${line}/><rect x="114" y="${g.waterY + 26}" width="12" height="20" rx="3" fill="none" stroke="#E8EEEB" stroke-width="1.4"/>${tag(130, g.waterY + 40)}`;
    case 'probe': {
      const b = g.bedAt(200);
      return `<path d="M200 ${g.waterY - 20} V${b - 8}" ${line}/><rect x="197" y="${b - 14}" width="7" height="12" rx="2" fill="#E8EEEB"/>${tag(146, b - 26)}`;
    }
    case 'net': {
      const y = Math.min(g.waterY + 140, Math.min(g.bedAt(70), g.bedAt(180)) - 70);
      return `<path d="M70 ${y} Q120 ${y + 60} 180 ${y}" fill="none" stroke="#E8EEEB" stroke-dasharray="2 3" stroke-width="1.2"/>${tag(84, y - 8)}`;
    }
    case 'trap': {
      const b = g.bedAt(15);
      return `<rect x="4" y="${b - 56}" width="22" height="16" rx="2" fill="none" stroke="#E8EEEB" stroke-width="1.4"/>${tag(30, b - 46)}`;
    }
    case 'core': {
      const b = g.bedAt(146);
      return `<rect x="140" y="${b - 8}" width="12" height="110" rx="2" fill="none" stroke="#E8EEEB" stroke-width="1.5"/>${tag(156, b + 40)}`;
    }
  }
  return '';
}
