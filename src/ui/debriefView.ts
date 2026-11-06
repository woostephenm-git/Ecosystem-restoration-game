// Debrief: what actually happened over the mission, on one line chart. Unlike the rest of
// the game it shows true values, the way the final survey does, because the mission is over.
import { calendar, fmtUnit } from '../sim/format';
import type { DebriefEvent, Game } from '../sim/game';
import type { Variable } from '../sim/schema';
import { scalePos } from './gauge';
import { esc, header, modals, type UiState } from './view';

/**
 * Categorical slots 1 to 4 of the reference palette (validated together on a light surface).
 * A variable keeps its slot while selected, so removing one never repaints the others.
 */
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'];
export const MAX_SERIES = SERIES_COLORS.length;

const W = 1000;
const H = 430;
const M = { l: 58, r: 190, t: 58, b: 44 };
const PW = W - M.l - M.r;
const PH = H - M.t - M.b;

interface Series {
  v: Variable;
  color: string;
  values: number[];
}

/** What the hover handler needs from the last render. */
let chart: { days: number[]; series: Series[]; events: DebriefEvent[]; d0: number; d1: number } | null = null;

const xOf = (day: number) => M.l + ((day - chart!.d0) / Math.max(1, chart!.d1 - chart!.d0)) * PW;
const yOf = (v: Variable, x: number) => M.t + (1 - scalePos(v, x)) * PH;
const shortDate = (game: Game, day: number) => calendar(day, game.mission.start.day_of_year).label.replace('Year ', 'Y');
const tickDate = (game: Game, day: number) => {
  const c = calendar(day, game.mission.start.day_of_year);
  return `${c.month.slice(0, 3)} Y${c.year}`;
};

export function debriefVariables(game: Game): Variable[] {
  return game.visibleVariables();
}

export function renderDebrief(game: Game, ui: UiState): string {
  const db = ui.debrief;
  const vars = new Map(debriefVariables(game).map((v) => [v.id, v]));
  const series: Series[] = db.slots
    .map((id, k) => (id && vars.has(id) ? { v: vars.get(id)!, color: SERIES_COLORS[k], values: game.historySeries(id, db.tile) } : null))
    .filter((s): s is Series => !!s);
  const days = game.history.days;
  const events = game.debriefEvents();
  chart = { days, series, events, d0: days[0] ?? 0, d1: Math.max(days[days.length - 1] ?? 1, game.deadlineDay) };

  return `${header(game, ui)}
  <main class="debrief">
    ${summary(game)}
    ${filters(game, ui, vars)}
    <figure class="db-figure">
      ${series.length ? '' : '<p class="db-empty">Pick at least one variable to plot.</p>'}
      <div class="db-plot">${svg(game, series, events)}<div class="db-tip" role="status" aria-live="polite" hidden></div></div>
      ${legend(series)}
      <figcaption class="muted small">Each line sits on its own typical range for this kind of pond (shown in the legend), so lines in different units share one axis: low, mid or high. Hover for actual values. Numbered markers are your interventions; shading shows how long each took.${db.tile === 'median' ? ' The median tile can differ from the pond-wide mean that the objective is scored on.' : ''}</figcaption>
    </figure>
    ${eventList(game, events)}
    ${table(game, ui, series)}
  </main>
  ${modals(game, ui)}`;
}

function summary(game: Game): string {
  const o = game.outcome;
  const v = game.data.variables.get(game.mission.objective.variable)!;
  const status = o
    ? `<span class="banner ${o.success ? '' : 'fail'}">${o.success ? 'Objective met' : 'Objective not met'}</span> Final survey: <span class="mono">${fmtUnit(v, o.value)}</span> ${esc(v.name.toLowerCase())} against a target of <span class="mono">${fmtUnit(v, o.target)}</span>.`
    : `The mission is still running. Showing the first ${game.day} days.`;
  return `<section class="db-head">
    <h1>Debrief</h1>
    <p>${status}</p>
    <p class="muted small">These are the true values from the simulation, not your measurements.</p>
    ${o && !o.success ? '<div class="modal-actions db-retry"><button type="button" class="btn primary" data-action="retry">Retry the mission</button></div>' : ''}
  </section>`;
}

