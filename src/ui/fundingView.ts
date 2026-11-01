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
  // Sampled variables scattered loosely on the left, the target on its own on the right. A
  // fixed shuffle and uneven offsets keep them out of tidy columns, so nothing suggests which
  // column holds the near factor and which the far one. Positions never change between visits.
  const order = [...rest].sort((a, b) => hash(a) - hash(b));
  const h = boardHeight(rest.length);
  const nodes: Node[] = order.map((id, k) => {
    const row = Math.floor(k / 2);
    const right = k % 2 === 1;
    const wobble = (hash(id) % 1000) / 1000;
    return {
      id,
      name: game.data.variables.get(id)!.name,
      x: (right ? 330 : 100) + (row % 2 ? 70 : 0) + (wobble - 0.5) * 50,
      y: PAD + ROW / 2 + row * ROW + (right ? ROW * 0.3 : 0) + (wobble - 0.5) * 10,
      target: false,
    };
  });
  nodes.push({ id: target, name: f.target_name, x: 620, y: h / 2, target: true });
  return nodes;
}

const ROW = 76;
const PAD = 24;
const boardHeight = (n: number) => Math.max(200, 2 * PAD + (Math.ceil(n / 2) + 0.5) * ROW);

/** A stable number from a string, for a fixed shuffle. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

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

/** Arrow styles: the two the player draws, and verdicts from past applications. */
const ARROW = {
  factor: '#c2453a',
  cause: '#8a5a2b',
  yes: '#2f8a3e',
  no: '#a9b2af',
} as const;

export function fundingModal(game: Game, ui: UiState): string {
  const f = game.mission.funding!;
  const st = ui.funding;
  const nodes = layout(game);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const H = boardHeight(nodes.length - 1);
  const name = (id: string) => byId.get(id)!.name;
  const factor = st.factor && byId.has(st.factor) ? st.factor : null;
  const cause = factor && st.cause && byId.has(st.cause) ? st.cause : null;

  const path = (a: string, b: string, paired: boolean) => {
    const [x1, y1, mx, my, x2, y2] = route(byId.get(a)!, byId.get(b)!, nodes, paired, H);
    return `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  };

  // Past verdicts sit underneath: bold green where the reviewers found support, grey where not.
  const past = game
    .pastArrows()
    .filter((p) => byId.has(p.from) && byId.has(p.to))
    .map((p) => {
      const tip = `${name(p.from)} → ${name(p.to)}: ${p.supported ? 'supported' : 'not supported'} in an earlier application.`;
      return `<g class="fa-past ${p.supported ? 'yes' : 'no'}"><title>${esc(tip)}</title><path d="${path(p.from, p.to, false)}" marker-end="url(#fa-${p.supported ? 'yes' : 'no'})"/></g>`;
    })
    .join('');

  const drawn: { key: 'factor' | 'cause'; from: string; to: string }[] = [];
  if (factor) drawn.push({ key: 'factor', from: factor, to: f.target });
  if (factor && cause) drawn.push({ key: 'cause', from: cause, to: factor });
  const lines = drawn
    .map(({ key, from, to }) => {
      const paired = drawn.some((d) => d.from === to && d.to === from);
      const d = path(from, to, paired);
      return `<g class="fa ${key}" data-action="funding-remove:${key}"><title>${esc(`${name(from)} → ${name(to)}. Click to remove.`)}</title><path class="fa-hit" d="${d}"/><path class="fa-line" d="${d}" marker-end="url(#fa-${key})"/></g>`;
    })
    .join('');

  const boxes = nodes
    .map((n) => {
      if (n.target) {
        return `<g class="fn-node target"><rect x="${n.x - NODE_W / 2}" y="${n.y - NODE_H / 2}" width="${NODE_W}" height="${NODE_H}" rx="${NODE_H / 2}"/><text x="${n.x}" y="${n.y + 4}" text-anchor="middle">${esc(n.name)}</text></g>`;
      }
      const role = n.id === factor ? 'factor' : n.id === cause ? 'cause' : '';
      const label = !factor
        ? `${n.name} limits ${f.target_name.toLowerCase()}`
        : n.id === factor
          ? `${n.name}: the limiting factor. Click again to remove both arrows.`
          : n.id === cause
            ? `${n.name}: drives ${name(factor).toLowerCase()}. Click again to remove this arrow.`
            : `${n.name} drives ${name(factor).toLowerCase()}`;
      return `<g class="fn-node ${role}" data-action="funding-node:${n.id}" role="button" tabindex="0" aria-pressed="${!!role}" aria-label="${esc(label)}">
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
  const target = esc(f.target_name.toLowerCase());
  const hint = !factor
    ? `<strong>Step 1 of 2.</strong> Click what limits ${target}.`
    : !cause
      ? `<strong>Step 2 of 2.</strong> Click what drives ${esc(name(factor).toLowerCase())}.`
      : `Both arrows are placed. Click another variable to change what drives ${esc(name(factor).toLowerCase())}. Click a chosen variable again to remove its arrow.`;
  const markers = Object.entries(ARROW)
    .map(([k, c]) => `<marker id="fa-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="${k === 'yes' ? 6 : 8}" markerHeight="${k === 'yes' ? 6 : 8}" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${c}"/></marker>`)
    .join('');
  const pastArrows = game.pastArrows();
  const key = (cls: string, text: string) => `<li><span class="fk ${cls}" aria-hidden="true"></span>${text}</li>`;

  return `<div class="modal-back"><div class="modal funding" role="dialog" aria-modal="true" aria-labelledby="fund-title">
    <div class="label">Parish council environment fund</div>
    <h1 id="fund-title">Apply for more funding</h1>
    <p>The council will add <strong>${fmtMoney(f.grant)}</strong> to your budget if you can show what holds ${target} back in this pond, two steps deep: something that limits ${target}, and what drives that.</p>
    <p class="muted small">Applying is free. The decision takes ${f.days} days and the pond carries on meanwhile. If the reviewers find either arrow is not supported by the evidence, the application is turned down. Only variables you have sampled can be used.</p>
    ${lastText}${few}
    <div class="fund-board">
      <svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Variables you have sampled, and the arrows you have drawn">
        <defs>${markers}</defs>
        ${past}${lines}${boxes}
      </svg>
    </div>
    <ul class="fund-key">
      ${key('factor', `Limits ${target}`)}
      ${key('cause', 'Drives that factor')}
      ${pastArrows.some((p) => p.supported) ? key('yes', 'Supported in an earlier application') : ''}
      ${pastArrows.some((p) => !p.supported) ? key('no', 'Not supported in an earlier application') : ''}
    </ul>
    <p class="fund-hint small" aria-live="polite">${hint}</p>
    ${
      drawn.length
        ? `<ul class="fund-list">${drawn
            .map(
              ({ key: k, from, to }) =>
                `<li><span><span class="fk ${k}" aria-hidden="true"></span>${esc(name(from))} → ${esc(name(to))}</span><button type="button" class="btn small" data-action="funding-remove:${k}" aria-label="Remove the arrow from ${esc(name(from))} to ${esc(name(to))}">Remove</button></li>`,
            )
            .join('')}</ul>`
        : ''
    }
    <div class="modal-actions">
      <button type="button" class="btn primary" data-action="funding-submit" ${cause ? '' : 'disabled'}>Submit application</button>
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
