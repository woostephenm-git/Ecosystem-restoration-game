// Map screen: the 3D map (map3d/MapScene) plus the panels around it. The scene is created
// once and moved into place on each render; this module builds what it is allowed to show.
import { fmt, fmtUnit, withUnit } from '../sim/format';
import type { FactorStatus, Game } from '../sim/game';
import { OFF_MAP } from '../sim/grid';
import { bounds, type Known } from '../sim/knowledge';
import { gauge } from './gauge';
import type { MapViewState, TileView } from './map3d/MapScene';
import { barrierState, esc, header, interventionsPanel, knownText, modals, type UiState } from './view';

/** Variables offered as map overlays, in display order. */
const OVERLAYS = ['water_depth', 'secchi', 'light_bed', 'plant_cover', 'suspended_sediment', 'chla', 'total_p', 'bottom_do', 'carp', 'legacy_p'];

const STATUS_SHORT: Record<FactorStatus, string> = {
  LIMITING: 'st-limiting',
  LIKELY: 'st-likely',
  SUSPECTED: 'st-suspected',
  'NOT LIMITING': 'st-ok',
  UNKNOWN: 'st-unknown',
};

function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const c = pa.map((x, i) => Math.round(x + (pb[i] - x) * Math.min(1, Math.max(0, t))));
  return `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}
/** The map uses the light theme, so overlays run from near-white to a deepened layer colour. */
const ramp = (layerColor: string, t: number) => mix('#F1F4F3', mix(layerColor, '#000000', 0.3), t);

function mid(k: Known): number | null {
  const b = bounds(k);
  return b ? (b.lo + b.hi) / 2 : null;
}

export function renderMap(game: Game, ui: UiState): string {
  return `${header(game, ui)}
  <main class="layout">
    <section class="left" aria-label="Pond map">
      <div id="stage-slot"></div>
      ${legend(game, ui)}
    </section>
    <aside class="right" aria-label="Pond overview">
      ${tilePanel(game, ui)}
      ${interventionsPanel(game, ui.selection, ui.selection.length > 1 ? `${ui.selection.length} selected tiles` : undefined)}
    </aside>
  </main>
  ${modals(game, ui)}`;
}

/** Views offered in the map's "Show" drop-down. */
function overlayOptions(game: Game) {
  const layers = new Set(game.mission.layers_enabled);
  const vars = OVERLAYS.map((id) => game.data.variables.get(id)!).filter((v) => layers.has(v.layer));
  return [
    { id: 'surface', label: 'Surface view', group: 'Views' },
    { id: 'flow', label: 'Water flow', group: 'Views' },
    ...vars.map((v) => ({ id: v.id, label: v.name, group: 'What you know' })),
  ];
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


/**
 * Mean rise of the pond surface since the mission began, from the depth gauges on the
 * original pond tiles (water depth is fully observable). Flooded meadow is left out:
 * its depth starts from dry ground, not from the old surface.
 */
function waterRise(game: Game): number {
  const map = game.sim.grid.map;
  const pond = game.sim.grid.waterTiles().filter((t) => (map.tiles[t.index].initial.water_depth ?? 0) > 0);
  let sum = 0;
  for (const t of pond) {
    const k = game.known(t.id, 'water_depth');
    const start = map.tiles[t.index].initial.water_depth ?? 0;
    if (k.state === 'measured') sum += k.value - start;
  }
  return pond.length ? sum / pond.length : 0;
}

/** The outlet weir: raised by the raise_weir intervention's depth change, built over its duration. */
function weirState(game: Game): MapViewState['weir'] {
  const iv = game.data.interventions.get('raise_weir');
  if (!iv || !game.mission.interventions.includes(iv.id)) return { raisedBy: 0, building: false, progress: 0 };
  const level = game.sim.grid.map.level_variable;
  const full = iv.effects.find((e) => e.variable === level && e.op === 'add')?.value ?? 0;
  const progress = game.sim.interventionProgress(iv.id);
  if (progress !== null) return { raisedBy: full * progress, building: true, progress };
  return { raisedBy: game.timesDone(iv.id) > 0 ? full : 0, building: false, progress: 0 };
}

/** Everything the 3D scene may draw: observable state and knowledge only. */
export function mapViewState(game: Game, ui: UiState): MapViewState {
  const g = game.sim.grid;
  const map = g.map;
  const overlayVar = ui.overlay !== 'surface' && ui.overlay !== 'flow' ? game.data.variables.get(ui.overlay)! : null;
  const scale = overlayVar ? overlayScale(game, overlayVar.id) : null;
  const layerColor = overlayVar ? game.data.layers.get(overlayVar.layer)!.color : '#000000';
  const bodyName = new Map(map.bodies.map((b) => [b.id, b.name]));

  const tiles: TileView[] = g.tiles.map((t) => {
    const values = game.sim.tiles[t.index].values;
    if (!t.water) {
      const above = (values.bed_elevation ?? map.water_level) - map.water_level;
      const runoff = g.runoffTo[t.index];
      const drains = runoff === null ? '' : runoff === OFF_MAP ? ' · runoff pools here' : ` · runoff drains to ${g.tiles[runoff].id}`;
      const info = t.body ? `${bodyName.get(t.body)} · scenery in this mission` : `${above.toFixed(2)} m above the pond surface${drains}`;
      return { id: t.id, row: t.row, col: t.col, water: false, turbidity: null, cover: 0, carpMeasured: null, overlay: null, title: `Tile ${t.id} · ${t.description}`, info };
    }
    const secchi = mid(game.known(t.id, 'secchi'));
    const turbidity = secchi === null ? 0.6 : Math.min(1, Math.max(0, (1.6 - secchi) / 1.4)) * 0.9 + 0.05;
    const cover = (mid(game.known(t.id, 'plant_cover')) ?? 0) / 100;
    const carpK = game.known(t.id, 'carp');
    let overlay: TileView['overlay'] = null;
    let overlayText = '';
    if (overlayVar && scale) {
      const k = game.known(t.id, overlayVar.id);
      const b = bounds(k);
      overlay = b ? { color: ramp(layerColor, scale.t((b.lo + b.hi) / 2)), state: k.state as 'estimate' | 'measured' } : { color: '#D5DCDA', state: 'unknown' };
      const kt = knownText(overlayVar, k);
      overlayText = ` · ${overlayVar.name}: ${kt.unknown ? 'not known' : kt.est ? `${withUnit(overlayVar, kt.text)} (estimate)` : kt.text}`;
    }
    const depth = game.known(t.id, 'water_depth');
    const depthText = depth.state === 'measured' ? `water depth ${fmtUnit(game.data.variables.get('water_depth')!, depth.value)} (gauge)` : '';
    return {
      id: t.id,
      row: t.row,
      col: t.col,
      water: true,
      turbidity,
      cover,
      carpMeasured: carpK.state === 'measured' ? carpK.value : null,
      overlay,
      title: `Tile ${t.id} · ${t.description}`,
      info: depthText + overlayText,
    };
  });

  return {
    tiles,
    focus: ui.tileId,
    selection: ui.selection,
    windSpeed: game.sim.boundary.wind ?? 0,
    flowOverlay: ui.overlay === 'flow',
    flow: g.flowVector,
    runoff: g.runoffTo,
    boundaries: [
      ...map.inlets.map((b) => ({ tile: b.tile, face: b.face, name: b.name, kind: 'in' as const })),
      ...map.outlets.map((b) => ({ tile: b.tile, face: b.face, name: b.name, kind: 'out' as const })),
    ],
    barrier: barrierState(game),
    bales: game.mission.interventions.includes('barley_straw') ? game.sim.interventionProgress('barley_straw') : null,
    waterRise: waterRise(game),
    weir: weirState(game),
    overlay: ui.overlay,
    overlayOptions: overlayOptions(game),
  };
}

function legend(game: Game, ui: UiState): string {
  if (ui.overlay === 'surface') {
    return `<div class="legend"><span>Surface view: water colour from visible clarity, green fronds for visible plants. Fish appear once surveyed.</span></div>`;
  }
  if (ui.overlay === 'flow') {
    return `<div class="legend"><span><span class="swatch" style="background:#1f5f8e"></span> water flowing through the pond (longer arrows carry more)</span><span><span class="swatch" style="background:#8a5a2b"></span> where rain runs off the land; × marks a hollow</span></div>`;
  }
  const v = game.data.variables.get(ui.overlay)!;
  const s = overlayScale(game, v.id);
  const color = game.data.layers.get(v.layer)!.color;
  const unknown = game.waterTileIds().filter((id) => !game.knowledge.isKnown(id, v.id)).length;
  return `<div class="legend">
    <span class="ramp" style="background:linear-gradient(90deg, ${ramp(color, 0.15)}, ${ramp(color, 1)})"></span>
    <span class="mono">${fmtUnit(v, s.lo)} to ${fmtUnit(v, s.hi)}</span>
    <span><span class="swatch hatch"></span> estimate</span>
    <span><span class="swatch unk"></span> ? not known${unknown ? ` on ${unknown} of ${game.waterTileIds().length} tiles` : ''}</span>
    <span class="muted">Hover a tile for its value.</span>
  </div>`;
}

function tilePanel(game: Game, ui: UiState): string {
  const g = game.sim.grid;
  const t = g.tiles[g.indexOf(ui.tileId)];
  const map = g.map;
  if (!t.water) {
    const values = game.sim.tiles[t.index].values;
    const above = (values.bed_elevation ?? map.water_level) - map.water_level;
    const runoff = g.runoffTo[t.index];
    const body = t.body ? map.bodies.find((b) => b.id === t.body)! : null;
    return `<div class="box">
      <div class="label">Selected tile</div>
      <div class="selrow"><div class="selname">${t.id} · ${esc(t.description)}</div></div>
      ${
        body
          ? `<div class="orow"><span>Water body</span><span>${esc(body.name)}</span></div><p class="muted small">This pond is not connected to Clearwater Pond and is not part of this mission.</p>`
          : `<div class="orow"><span>Height above the pond</span><span class="mono">${fmt(game.data.variables.get('bed_elevation')!, above)} m</span></div>
             <div class="orow"><span>Rain runs off to</span><span>${runoff === null ? '' : runoff === OFF_MAP ? 'Pools in a hollow' : g.tiles[runoff].id}</span></div>
             <p class="muted small">Land is scenery in Mission 1. Later missions bring runoff and land use into play.</p>`
      }
    </div>`;
  }
  const rows = ['water_depth', 'secchi', 'light_bed', 'plant_cover', 'carp']
    .map((id) => {
      const v = game.data.variables.get(id)!;
      const k = game.known(t.id, id);
      const kt = knownText(v, k);
      const val = kt.unknown ? '?' : kt.est ? withUnit(v, kt.text) : kt.text;
      return `<div class="orow gauged"><span>${esc(v.name)}</span><span class="mono">${esc(val)}${kt.est ? ' <span class="est">EST</span>' : ''}</span>${gauge(v, k)}</div>`;
    })
    .join('');
  const flux = game.sim.edgeFluxes(t.id);
  const factors = game
    .limitingFactors(t.id)
    .map((f) => `<div class="fchip"><span class="status ${STATUS_SHORT[f.status]}">${f.status}</span><span>${esc(f.name)}</span></div>`)
    .join('');
  const sel = ui.selection.length > 1 ? `<p class="muted small">${ui.selection.length} tiles selected for planting. Shift-click a tile to add or remove it.</p>` : '';
  return `<div class="box">
    <div class="label">Selected tile</div>
    <div class="selrow"><div class="selname">${t.id} · ${esc(t.description)}</div></div>
    ${rows}
    <div class="orow"><span>Water flows to</span><span>${esc(flux.to)}</span></div>
    <div class="label" style="margin-top:4px">${esc(game.mission.limiting_factors.title)}</div>
    <div class="fchips">${factors}</div>
    ${sel}
    <button type="button" class="btn primary" data-action="open-tile:${t.id}">Investigate tile ${t.id}</button>
  </div>`;
}