function filters(game: Game, ui: UiState, vars: Map<string, Variable>): string {
  const db = ui.debrief;
  const tiles = game.waterTileIds().map((id) => game.sim.grid.tiles[game.sim.grid.indexOf(id)]);
  const options = [`<option value="median" ${db.tile === 'median' ? 'selected' : ''}>All pond tiles (median)</option>`]
    .concat(tiles.map((t) => `<option value="${t.id}" ${db.tile === t.id ? 'selected' : ''}>${t.id} · ${esc(t.description)}</option>`))
    .join('');
  const chosen = db.slots.filter(Boolean).length;
  const boxes = [...vars.values()]
    .map((v) => {
      const slot = db.slots.indexOf(v.id);
      const on = slot >= 0;
      const full = !on && chosen >= MAX_SERIES;
      return `<label class="db-var ${on ? 'on' : ''} ${full ? 'off' : ''}">
        <input type="checkbox" data-change="db-var:${v.id}" ${on ? 'checked' : ''} ${full ? 'disabled' : ''}>
        ${on ? `<span class="db-swatch" style="background:${SERIES_COLORS[slot]}"></span>` : ''}${esc(v.name)}
      </label>`;
    })
    .join('');
  return `<section class="db-filters" aria-label="Chart filters">
    <label class="db-tile"><span class="label">Tile</span><select data-change="db-tile">${options}</select></label>
    <fieldset class="db-vars"><legend class="label">Variables <span class="muted">(${chosen} of ${MAX_SERIES})</span></legend>${boxes}</fieldset>
  </section>`;
}

