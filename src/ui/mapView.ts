// Isometric map view (build plan milestone 5). Like the tile drawing, it renders only
// what the player can observe or has measured, never the true state.
import { fmt, fmtUnit } from '../sim/format';
import type { FactorStatus, Game } from '../sim/game';
import { OFF_MAP, type GridTile } from '../sim/grid';
import { bounds, type Known } from '../sim/knowledge';
import { gauge } from './gauge';
import type { SceneState, SceneTile } from './scene/pondScene';
import { esc, header, interventionsPanel, knownText, logPanel, modals, objectivePanel, type UiState } from './view';

const TW = 170; // tile width on screen
const TH = 85; // tile height on screen
const DEPTH_PX = 34; // pixels per metre of water on the cut-away faces
const SED_PX = 16; // sediment band below the deepest bed
const MARGIN_X = 210;
const MARGIN_TOP = 70;

/** Variables offered as map overlays, in display order. */
const OVERLAYS = ['water_depth', 'secchi', 'light_bed', 'plant_cover', 'suspended_sediment', 'chla', 'total_p', 'bottom_do', 'carp', 'legacy_p'];

const STATUS_SHORT: Record<FactorStatus, string> = {
  LIMITING: 'st-limiting',
  LIKELY: 'st-likely',
  SUSPECTED: 'st-suspected',
  'NOT LIMITING': 'st-ok',
  UNKNOWN: 'st-unknown',
};

type Pt = { x: number; y: number };

/** The map uses the light theme, so overlays run from near-white to a deepened layer colour. */
const UNKNOWN_FILL = '#D5DCDA';
const ramp = (layerColor: string, t: number) => mix('#F1F4F3', mix(layerColor, '#000000', 0.3), t);

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

const pts = (p: Pt[]) => p.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ');
const add = (a: Pt, b: Pt, k = 1): Pt => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const midpoint = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

interface Geometry {
  ox: number;
  oy: number;
  width: number;
  height: number;
  baseDepth: number;
}

function geometry(game: Game): Geometry {
  const g = game.sim.grid;
  const maxDepth = Math.max(...game.sim.tiles.map((t) => t.values.water_depth ?? 0));
  const baseDepth = maxDepth * DEPTH_PX + SED_PX;
  const ox = MARGIN_X + (g.rows * TW) / 2;
  return { ox, oy: MARGIN_TOP, width: MARGIN_X * 2 + ((g.rows + g.cols) * TW) / 2, height: MARGIN_TOP + ((g.rows + g.cols) * TH) / 2 + baseDepth + 60, baseDepth };
}

/** The four corners of a tile's top face. */
function corners(geo: Geometry, t: GridTile) {
  const x = geo.ox + ((t.col - t.row) * TW) / 2;
  const y = geo.oy + ((t.col + t.row) * TH) / 2;
  return { top: { x, y }, right: { x: x + TW / 2, y: y + TH / 2 }, bottom: { x, y: y + TH }, left: { x: x - TW / 2, y: y + TH / 2 }, centre: { x, y: y + TH / 2 } };
}

/** Edge and outward direction of one face of a tile. */
function face(geo: Geometry, t: GridTile, f: 'N' | 'E' | 'S' | 'W'): { a: Pt; b: Pt; out: Pt } {
  const c = corners(geo, t);
  const norm = (x: number, y: number) => ({ x: x / Math.hypot(x, y), y: y / Math.hypot(x, y) });
  switch (f) {
    case 'N':
      return { a: c.top, b: c.right, out: norm(TW / 2, -TH / 2) };
    case 'E':
      return { a: c.right, b: c.bottom, out: norm(TW / 2, TH / 2) };
    case 'S':
      return { a: c.bottom, b: c.left, out: norm(-TW / 2, TH / 2) };
    case 'W':
      return { a: c.left, b: c.top, out: norm(-TW / 2, -TH / 2) };
  }
}

