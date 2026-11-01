// Funding application: the player draws what limits plant establishment, two steps deep,
// using only variables they have sampled. The game judges it; the decision arrives later.
import { calendar, fmtMoney } from '../sim/format';
import type { Game } from '../sim/game';
import { esc, type UiState } from './view';

const W = 720;
const NODE_W = 176;
const NODE_H = 36;

interface Node {
  id: string;
  name: string;
  x: number;
  y: number;
  target: boolean;
}

function layout(game: Game): Node[] {
  const f = game.mission.funding!;
  const [target, ...rest] = game.fundingNodes();
  // Sampled variables in two staggered columns on the left, the target on its own on the right.
  // The stagger leaves gaps for arrows to pass between nodes.
  const rows = Math.max(1, Math.ceil(rest.length / 2));
  const h = boardHeight(rest.length);
  const nodes: Node[] = rest.map((id, k) => ({
    id,
    name: game.data.variables.get(id)!.name,
    x: k < rows ? 104 : 392,
    y: PAD + ROW / 2 + (k % rows) * ROW + (k < rows ? 0 : ROW / 2),
    target: false,
  }));
  nodes.push({ id: target, name: f.target_name, x: 620, y: h / 2, target: true });
  return nodes;
}

const ROW = 76;
const PAD = 24;
const boardHeight = (n: number) => Math.max(200, 2 * PAD + (Math.ceil(n / 2) + 0.5) * ROW);

/** Where the line from `a` towards `b` leaves the edge of a's pill. */
function edgePoint(a: Node, b: Node): [number, number] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.min(NODE_W / 2 / Math.max(1e-6, Math.abs(dx)), NODE_H / 2 / Math.max(1e-6, Math.abs(dy)));
  return [a.x + dx * t, a.y + dy * t];
}

/**
 * A curved path from a to b that does not run behind any other node: try a straight line, then
 * bends of growing size on either side. A reverse pair starts bent so the two never overlap.
 */
function route(a: Node, b: Node, nodes: Node[], paired: boolean, H: number): number[] {
  const [x1, y1] = edgePoint(a, b);
  const [x2, y2] = edgePoint(b, a);
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const nx = -(y2 - y1) / len;
  const ny = (x2 - x1) / len;
  const others = nodes.filter((n) => n !== a && n !== b);
  const clear = (mx: number, my: number) => {
    for (let i = 1; i < 40; i++) {
      const t = i / 40;
      const x = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * mx + t * t * x2;
      const y = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * my + t * t * y2;
      if (x < 4 || x > W - 4 || y < 4 || y > H - 4) return false;
      if (others.some((n) => Math.abs(x - n.x) < NODE_W / 2 + 4 && Math.abs(y - n.y) < NODE_H / 2 + 4)) return false;
    }
    return true;
  };
  const steps = Array.from({ length: 30 }, (_, i) => 10 * (i + 1) + (paired ? 20 : 0));
  const bends = paired ? steps : [0, ...steps.flatMap((k) => [k, -k])];
  for (const k of bends) {
    const mx = (x1 + x2) / 2 + nx * k;
    const my = (y1 + y2) / 2 + ny * k;
    if (clear(mx, my)) return [x1, y1, mx, my, x2, y2];
  }
  const k = paired ? 30 : 0;
  return [x1, y1, (x1 + x2) / 2 + nx * k, (y1 + y2) / 2 + ny * k, x2, y2];
}

