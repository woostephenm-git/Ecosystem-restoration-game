// Investigation view (design doc section 5). Renders game state to HTML strings;
// main.ts owns the UI state and wires the data-action attributes to handlers.
import { calendar, fmt, fmtMoney, fmtRange, fmtUnit } from '../sim/format';
import type { FactorStatus, Game } from '../sim/game';
import type { Known } from '../sim/knowledge';
import type { NormalLink } from '../sim/loader';
import type { Variable } from '../sim/schema';
import { DRAW_W, ZONE_H, drawTile } from './drawing';

export interface UiState {
  screen: 'map' | 'tile';
  /** Selected tile on the map, and the tile open in the investigation view. */
  tileId: string;
  layer: string;
  selected: string;
  /** Map overlay: 'surface' for the observable view, or a variable id. */
  overlay: string;
  speed: 0 | 1 | 4;
  showBriefing: boolean;
  showOutcome: boolean;
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
      ${chips(game, ui)}
      <div class="xsec-scroll">${crossSection(game, ui)}</div>
      ${methodsPanel(game, ui)}
      ${interventionsPanel(game, ui.tileId)}
    </section>
    <aside class="right" aria-label="Analysis">
      ${objectivePanel(game)}
      ${selectedPanel(game, ui)}
      ${limitsPanel(game, ui)}
      ${logPanel(game)}
    </aside>
  </main>
  ${modals(game, ui)}`;
}

export function modals(game: Game, ui: UiState): string {
  return `${ui.showBriefing ? briefing(game) : ''}${ui.showOutcome && game.outcome ? outcomeModal(game) : ''}`;
}

/** A small clickable copy of the grid, for jumping between tiles in the investigation view. */
function tileSwitcher(game: Game, ui: UiState): string {
  const g = game.sim.grid;
  const cells = g.tiles
    .slice()
    .sort((a, b) => a.row - b.row || a.col - b.col)
    .map(
      (t) =>
        `<button type="button" class="mini ${t.id === ui.tileId ? 'on' : ''}" data-action="open-tile:${t.id}" aria-label="Tile ${t.id}, ${esc(t.description)}" aria-pressed="${t.id === ui.tileId}" style="grid-row:${t.row + 1};grid-column:${t.col + 1}">${t.id}</button>`,
    )
    .join('');
  return `<div class="switcher" role="group" aria-label="Switch tile" style="grid-template-columns:repeat(${g.cols}, 30px)">${cells}</div>`;
}

export function header(game: Game, ui: UiState): string {
  const cal = calendar(game.day, game.mission.start.day_of_year);
  const speedBtn = (speed: 0 | 1 | 4, label: string, ic: string) =>
    `<button type="button" class="btn time ${ui.speed === speed ? 'on' : ''}" data-action="speed:${speed}" aria-pressed="${ui.speed === speed}">${ic}<span>${label}</span></button>`;
  const onMap = ui.screen === 'map';
  const tile = game.sim.grid.tiles[game.sim.grid.indexOf(ui.tileId)];
  const title = onMap ? `${esc(game.mission.title)} · Map` : `Tile ${esc(ui.tileId)} · ${esc(tile.description)}`;
  return `<header class="top">
    ${onMap ? '' : `<button type="button" class="btn" data-action="back-to-map">${icon.back}<span>Back to map</span></button>`}
    <div class="title">
      <div class="t1">${title}</div>
      <div class="t2">Mission 1: ${esc(game.mission.title)} · ${cal.label}</div>
    </div>
    ${onMap ? '' : tileSwitcher(game, ui)}
    <div class="grow"></div>
    <div class="time-controls" role="group" aria-label="Time controls">
      ${speedBtn(0, 'Pause', icon.pause)}
      ${speedBtn(1, '1 week/s', icon.play)}
      ${speedBtn(4, '1 month/s', icon.fast)}
      <button type="button" class="btn time" data-action="step">${icon.step}<span>+1 week</span></button>
    </div>
    <div class="sep"></div>
    <div class="stat"><div class="k">Budget</div><div class="v mono">${fmtMoney(game.budget)}</div></div>
    <div class="sep"></div>
    <div class="stat"><div class="k">Samples taken</div><div class="v mono">${game.samplesTaken}</div></div>
  </header>`;
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
            return `<button type="button" class="flux ${ui.selected === v.id ? 'sel' : ''}" data-action="select:${v.id}"><span class="fn">${esc(name)}</span><span class="fv mono">${esc(val)}</span></button>`;
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
  return `<div class="panel-block">
    <div class="block-head"><span class="label">Sampling methods</span><span class="sub">Each method reveals specific variables. One budget pays for sampling and interventions.</span></div>
    <div class="grid4">${buttons}</div>
  </div>`;
}

/** Interventions; tile-scoped ones act on `tileId`. */
export function interventionsPanel(game: Game, tileId: string): string {
  const buttons = game
    .interventions()
    .map((iv) => {
      const onTile = iv.scope === 'tile';
      const can = game.canIntervene(iv.id, tileId);
      const times = game.timesDone(iv.id, onTile ? tileId : undefined);
      const running = game.sim.activeInterventions(onTile ? tileId : undefined).includes(iv.id);
      const status = running ? 'In progress' : !iv.repeatable && times ? 'In place' : times ? `Done ${times}×${onTile ? ` on ${tileId}` : ''}` : '';
      const name = onTile ? `${iv.name} on ${tileId}` : iv.name;
      return `<button type="button" class="action iv ${running ? 'running' : ''}" data-action="intervene:${iv.id}" ${can.ok ? '' : 'disabled'}>
        <span class="arow"><span>${esc(name)}</span><span class="mono">${fmtMoney(iv.cost)}</span></span>
        <span class="adesc">${esc(iv.description)} ${onTile ? 'One tile.' : 'Whole pond.'} Takes ${iv.duration_days} days.</span>
        ${status ? `<span class="anote">${status}</span>` : ''}
        ${!can.ok && can.reason === 'Not enough budget' ? '<span class="anote">Not enough budget</span>' : ''}
      </button>`;
    })
    .join('');
  return `<div class="panel-block">
    <div class="block-head"><span class="label">Interventions</span><span class="sub">Act once you understand what limits the system. Order matters.</span></div>
    <div class="grid4">${buttons}</div>
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
    <div class="orow"><span>Pond mean now</span><span class="mono">${esc(kt.est ? `${kt.text} ${v.unit}` : kt.text)}${kt.est ? ' <span class="est">EST</span>' : ''}</span></div>
    <div class="orow"><span>Target</span><span class="mono">${fmtUnit(v, o.target)}</span></div>
    <div class="progress" role="progressbar" aria-label="Time elapsed" aria-valuenow="${pct.toFixed(0)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct.toFixed(1)}%"></span></div>
    <div class="osub">${game.outcome ? (game.outcome.success ? 'Objective met at the deadline.' : 'Deadline passed. Objective not met.') : `${left} days left`}</div>
  </div>`;
}

function linkItems(game: Game, ui: UiState, v: Variable, dir: 'in' | 'out') {
  const links = game.data.links.filter((l) => (dir === 'in' ? l.to === v.id && l.from.some((f) => f !== v.id) : l.from.includes(v.id) && l.to !== v.id));
  const found = links.filter((l) => game.isDiscovered(l));
  const items: { link: NormalLink; other: string; sign: number }[] = [];
  for (const l of found) {
    if (dir === 'in') for (const src of new Set(l.from)) src !== v.id && items.push({ link: l, other: src, sign: game.linkDirection(ui.tileId, l, src) });
    else items.push({ link: l, other: l.to, sign: game.linkDirection(ui.tileId, l, v.id) });
  }
  return { items, hidden: links.length - found.length, total: links.length };
}

function selectedPanel(game: Game, ui: UiState): string {
  const v = game.data.variables.get(ui.selected)!;
  const layer = game.data.layers.get(v.layer)!;
  const zone = game.data.zones.find((z) => z.id === v.zone)!;
  const k = game.known(ui.tileId, v.id);
  const kt = knownText(v, k);
  const valueText = kt.unknown ? '?' : kt.est ? `${kt.text} ${v.unit}` : kt.text;

  const list = (dir: 'in' | 'out') => {
    const { items, hidden, total } = linkItems(game, ui, v, dir);
    const btns = items
      .map(({ link, other, sign }) => {
        const ov = game.data.variables.get(other)!;
        const verb = sign > 0 ? 'raises' : sign < 0 ? 'lowers' : 'affects';
        const arrow = sign > 0 ? '↑' : sign < 0 ? '↓' : '·';
        return `<button type="button" class="link" data-action="select:${other}">
          <span class="lname">${esc(ov.name)}</span>
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

export function logPanel(game: Game): string {
  const entries = game.log.slice(-6).reverse();
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

function outcomeModal(game: Game): string {
  const o = game.outcome!;
  const v = game.data.variables.get(game.mission.objective.variable)!;
  return `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="out-title">
    <div class="label">Deadline reached</div>
    <h1 id="out-title">${o.success ? 'The meadows are back' : 'The pond is still turbid'}</h1>
    <p>Final survey: <span class="mono">${fmt(v, o.value)}${v.unit}</span> ${esc(v.name.toLowerCase())} against a target of <span class="mono">${fmt(v, o.target)}${v.unit}</span>.</p>
    <p class="muted">${o.success ? 'The clear-water state is holding. Keep watching to see whether it lasts.' : 'You can keep running the pond to see what would have worked, but the mission is scored.'}</p>
    <button type="button" class="btn primary" data-action="outcome-close">Keep exploring</button>
  </div></div>`;
}
