import { loadBrowserData } from '../data/browser';
import { Game } from '../sim/game';
import './styles.css';
import { MapScene } from './map3d/MapScene';
import { mapViewState, renderMap } from './mapView';
import { renderTile, type UiState } from './view';

const MISSION = 'm01_clearwater_pond';
/** Simulated days per real second at each speed. 1 = a week per second, 4 = about a month. */
const DAYS_PER_SECOND = { 0: 0, 1: 7, 4: 30 } as const;

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? Math.floor(Math.random() * 1e9));
const data = loadBrowserData();
// The dev server starts with a large testing budget; ?budget=7000 restores the mission's own.
// Production builds use the mission budget unless the URL overrides it.
const TESTING_BUDGET = 100_000;
const budgetParam = params.get('budget');
const budget = budgetParam !== null ? Number(budgetParam) : import.meta.env.DEV ? TESTING_BUDGET : undefined;
const game = new Game(data, MISSION, seed, { budget });
// Start on the pond tile nearest the middle of the map.
const grid = game.sim.grid;
const centre = grid
  .waterTiles()
  .slice()
  .sort((a, b) => Math.hypot(a.row - grid.rows / 2, a.col - grid.cols / 2) - Math.hypot(b.row - grid.rows / 2, b.col - grid.cols / 2))[0];

const ui: UiState = {
  screen: 'map',
  tileId: centre.id,
  layer: 'all',
  selected: game.mission.objective.variable,
  overlay: 'surface',
  selection: [centre.id],
  drawerOpen: false,
  speed: 0,
  showBriefing: true,
  showOutcome: false,
};

const root = document.getElementById('app')!;

// The 3D map keeps one WebGL canvas for the whole session; renders move it into place.
let scene: MapScene | null = null;
function mapScene(): MapScene {
  if (scene) return scene;
  const terrain = data.terrains.get(grid.map.terrain!)!;
  scene = new MapScene(terrain, {
    onSelect(ids, mode) {
      if (mode === 'replace') {
        const id = ids[0];
        // First click selects a tile; clicking the selected pond tile again investigates it.
        if (id === ui.tileId && game.isWater(id) && ui.selection.length <= 1) ui.screen = 'tile';
        ui.tileId = id;
        ui.selection = game.isWater(id) ? [id] : [];
      } else {
        const set = new Set(ui.selection);
        const pond = ids.filter((id) => game.isWater(id));
        // A single Shift-click toggles; a dragged area adds.
        if (pond.length === 1 && set.has(pond[0])) set.delete(pond[0]);
        else pond.forEach((id) => set.add(id));
        ui.selection = [...set];
        if (ids.length) ui.tileId = ids[ids.length - 1];
      }
      draw();
    },
    onOpen(id) {
      if (!game.isWater(id)) return;
      ui.tileId = id;
      ui.screen = 'tile';
      draw();
    },
  });
  return scene;
}

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
  const canvasFocused = !!scene && scene.element.contains(document.activeElement);
  root.innerHTML = ui.screen === 'map' ? renderMap(game, ui) : renderTile(game, ui);
  const xs = root.querySelector('.xsec-scroll');
  if (xs) xs.scrollLeft = scroll;
  if (ui.screen === 'map') {
    const s = mapScene();
    root.querySelector('#stage-slot')?.replaceWith(s.element);
    s.update(mapViewState(game, ui));
    if (canvasFocused) s.element.querySelector('canvas')!.focus();
  }
  if (focused) (root.querySelector(`[data-action="${CSS.escape(focused)}"]`) as HTMLElement | null)?.focus();
}

function setDrawer(open: boolean) {
  ui.drawerOpen = open;
  root.querySelector('.drawer-wrap')?.classList.toggle('open', open);
  root.querySelector('.drawer-tab')?.setAttribute('aria-expanded', String(open));
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
  if (action === 'drawer') {
    // Toggle in place rather than re-rendering, so the drawer can slide.
    setDrawer(!ui.drawerOpen);
    return;
  }
  switch (action) {
    case 'layer':
      ui.layer = arg;
      break;
    case 'overlay':
      ui.overlay = arg;
      break;
    case 'open-tile':
      ui.tileId = arg;
      ui.screen = 'tile';
      break;
    case 'back-to-map':
      ui.screen = 'map';
      if (game.isWater(ui.tileId) && !ui.selection.includes(ui.tileId)) ui.selection = [ui.tileId];
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
      // On the map, tile-scoped interventions act on the whole selection.
      game.interveneOn(arg, ui.screen === 'map' ? ui.selection : [ui.tileId]);
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
  const el = e.target as Element;
  if (e.key === 'Backspace' && ui.screen === 'tile' && !(el instanceof HTMLInputElement)) {
    ui.screen = 'map';
    draw();
    return;
  }
  if (e.key === 'Escape' && ui.drawerOpen && !ui.showBriefing && !ui.showOutcome) {
    setDrawer(false);
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
(window as unknown as { game: Game; mapScene: () => MapScene | null }).game = game;
(window as unknown as { mapScene: () => MapScene | null }).mapScene = () => scene;