export function fundingModal(game: Game, ui: UiState): string {
  const f = game.mission.funding!;
  const st = ui.funding;
  const nodes = layout(game);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const arrows = st.arrows.filter(([a, b]) => byId.has(a) && byId.has(b));
  const H = boardHeight(nodes.length - 1);
  const name = (id: string) => byId.get(id)!.name;

  const lines = arrows
    .map(([a, b], i) => {
      const na = byId.get(a)!;
      const nb = byId.get(b)!;
      const [x1, y1, mx, my, x2, y2] = route(na, nb, nodes, st.arrows.some(([c, d]) => c === b && d === a), H);
      const d = `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
      return `<g class="fa" data-action="funding-remove:${i}"><title>${esc(`${name(a)} → ${name(b)}. Click to remove.`)}</title><path class="fa-hit" d="${d}"/><path class="fa-line" d="${d}" marker-end="url(#fa-head)"/></g>`;
    })
    .join('');

  const boxes = nodes
    .map((n) => {
      const picked = st.pick === n.id;
      const label = picked ? `${n.name}: selected. Choose what it drives.` : st.pick ? `Draw an arrow from ${name(st.pick)} to ${n.name}` : `Start an arrow from ${n.name}`;
      return `<g class="fn-node ${n.target ? 'target' : ''} ${picked ? 'picked' : ''}" data-action="funding-node:${n.id}" role="button" tabindex="0" aria-label="${esc(label)}" aria-pressed="${picked}">
        <rect x="${n.x - NODE_W / 2}" y="${n.y - NODE_H / 2}" width="${NODE_W}" height="${NODE_H}" rx="${NODE_H / 2}"/>
        <text x="${n.x}" y="${n.y + 4}" text-anchor="middle">${esc(n.name)}</text>
      </g>`;
    })
    .join('');

  const last = [...game.applications].reverse().find((a) => a.resolved);
  const lastText = last
    ? `<p class="fund-last ${last.success ? 'ok' : 'no'}"><strong>Last application ${last.success ? 'approved' : 'declined'}.</strong> ${esc(last.success ? `${fmtMoney(f.grant)} was added to your budget.` : last.problems.join(' '))}</p>`
    : '';
  const few = nodes.length < 4 ? `<p class="fund-note">You have sampled very little so far. Only sampled variables can go in an application.</p>` : '';
  const hint = st.pick ? `Arrow from <strong>${esc(name(st.pick))}</strong>: click what it drives. Click it again to cancel.` : 'Click a variable, then click what it drives, to draw an arrow. Click an arrow to remove it.';

  return `<div class="modal-back"><div class="modal funding" role="dialog" aria-modal="true" aria-labelledby="fund-title">
    <div class="label">Parish council environment fund</div>
    <h1 id="fund-title">Apply for more funding</h1>
    <p>The council will add <strong>${fmtMoney(f.grant)}</strong> to your budget if you can show what holds ${esc(f.target_name.toLowerCase())} back in this pond. Draw arrows from cause to effect, two steps deep: something that limits ${esc(f.target_name.toLowerCase())}, and what drives that.</p>
    <p class="muted small">Applying is free. The decision takes ${f.days} days and the pond carries on meanwhile. If the reviewers find any arrow the evidence does not support, the application is turned down. Only variables you have sampled can be used.</p>
    ${lastText}${few}
    <div class="fund-board">
      <svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Variables you have sampled, and the arrows you have drawn">
        <defs><marker id="fa-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="fa-headpath"/></marker></defs>
        ${lines}${boxes}
      </svg>
    </div>
    <p class="fund-hint small" aria-live="polite">${hint}</p>
    ${
      arrows.length
        ? `<ul class="fund-list">${arrows.map(([a, b], i) => `<li><span>${esc(name(a))} → ${esc(name(b))}</span><button type="button" class="btn small" data-action="funding-remove:${i}" aria-label="Remove the arrow from ${esc(name(a))} to ${esc(name(b))}">Remove</button></li>`).join('')}</ul>`
        : ''
    }
    <div class="modal-actions">
      <button type="button" class="btn primary" data-action="funding-submit" ${arrows.length ? '' : 'disabled'}>Submit application</button>
      <button type="button" class="btn" data-action="funding-clear" ${arrows.length ? '' : 'disabled'}>Clear arrows</button>
      <button type="button" class="btn" data-action="funding-close">Cancel</button>
    </div>
  </div></div>`;
}

/** The council's reply, shown when a decision arrives. Time stays paused until it is closed. */
export function decisionModal(game: Game, index: number): string {
  const f = game.mission.funding!;
  const app = game.applications[index];
  const name = (id: string) => (id === f.target ? f.target_name : game.data.variables.get(id)!.name);
  const chain = app.chain ? [...app.chain, f.target].map(name).join(' → ') : '';
  const body = app.success
    ? `<div class="banner">Approved</div>
       <h1 id="dec-title">Funding approved</h1>
       <p>The reviewers accepted your case: <strong>${esc(chain)}</strong>. <span class="mono">${fmtMoney(f.grant)}</span> has been added to your budget.</p>`
    : `<div class="banner fail">Declined</div>
       <h1 id="dec-title">Funding declined</h1>
       <p>The council will not fund this application. No money has been added.</p>
       <ul class="dec-problems">${app.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
       <p class="muted small">You can apply again with a different case.</p>`;
  return `<div class="modal-back"><div class="modal decision" role="dialog" aria-modal="true" aria-labelledby="dec-title">
    <div class="label">Parish council environment fund · reply to your application of ${esc(calendar(app.day, game.mission.start.day_of_year).label)}</div>
    ${body}
    <div class="modal-actions"><button type="button" class="btn primary" data-action="decision-close">Back to the pond</button></div>
  </div></div>`;
}

/** The button under the interventions list. */
export function fundingButton(game: Game): string {
  const f = game.mission.funding;
  if (!f) return '';
  const can = game.canApplyForFunding();
  return `<div class="fund-row">
    <button type="button" class="btn" data-action="funding-open" ${can.ok ? '' : 'disabled'}>Apply for more funding</button>
    <span class="sub">${can.ok ? `Free. Takes ${f.days} days; ${fmtMoney(f.grant)} if approved.` : esc(can.reason!)}</span>
  </div>`;
}