function mid(k: Known): number | null {
  const b = bounds(k);
  return b ? (b.lo + b.hi) / 2 : null;
}

/** `use3d`: the 3D scene is mounted into #map-slot after rendering; otherwise draw the SVG map. */
export function renderMap(game: Game, ui: UiState, use3d = false): string {
  return `${header(game, ui)}
  <main class="layout">
    <section class="left" aria-label="Pond map">
      ${overlayChips(game, ui)}
      <div class="mapwrap ${use3d ? 'is3d' : ''}" id="map-slot">${use3d ? '' : mapSvg(game, ui)}</div>
      ${legend(game, ui, use3d)}
      ${interventionsPanel(game, ui.tileId)}
    </section>
    <aside class="right" aria-label="Pond overview">
      ${objectivePanel(game)}
      ${tilePanel(game, ui)}
      ${boundaryPanel(game)}
      ${logPanel(game)}
    </aside>
  </main>
  ${modals(game, ui)}`;
}

function overlayChips(game: Game, ui: UiState): string {
  const chip = (id: string, name: string, color: string) =>
    `<button type="button" class="chip ${ui.overlay === id ? 'on' : ''}" data-action="overlay:${id}" aria-pressed="${ui.overlay === id}"><span class="dot" style="background:${color}"></span>${esc(name)}</button>`;
  const layers = new Set(game.mission.layers_enabled);
  const vars = OVERLAYS.map((id) => game.data.variables.get(id)!).filter((v) => layers.has(v.layer));
  return `<div class="chips"><span class="label">Show</span>${chip('surface', 'Surface view', 'var(--text)')}${vars
    .map((v) => chip(v.id, v.name, game.data.layers.get(v.layer)!.color))
    .join('')}</div>`;
}

