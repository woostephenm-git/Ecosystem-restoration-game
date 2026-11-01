// Investigation view (design doc section 5). Renders game state to HTML strings;
// main.ts owns the UI state and wires the data-action attributes to handlers.
import { calendar, fmt, fmtMoney, fmtRange, fmtUnit, withUnit } from '../sim/format';
import type { FactorStatus, Game } from '../sim/game';
import type { Known } from '../sim/knowledge';
import type { NormalLink } from '../sim/loader';
import type { Variable } from '../sim/schema';
import { DRAW_W, ZONE_H, drawTile } from './drawing';
import { decisionModal, fundingButton, fundingModal } from './fundingView';
import { gauge } from './gauge';

export interface UiState {
  screen: 'map' | 'tile' | 'debrief';
  /** Selected tile on the map, and the tile open in the investigation view. */
  tileId: string;
  layer: string;
  selected: string;
  /** Map overlay: 'surface' for the observable view, 'flow', or a variable id. */
  overlay: string;
  /** Pond tiles selected on the map; tile-scoped interventions act on all of them. */
  selection: string[];
  /** The mission drawer (objective, weather and inflow, field log) under the top bar. */
  drawerOpen: boolean;
  speed: 0 | 1 | 4;
  showBriefing: boolean;
  showOutcome: boolean;
  /** Debrief chart: a pond tile or the median of all of them, and up to four variables in fixed colour slots. */
  debrief: { tile: string; slots: (string | null)[]; table: boolean };
  /**
   * The funding application pop-up. Two arrows only: `factor` limits the target (the red arrow),
   * and `cause` drives the factor (the brown arrow).
   */
  funding: { open: boolean; factor: string | null; cause: string | null };
  /** A funding decision that has just arrived (index into game.applications), shown until closed. */
  decision: number | null;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STATUS_CLASS: Record<FactorStatus, string> = {
  LIMITING: 'st-limiting',
  LIKELY: 'st-likely',
  SUSPECTED: 'st-suspected',
  'NOT LIMITING': 'st-ok',
  UNKNOWN: 'st-unknown',
};

const STRENGTH_W = { strong: 100, moderate: 60, weak: 30 };

export const icon = {
  back: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>',
  pause: '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="2" y="2" width="3.5" height="10" rx="1"/><rect x="8.5" y="2" width="3.5" height="10" rx="1"/></svg>',
  play: '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M3 2l9 5-9 5z"/></svg>',
  fast: '<svg width="18" height="14" viewBox="0 0 18 14" fill="currentColor" aria-hidden="true"><path d="M1 2l8 5-8 5zM9 2l8 5-8 5z"/></svg>',
  step: '<svg width="16" height="14" viewBox="0 0 16 14" fill="currentColor" aria-hidden="true"><path d="M2 2l8 5-8 5z"/><rect x="11" y="2" width="2.5" height="10" rx="1"/></svg>',
  arrow: '<svg width="14" height="10" viewBox="0 0 14 10" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M1 5h11M8 1l4 4-4 4"/></svg>',
};

export function knownText(v: Variable, k: Known): { text: string; est: boolean; unknown: boolean } {
  if (k.state === 'unknown') return { text: '? not sampled', est: false, unknown: true };
  if (k.state === 'estimate') return { text: fmtRange(v, k.lo, k.hi), est: true, unknown: false };
  return { text: fmtUnit(v, k.value), est: false, unknown: false };
}

function ageText(day: number, today: number): string {
  const d = today - day;
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  return `${d} days ago`;
}

function sourceText(game: Game, v: Variable, k: Known): string {
  if (k.state === 'unknown') {
    const methods = game.methods().filter((m) => m.reveals.includes(v.id));
    if (v.inferred_from) {
      const names = v.inferred_from.map((id) => game.data.variables.get(id)!.name.toLowerCase());
      return `Not known. Can be calculated once ${names.join(' and ')} are known.`;
    }
    return methods.length ? `Not sampled. Use: ${methods.map((m) => m.name).join(', ')}.` : 'Cannot be observed in this mission.';
  }
  const when = ageText(k.day, game.day);
  if (k.state === 'estimate') return `${k.source} (${when}). Sample for a measured value.`;
  if (v.observable === 'full' || v.inferred_from) return `${k.source}, ${when}.`;
  return `Measured ${when} by ${k.source.toLowerCase()}.`;
}

export function renderTile(game: Game, ui: UiState): string {
  return `${header(game, ui)}
  <main class="layout">
    <section class="left" aria-label="Tile cross-section">
      <div class="tile-nav">${tilePicker(game, ui)}${chips(game, ui)}</div>
      <div class="xsec-scroll">${crossSection(game, ui)}</div>
      ${methodsPanel(game, ui)}
      ${interventionsPanel(game, [ui.tileId])}
    </section>
    <aside class="right" aria-label="Analysis">
      ${selectedPanel(game, ui)}
      ${limitsPanel(game, ui)}
    </aside>
  </main>
  ${modals(game, ui)}`;
}

export function modals(game: Game, ui: UiState): string {
  return `${ui.showBriefing ? briefing(game) : ''}${ui.showOutcome && game.outcome ? outcomeModal(game) : ''}${ui.funding.open && game.mission.funding ? fundingModal(game, ui) : ''}${ui.decision !== null ? decisionModal(game, ui.decision) : ''}`;
}

/**
 * The tiles around this one as a 3 × 3 isometric grid, turned the way the map's opening view
 * is (north to the upper right). The centre is the tile open now; pond tiles around it open
 * on click. Land and off-map tiles are drawn but cannot be picked.
 */
function tilePicker(game: Game, ui: UiState): string {
  const g = game.sim.grid;
  const t = g.tiles[g.indexOf(ui.tileId)];
  const CW = 50;
  const CH = 25;
  const W = 3 * CW;
  const H = 3 * CH;
  const DIRS: Record<string, string> = {
    '-1,-1': 'north-west',
    '-1,0': 'north',
    '-1,1': 'north-east',
    '0,-1': 'west',
    '0,1': 'east',
    '1,-1': 'south-west',
    '1,0': 'south',
    '1,1': 'south-east',
  };
  const cells: string[] = [];
  // Draw back to front so the hover outline of a near tile is never hidden.
  for (let s = -2; s <= 2; s++)
    for (let dr = -1; dr <= 1; dr++) {
      const dc = s - dr;
      if (dc < -1 || dc > 1) continue;
      // Isometric placement: columns run down-right, rows run down-left.
      const cx = W / 2 + ((dc - dr) * CW) / 2;
      const cy = H / 2 + ((dc + dr) * CH) / 2;
      const pts = `${cx},${cy - CH / 2} ${cx + CW / 2},${cy} ${cx},${cy + CH / 2} ${cx - CW / 2},${cy}`;
      const n = g.at(t.row + dr, t.col + dc);
      const here = dr === 0 && dc === 0;
      const label = n ? `<text x="${cx}" y="${cy + 3.5}" text-anchor="middle">${n.id}</text>` : '';
      if (here) {
        cells.push(`<g class="tp here" role="img" aria-label="Tile ${t.id}, open now"><polygon points="${pts}"/>${label}</g>`);
      } else if (n?.water) {
        const name = `Go ${DIRS[`${dr},${dc}`]} to tile ${n.id}`;
        cells.push(`<g class="tp pond" data-action="open-tile:${n.id}" role="button" tabindex="0" aria-label="${name}"><title>${name}</title><polygon points="${pts}"/>${label}</g>`);
      } else {
        cells.push(`<g class="tp ${n ? 'land' : 'off'}" aria-hidden="true"><polygon points="${pts}"/>${label}</g>`);
      }
    }
  return `<div class="tile-picker">
    <svg viewBox="-2 -4 ${W + 26} ${H + 8}" width="${W + 26}" height="${H + 8}" role="group" aria-label="Neighbouring tiles">
      ${cells.join('')}
      <g class="tp-north" aria-hidden="true"><path d="M${(3 * W) / 4 + 6} ${H / 4 - 3} l10 -5"/><text x="${(3 * W) / 4 + 18}" y="${H / 4 - 6}">N</text></g>
    </svg>
  </div>`;
}

export function header(game: Game, ui: UiState): string {
  const cal = calendar(game.day, game.mission.start.day_of_year);
  const speedBtn = (speed: 0 | 1 | 4, label: string, ic: string) =>
    `<button type="button" class="btn time ${ui.speed === speed ? 'on' : ''}" data-action="speed:${speed}" aria-pressed="${ui.speed === speed}">${ic}<span>${label}</span></button>`;
  const onMap = ui.screen === 'map';
  const onDebrief = ui.screen === 'debrief';
  const tile = game.sim.grid.tiles[game.sim.grid.indexOf(ui.tileId)];
  const title = onMap ? `${esc(game.mission.title)} · Map` : onDebrief ? 'Debrief' : `Tile ${esc(ui.tileId)} · ${esc(tile.description)}`;
  // Time stands still on the debrief, so the chart can be read and hovered.
  const time = onDebrief
    ? ''
    : `<div class="time-controls" role="group" aria-label="Time controls">
      ${speedBtn(0, 'Pause', icon.pause)}
      ${speedBtn(1, '1 week/s', icon.play)}
      ${speedBtn(4, '1 month/s', icon.fast)}
      <button type="button" class="btn time" data-action="step">${icon.step}<span>+1 week</span></button>
    </div>
    <div class="sep"></div>`;
  return `<header class="top">
    ${onMap ? '' : `<button type="button" class="btn" data-action="back-to-map">${icon.back}<span>Back to map</span></button>`}
    <div class="title">
      <div class="t1">${title}</div>
      <div class="t2">Mission 1: ${esc(game.mission.title)} · ${cal.label}</div>
    </div>
    <div class="grow"></div>
    ${game.outcome && !onDebrief ? `<button type="button" class="btn" data-action="debrief">Debrief</button><div class="sep"></div>` : ''}
    ${time}
    <div class="stat"><div class="k">Budget</div><div class="v mono">${fmtMoney(game.budget)}</div></div>
    <div class="sep"></div>
    <div class="stat"><div class="k">Samples taken</div><div class="v mono">${game.samplesTaken}</div></div>
    ${missionDrawer(game, ui)}
  </header>`;
}

/**
 * The objective, weather and inflow, and field log live in a drawer that slides down from
 * under the top bar. Its tab peeks out below the bar and summarises the objective.
 */
function missionDrawer(game: Game, ui: UiState): string {
  const o = game.mission.objective;
  const v = game.data.variables.get(o.variable)!;
  const k = game.knownMean(o.variable);
  const kt = knownText(v, k);
  const left = Math.max(0, game.deadlineDay - game.day);
  const now = kt.unknown ? '?' : kt.est ? withUnit(v, kt.text) : kt.text;
  const status = game.outcome ? (game.outcome.success ? 'objective met' : 'deadline passed') : `${left} days left`;
  const chevron = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>`;
  return `<div class="drawer-wrap ${ui.drawerOpen ? 'open' : ''}">
    <div class="drawer" id="mission-drawer" role="region" aria-label="Mission objective, weather and inflow, field log">
      <div class="drawer-inner">
        <div class="drawer-grid">
          ${objectivePanel(game)}
          ${boundaryPanel(game)}
          ${logPanel(game, 12) || '<div class="box log"><div class="label">Field log</div><p class="muted small">Nothing yet. Samples and interventions are recorded here.</p></div>'}
        </div>
      </div>
    </div>
    <button type="button" class="drawer-tab" data-action="drawer" aria-expanded="${ui.drawerOpen}" aria-controls="mission-drawer">
      <span class="dt-label">Mission</span>
      <span class="dt-sep" aria-hidden="true"></span>
      <span>${esc(v.name)} <span class="mono">${esc(now)}</span> of <span class="mono">${fmtUnit(v, o.target)}</span></span>
      <span class="dt-sep" aria-hidden="true"></span>
      <span>${status}</span>
      <span class="dt-chev">${chevron}</span>
    </button>
  </div>`;
}

function chips(game: Game, ui: UiState): string {
  const defs = [{ id: 'all', name: 'All layers', color: 'var(--text)' }, ...game.mission.layers_enabled.map((id) => game.data.layers.get(id)!)];
  return `<div class="chips"><span class="label">Layers</span>${defs
    .map(
      (c) =>
        `<button type="button" class="chip ${ui.layer === c.id ? 'on' : ''}" data-action="layer:${c.id}" aria-pressed="${ui.layer === c.id}"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</button>`,
    )
    .join('')}</div>`;
}

function crossSection(game: Game, ui: UiState): string {
  const zones = game.data.zones;
  const order = zones.map((z) => z.id);
  const flux = game.sim.edgeFluxes(ui.tileId);
  const visible = game.visibleVariables();

  const fluxRows = (side: 'inflow' | 'outflow') =>
    zones
      .map((z) => {
        const list = flux[side][z.id] ?? [];
        const items = list
          .map((id) => {
            const v = game.data.variables.get(id)!;
            const k = game.known(ui.tileId, id);
            const kt = knownText(v, k);
            const name = side === 'inflow' ? v.name.replace(/^Incoming /, '').replace(/^\w/, (c) => c.toUpperCase()) : v.name;
            const val = kt.unknown ? '?' : kt.text + (kt.est ? ' EST' : '');
            return `<button type="button" class="flux ${ui.selected === v.id ? 'sel' : ''}" data-action="select:${v.id}"><span class="fn">${esc(name)}</span><span class="fv mono">${esc(val)}</span>${gauge(v, k)}</button>`;
          })
          .join('');
        const water = z.id === 'water';
        const title = side === 'inflow' ? (water ? 'Arriving' : z.id === 'air' ? 'Upwind' : 'Lateral') : water ? `To ${flux.to}` : z.id === 'air' ? 'Downwind' : 'Lateral';
        const sources = [...flux.from.inlets, ...flux.from.upstream];
        const fromText = `${sources.length ? `Flow from ${sources.join(', ')}. ` : ''}Mixes with ${flux.from.mixing.join(', ')}.`;
        const sub = side === 'inflow' && water ? `<div class="fsub">${esc(fromText)}</div>` : '';
        const arrowFirst = side === 'inflow';
        return `<div class="fluxzone zone-${z.id}" style="height:${ZONE_H[z.id]}px">
          <div class="ftitle">${arrowFirst ? icon.arrow : ''}${esc(title)}${arrowFirst ? '' : icon.arrow}</div>
          ${sub}
          ${items || '<div class="fnone">No tracked flux</div>'}
        </div>`;
      })
      .join('');

  const cardRows = zones
    .map((z) => {
      const cards = visible
        .filter((v) => v.zone === z.id)
        .map((v) => {
          const k = game.known(ui.tileId, v.id);
          const kt = knownText(v, k);
          const dim = ui.layer !== 'all' && ui.layer !== v.layer;
          const sel = ui.selected === v.id;
          const color = game.data.layers.get(v.layer)!.color;
          const value = kt.unknown
            ? `<span class="val unknown mono">? not sampled</span>`
            : `<span class="val mono">${esc(kt.text)}</span>${kt.est ? '<span class="est">EST</span>' : ''}${
                k.state === 'measured' && game.isStale(k) ? `<span class="age" title="Measured ${game.day - k.day} days ago">${game.day - k.day}d old</span>` : ''
              }`;
          return `<button type="button" class="card ${sel ? 'sel' : ''} ${dim ? 'dim' : ''}" data-action="select:${v.id}" aria-pressed="${sel}">
            <span class="cname"><span class="dot" style="background:${color}"></span>${esc(v.name)}</span>
            <span class="cval">${value}</span>
            ${gauge(v, k)}
          </button>`;
        })
        .join('');
      return `<div class="zonecards zone-${z.id}" style="height:${ZONE_H[z.id]}px">
        <div class="zname">${esc(z.name)}</div>
        <div class="cards">${cards || '<div class="fnone">No variables tracked in this mission</div>'}</div>
      </div>`;
    })
    .join('');

  return `<div class="xsec" style="grid-template-columns: 132px ${DRAW_W}px minmax(380px, 1fr) 124px">
    <div class="col fluxcol in">${fluxRows('inflow')}</div>
    <div class="col drawcol">${drawTile(game, ui.tileId, order, ui.selected)}</div>
    <div class="col cardcol">${cardRows}</div>
    <div class="col fluxcol out">${fluxRows('outflow')}</div>
  </div>`;
}

function methodsPanel(game: Game, ui: UiState): string {
  const buttons = game
    .methods()
    .map((m) => {
      const can = game.canSample(m.id, ui.tileId);
      const done = can.reason === 'Done today';
      const reveals = m.reveals.map((id) => game.data.variables.get(id)!.name.toLowerCase()).join(', ');
      const ago = game.sampledDaysAgo(m.id, ui.tileId);
      const note = done ? 'Done today' : ago !== null ? `Last done ${ago} days ago` : '';
      return `<button type="button" class="action ${done ? 'done' : ''}" data-action="sample:${m.id}" ${can.ok ? '' : 'disabled'}>
        <span class="arow"><span>${esc(m.name)}</span><span class="mono">${done ? 'Done' : fmtMoney(m.cost)}</span></span>
        <span class="adesc">Reveals ${esc(reveals)}</span>
        ${note && !done ? `<span class="anote">${note}</span>` : ''}
        ${!can.ok && !done ? `<span class="anote">${esc(can.reason!)}</span>` : ''}
      </button>`;
    })
    .join('');
  return `<div class="panel-block compact">
    <div class="block-head"><span class="label">Sampling methods</span><span class="sub">Each method reveals specific variables. One budget pays for sampling and interventions.</span></div>
    <div class="pb-body"><div class="grid4">${buttons}</div>${infoBox('Point at a method to see what it reveals.')}</div>
  </div>`;
}

/**
 * On a desktop the action buttons show only their name and cost; pointing at one (or tabbing
 * to it) shows its description here. main.ts fills it. Narrow screens keep descriptions inline.
 */
function infoBox(placeholder: string): string {
  return `<div class="action-info" aria-hidden="true" data-placeholder="${esc(placeholder)}"><p class="ai-empty">${esc(placeholder)}</p></div>`;
}

/** Interventions; tile-scoped ones act on every pond tile in `tiles`. */
export function interventionsPanel(game: Game, tiles: string[], selectionLabel?: string): string {
  const pond = tiles.filter((t) => game.isWater(t));
  const buttons = game
    .interventions()
    .map((iv) => {
      const onTile = iv.scope === 'tile';
      const can = game.canInterveneOn(iv.id, tiles);
      const targets = onTile ? game.targetsFor(iv.id, pond).length : 1;
      const where = onTile ? (selectionLabel ?? (pond.length === 1 ? pond[0] : `${pond.length} tiles`)) : '';
      const times = onTile ? pond.reduce((s, t) => s + game.timesDone(iv.id, t), 0) : game.timesDone(iv.id);
      const running = onTile ? pond.some((t) => game.sim.activeInterventions(t).includes(iv.id)) : game.sim.activeInterventions().includes(iv.id);
      const status = running ? 'In progress' : !iv.repeatable && times ? 'In place' : times ? `Done ${times}×${onTile && pond.length === 1 ? ` on ${pond[0]}` : ''}` : '';
      const name = onTile ? (pond.length ? `${iv.name} on ${where}` : `${iv.name} (select pond tiles)`) : iv.name;
      const cost = iv.cost * Math.max(1, targets);
      return `<button type="button" class="action iv ${running ? 'running' : ''}" data-action="intervene:${iv.id}" ${can.ok ? '' : 'disabled'}>
        <span class="arow"><span>${esc(name)}</span><span class="mono">${fmtMoney(cost)}</span></span>
        <span class="adesc">${esc(iv.description)} ${onTile ? `${fmtMoney(iv.cost)} per tile.` : 'Whole pond.'} Takes ${iv.duration_days} days.</span>
        ${status ? `<span class="anote">${status}</span>` : ''}
        ${!can.ok && can.reason === 'Not enough budget' ? '<span class="anote">Not enough budget</span>' : ''}
      </button>`;
    })
    .join('');
  return `<div class="panel-block compact">
    <div class="block-head"><span class="label">Interventions</span><span class="sub">Act once you understand what limits the system. Order matters.</span></div>
    <div class="pb-body"><div class="pb-main"><div class="grid4">${buttons}</div>${fundingButton(game)}</div>${infoBox('Point at an intervention to see what it does.')}</div>
  </div>`;
}

export function objectivePanel(game: Game): string {
  const o = game.mission.objective;
  const v = game.data.variables.get(o.variable)!;
  const k = game.knownMean(o.variable);
  const kt = knownText(v, k);
  const left = Math.max(0, game.deadlineDay - game.day);
  const pct = Math.min(100, (game.day / game.deadlineDay) * 100);
  return `<div class="box">
    <div class="label">Mission objective</div>
    <div class="otext">${esc(o.text)}</div>
    <div class="orow"><span>Pond mean now</span><span class="mono">${esc(kt.est ? withUnit(v, kt.text) : kt.text)}${kt.est ? ' <span class="est">EST</span>' : ''}</span></div>
    ${gauge(v, k, 'full')}
    <div class="orow"><span>Target</span><span class="mono">${fmtUnit(v, o.target)}</span></div>
    <div class="progress" role="progressbar" aria-label="Time elapsed" aria-valuenow="${pct.toFixed(0)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct.toFixed(1)}%"></span></div>
    <div class="osub">${game.outcome ? (game.outcome.success ? 'Objective met at the deadline.' : 'Deadline passed. Objective not met.') : `${left} days left`}</div>
  </div>`;
}

/** Water exchange is the pathway that carries sediment, nutrients and algae between tiles. */
function isPathway(game: Game, id: string): boolean {
  return game.data.variables.get(id)?.lateral?.process === 'water_exchange';
}

function linkItems(game: Game, ui: UiState, v: Variable, dir: 'in' | 'out') {
  const links = game.data.links.filter((l) => (dir === 'in' ? l.to === v.id && l.from.some((f) => f !== v.id) : l.from.includes(v.id) && l.to !== v.id));
  const found = links.filter((l) => game.isDiscovered(l));
  const items: { link: NormalLink; other: string; via: string | null; sign: number }[] = [];
  for (const l of found) {
    if (dir === 'out') {
      items.push({ link: l, other: l.to, via: null, sign: game.linkDirection(ui.tileId, l, v.id) });
      continue;
    }
    // When water exchange carries something in, one row names what it carries and shows the
    // exchange as the pathway, so neither appears twice. Other links get a row per input.
    const inputs = [...new Set(l.from)].filter((f) => f !== v.id);
    const pathway = inputs.find((f) => isPathway(game, f));
    const carried = inputs.filter((f) => f !== pathway);
    if (pathway && carried.length === 1) items.push({ link: l, other: carried[0], via: pathway, sign: game.linkDirection(ui.tileId, l, carried[0]) });
    else for (const src of inputs) items.push({ link: l, other: src, via: null, sign: game.linkDirection(ui.tileId, l, src) });
  }
  return { items, hidden: links.length - found.length, total: links.length };
}

function selectedPanel(game: Game, ui: UiState): string {
  const v = game.data.variables.get(ui.selected)!;
  const layer = game.data.layers.get(v.layer)!;
  const zone = game.data.zones.find((z) => z.id === v.zone)!;
  const k = game.known(ui.tileId, v.id);
  const kt = knownText(v, k);
  const valueText = kt.unknown ? '?' : kt.est ? withUnit(v, kt.text) : kt.text;

  const list = (dir: 'in' | 'out') => {
    const { items, hidden, total } = linkItems(game, ui, v, dir);
    const btns = items
      .map(({ link, other, via, sign }) => {
        const ov = game.data.variables.get(other)!;
        const viaText = via ? ` <span class="lvia">via ${esc(game.data.variables.get(via)!.name.toLowerCase())}</span>` : '';
        const verb = sign > 0 ? 'raises' : sign < 0 ? 'lowers' : 'affects';
        const arrow = sign > 0 ? '↑' : sign < 0 ? '↓' : '·';
        return `<button type="button" class="link" data-action="select:${other}">
          <span class="lname">${esc(ov.name)}${viaText}</span>
          <span class="llabel">${esc(link.label)} · ${link.strength} · <span aria-hidden="true">${arrow}</span> ${dir === 'in' ? verb + ' this' : verb + ' it'}</span>
          <span class="lbar ${dir}" style="width:${STRENGTH_W[link.strength]}%"></span>
        </button>`;
      })
      .join('');
    const hiddenText =
      hidden > 0
        ? `<div class="lhidden">${hidden} ${dir === 'in' ? (hidden === 1 ? 'suspected driver' : 'suspected drivers') : hidden === 1 ? 'effect' : 'effects'} not yet identified. Measure related variables to find ${hidden === 1 ? 'it' : 'them'}.</div>`
        : '';
    const none = total === 0 ? `<div class="lnone">${dir === 'in' ? 'No known drivers on this tile.' : 'No known effects on this tile.'}</div>` : '';
    return btns + hiddenText + none;
  };

  return `<div class="box sel">
    <div class="selhead"><span class="dot big" style="background:${layer.color}"></span><span class="muted">${esc(layer.name)} layer · ${esc(v.kind === 'boundary' ? 'Inflow face' : zone.name)}</span></div>
    <div class="selrow"><div class="selname">${esc(v.name)}</div><div class="selval mono">${esc(valueText)}${kt.est ? ' <span class="est">EST</span>' : ''}</div></div>
    ${gauge(v, k, 'full')}
    <div class="muted small">${esc(sourceText(game, v, k))}</div>
    ${
      k.state === 'estimate'
        ? `<div class="bounds"><div><span class="label">Lower bound</span><span class="mono">${fmtUnit(v, k.lo)}</span></div><div><span class="label">Upper bound</span><span class="mono">${fmtUnit(v, k.hi)}</span></div></div>`
        : ''
    }
    ${v.description ? `<div class="desc">${esc(v.description)}</div>` : ''}
    <div class="links">
      <div><div class="label">Driven by</div>${list('in')}</div>
      <div><div class="label">Affects</div>${list('out')}</div>
    </div>
  </div>`;
}

function limitsPanel(game: Game, ui: UiState): string {
  const rows = game
    .limitingFactors(ui.tileId)
    .map(
      (f) => `<button type="button" class="limit" data-action="select:${f.variable}">
      <span class="status ${STATUS_CLASS[f.status]}">${f.status}</span>
      <span class="ltext"><span class="lname">${esc(f.name)}</span><span class="ldetail">${esc(f.text)}</span></span>
    </button>`,
    )
    .join('');
  const hints = game
    .hints(ui.tileId)
    .map((h) => `<div class="hint">${esc(h)}</div>`)
    .join('');
  return `<div class="box limits">
    <div class="label">${esc(game.mission.limiting_factors.title)}</div>
    ${rows}
    ${hints}
  </div>`;
}

export function logPanel(game: Game, count = 6): string {
  const entries = game.log.slice(-count).reverse();
  if (!entries.length) return '';
  return `<div class="box log">
    <div class="label">Field log</div>
    ${entries
      .map((e) => `<div class="logrow ${e.kind}"><span class="mono when">${calendar(e.day, game.mission.start.day_of_year).label.replace('Year ', 'Y')}</span><span>${esc(e.text)}</span></div>`)
      .join('')}
  </div>`;
}

function briefing(game: Game): string {
  const m = game.mission;
  return `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="brief-title">
    <div class="label">Mission 1 briefing</div>
    <h1 id="brief-title">${esc(m.title)}</h1>
    <p>${esc(m.briefing)}</p>
    <div class="brief-grid">
      <div><span class="label">Objective</span><span>${esc(m.objective.text)}</span></div>
      <div><span class="label">Budget</span><span class="mono">${fmtMoney(m.budget)} for sampling and interventions</span></div>
    </div>
    <p class="muted small">Time is paused. Sample first, then act. Use the time controls in the top bar to let seasons pass.</p>
    <button type="button" class="btn primary" data-action="briefing-close">Begin investigation</button>
  </div></div>`;
}

/** Start and final pond-wide means, side by side, with the objective's target. */
function surveyTable(game: Game): string {
  const o = game.outcome!;
  const objective = game.mission.objective;
  const rows = game.mission.final_survey
    .map((id) => {
      const v = game.data.variables.get(id)!;
      const target = id === objective.variable ? `<span class="muted target"> target ${fmtUnit(v, objective.target)}</span>` : '';
      return `<tr><th scope="row">${esc(v.name)}</th><td class="mono">${fmtUnit(v, game.startSurvey[id])}</td><td aria-hidden="true">→</td><td class="mono strong">${fmtUnit(v, o.survey[id])}${target}</td></tr>`;
    })
    .join('');
  return `<table class="survey"><caption class="label">Final survey, pond-wide means</caption><thead><tr><th></th><th scope="col">Year 1</th><th></th><th scope="col">Deadline</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Fill {variable_id}, {target}, {budget_left} and {date} in mission text from the final survey. */
function fillLetter(game: Game, text: string): string {
  const o = game.outcome!;
  const objective = game.data.variables.get(game.mission.objective.variable)!;
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => {
    if (key in o.survey) return fmtUnit(game.data.variables.get(key)!, o.survey[key]);
    if (key === 'target') return fmtUnit(objective, o.target);
    if (key === 'budget_left') return fmtMoney(game.budget);
    if (key === 'date') return calendar(o.day, game.mission.start.day_of_year).label;
    return whole;
  });
}

function letter(game: Game): string {
  const l = game.mission.success_letter;
  if (!l) return '';
  const f = (t: string) => esc(fillLetter(game, t));
  return `<article class="letter" aria-label="Letter from ${esc(l.from)}">
    <div class="seal" aria-hidden="true">${esc(l.from.split(' ').map((w) => w[0]).join(''))}</div>
    <header><div class="lfrom">${esc(l.from)}</div><div class="laddr">${esc(l.address)}</div><div class="ldate">${esc(calendar(game.outcome!.day, game.mission.start.day_of_year).label)}</div></header>
    <p>${esc(l.salutation)}</p>
    ${l.paragraphs.map((p) => `<p>${f(p)}</p>`).join('')}
    <p>${esc(l.signoff)}</p>
    <p class="lsig">${esc(l.signature)}</p>
    <p class="lrole">${esc(l.role)}</p>
  </article>`;
}

/** Falling leaves for the win screen. Decorative; hidden when the player prefers reduced motion. */
function leaves(): string {
  const colors = ['#7CC27A', '#5FA35A', '#A7D18C', '#E3B341', '#4F8FD6'];
  return Array.from({ length: 28 }, (_, i) => {
    const r = (n: number) => (Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1;
    const left = Math.abs(r(1)) * 100;
    const delay = Math.abs(r(2)) * 4;
    const dur = 5 + Math.abs(r(3)) * 5;
    return `<span class="leaf" style="left:${left.toFixed(1)}%;animation-delay:${delay.toFixed(2)}s;animation-duration:${dur.toFixed(2)}s;background:${colors[i % colors.length]}"></span>`;
  }).join('');
}

function outcomeModal(game: Game): string {
  const o = game.outcome!;
  if (o.success) {
    return `<div class="modal-back celebrate"><div class="leaves" aria-hidden="true">${leaves()}</div>
      <div class="modal win" role="dialog" aria-modal="true" aria-labelledby="out-title">
        <div class="banner">Objective met</div>
        <h1 id="out-title">The meadows are back</h1>
        <p class="muted">Three years on, the clear-water state is holding. Here is what changed.</p>
        ${surveyTable(game)}
        ${letter(game)}
        <div class="modal-actions">
          <button type="button" class="btn primary" data-action="debrief">Open the debrief</button>
          <button type="button" class="btn" data-action="outcome-close">Keep exploring the pond</button>
        </div>
      </div></div>`;
  }
  const v = game.data.variables.get(game.mission.objective.variable)!;
  return `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="out-title">
    <div class="label">Deadline reached</div>
    <h1 id="out-title">The pond is still turbid</h1>
    <p>Final survey: <span class="mono">${fmt(v, o.value)}${v.unit}</span> ${esc(v.name.toLowerCase())} against a target of <span class="mono">${fmt(v, o.target)}${v.unit}</span>.</p>
    ${surveyTable(game)}
    <p class="muted">You can keep running the pond to see what would have worked, but the mission is scored.</p>
    <div class="modal-actions">
      <button type="button" class="btn primary" data-action="debrief">Open the debrief</button>
      <button type="button" class="btn" data-action="outcome-close">Keep exploring</button>
    </div>
  </div></div>`;
}

export function barrierState(game: Game): 'none' | 'building' | 'built' {
  if (game.sim.activeInterventions().includes('carp_barrier')) return 'building';
  return game.timesDone('carp_barrier') > 0 ? 'built' : 'none';
}

/** Weather and inflow: the boundary conditions set outside the pond. */
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
  // The weir is shown at the outlet, not as an inflow.
  const ids = Object.keys(watershed.values).filter((id) => game.data.variables.get(id)!.zone !== 'air' && id !== g.map.level_variable);
  const climate = Object.keys(watershed.values).filter((id) => game.data.variables.get(id)!.zone === 'air');
  const barrier = barrierState(game);
  return `<div class="box">
    <div class="label">Weather and inflow</div>
    <div class="bsub strong">Weather</div>
    ${climate.map(row).join('')}
    <div class="bsub strong">Inflow from the ${esc(g.map.inlets.map((i) => i.name).join(', '))}</div>
    ${ids.map(row).join('')}
    ${barrier !== 'none' ? `<div class="bnote">Carp barrier ${barrier === 'building' ? 'being built' : 'in place'}: blocks most adult carp coming from upstream.</div>` : ''}
  </div>`;
}