function svg(game: Game, series: Series[], events: DebriefEvent[]): string {
  const c = chart!;
  const parts: string[] = [];
  // Recessive grid: band edges at thirds, labelled low / mid / high.
  for (const f of [0, 1 / 3, 2 / 3, 1]) {
    const y = M.t + (1 - f) * PH;
    parts.push(`<line class="grid" x1="${M.l}" x2="${M.l + PW}" y1="${y}" y2="${y}"/>`);
  }
  ['Low', 'Mid', 'High'].forEach((name, k) => {
    const y = M.t + (1 - (k + 0.5) / 3) * PH;
    parts.push(`<text class="axis" x="${M.l - 10}" y="${y + 4}" text-anchor="end">${name}</text>`);
  });
  // Time axis: a tick at the start of each quarter (January, April, July, October).
  const quarters = new Set(['January', 'April', 'July', 'October']);
  for (let d = c.d0; d <= c.d1; d++) {
    const m = calendar(d, game.mission.start.day_of_year).month;
    if (!quarters.has(m) || (d > c.d0 && calendar(d - 1, game.mission.start.day_of_year).month === m)) continue;
    const x = xOf(d);
    parts.push(`<line class="tick" x1="${x}" x2="${x}" y1="${M.t + PH}" y2="${M.t + PH + 5}"/><text class="axis" x="${x}" y="${M.t + PH + 20}" text-anchor="middle">${tickDate(game, d)}</text>`);
  }
  // Deadline.
  const xd = xOf(game.deadlineDay);
  parts.push(`<line class="deadline" x1="${xd}" x2="${xd}" y1="${M.t}" y2="${M.t + PH}"/><text class="axis" x="${xd - 4}" y="${M.t + 12}" text-anchor="end">Deadline</text>`);

  // Interventions: shaded for their duration, numbered at the top. Markers that would
  // overlap stack upward rather than collide.
  const lastX: number[] = [];
  events.forEach((e, k) => {
    const x0 = xOf(e.day);
    const x1 = xOf(Math.min(c.d1, e.day + e.duration));
    parts.push(`<rect class="span" x="${x0}" y="${M.t}" width="${Math.max(1, x1 - x0)}" height="${PH}"/>`);
    parts.push(`<line class="event" x1="${x0}" x2="${x0}" y1="${M.t}" y2="${M.t + PH}"/>`);
    let level = 0;
    while (lastX[level] !== undefined && x0 - lastX[level] < 22) level++;
    lastX[level] = x0;
    const cy = M.t - 14 - level * 20;
    parts.push(`<g class="marker"><title>${esc(`${k + 1}. ${e.name}, ${shortDate(game, e.day)}`)}</title><circle cx="${x0}" cy="${cy}" r="9"/><text x="${x0}" y="${cy + 4}" text-anchor="middle">${k + 1}</text></g>`);
  });

  // Lines: 2px, broken where a tile did not exist yet (flooded later).
  for (const s of series) {
    let d = '';
    let pen = false;
    s.values.forEach((val, i) => {
      if (!Number.isFinite(val)) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${xOf(c.days[i]).toFixed(1)} ${yOf(s.v, val).toFixed(1)}`;
      pen = true;
    });
    parts.push(`<path class="line" d="${d}" stroke="${s.color}"/>`);
  }

  // Direct labels at the line ends, nudged apart so they never collide.
  const ends = series
    .map((s) => {
      let i = s.values.length - 1;
      while (i >= 0 && !Number.isFinite(s.values[i])) i--;
      return i < 0 ? null : { s, val: s.values[i], y: yOf(s.v, s.values[i]) };
    })
    .filter((e): e is { s: Series; val: number; y: number } => !!e)
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 30);
  const overflow = ends.length ? ends[ends.length - 1].y - (M.t + PH) : 0;
  if (overflow > 0) ends.forEach((e) => (e.y -= overflow));
  const xEnd = xOf(c.days[c.days.length - 1] ?? c.d0);
  for (const e of ends) {
    parts.push(`<line x1="${xEnd + 6}" x2="${xEnd + 18}" y1="${e.y}" y2="${e.y}" stroke="${e.s.color}" stroke-width="2"/>`);
    parts.push(`<text class="end" x="${xEnd + 22}" y="${e.y - 2}">${esc(e.s.v.name)}</text><text class="endval" x="${xEnd + 22}" y="${e.y + 12}">${esc(fmtUnit(e.s.v, e.val))}</text>`);
  }

  // Hover layer: crosshair and dots, placed by the handler.
  parts.push(`<line class="cross" x1="0" x2="0" y1="${M.t}" y2="${M.t + PH}" visibility="hidden"/>`);
  series.forEach((s, k) => parts.push(`<circle class="dot" data-k="${k}" r="5" fill="${s.color}" visibility="hidden"/>`));
  parts.push(`<rect class="hit" x="${M.l}" y="${M.t - 40}" width="${PW}" height="${PH + 40}"/>`);

  const desc = series.length
    ? `Line chart of ${series.map((s) => s.v.name).join(', ')} over the mission, with ${events.length} interventions marked.`
    : 'Empty chart: no variables selected.';
  return `<svg class="db-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(desc)}">${parts.join('')}</svg>`;
}

function legend(series: Series[]): string {
  if (series.length < 2) return '';
  return `<ul class="db-legend">${series
    .map((s) => `<li><span class="db-swatch" style="background:${s.color}"></span>${esc(s.v.name)} <span class="muted">typical range ${esc(fmtUnit(s.v, s.v.scale.min))} to ${esc(fmtUnit(s.v, s.v.scale.max))}${s.v.scale.log ? ', log scale' : ''}</span></li>`)
    .join('')}</ul>`;
}

function eventList(game: Game, events: DebriefEvent[]): string {
  if (!events.length) return `<section class="db-events"><h2 class="label">Interventions</h2><p class="muted small">No interventions were made.</p></section>`;
  return `<section class="db-events"><h2 class="label">Interventions</h2><ol>${events
    .map(
      (e, k) =>
        `<li><span class="db-num">${k + 1}</span><span class="mono">${esc(shortDate(game, e.day))}</span><span>${esc(e.name)}${e.tiles.length ? ` on ${esc(e.tiles.join(', '))}` : ''}</span><span class="muted">${e.duration} days</span></li>`,
    )
    .join('')}</ol></section>`;
}

function table(game: Game, ui: UiState, series: Series[]): string {
  if (!series.length) return '';
  const c = chart!;
  const rows: string[] = [];
  for (let i = 0; i < c.days.length; i += 30) rows.push(row(i));
  if ((c.days.length - 1) % 30) rows.push(row(c.days.length - 1));
  function row(i: number) {
    return `<tr><th scope="row" class="mono">${esc(shortDate(game, c.days[i]))}</th>${series
      .map((s) => `<td class="mono">${Number.isFinite(s.values[i]) ? esc(fmtUnit(s.v, s.values[i])) : '–'}</td>`)
      .join('')}</tr>`;
  }
  return `<details class="db-table" ${ui.debrief.table ? 'open' : ''} data-toggle="db-table">
    <summary>Show the data as a table (monthly)</summary>
    <div class="db-table-scroll"><table><thead><tr><th scope="col">Date</th>${series.map((s) => `<th scope="col">${esc(s.v.name)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>
  </details>`;
}

/** Crosshair and tooltip. Wired after each render; reads the data kept from that render. */
export function wireDebrief(root: HTMLElement, game: Game) {
  const svgEl = root.querySelector<SVGSVGElement>('svg.db-chart');
  const tip = root.querySelector<HTMLDivElement>('.db-tip');
  if (!svgEl || !tip || !chart) return;
  const c = chart;
  const cross = svgEl.querySelector<SVGLineElement>('.cross')!;
  const dots = [...svgEl.querySelectorAll<SVGCircleElement>('.dot')];
  const hide = () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
  };
  svgEl.querySelector('.hit')!.addEventListener('pointerleave', hide);
  svgEl.querySelector('.hit')!.addEventListener('pointermove', (ev) => {
    const e = ev as PointerEvent;
    if (!c.days.length || !c.series.length) return;
    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svgEl.getScreenCTM()!.inverse());
    const day = c.d0 + ((p.x - M.l) / PW) * (c.d1 - c.d0);
    let i = Math.round(day - c.days[0]);
    i = Math.max(0, Math.min(c.days.length - 1, i));
    const x = xOf(c.days[i]);
    cross.setAttribute('x1', String(x));
    cross.setAttribute('x2', String(x));
    cross.setAttribute('visibility', 'visible');
    c.series.forEach((s, k) => {
      const v = s.values[i];
      const dot = dots[k];
      if (!Number.isFinite(v)) return dot.setAttribute('visibility', 'hidden');
      dot.setAttribute('cx', String(x));
      dot.setAttribute('cy', String(yOf(s.v, v)));
      dot.setAttribute('visibility', 'visible');
    });
    const d = c.days[i];
    const active = c.events.filter((ev) => d >= ev.day && d < ev.day + ev.duration).map((ev) => `${c.events.indexOf(ev) + 1}. ${ev.name} (day ${d - ev.day + 1} of ${ev.duration})`);
    tip.innerHTML = `<div class="tip-date mono">${esc(shortDate(game, d))}</div>${c.series
      .map((s) => `<div class="tip-row"><span class="db-swatch" style="background:${s.color}"></span><span>${esc(s.v.name)}</span><span class="mono">${Number.isFinite(s.values[i]) ? esc(fmtUnit(s.v, s.values[i])) : 'not pond yet'}</span></div>`)
      .join('')}${active.length ? `<div class="tip-active">${active.map(esc).join('<br>')}</div>` : ''}`;
    tip.hidden = false;
    // Place the tooltip beside the crosshair, flipping sides near the right edge.
    const box = svgEl.getBoundingClientRect();
    const px = ((x / W) * box.width) | 0;
    const flip = px > box.width * 0.6;
    tip.style.left = flip ? '' : `${px + 14}px`;
    tip.style.right = flip ? `${box.width - px + 14}px` : '';
    tip.style.top = `${((M.t / H) * box.height) | 0}px`;
  });
}