function mapSvg(game: Game, ui: UiState): string {
  const g = game.sim.grid;
  const geo = geometry(game);
  const overlay = ui.overlay === 'surface' ? null : game.data.variables.get(ui.overlay)!;
  const scale = overlay ? overlayScale(game, overlay.id) : null;
  const parts: string[] = [];

  parts.push(`<defs>
    <pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="none"/><path d="M0 0V7" stroke="#0F1416" stroke-width="2.2" opacity="0.45"/></pattern>
    <marker id="flowhead" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#9CC9E6"/></marker>
    <marker id="compasshead" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#56666C"/></marker>
    <marker id="bndhead" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#4F8FD6"/></marker>
  </defs>`);

  // Boundary channels sit behind the tiles.
  for (const inlet of g.map.inlets) parts.push(channel(geo, g.tiles[g.indexOf(inlet.tile)], inlet.face, 'in'));
  for (const outlet of g.map.outlets) parts.push(channel(geo, g.tiles[g.indexOf(outlet.tile)], outlet.face, 'out'));

  // Painter's order: back to front.
  const order = g.tiles.slice().sort((a, b) => a.row + a.col - (b.row + b.col) || a.col - b.col);
  for (const t of order) {
    const c = corners(geo, t);
    const depthK = game.known(t.id, 'water_depth');
    const depth = depthK.state === 'measured' ? depthK.value : 1;
    const secchi = mid(game.known(t.id, 'secchi')) ?? 0.5;
    const clarity = Math.min(1, Math.max(0, (secchi - 0.2) / 2.2));
    const water = mix('#4B4630', '#1B4A63', clarity);
    const waterSide = mix('#3A3424', '#123448', clarity);

    // Cut-away faces on the front edges of the map show depth and sediment.
    const southOpen = !g.tiles.some((n) => n.row === t.row + 1 && n.col === t.col);
    const eastOpen = !g.tiles.some((n) => n.row === t.row && n.col === t.col + 1);
    const wd = depth * DEPTH_PX;
    const down = (p: Pt, h: number): Pt => ({ x: p.x, y: p.y + h });
    for (const [open, a, b, shade] of [
      [southOpen, c.left, c.bottom, 0],
      [eastOpen, c.bottom, c.right, 1],
    ] as const) {
      if (!open) continue;
      parts.push(`<polygon points="${pts([a, b, down(b, wd), down(a, wd)])}" fill="${shade ? mix(waterSide, '#000000', 0.15) : waterSide}"/>`);
      parts.push(`<polygon points="${pts([down(a, wd), down(b, wd), down(b, geo.baseDepth), down(a, geo.baseDepth)])}" fill="${shade ? '#3E2E20' : '#4E3A28'}"/>`);
      parts.push(`<path d="M${pts([down(a, wd), down(b, wd)])}" stroke="#2E231A" stroke-width="3"/>`);
    }

    // Top face.
    let fill = water;
    let label = '';
    let hatch = false;
    if (overlay && scale) {
      const k = game.known(t.id, overlay.id);
      const b = bounds(k);
      if (!b) {
        fill = UNKNOWN_FILL;
        label = '?';
      } else {
        fill = ramp(game.data.layers.get(overlay.layer)!.color, scale.t((b.lo + b.hi) / 2));
        hatch = k.state === 'estimate';
        label = k.state === 'estimate' ? `${fmt(overlay, b.lo)}–${fmt(overlay, b.hi)}` : fmt(overlay, b.lo);
      }
    }
    const sel = t.id === ui.tileId;
    const diamond = pts([c.top, c.right, c.bottom, c.left]);
    const k = game.known(t.id, 'plant_cover');
    const cover = mid(k) ?? 0;
    const ariaValue = overlay ? `${overlay.name} ${label === '?' ? 'unknown' : label}` : `${t.description}, water ${clarity < 0.3 ? 'murky' : clarity < 0.6 ? 'fairly clear' : 'clear'}`;
    parts.push(`<g class="tile ${sel ? 'sel' : ''}" data-action="tile:${t.id}" tabindex="0" role="button" aria-pressed="${sel}" aria-label="Tile ${t.id}: ${esc(ariaValue)}">`);
    parts.push(`<polygon class="top" points="${diamond}" fill="${fill}"/>`);
    if (hatch) parts.push(`<polygon points="${diamond}" fill="url(#hatch)" pointer-events="none"/>`);
    if (!overlay) {
      // Plant tufts, as many as the visible cover suggests.
      const n = Math.round((cover / 100) * 22);
      for (let i = 0; i < n; i++) {
        const u = jitter(t.index * 100 + i) - 0.5;
        const v = jitter(t.index * 100 + i + 50) - 0.5;
        const p = { x: c.centre.x + (u + v) * TW * 0.42, y: c.centre.y + (v - u) * TH * 0.42 };
        parts.push(`<path d="M${p.x - 3} ${p.y} l3 -6 l3 6 M${p.x} ${p.y} v-7" stroke="#6FB86A" stroke-width="1.4" fill="none" stroke-linecap="round" pointer-events="none"/>`);
      }
      // Carp only appear once a fish survey has measured them.
      const carp = game.known(t.id, 'carp');
      if (carp.state === 'measured') {
        const nf = Math.min(4, Math.round(carp.value / 120));
        for (let i = 0; i < nf; i++) {
          const p = { x: c.centre.x + (jitter(t.index * 7 + i) - 0.5) * TW * 0.4, y: c.centre.y + (jitter(t.index * 7 + i + 3) - 0.5) * TH * 0.35 };
          parts.push(`<path d="M${p.x - 9} ${p.y} q9 -5 16 0 q-7 5 -16 0z M${p.x + 7} ${p.y} l5 -4 v8z" fill="#C2A06A" opacity="0.85" pointer-events="none"/>`);
        }
      }
    }
    parts.push(`<text x="${c.centre.x}" y="${c.centre.y + (overlay ? -8 : 4)}" class="tid" text-anchor="middle" pointer-events="none">${t.id}</text>`);
    if (overlay) parts.push(`<text x="${c.centre.x}" y="${c.centre.y + 10}" class="tval" text-anchor="middle" pointer-events="none">${esc(label)}</text>`);
    parts.push(`</g>`);
  }

  // D8 flow arrows (water movement is visible from the bank).
  if (!overlay || overlay.layer === 'hydrology') {
    for (const t of g.tiles) {
      const r = g.receiver[t.index];
      if (r === null || r === OFF_MAP) continue;
      const a = corners(geo, t).centre;
      const b = corners(geo, g.tiles[r]).centre;
      const s = add(a, { x: b.x - a.x, y: b.y - a.y }, 0.28);
      const e = add(a, { x: b.x - a.x, y: b.y - a.y }, 0.72);
      parts.push(`<path d="M${pts([s, e])}" stroke="#9CC9E6" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#flowhead)" opacity="0.8" pointer-events="none"/>`);
    }
  }

  // Selected tile outline drawn last so it is never covered.
  const selTile = g.tiles[g.indexOf(ui.tileId)];
  const sc = corners(geo, selTile);
  // Dark halo under a white line, so the selection reads on murky water and on the light page alike.
  const selPts = pts([sc.top, sc.right, sc.bottom, sc.left]);
  parts.push(`<polygon points="${selPts}" fill="none" stroke="#182226" stroke-width="5" pointer-events="none"/>`);
  parts.push(`<polygon points="${selPts}" fill="none" stroke="#FFFFFF" stroke-width="2.5" pointer-events="none"/>`);

  for (const inlet of g.map.inlets) parts.push(boundaryLabel(game, geo, g.tiles[g.indexOf(inlet.tile)], inlet.face, inlet.name, 'in'));
  for (const outlet of g.map.outlets) parts.push(boundaryLabel(game, geo, g.tiles[g.indexOf(outlet.tile)], outlet.face, outlet.name, 'out'));
  parts.push(compass(game, geo));

  const desc = `Isometric map of ${g.map.name}, ${g.rows} by ${g.cols} tiles. Water enters from the ${g.map.inlets.map((i) => i.name).join(', ')} and leaves through the ${g.map.outlets.map((o) => o.name).join(', ')}.`;
  return `<svg class="map" viewBox="0 0 ${geo.width} ${geo.height}" role="group" aria-label="${esc(desc)}">${parts.join('')}</svg>`;
}

