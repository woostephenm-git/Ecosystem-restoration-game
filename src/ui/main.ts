import { loadBrowserData } from '../data/browser';
import { Game } from '../sim/game';
import './styles.css';
import { renderMap } from './mapView';
import { renderTile, type UiState } from './view';

const MISSION = 'm01_clearwater_pond';
/** Simulated days per real second at each speed. 1 = a week per second, 4 = about a month. */
const DAYS_PER_SECOND = { 0: 0, 1: 7, 4: 30 } as const;

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? Math.floor(Math.random() * 1e9));
const data = loadBrowserData();
const game = new Game(data, MISSION, seed);
const tiles = game.sim.grid.tiles;
const centre = tiles.find((t) => t.row === Math.floor(game.sim.grid.rows / 2) && t.col === Math.floor(game.sim.grid.cols / 2)) ?? tiles[0];

const ui: UiState = {
  screen: 'map',
  tileId: centre.id,
  layer: 'all',
  selected: game.mission.objective.variable,
  overlay: 'surface',
  speed: 0,
  showBriefing: true,
  showOutcome: false,
};

const root = document.getElementById('app')!;

// Re-rendering replaces every element. If that happens between pointerdown and pointerup,
// the browser drops the click (that is what made Pause unreliable while time was running).
// So while a pointer is held down, the sim keeps running but the screen waits.
let pointerHeld = false;
let redrawPending = false;
root.addEventListener('pointerdown', () => (pointerHeld = true));
const release = () => {
  pointerHeld = false;
  if (redrawPending) {
    redrawPending = false;
    // Let the click event fire on the element that was pressed before replacing it.
    setTimeout(draw, 0);
  }
};
window.addEventListener('pointerup', release);
window.addEventListener('pointercancel', release);

/** Redraw from the game loop, unless the player is mid-click. */
function drawFromLoop() {
  if (pointerHeld) redrawPending = true;
  else draw();
}

function draw() {
  theme();
  // Keep focus on the same control across re-renders so keyboard play works.
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.action;
  const scroll = root.querySelector('.xsec-scroll')?.scrollLeft ?? 0;
  root.innerHTML = ui.screen === 'map' ? renderMap(game, ui) : renderTile(game, ui);
  const xs = root.querySelector('.xsec-scroll');
  if (xs) xs.scrollLeft = scroll;
  if (focused) (root.querySelector(`[data-action="${CSS.escape(focused)}"]`) as HTMLElement | null)?.focus();
}

/** Light theme on the map, ochre in the investigation view. */
function theme() {
  document.documentElement.dataset.theme = ui.screen === 'map' ? 'light' : 'ochre';
}

function advance(days: number) {
  const hadOutcome = !!game.outcome;
  game.advance(days);
  if (!hadOutcome && game.outcome) {
    ui.speed = 0;
    ui.showOutcome = true;
  }
}

root.addEventListener('click', (e) => {
  const el = (e.target as Element).closest<HTMLElement | SVGElement>('[data-action]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  const [action, arg] = el.dataset.action!.split(':');
  switch (action) {
    case 'layer':
      ui.layer = arg;
      break;
    case 'overlay':
      ui.overlay = arg;
      break;
    case 'tile':
      // First click selects a tile on the map; clicking the selected tile opens it.
      if (ui.tileId === arg) ui.screen = 'tile';
      ui.tileId = arg;
      break;
    case 'open-tile':
      ui.tileId = arg;
      ui.screen = 'tile';
      break;
    case 'back-to-map':
      ui.screen = 'map';
      break;
    case 'inspect-boundary':
      // Boundary inputs are shown on the inflow face of the inlet tile.
      ui.tileId = game.sim.grid.map.inlets[0].tile;
      ui.selected = arg;
      ui.screen = 'tile';
      break;
    case 'select':
      ui.selected = arg;
      break;
    case 'sample':
      if (game.sample(arg, ui.tileId)) ui.selected = data.methods.get(arg)!.reveals[0];
      break;
    case 'intervene':
      game.intervene(arg, ui.tileId);
      break;
    case 'speed':
      ui.speed = Number(arg) as UiState['speed'];
      break;
    case 'step':
      ui.speed = 0;
      advance(7);
      break;
    case 'briefing-close':
      ui.showBriefing = false;
      break;
    case 'outcome-close':
      ui.showOutcome = false;
      break;
  }
  draw();
});

document.addEventListener('keydown', (e) => {
  // SVG map tiles are not buttons, so give them button keyboard behaviour.
  const el = e.target as Element;
  if ((e.key === 'Enter' || e.key === ' ') && el instanceof SVGElement && el.dataset.action) {
    e.preventDefault();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return;
  }
  if (e.key === 'Backspace' && ui.screen === 'tile' && !(el instanceof HTMLInputElement)) {
    ui.screen = 'map';
    draw();
    return;
  }
  if (e.key === 'Escape' && (ui.showBriefing || ui.showOutcome)) {
    ui.showBriefing = false;
    ui.showOutcome = false;
    draw();
  }
});

// A timer rather than requestAnimationFrame: the sim only needs ~20 updates a second,
// and timers keep running (throttled) in background tabs.
let carry = 0;
let last = performance.now();
function frame() {
  const now = performance.now();
  const dt = Math.min(1, (now - last) / 1000);
  last = now;
  const rate = DAYS_PER_SECOND[ui.speed];
  if (rate && !ui.showBriefing && !ui.showOutcome) {
    carry += dt * rate;
    const days = Math.floor(carry);
    if (days > 0) {
      carry -= days;
      advance(days);
      drawFromLoop();
    }
  } else carry = 0;
}

draw();
setInterval(frame, 50);
// Exposed for debugging in the console only.
(window as unknown as { game: Game }).game = game;