function channel(geo: Geometry, t: GridTile, f: 'N' | 'E' | 'S' | 'W', dir: 'in' | 'out'): string {
  const { a, b, out } = face(geo, t, f);
  const m = midpoint(a, b);
  const far = add(m, out, 120);
  const half = { x: (b.x - a.x) * 0.16, y: (b.y - a.y) * 0.16 };
  const poly = [add(m, half, -1), add(m, half, 1), add(far, half, 1), add(far, half, -1)];
  const [s, e] = dir === 'in' ? [add(m, out, 105), add(m, out, 12)] : [add(m, out, 12), add(m, out, 105)];
  return `<polygon points="${pts(poly)}" fill="#1E4560" opacity="0.9"/><path d="M${pts([s, e])}" stroke="#4F8FD6" stroke-width="3" marker-end="url(#bndhead)"/>`;
}

function boundaryLabel(game: Game, geo: Geometry, t: GridTile, f: 'N' | 'E' | 'S' | 'W', name: string, dir: 'in' | 'out'): string {
  const { a, b, out } = face(geo, t, f);
  const anchor = add(midpoint(a, b), out, 128);
  const lines: string[] = [];
  if (dir === 'in') {
    for (const id of ['inflow_discharge', 'inflow_tp', 'inflow_no3', 'inflow_ss', 'carp_immigration']) {
      const v = game.data.variables.get(id)!;
      const kt = knownText(v, game.known(t.id, id));
      lines.push(`${v.name.replace(/^Inflow /, '').replace(/^\w/, (c) => c.toUpperCase())}: ${kt.unknown ? '?' : kt.text}`);
    }
  } else {
    lines.push('Water leaves the pond here.');
    lines.push('Carries what the');
    lines.push(`outlet tile (${t.id}) holds.`);
  }
  const barrier = dir === 'in' ? barrierState(game) : null;
  if (barrier) lines.push(barrier);
  const w = 178;
  const h = 26 + lines.length * 15;
  const x = Math.max(6, Math.min(geo.width - w - 6, anchor.x - (out.x < 0 ? w - 10 : 10)));
  const y = Math.max(6, anchor.y - h / 2);
  const text = lines.map((l, i) => `<text x="${x + 10}" y="${y + 36 + i * 15}" class="blval">${esc(l)}</text>`).join('');
  const bars =
    barrier && barrier.startsWith('Carp barrier')
      ? (() => {
          const m = add(midpoint(a, b), out, 55);
          return `<g stroke="#E8EEEB" stroke-width="2">${[-12, -4, 4, 12].map((d) => `<path d="M${m.x + d} ${m.y - 12} v24"/>`).join('')}</g>`;
        })()
      : '';
  return `${bars}<g class="blabel"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7"/><text x="${x + 10}" y="${y + 18}" class="bltitle">${esc(name)}</text>${text}</g>`;
}

function barrierState(game: Game): string | null {
  if (game.sim.activeInterventions().includes('carp_barrier')) return 'Carp barrier being built';
  if (game.timesDone('carp_barrier') > 0) return 'Carp barrier in place';
  return null;
}

function compass(game: Game, geo: Geometry): string {
  const cx = geo.width - 70;
  const cy = 52;
  // North is up-right on this projection (decreasing row).
  const n = { x: TW / 2, y: -TH / 2 };
  const len = Math.hypot(n.x, n.y);
  const u = { x: (n.x / len) * 26, y: (n.y / len) * 26 };
  const wind = game.data.variables.get('wind')!;
  const kw = game.known(game.sim.grid.tiles[0].id, 'wind');
  const windText = kw.state === 'measured' ? fmtUnit(wind, kw.value) : '?';
  return `<g class="compass" aria-hidden="true">
    <circle cx="${cx}" cy="${cy}" r="30"/>
    <path d="M${cx - u.x} ${cy - u.y} L${cx + u.x} ${cy + u.y}" stroke-width="1.5" marker-end="url(#compasshead)"/>
    <text x="${cx + u.x + 6}" y="${cy + u.y - 2}" class="bltitle">N</text>
  </g>
  <text x="${cx}" y="${cy + 48}" class="blval" text-anchor="middle">Wind ${esc(windText)}</text>`;
}

/** Colour scale for an overlay, spanning what the player knows across tiles. */
function overlayScale(game: Game, variableId: string) {
  const bs = game.waterTileIds().map((id) => bounds(game.known(id, variableId))).filter((b): b is { lo: number; hi: number } => !!b);
  let lo = Math.min(...bs.map((b) => b.lo));
  let hi = Math.max(...bs.map((b) => b.hi));
  if (!bs.length) [lo, hi] = [0, 1];
  if (hi - lo < 1e-9) hi = lo + 1;
  return { lo, hi, t: (x: number) => 0.15 + 0.85 * ((x - lo) / (hi - lo)) };
}

function legend(game: Game, ui: UiState, use3d = false): string {
  if (ui.overlay === 'surface') {
    const text = use3d
      ? 'Surface view: water colour from visible clarity, plants from visible cover. Ripples and silt plumes hint at fish; the fish themselves appear once surveyed.'
      : 'Surface view: water colour from visible clarity, green tufts for visible plants. Dashed arrows show water flow. Carp appear once surveyed.';
    return `<div class="legend"><span>${text}</span><span class="muted">Click a tile to select it, click again to investigate.</span></div>`;
  }
  const v = game.data.variables.get(ui.overlay)!;
  const s = overlayScale(game, v.id);
  const color = game.data.layers.get(v.layer)!.color;
  const unknown = game.waterTileIds().filter((id) => !game.knowledge.isKnown(id, v.id)).length;
  return `<div class="legend">
    <span class="ramp" style="background:linear-gradient(90deg, ${use3d ? `${mix('#1B2A33', color, 0.15)}, ${color}` : `${ramp(color, 0)}, ${ramp(color, 1)}`})"></span>
    <span class="mono">${fmtUnit(v, s.lo)} to ${fmtUnit(v, s.hi)}</span>
    <span><span class="swatch hatch"></span> estimate (range shown)</span>
    <span><span class="swatch unk"></span> ? not known${unknown ? ` on ${unknown} of ${game.waterTileIds().length} tiles` : ''}</span>
  </div>`;
}

function tilePanel(game: Game, ui: UiState): string {
  const g = game.sim.grid;
  const t = g.tiles[g.indexOf(ui.tileId)];
  const rows = ['water_depth', 'secchi', 'light_bed', 'plant_cover', 'carp']
    .map((id) => {
      const v = game.data.variables.get(id)!;
      const kt = knownText(v, game.known(t.id, id));
      const val = kt.unknown ? '?' : kt.est ? `${kt.text} ${v.unit}` : kt.text;
      const k = game.known(t.id, id);
      return `<div class="orow gauged"><span>${esc(v.name)}</span><span class="mono">${esc(val)}${kt.est ? ' <span class="est">EST</span>' : ''}</span>${gauge(v, k)}</div>`;
    })
    .join('');
  const flux = game.sim.edgeFluxes(t.id);
  const factors = game
    .limitingFactors(t.id)
    .map((f) => `<div class="fchip"><span class="status ${STATUS_SHORT[f.status]}">${f.status}</span><span>${esc(f.name)}</span></div>`)
    .join('');
  return `<div class="box">
    <div class="label">Selected tile</div>
    <div class="selrow"><div class="selname">${t.id} · ${esc(t.description)}</div></div>
    ${rows}
    <div class="orow"><span>Water flows to</span><span>${esc(flux.to)}</span></div>
    <div class="label" style="margin-top:4px">${esc(game.mission.limiting_factors.title)}</div>
    <div class="fchips">${factors}</div>
    <div class="label" style="margin-top:4px">Select a tile</div>
    ${tilePicker(game, ui)}
    <button type="button" class="btn primary" data-action="open-tile:${t.id}">Investigate tile ${t.id}</button>
  </div>`;
}

function boundaryPanel(game: Game): string {
  const g = game.sim.grid;
  const inletTile = g.map.inlets[0].tile;
  const row = (id: string) => {
    const v = game.data.variables.get(id)!;
    const kt = knownText(v, game.known(inletTile, id));
    const val = kt.unknown ? '? not measured' : kt.text;
    return `<button type="button" class="brow" data-action="inspect-boundary:${id}"><span>${esc(v.name)}</span><span class="mono">${esc(val)}</span>${gauge(v, game.known(inletTile, id))}</button>`;
  };
  const watershed = game.data.boundaryConditions.get(game.mission.boundary_conditions)!;
  const ids = Object.keys(watershed.values).filter((id) => game.data.variables.get(id)!.zone !== 'air');
  const climate = Object.keys(watershed.values).filter((id) => game.data.variables.get(id)!.zone === 'air');
  const barrier = barrierState(game);
  return `<div class="box">
    <div class="label">Boundary conditions</div>
    <div class="bsub">Climate forcings. Not under your control.</div>
    ${climate.map(row).join('')}
    <div class="bsub">Watershed inputs at the ${esc(g.map.inlets.map((i) => i.name).join(', '))}. Fixed in this mission.</div>
    ${ids.map(row).join('')}
    ${barrier ? `<div class="bnote">${esc(barrier)}: blocks most adult carp coming from upstream.</div>` : ''}
  </div>`;
}

/** Keyboard-friendly copy of the grid: the 3D canvas cannot take focus per tile. */
function tilePicker(game: Game, ui: UiState): string {
  const g = game.sim.grid;
  const cells = g.tiles
    .map(
      (t) =>
        `<button type="button" class="tilebtn ${t.id === ui.tileId ? 'on' : ''}" data-action="tile:${t.id}" aria-label="Select tile ${t.id}, ${esc(t.description)}" aria-pressed="${t.id === ui.tileId}" style="grid-row:${t.row + 1};grid-column:${t.col + 1}">${t.id}</button>`,
    )
    .join('');
  return `<div class="switcher" role="group" aria-label="Tiles" style="grid-template-columns:repeat(${g.cols}, 30px)">${cells}</div>`;
}

/** What the 3D scene draws, built from what the player knows (plus visible cues). */
export function sceneState(game: Game, ui: UiState): SceneState {
  const g = game.sim.grid;
  const overlay = ui.overlay === 'surface' ? null : game.data.variables.get(ui.overlay)!;
  const scale = overlay ? overlayScale(game, overlay.id) : null;
  const tiles: SceneTile[] = g.tiles.map((t) => {
    const depthK = game.known(t.id, 'water_depth');
    const secchi = mid(game.known(t.id, 'secchi')) ?? 0.5;
    const carp = game.known(t.id, 'carp');
    let ov: SceneTile['overlay'] = null;
    if (overlay && scale) {
      const k = game.known(t.id, overlay.id);
      const b = bounds(k);
      if (!b) ov = { color: '#7D868A', opacity: 0.35, label: '?' };
      else
        ov = {
          // The 3D stage is dark, so low values are dark and high values bright.
          color: mix('#1B2A33', game.data.layers.get(overlay.layer)!.color, scale.t((b.lo + b.hi) / 2)),
          opacity: k.state === 'estimate' ? 0.5 : 0.75,
          label: k.state === 'estimate' ? `${fmt(overlay, b.lo)}–${fmt(overlay, b.hi)} EST` : fmtUnit(overlay, b.lo),
        };
    }
    return {
      id: t.id,
      row: t.row,
      col: t.col,
      description: t.description,
      depth: depthK.state === 'measured' ? depthK.value : 1,
      turbidity: 1 - Math.min(1, Math.max(0, (secchi - 0.25) / 1.75)),
      cover: (mid(game.known(t.id, 'plant_cover')) ?? 0) / 100,
      fishShown: carp.state === 'measured' ? Math.min(1, carp.value / 400) : 0,
      // Ripples and silt plumes are visible from the bank, so they follow the fish actually there.
      fishCue: Math.min(1, (game.sim.tiles[t.index].values.carp ?? 0) / 450),
      overlay: ov,
    };
  });
  const inletLines = (tileId: string) =>
    ['inflow_discharge', 'inflow_tp', 'inflow_no3', 'inflow_ss', 'carp_immigration'].map((id) => {
      const v = game.data.variables.get(id)!;
      const kt = knownText(v, game.known(tileId, id));
      return `${v.name.replace(/^Inflow /, '').replace(/^\w/, (c) => c.toUpperCase())}: ${kt.unknown ? '?' : kt.text}`;
    });
  const barrier = barrierState(game);
  const any = g.tiles[0].id;
  const discharge = game.known(any, 'inflow_discharge');
  const wind = game.known(any, 'wind');
  return {
    tiles,
    selected: ui.tileId,
    inlets: g.map.inlets.map((i) => ({ tile: i.tile, face: i.face, name: i.name, lines: [...inletLines(i.tile), ...(barrier ? [barrier] : [])].map(esc) })),
    outlets: g.map.outlets.map((o) => ({ tile: o.tile, face: o.face, name: o.name, lines: [`Leaves from ${o.tile}`] })),
    barrier: barrier === null ? 'none' : barrier.includes('being built') ? 'building' : 'in_place',
    discharge: discharge.state === 'measured' ? discharge.value / 500 : 1,
    wind: wind.state === 'measured' ? Math.min(1, wind.value / 12) : 0.4,
  };
}
