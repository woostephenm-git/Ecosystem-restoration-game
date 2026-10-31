// 3D map view, ported from the "Marsh Specimen Bench" artifact (three.js, orthographic, isometric).
// The renderer reads a SceneState built from what the player knows; it never touches the sim.
// Everything outside the playable square is decorative scenery.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { solveSteadyFlow, type FlowField } from './flow';
import { TILE, channelFrom, fbm, hash2, makeHeight, smooth, type PondShape } from './terrain';

export interface SceneTile {
  id: string;
  row: number;
  col: number;
  description: string;
  /** Gauge depth in metres. */
  depth: number;
  /** 0 clear to 1 murky, from what is visible. */
  turbidity: number;
  /** 0 to 1 submerged plant cover, from what is visible. */
  cover: number;
  /** 0 to 1 school size to draw. Zero until carp on this tile have been surveyed. */
  fishShown: number;
  /** 0 to 1 strength of surface ripples and silt plumes, the visible sign of fish. */
  fishCue: number;
  overlay: { color: string; opacity: number; label: string } | null;
}

export interface SceneBoundary {
  tile: string;
  face: 'N' | 'E' | 'S' | 'W';
  name: string;
  lines: string[];
}

export interface SceneState {
  tiles: SceneTile[];
  selected: string;
  inlets: SceneBoundary[];
  outlets: SceneBoundary[];
  barrier: 'none' | 'building' | 'in_place';
  /** Inflow discharge relative to normal (1 = normal). */
  discharge: number;
  /** Wind strength, 0 to 1. */
  wind: number;
}

/* ---------------- Palette tokens (OKLCH) ---------------- */
const TOKENS: Record<string, [number, number, number]> = {
  sky: [0.27, 0.04, 250],
  grass_lt: [0.76, 0.15, 128],
  grass_md: [0.66, 0.15, 134],
  grass_dk: [0.53, 0.125, 140],
  wet_meadow: [0.57, 0.095, 112],
  mud: [0.52, 0.06, 72],
  sediment: [0.45, 0.05, 66],
  sediment_deep: [0.33, 0.04, 58],
  soil: [0.47, 0.085, 52],
  soil_dk: [0.37, 0.07, 46],
  bark: [0.43, 0.075, 50],
  conifer: [0.66, 0.15, 138],
  conifer_dk: [0.48, 0.115, 146],
  broadleaf: [0.72, 0.155, 122],
  broadleaf_dk: [0.53, 0.125, 132],
  water_shallow: [0.74, 0.115, 205],
  water_deep: [0.47, 0.11, 238],
  water_turbid: [0.56, 0.075, 92],
  foam: [0.96, 0.02, 210],
  cattail_leaf: [0.62, 0.12, 124],
  cattail_head: [0.4, 0.08, 44],
  phrag_stem: [0.72, 0.105, 104],
  phrag_plume: [0.56, 0.065, 18],
  lily_pad: [0.6, 0.135, 146],
  lily_flower: [0.94, 0.035, 350],
  lily_center: [0.86, 0.14, 92],
  submerged: [0.54, 0.12, 150],
  submerged_lt: [0.72, 0.14, 136],
  pebble: [0.7, 0.018, 80],
  pebble_dk: [0.52, 0.02, 70],
  fish: [0.63, 0.105, 68],
  fish_belly: [0.82, 0.06, 85],
  duckweed: [0.74, 0.15, 128],
  barrier: [0.62, 0.02, 250],
};
const CHROMA = 0.95;
const COL: Record<string, THREE.Color> = {};
function oklchToLinear(L: number, C: number, h: number): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map((v) =>
    Math.min(1, Math.max(0, v)),
  ) as [number, number, number];
}
for (const [k, [L, C, h]] of Object.entries(TOKENS)) {
  const [r, g, b] = oklchToLinear(L, C * CHROMA, h);
  COL[k] = new THREE.Color().setRGB(r, g, b);
}

/* ---------------- Shared shader code ---------------- */
type ShaderParams = { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string };

const OUT_FRAG = `
uniform vec3 uFogCol; uniform vec2 uHalf;
vec3 outsideFx(vec3 c, vec2 p){
  float o = max(abs(p.x) - uHalf.x, abs(p.y) - uHalf.y);
  float out1 = smoothstep(0.0, 0.2, o);
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 g = mix(c, vec3(l), 0.72 * out1) * mix(1.0, 0.66, out1);
  float fog = smoothstep(0.5, 15.0, o);
  return mix(g, uFogCol, fog);
}`;
const GLSL_COMMON = `
uniform float uTime; uniform vec2 uWindDir; uniform float uWindStrength; uniform float uGust; uniform float uWaveAmp;
float hash21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float a=hash21(i), b=hash21(i+vec2(1.,0.)), c=hash21(i+vec2(0.,1.)), d=hash21(i+vec2(1.,1.));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }
float waveH(vec2 p){ vec2 d=uWindDir; vec2 q=vec2(-d.y,d.x); float t=uTime;
  return uWaveAmp*( sin(dot(p,d)*2.4 - t*1.9)*0.45 + sin(dot(p,q)*1.9 + dot(p,d)*0.8 + t*1.3)*0.25 + (vnoise(p*1.6 - d*t*0.7)-0.5)*0.9 ); }
uniform sampler2D uFlowTex; uniform vec4 uFlowRect;
vec2 flowAt(vec2 p){ vec2 uv = (p - uFlowRect.xy) / uFlowRect.z; vec4 t = texture2D(uFlowTex, uv); return (t.xy*255.0 - 127.0) / 127.0 * uFlowRect.w; }
`;
const SWAY: Record<number, string> = {
  0: `float gust = vnoise(root.xz*0.45 - uWindDir*uTime*1.6);
      float push = uWindStrength*(0.3 + 1.4*uGust*gust);
      float flutter = (sin(uTime*(2.2+uWindStrength*2.0)+ph)*0.6 + sin(uTime*5.3+ph*1.7)*0.25) * (0.15+0.5*uWindStrength);
      float b = pow(hn, uCurve) * uFlex;
      vec2 side = vec2(-uWindDir.y, uWindDir.x);
      wp.xz += uWindDir*(push + flutter*0.5)*b + side*flutter*0.25*b;
      wp.y -= abs(push + flutter*0.5)*b*0.35*hn;`,
  1: `wp.y += waveH(root.xz);
      wp.xz += vec2(sin(uTime*0.4+ph), cos(uTime*0.33+ph))*0.012 + uWindDir*uWindStrength*0.01*sin(uTime*0.5+ph);`,
  2: `float b = pow(hn, uCurve) * uFlex;
      vec2 fl = flowAt(root.xz); float sp = length(fl);
      vec2 cur = sp > 0.002 ? fl / sp : vec2(0.7071, 0.7071);
      float lean = clamp(sp * 4.0, 0.0, 1.8);
      float s1 = sin(uTime*(0.9 + sp*5.0) + ph + root.x*0.7);
      float s2 = sin(uTime*1.7 + ph*1.3 + hn*3.0);
      wp.xz += cur*(lean + (0.15 + 0.3*min(lean, 1.0))*s1)*b + vec2(-cur.y, cur.x)*s2*0.3*b*(1.0 - 0.5*min(lean, 1.0));
      wp.y -= min(lean, 1.2)*b*0.4*hn;`,
  3: ``,
  4: `wp.y += waveH(root.xz);`,
};

/* ---------------- Geometry helpers ---------------- */
type Spine = [number, number, number, number][];
function ribbon(spine: Spine): THREE.BufferGeometry {
  const pos: number[] = [];
  for (let k = 0; k < spine.length - 1; k++) {
    const [x0, y0, z0, w0] = spine[k];
    const [x1, y1, z1, w1] = spine[k + 1];
    pos.push(x0 - w0, y0, z0, x0 + w0, y0, z0, x1 + w1, y1, z1, x0 - w0, y0, z0, x1 + w1, y1, z1, x1 - w1, y1, z1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
type V3 = [number, number, number];
function xf(geo: THREE.BufferGeometry, t: V3 = [0, 0, 0], r: V3 = [0, 0, 0], s: V3 = [1, 1, 1]): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  _m.compose(_v.set(...t), _q.setFromEuler(_e.set(...r)), _s.set(...s));
  return g.applyMatrix4(_m);
}
function cyl(rt: number, rb: number, h: number, seg = 5) {
  return new THREE.CylinderGeometry(rt, rb, h, seg).translate(0, h / 2, 0);
}
interface PlantRec {
  geo: THREE.BufferGeometry;
  ta: string[];
  tb: string[];
  tt: number[];
}
function buildPlant(parts: [THREE.BufferGeometry, string, string?][]): PlantRec {
  const pos: number[] = [];
  const ta: string[] = [];
  const tb: string[] = [];
  const tt: number[] = [];
  for (const [geo, a, b] of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.computeBoundingBox();
    const { min, max } = g.boundingBox!;
    const arr = g.attributes.position.array as Float32Array;
    const span = max.y - min.y;
    for (let i = 0; i < arr.length; i += 3) {
      pos.push(arr[i], arr[i + 1], arr[i + 2]);
      ta.push(a);
      tb.push(b || a);
      tt.push(span > 1e-5 ? (arr[i + 1] - min.y) / span : 0);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
  geo.computeVertexNormals();
  const c = geo.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < ta.length; i++) {
    _c.copy(COL[ta[i]]).lerp(COL[tb[i]], tt[i]);
    c.setXYZ(i, _c.r, _c.g, _c.b);
  }
  return { geo, ta, tb, tt };
}
/** Seeded so scenery is identical on every load. */
const rand = (() => {
  let a = 1337;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();

/* ---------------- Plant geometries ---------------- */
function grassGeo() {
  const parts: [THREE.BufferGeometry, string, string?][] = [];
  for (let k = 0; k < 6; k++) {
    const h = 0.13 + rand() * 0.07;
    const lean = 0.04 + rand() * 0.05;
    parts.push([xf(ribbon([[0, 0, 0, 0.022], [0, h * 0.5, lean * 0.4, 0.016], [0, h, lean, 0]]), [(rand() - 0.5) * 0.06, 0, (rand() - 0.5) * 0.06], [0, k * 1.05 + rand(), 0]), 'grass_dk', 'grass_lt']);
  }
  return buildPlant(parts);
}
function cattailGeo() {
  const parts: [THREE.BufferGeometry, string, string?][] = [];
  for (let k = 0; k < 5; k++) {
    const h = 0.48 + rand() * 0.16;
    const lean = 0.12 + rand() * 0.14;
    parts.push([xf(ribbon([[0, 0, 0, 0.026], [0, h * 0.5, lean * 0.25, 0.022], [0, h * 0.85, lean * 0.65, 0.012], [0, h, lean, 0]]), [0, 0, 0], [0, k * 1.26 + rand() * 0.5, 0]), 'cattail_leaf', 'phrag_stem']);
  }
  for (const [ox, oz, h] of [
    [0.015, 0.01, 0.62],
    [-0.03, -0.02, 0.54],
  ]) {
    parts.push([xf(cyl(0.007, 0.009, h, 4), [ox, 0, oz]), 'cattail_leaf']);
    parts.push([xf(cyl(0.024, 0.024, 0.1, 6), [ox, h - 0.16, oz]), 'cattail_head']);
    parts.push([xf(cyl(0.003, 0.004, 0.07, 3), [ox, h - 0.06, oz]), 'phrag_stem']);
  }
  return buildPlant(parts);
}
function phragGeo() {
  const parts: [THREE.BufferGeometry, string, string?][] = [];
  for (const [ox, oz, h] of [
    [0, 0, 0.95],
    [0.05, 0.03, 0.86],
    [-0.04, 0.04, 0.9],
  ]) {
    parts.push([xf(cyl(0.006, 0.009, h, 4), [ox, 0, oz]), 'phrag_stem']);
    for (let k = 0; k < 4; k++) {
      const y = 0.22 + k * 0.16;
      parts.push([xf(ribbon([[0, 0, 0, 0.02], [0, 0.05, 0.12, 0.014], [0, 0.02, 0.22, 0]]), [ox, y, oz], [0, rand() * 6.28, 0]), 'phrag_stem', 'cattail_leaf']);
    }
    parts.push([xf(new THREE.ConeGeometry(0.05, 0.22, 5), [ox + 0.03, h - 0.02, oz], [Math.PI, 0, 0.45]), 'phrag_plume', 'phrag_stem']);
  }
  return buildPlant(parts);
}
function lilyGeo() {
  const parts: [THREE.BufferGeometry, string, string?][] = [];
  for (const [ox, oz, r, rot] of [
    [0, 0, 0.1, 0],
    [0.15, 0.05, 0.08, 2],
    [-0.06, 0.14, 0.065, 4],
  ]) {
    parts.push([xf(new THREE.CircleGeometry(r, 10, 0.3, Math.PI * 2 - 0.6), [ox, 0, oz], [-Math.PI / 2, 0, rot]), 'lily_pad']);
  }
  return buildPlant(parts);
}
function submergedGeo() {
  const parts: [THREE.BufferGeometry, string, string?][] = [];
  for (let k = 0; k < 4; k++) {
    const sp: Spine = [];
    let x = 0;
    for (let i = 0; i <= 6; i++) {
      x += (rand() - 0.5) * 0.06;
      sp.push([x, i * 0.1, Math.sin(i * 1.3 + k) * 0.03, 0.028 * (1 - i / 8)]);
    }
    parts.push([xf(ribbon(sp), [(rand() - 0.5) * 0.08, 0, (rand() - 0.5) * 0.08], [0, k * 1.6, 0]), 'submerged', 'submerged_lt']);
  }
  return buildPlant(parts);
}
function pebbleGeo() {
  const parts: [THREE.BufferGeometry, string, string?][] = [];
  const n = 3 + Math.floor(rand() * 3);
  for (let k = 0; k < n; k++) {
    const r = 0.022 + rand() * 0.03;
    parts.push([xf(new THREE.IcosahedronGeometry(r, 0), [(rand() - 0.5) * 0.18, r * 0.35, (rand() - 0.5) * 0.18], [rand() * 3, rand() * 3, rand() * 3], [1.2, 0.55, 1]), rand() < 0.5 ? 'pebble' : 'pebble_dk', 'pebble']);
  }
  return buildPlant(parts);
}
function coniferGeo() {
  return buildPlant([
    [xf(cyl(0.045, 0.07, 0.55, 5)), 'bark'],
    [xf(new THREE.ConeGeometry(0.4, 0.6, 7), [0, 0.68, 0]), 'conifer_dk', 'conifer'],
    [xf(new THREE.ConeGeometry(0.31, 0.52, 7), [0, 0.98, 0], [0, 0.4, 0]), 'conifer_dk', 'conifer'],
    [xf(new THREE.ConeGeometry(0.2, 0.42, 7), [0, 1.26, 0], [0, 0.8, 0]), 'conifer_dk', 'conifer'],
  ]);
}
function broadleafGeo() {
  return buildPlant([
    [xf(cyl(0.05, 0.075, 0.62, 5)), 'bark'],
    [xf(new THREE.IcosahedronGeometry(0.38, 0), [0, 0.95, 0], [0.3, 0.2, 0], [1, 1.1, 1]), 'broadleaf_dk', 'broadleaf'],
    [xf(new THREE.IcosahedronGeometry(0.24, 0), [0.2, 1.22, 0.08], [0.5, 0, 0.2]), 'broadleaf_dk', 'broadleaf'],
  ]);
}
function fishGeo() {
  const tail = new THREE.BufferGeometry();
  tail.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.07, 0, 0.04, -0.13, 0, -0.04, -0.13], 3));
  return buildPlant([
    [xf(new THREE.OctahedronGeometry(0.05, 0), [0, 0, 0], [0, 0, 0], [0.55, 0.7, 1.7]), 'fish_belly', 'fish'],
    [xf(ribbon([[0, -0.03, 0, 0], [0, 0.03, 0, 0]])), 'fish'],
    [tail, 'fish'],
  ]);
}

interface Cand {
  x: number;
  z: number;
  h: number;
  rot: number;
  s: number;
  v: number;
  flower: boolean;
}
interface PlantType {
  mesh: THREE.InstancedMesh;
  mode: number;
  max: number;
  maxOut: number;
  cands: Cand[];
  outCands: Cand[];
  outCover: number;
  hab: (d: number) => boolean;
  surface?: boolean;
  fitDepth?: boolean;
  sink?: number;
  /** Cover inside the playable square comes from the sim (submerged plants only). */
  simDriven?: boolean;
}
interface Fish {
  x: number;
  z: number;
  vx: number;
  vz: number;
  s: number;
  ph: number;
}
interface School {
  tile: number;
  members: Fish[];
  tx: number;
  tz: number;
  timer: number;
}

const MAX_SWIRL = 32;
const EXT = 10; // decorative scatter reaches this far past the playable edge
const VIEW_H = 15.5;
const SUN = new THREE.Vector3(-0.55, 1.0, 0.35).normalize();

export class PondScene {
  readonly element: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  private readonly controls: OrbitControls;
  private readonly H: (x: number, z: number) => number;
  private readonly NX: number;
  private readonly NZ: number;
  private readonly HX: number;
  private readonly HZ: number;
  private readonly WMIN: number;
  private readonly WMAX: number;
  private readonly shared: Record<string, THREE.IUniform>;
  private readonly waterU: Record<string, THREE.IUniform>;
  private readonly turbData: Uint8Array<ArrayBuffer>;
  private readonly turbTex: THREE.DataTexture;
  private readonly types: PlantType[] = [];
  private submergedType!: PlantType;
  private readonly fishMesh: THREE.InstancedMesh;
  private schools: School[] = [];
  private ripIdx = 0;
  private ripTimers: number[] = [];
  private flow: FlowField | null = null;
  private readonly FR = 2;
  private readonly FNX: number;
  private readonly flowTex: THREE.DataTexture;
  private readonly flowData: Uint8Array<ArrayBuffer>;
  private specks: { mesh: THREE.InstancedMesh; parts: { x: number; z: number; age: number; life: number; rot: number; s: number; wa: number }[] }[] = [];
  private readonly overlayQuads: THREE.Mesh[] = [];
  private readonly selStrip: THREE.Mesh;
  private readonly hoverLoop: THREE.LineLoop;
  private readonly barrierGroup = new THREE.Group();
  private readonly labelLayer: HTMLElement;
  private readonly tileLabels: HTMLElement[] = [];
  private boundaryLabels: { el: HTMLElement; x: number; z: number }[] = [];
  private readonly hudTile: HTMLElement;
  private readonly hudInfo: HTMLElement;
  private readonly needle: SVGElement;
  private readonly cLetters: SVGElement[];
  private state: SceneState;
  private hover: number | null = null;
  private running = false;
  private last = performance.now();
  private time = 0;
  private readonly paused = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private lastKey = { plants: '', fish: '', flow: -1, selected: '', barrier: '', boundary: '' };

  static supported(): boolean {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      return false;
    }
  }

  constructor(
    initial: SceneState,
    rows: number,
    cols: number,
    private readonly onTile: (id: string) => void,
  ) {
    this.state = initial;
    this.NX = cols * TILE;
    this.NZ = rows * TILE;
    this.HX = this.NX / 2;
    this.HZ = this.NZ / 2;
    this.WMIN = -18;
    this.WMAX = Math.max(this.NX, this.NZ) + 18;

    const depth: number[][] = Array.from({ length: rows }, () => Array(cols).fill(1));
    for (const t of initial.tiles) depth[t.row][t.col] = t.depth;
    const shape: PondShape = { rows, cols, depth, channels: [] };
    for (const b of [...initial.inlets, ...initial.outlets]) {
      const t = initial.tiles.find((x) => x.id === b.tile)!;
      shape.channels.push(channelFrom(b.face, t.row, t.col, shape, 30));
    }
    this.H = makeHeight(shape);

    /* DOM */
    this.element = document.createElement('div');
    this.element.className = 'stage3d';
    this.element.innerHTML = `
      <canvas aria-label="Animated 3D view of the pond. Use the tile buttons beside the map to select tiles with the keyboard."></canvas>
      <div class="s-labels" aria-hidden="true"></div>
      <div class="s-hud" aria-live="polite"><div class="s-hud-tile">Hover a tile</div><div class="s-hud-info">Shows observable state only</div></div>
      <div class="s-hint">Click a tile to select it, click again to investigate · Drag to rotate · Scroll to zoom</div>
      <div class="s-compass" aria-hidden="true"><svg viewBox="-32 -32 64 64">
        <circle r="17" fill="none" stroke="#8a98a6" stroke-opacity="0.35" stroke-width="1"/>
        <g class="needle"><path d="M0 -15 L3.6 0 L0 2.5 L-3.6 0 Z" fill="#dfe6ec"/><path d="M0 15 L3.6 0 L0 -2.5 L-3.6 0 Z" fill="#8a98a6" fill-opacity="0.55"/></g>
        <text class="n">N</text><text>E</text><text>S</text><text>W</text>
      </svg></div>`;
    this.canvas = this.element.querySelector('canvas')!;
    this.labelLayer = this.element.querySelector('.s-labels')!;
    this.hudTile = this.element.querySelector('.s-hud-tile')!;
    this.hudInfo = this.element.querySelector('.s-hud-info')!;
    this.needle = this.element.querySelector('.needle')!;
    this.cLetters = [...this.element.querySelectorAll<SVGElement>('.s-compass text')];

    /* Renderer and camera */
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = COL.sky;
    this.camera.position.set(18, 18, 18);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.set(0, -0.4, 0);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.minPolarAngle = 0.72;
    this.controls.maxPolarAngle = 1.12;
    this.controls.minZoom = 0.8;
    this.controls.maxZoom = 4;
    this.controls.update();
    new ResizeObserver(() => this.resize()).observe(this.element);

    /* Lights */
    const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1.35);
    hemi.color.copy(COL.sky).lerp(new THREE.Color(1, 1, 1), 0.75);
    hemi.groundColor.copy(COL.soil_dk).lerp(new THREE.Color(0.2, 0.2, 0.2), 0.3);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3df, 2.3);
    sun.position.copy(SUN).multiplyScalar(20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 50 });
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);

    /* Shared uniforms */
    this.FNX = (this.WMAX - this.WMIN) * this.FR;
    this.flowData = new Uint8Array(this.FNX * this.FNX * 4);
    this.flowTex = new THREE.DataTexture(this.flowData, this.FNX, this.FNX, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.flowTex.magFilter = THREE.LinearFilter;
    this.flowTex.minFilter = THREE.LinearFilter;
    this.flowTex.needsUpdate = true;
    const fog = COL.sky.clone().convertLinearToSRGB();
    this.shared = {
      uTime: { value: 0 },
      uWindDir: { value: new THREE.Vector2(1, 0) },
      uWindStrength: { value: 0.45 },
      uGust: { value: 0.5 },
      uWaveAmp: { value: 0.04 },
      uFogCol: { value: fog },
      uHalf: { value: new THREE.Vector2(this.HX, this.HZ) },
      uFlowTex: { value: this.flowTex },
      uFlowRect: { value: new THREE.Vector4(this.WMIN - this.HX, this.WMIN - this.HZ, this.WMAX - this.WMIN, 0.1) },
    };
    // Wind blows toward a bearing of 120 degrees; north is map -z.
    const a = (120 * Math.PI) / 180;
    (this.shared.uWindDir.value as THREE.Vector2).set(Math.sin(a), -Math.cos(a));

    /* Per-tile turbidity, sampled smoothly by the water shader */
    this.turbData = new Uint8Array(cols * rows * 4);
    this.turbTex = new THREE.DataTexture(this.turbData, cols, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.turbTex.magFilter = THREE.LinearFilter;
    this.turbTex.minFilter = THREE.LinearFilter;
    this.waterU = {
      uWaterLevel: { value: 0 },
      uTurbTex: { value: this.turbTex },
      uPlay: { value: new THREE.Vector4(-this.HX, -this.HZ, this.NX, this.NZ) },
      uShallow: { value: COL.water_shallow },
      uDeep: { value: COL.water_deep },
      uTurbid: { value: COL.water_turbid },
      uFoam: { value: COL.foam },
      uSun: { value: SUN.clone() },
      uViewDir: { value: new THREE.Vector3(1, 1, 1).normalize() },
      uSwirl: { value: Array.from({ length: MAX_SWIRL }, () => new THREE.Vector4(0, 0, 0, 0)) },
    };

    this.buildTerrain();
    this.buildWater();
    this.buildPlants();
    this.fishMesh = this.buildFish();
    this.buildSpecks();

    /* Tile grid, playable border, selection and hover */
    this.scene.add(this.gridLines());
    this.scene.add(this.strip(this.borderPath(0, 0, this.NX, this.NZ), 0.045, 0xeef5fa, 1));
    this.selStrip = this.strip([], 0.07, 0xffffff, 5);
    this.scene.add(this.selStrip);
    this.hoverLoop = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthTest: false }));
    this.hoverLoop.renderOrder = 5;
    this.hoverLoop.visible = false;
    this.scene.add(this.hoverLoop);
    this.scene.add(this.barrierGroup);

    /* Overlay quads and tile labels */
    for (const t of initial.tiles) {
      const quad = new THREE.Mesh(
        new THREE.PlaneGeometry(TILE - 0.18, TILE - 0.18).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }),
      );
      quad.position.set((t.col + 0.5) * TILE - this.HX, 0.07, (t.row + 0.5) * TILE - this.HZ);
      quad.renderOrder = 4;
      quad.visible = false;
      this.overlayQuads.push(quad);
      this.scene.add(quad);
      const label = document.createElement('div');
      label.className = 's-tile';
      this.labelLayer.appendChild(label);
      this.tileLabels.push(label);
    }

    this.bindPointer();
    this.resize();
    this.update(initial);
  }

  /* ---------------- Public API ---------------- */

  update(state: SceneState) {
    this.state = state;
    // Turbidity texture
    for (const t of state.tiles) {
      const k = (t.row * (this.NX / TILE) + t.col) * 4;
      this.turbData[k] = Math.round(Math.min(1, Math.max(0, t.turbidity)) * 255);
      this.turbData[k + 3] = 255;
    }
    this.turbTex.needsUpdate = true;
    // Wind and waves
    this.shared.uWindStrength.value = 0.15 + 0.75 * state.wind;
    this.shared.uWaveAmp.value = 0.018 + 0.06 * state.wind;
    // Plants: rebuild when visible cover changes noticeably
    const plantKey = state.tiles.map((t) => Math.round(t.cover * 40)).join(',');
    if (plantKey !== this.lastKey.plants) {
      this.lastKey.plants = plantKey;
      this.placePlants();
    }
    const fishKey = state.tiles.map((t) => Math.round(t.fishShown * 10)).join(',');
    if (fishKey !== this.lastKey.fish) {
      this.lastKey.fish = fishKey;
      this.rebuildFish();
    }
    const flowKey = Math.round(state.discharge * 20);
    if (flowKey !== this.lastKey.flow) {
      this.lastKey.flow = flowKey;
      this.rebuildFlow();
    }
    // Overlays and labels
    state.tiles.forEach((t, i) => {
      const quad = this.overlayQuads[i];
      const mat = quad.material as THREE.MeshBasicMaterial;
      quad.visible = !!t.overlay;
      if (t.overlay) {
        mat.color.set(t.overlay.color);
        mat.opacity = t.overlay.opacity;
      }
      const label = this.tileLabels[i];
      label.innerHTML = `<b>${t.id}</b>${t.overlay ? `<span>${t.overlay.label}</span>` : ''}`;
      label.classList.toggle('sel', t.id === state.selected);
    });
    if (state.selected !== this.lastKey.selected) {
      this.lastKey.selected = state.selected;
      this.setSelected(state.selected);
    }
    if (state.barrier !== this.lastKey.barrier) {
      this.lastKey.barrier = state.barrier;
      this.buildBarrier(state.barrier);
    }
    const boundaryKey = JSON.stringify([state.inlets, state.outlets]);
    if (boundaryKey !== this.lastKey.boundary) {
      this.lastKey.boundary = boundaryKey;
      this.buildBoundaryLabels();
    }
    if (this.hover !== null) this.setHover(this.hover);
  }

  /** Runs the render loop while the element is in the document. Safe to call repeatedly. */
  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const frame = (now: number) => {
      if (!this.element.isConnected) {
        this.running = false;
        return;
      }
      this.frame(now);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  /* ---------------- Coordinates ---------------- */

  private surfY(x: number, z: number) {
    const h = this.H(x, z);
    return h > 0 ? h + 0.015 : 0.05;
  }

  private tileAt(x: number, z: number): number | null {
    if (x < 0 || z < 0 || x >= this.NX || z >= this.NZ) return null;
    const col = Math.floor(x / TILE);
    const row = Math.floor(z / TILE);
    const i = this.state.tiles.findIndex((t) => t.row === row && t.col === col);
    return i >= 0 ? i : null;
  }

  private setInst(mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number, rot: number, sx: number, sy = sx, sz = sx) {
    _m.compose(_v.set(x - this.HX, y, z - this.HZ), _q.setFromEuler(_e.set(0, rot, 0)), _s.set(sx, sy, sz));
    mesh.setMatrixAt(i, _m);
  }

  private resize() {
    const w = this.element.clientWidth;
    const h = this.element.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    const vh = aspect < 1 ? (VIEW_H / aspect) * 0.85 : VIEW_H;
    this.camera.left = (-vh * aspect) / 2;
    this.camera.right = (vh * aspect) / 2;
    this.camera.top = vh / 2;
    this.camera.bottom = -vh / 2;
    this.camera.updateProjectionMatrix();
  }

  /* ---------------- Shaders ---------------- */

  private injectOutsideFrag(sh: ShaderParams) {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vPlayW;\n' + OUT_FRAG)
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.rgb = outsideFx(gl_FragColor.rgb, vPlayW);');
  }

  private swayMaterials(mode: number, height: number, flex: number, curve: number) {
    const local = { uHeight: { value: height }, uFlex: { value: flex }, uCurve: { value: curve } };
    const patch = (mat: THREE.Material, isDepth: boolean) => {
      mat.onBeforeCompile = (sh: ShaderParams) => {
        Object.assign(sh.uniforms, this.shared, local);
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\n' + GLSL_COMMON + '\nuniform float uHeight; uniform float uFlex; uniform float uCurve; varying vec2 vPlayW;')
          .replace(
            '#include <project_vertex>',
            `
    vec4 wp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
    vec4 root = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float hn = clamp((wp.y - root.y) / uHeight, 0.0, 1.2);
    float ph = hash21(root.xz*3.17) * 6.2831;
    ${SWAY[mode]}
    vPlayW = root.xz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;`,
          );
        if (!isDepth) this.injectOutsideFrag(sh);
      };
      mat.customProgramCacheKey = () => 'sway' + mode + (isDepth ? 'd' : '');
    };
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    patch(mat, false);
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
    patch(depth, true);
    return { mat, depth };
  }

  /* ---------------- Terrain ---------------- */

  private buildTerrain() {
    const { WMIN, WMAX, H, HX, HZ } = this;
    const RES = 3;
    const G = (WMAX - WMIN) * RES;
    const tv: [number, number, number][] = [];
    for (let j = 0; j <= G; j++)
      for (let i = 0; i <= G; i++) {
        let x = WMIN + i / RES;
        let z = WMIN + j / RES;
        const onEdge = i === 0 || j === 0 || i === G || j === G;
        const onBorder = Math.abs(x) < 1e-6 || Math.abs(x - this.NX) < 1e-6 || Math.abs(z) < 1e-6 || Math.abs(z - this.NZ) < 1e-6;
        if (!onEdge && !onBorder) {
          x += (hash2(i * 1.7, j * 2.3) - 0.5) * 0.14;
          z += (hash2(i * 3.1, j * 0.7) - 0.5) * 0.14;
        }
        tv.push([x, z, H(x, z)]);
      }
    const pos: number[] = [];
    const V = (i: number, j: number) => tv[j * (G + 1) + i];
    const push = (p: [number, number, number]) => pos.push(p[0] - HX, p[2], p[1] - HZ);
    for (let j = 0; j < G; j++)
      for (let i = 0; i < G; i++) {
        const a = V(i, j);
        const b = V(i + 1, j);
        const c = V(i, j + 1);
        const d = V(i + 1, j + 1);
        if ((i + j) & 1) [a, c, d, a, d, b].forEach(push);
        else [a, c, b, b, c, d].forEach(push);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
    geo.computeVertexNormals();
    // Colour by height relative to the water and by slope.
    const p = geo.attributes.position.array as Float32Array;
    const c = geo.attributes.color as THREE.BufferAttribute;
    const nrm = geo.attributes.normal.array as Float32Array;
    for (let f = 0; f < p.length / 9; f++) {
      const o = f * 9;
      const x = (p[o] + p[o + 3] + p[o + 6]) / 3 + HX;
      const y = (p[o + 1] + p[o + 4] + p[o + 7]) / 3;
      const z = (p[o + 2] + p[o + 5] + p[o + 8]) / 3 + HZ;
      const dw = y;
      if (dw < -0.03) _c.copy(COL.sediment).lerp(COL.sediment_deep, smooth(0, 1.6, -dw));
      else if (dw < 0.05) _c.copy(COL.mud);
      else if (dw < 0.15) _c.copy(COL.wet_meadow);
      else if (nrm[o + 1] < 0.62) _c.copy(COL.soil);
      else {
        const n = fbm(x * 0.55 + 20, z * 0.55 + 4);
        if (n < 0.5) _c.copy(COL.grass_dk).lerp(COL.grass_md, smooth(0.3, 0.5, n));
        else _c.copy(COL.grass_md).lerp(COL.grass_lt, smooth(0.5, 0.68, n));
      }
      _c.multiplyScalar(1 + (hash2(f * 1.37, 3.1) - 0.5) * 0.09);
      for (let k = 0; k < 3; k++) c.setXYZ(f * 3 + k, _c.r, _c.g, _c.b);
    }
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    mat.onBeforeCompile = (sh: ShaderParams) => {
      Object.assign(sh.uniforms, this.shared);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vPlayW;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvPlayW = (modelMatrix * vec4(transformed, 1.0)).xz;');
      this.injectOutsideFrag(sh);
    };
    const terrain = new THREE.Mesh(geo, mat);
    terrain.receiveShadow = true;
    this.scene.add(terrain);
  }

  /* ---------------- Water ---------------- */

  private buildWater() {
    const span = this.WMAX - this.WMIN;
    const cx = (this.WMIN + this.WMAX) / 2;
    const geo = new THREE.PlaneGeometry(span, span, span * 4, span * 4).rotateX(-Math.PI / 2).translate(cx - this.HX, 0, cx - this.HZ);
    const p = geo.attributes.position.array as Float32Array;
    const bed = new Float32Array(p.length / 3);
    for (let i = 0; i < bed.length; i++) bed[i] = this.H(p[i * 3] + this.HX, p[i * 3 + 2] + this.HZ);
    geo.setAttribute('aBed', new THREE.BufferAttribute(bed, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.shared, ...this.waterU },
      transparent: true,
      depthWrite: false,
      vertexShader:
        GLSL_COMMON +
        `
    uniform float uWaterLevel; attribute float aBed; varying vec3 vW; varying float vDepth;
    void main(){ float depth = uWaterLevel - aBed; float damp = smoothstep(0.0, 0.4, depth);
      vec3 w = vec3(position.x, uWaterLevel + waveH(position.xz)*damp, position.z);
      vW = w; vDepth = depth; gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0); }`,
      fragmentShader:
        GLSL_COMMON +
        OUT_FRAG +
        `
    uniform sampler2D uTurbTex; uniform vec4 uPlay; uniform vec3 uShallow; uniform vec3 uDeep; uniform vec3 uTurbid; uniform vec3 uFoam;
    uniform vec3 uSun; uniform vec3 uViewDir; uniform vec4 uSwirl[${MAX_SWIRL}]; varying vec3 vW; varying float vDepth;
    void main(){
      vec3 n = normalize(cross(dFdx(vW), dFdy(vW))); if (n.y < 0.0) n = -n;
      float d = max(vDepth, 0.0);
      // Turbidity per tile, from what the player can see, blended smoothly between tiles.
      float turb = texture2D(uTurbTex, (vW.xz - uPlay.xy) / uPlay.zw).r;
      float sw = 0.0, plume = 0.0;
      for (int i = 0; i < ${MAX_SWIRL}; i++) {
        vec4 s = uSwirl[i];
        if (s.z <= 0.0) continue;
        float age = uTime - s.w;
        if (age < 0.0 || age > 1.6) continue;
        vec2 dv = vW.xz - s.xy; float r = length(dv);
        if (r > 0.75) continue;
        float life = age / 1.6, fade = (1.0 - life) * (1.0 - life);
        float R1 = 0.04 + age * 0.34, R2 = max(0.0, age - 0.3) * 0.34;
        float ring = exp(-pow((r - R1) / 0.02, 2.0)) + 0.6 * step(0.3, age) * exp(-pow((r - R2) / 0.016, 2.0));
        float boil = exp(-r * r / 0.004) * max(0.0, 1.0 - age * 2.5);
        sw += s.z * fade * (ring * 0.9 + boil * 1.2);
        plume += s.z * exp(-r * 4.0) * (1.0 - life) * 0.6;
      }
      vec3 clearC = mix(uShallow, uDeep, smoothstep(0.0, 1.8, d));
      vec3 base = mix(clearC, uTurbid, clamp(turb + plume*0.3, 0.0, 1.0));
      float diff = clamp(dot(n, uSun), 0.0, 1.0);
      vec3 col = base * (0.62 + 0.5 * diff);
      vec3 hv = normalize(uSun + uViewDir);
      col += vec3(pow(max(dot(n, hv), 0.0), 48.0) * 0.35);
      col += uFoam * clamp(sw, 0.0, 1.0) * 0.5;
      col -= vec3(clamp(-sw, 0.0, 1.0) * 0.1);
      vec2 fv = flowAt(vW.xz); float fsp = length(fv);
      float fph0 = fract(uTime / 2.0), fph1 = fract(uTime / 2.0 + 0.5), fw = abs(fph0 * 2.0 - 1.0);
      vec2 fp = vW.xz * 7.0;
      float fn0 = vnoise(fp - fv * fph0 * 2.0 * 7.0), fn1 = vnoise(fp + vec2(3.7, 1.3) - fv * fph1 * 2.0 * 7.0);
      float streak = smoothstep(0.55, 0.9, mix(fn0, fn1, fw)) * smoothstep(0.01, 0.12, fsp);
      col += uFoam * streak * 0.16;
      float fn = vnoise(vW.xz*5.0 + vec2(uTime*0.35, -uTime*0.25));
      float foam = 1.0 - smoothstep(0.004, 0.025 + 0.035*fn, d);
      float k = mix(0.55, 6.5, turb);
      float a = mix(0.12, 0.9, 1.0 - exp(-d * k));
      a = max(a, (0.12 + 0.8*turb) * smoothstep(0.0, 0.12, d));
      a = clamp(a + plume*0.15 + abs(sw)*0.15, 0.0, 1.0);
      col = mix(col, uFoam, foam * 0.7);
      a = max(a, foam * 0.75);
      gl_FragColor = vec4(col, a);
      #include <colorspace_fragment>
      gl_FragColor.rgb = outsideFx(gl_FragColor.rgb, vW.xz);
    }`,
    });
    const water = new THREE.Mesh(geo, mat);
    water.renderOrder = 3;
    this.scene.add(water);
  }

  /* ---------------- Plants ---------------- */

  private genCands(clump: number, off: number, scale: [number, number], n: number, outer: boolean): Cand[] {
    const out: Cand[] = [];
    const inside = (x: number, z: number) => x >= 0 && x <= this.NX && z >= 0 && z <= this.NZ;
    let guard = 0;
    while (out.length < n && guard++ < n * 4) {
      const x = outer ? -EXT + rand() * (this.NX + 2 * EXT) : 0.08 + rand() * (this.NX - 0.16);
      const z = outer ? -EXT + rand() * (this.NZ + 2 * EXT) : 0.08 + rand() * (this.NZ - 0.16);
      if (outer && inside(x, z)) continue;
      out.push({ x, z, h: this.H(x, z), rot: rand() * 6.283, s: scale[0] + rand() * (scale[1] - scale[0]), v: fbm(x * clump + off, z * clump + off * 0.7) + rand() * 0.22, flower: rand() < 0.3 });
    }
    return out.sort((a, b) => b.v - a.v);
  }

  private makeType(o: {
    geo: () => PlantRec;
    mode: number;
    height: number;
    flex: number;
    curve: number;
    max: number;
    maxOut: number;
    cand: number;
    clump: number;
    off: number;
    scale: [number, number];
    cast?: boolean;
    outCover: number;
    hab: (d: number) => boolean;
    surface?: boolean;
    fitDepth?: boolean;
    sink?: number;
    simDriven?: boolean;
  }): PlantType {
    const rec = o.geo();
    const { mat, depth } = this.swayMaterials(o.mode, o.height, o.flex, o.curve);
    const mesh = new THREE.InstancedMesh(rec.geo, mat, o.max + o.maxOut);
    mesh.customDepthMaterial = depth;
    mesh.castShadow = !!o.cast;
    mesh.receiveShadow = o.mode !== 2;
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    const t: PlantType = {
      mesh,
      mode: o.mode,
      max: o.max,
      maxOut: o.maxOut,
      cands: o.simDriven ? this.genCands(o.clump, o.off, o.scale, o.cand, false) : [],
      outCands: this.genCands(o.clump, o.off, o.scale, Math.round(o.cand * 2.2), true),
      outCover: o.outCover,
      hab: o.hab,
      surface: o.surface,
      fitDepth: o.fitDepth,
      sink: o.sink,
      simDriven: o.simDriven,
    };
    this.types.push(t);
    return t;
  }

  private buildPlants() {
    // Shore vegetation is scenery outside the playable square; the sim does not model it.
    this.makeType({ geo: cattailGeo, mode: 0, height: 0.62, flex: 0.11, curve: 2.0, max: 0, maxOut: 1400, cand: 9000, clump: 0.9, off: 7, scale: [0.8, 1.15], cast: true, outCover: 0.55, hab: (d) => d > -0.12 && d < 0.42 });
    this.makeType({ geo: phragGeo, mode: 0, height: 0.95, flex: 0.17, curve: 2.6, max: 0, maxOut: 1000, cand: 9000, clump: 0.7, off: 13, scale: [0.85, 1.2], cast: true, outCover: 0.4, hab: (d) => d > -0.32 && d < 0.3 });
    this.makeType({ geo: grassGeo, mode: 0, height: 0.2, flex: 0.07, curve: 1.5, max: 0, maxOut: 4500, cand: 4200, clump: 0.5, off: 1, scale: [0.75, 1.3], outCover: 0.7, hab: (d) => d < -0.07 });
    this.makeType({ geo: lilyGeo, mode: 1, height: 0.1, flex: 0, curve: 1, max: 0, maxOut: 500, cand: 5000, clump: 0.8, off: 19, scale: [0.8, 1.3], outCover: 0.45, hab: (d) => d > 0.32 && d < 1.3, surface: true });
    this.makeType({ geo: pebbleGeo, mode: 3, height: 0.1, flex: 0, curve: 1, max: 0, maxOut: 1200, cand: 9000, clump: 1.3, off: 41, scale: [0.7, 1.4], outCover: 0.6, hab: (d) => d > -0.14 && d < 0.16, sink: 0.012 });
    // Submerged plants inside the pond follow each tile's visible cover.
    this.submergedType = this.makeType({ geo: submergedGeo, mode: 2, height: 0.6, flex: 0.12, curve: 1.4, max: 1800, maxOut: 1500, cand: 9000, clump: 0.6, off: 23, scale: [0.9, 1.3], outCover: 0.5, hab: (d) => d > 0.22 && d < 2.1, fitDepth: true, simDriven: true });

    // Trees on dry land around the pond.
    const treeCands: { x: number; z: number; h: number; rot: number; s: number; conifer: boolean; v: number }[] = [];
    for (let tries = 0; tries < 6000 && treeCands.length < 500; tries++) {
      const x = -EXT + rand() * (this.NX + 2 * EXT);
      const z = -EXT + rand() * (this.NZ + 2 * EXT);
      if (x > -0.5 && x < this.NX + 0.5 && z > -0.5 && z < this.NZ + 0.5) continue;
      if (treeCands.some((t) => Math.hypot(t.x - x, t.z - z) < 0.85)) continue;
      treeCands.push({ x, z, h: this.H(x, z), rot: rand() * 6.283, s: 0.8 + rand() * 0.45, conifer: rand() < 0.55, v: fbm(x * 0.4 + 31, z * 0.4 + 5) + rand() * 0.25 });
    }
    treeCands.sort((a, b) => b.v - a.v);
    const valid = treeCands.filter((c) => -c.h < -0.2);
    const list = valid.slice(0, Math.round(0.22 * valid.length));
    for (const con of [true, false]) {
      const rec = con ? coniferGeo() : broadleafGeo();
      const { mat, depth } = this.swayMaterials(0, 1.45, 0.06, 2.0);
      const mine = list.filter((c) => c.conifer === con);
      const mesh = new THREE.InstancedMesh(rec.geo, mat, Math.max(1, mine.length));
      mesh.customDepthMaterial = depth;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mine.forEach((c, i) => this.setInst(mesh, i, c.x, c.h - 0.03, c.z, c.rot, c.s));
      mesh.count = mine.length;
      this.scene.add(mesh);
    }
  }

  private placePlants() {
    const perTile = Math.floor(this.submergedType.max / Math.max(1, this.state.tiles.length));
    for (const T of this.types) {
      let list: Cand[] = [];
      if (T.simDriven) {
        // Group candidates by tile and take each tile's visible share.
        for (const [ti, t] of this.state.tiles.entries()) {
          const mine = T.cands.filter((c) => this.tileAt(c.x, c.z) === ti && T.hab(-c.h));
          list = list.concat(mine.slice(0, Math.round(t.cover * Math.min(mine.length, perTile))));
        }
      }
      const vout = T.outCands.filter((c) => T.hab(-c.h));
      list = list.concat(vout.slice(0, Math.round(T.outCover * Math.min(vout.length, T.maxOut))));
      list.forEach((c, i) => {
        const d = -c.h;
        if (T.surface) this.setInst(T.mesh, i, c.x, 0.008, c.z, c.rot, c.s);
        else if (T.fitDepth) this.setInst(T.mesh, i, c.x, c.h - 0.02, c.z, c.rot, c.s, Math.max(0.3, Math.min(2.2, (d * 0.85) / 0.6)), c.s);
        else this.setInst(T.mesh, i, c.x, c.h - (T.sink ?? 0.02), c.z, c.rot, c.s);
      });
      T.mesh.count = list.length;
      T.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /* ---------------- Fish ---------------- */

  private buildFish(): THREE.InstancedMesh {
    const rec = fishGeo();
    const mesh = new THREE.InstancedMesh(rec.geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 300);
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    return mesh;
  }

  private fishValid(x: number, z: number, tile: number) {
    const t = this.state.tiles[tile];
    const x0 = t.col * TILE;
    const z0 = t.row * TILE;
    if (x < x0 + 0.15 || z < z0 + 0.15 || x > x0 + TILE - 0.15 || z > z0 + TILE - 0.15) return false;
    return -this.H(x, z) > 0.22;
  }

  private rebuildFish() {
    this.schools = [];
    this.state.tiles.forEach((t, ti) => {
      if (t.fishShown <= 0.001) return;
      const n = Math.round(3 + t.fishShown * 11);
      const cx = (t.col + 0.5) * TILE;
      const cz = (t.row + 0.5) * TILE;
      const members: Fish[] = [];
      for (let k = 0; k < n; k++) {
        const a = rand() * 6.283;
        members.push({ x: cx + (rand() - 0.5) * 0.6, z: cz + (rand() - 0.5) * 0.6, vx: Math.cos(a) * 0.3, vz: Math.sin(a) * 0.3, s: 1.25 + rand() * 0.4, ph: rand() * 6.28 });
      }
      this.schools.push({ tile: ti, members, tx: cx, tz: cz, timer: 0 });
    });
  }

  private updateFish(dt: number, t: number) {
    let idx = 0;
    const TRY = [0.6, -0.6, 1.2, -1.2, 2.0, -2.0, Math.PI];
    for (const sc of this.schools) {
      const tile = this.state.tiles[sc.tile];
      let cx = 0;
      let cz = 0;
      let avx = 0;
      let avz = 0;
      for (const f of sc.members) {
        cx += f.x;
        cz += f.z;
        avx += f.vx;
        avz += f.vz;
      }
      const n = sc.members.length;
      cx /= n;
      cz /= n;
      avx /= n;
      avz /= n;
      sc.timer += dt;
      if (Math.hypot(cx - sc.tx, cz - sc.tz) < 0.7 || sc.timer > 12) {
        sc.tx = tile.col * TILE + 0.6 + rand() * (TILE - 1.2);
        sc.tz = tile.row * TILE + 0.6 + rand() * (TILE - 1.2);
        sc.timer = 0;
      }
      for (const f of sc.members) {
        if (dt > 0) {
          let ax = (cx - f.x) * 0.9 + (avx - f.vx) * 0.9;
          let az = (cz - f.z) * 0.9 + (avz - f.vz) * 0.9;
          const tdx = sc.tx - f.x;
          const tdz = sc.tz - f.z;
          const tl = Math.hypot(tdx, tdz) || 1;
          ax += (tdx / tl) * 0.35;
          az += (tdz / tl) * 0.35;
          for (const o of sc.members) {
            if (o === f) continue;
            const dx = f.x - o.x;
            const dz = f.z - o.z;
            const d = Math.hypot(dx, dz);
            if (d < 0.14 && d > 1e-4) {
              ax += (dx / d) * (0.14 - d) * 14;
              az += (dz / d) * (0.14 - d) * 14;
            }
          }
          ax += (rand() - 0.5) * 0.8;
          az += (rand() - 0.5) * 0.8;
          f.vx += ax * dt;
          f.vz += az * dt;
          let sp = Math.hypot(f.vx, f.vz);
          const cl = Math.min(0.5, Math.max(0.18, sp));
          f.vx *= cl / sp;
          f.vz *= cl / sp;
          sp = cl;
          if (!this.fishValid(f.x + (f.vx / sp) * 0.3, f.z + (f.vz / sp) * 0.3, sc.tile)) {
            const base = Math.atan2(f.vz, f.vx);
            for (const da of TRY) {
              const a = base + da;
              if (this.fishValid(f.x + Math.cos(a) * 0.3, f.z + Math.sin(a) * 0.3, sc.tile)) {
                f.vx = Math.cos(a) * sp;
                f.vz = Math.sin(a) * sp;
                break;
              }
            }
          }
          const nx = f.x + f.vx * dt;
          const nz = f.z + f.vz * dt;
          if (this.fishValid(nx, nz, sc.tile)) {
            f.x = nx;
            f.z = nz;
          } else {
            f.vx = -f.vx;
            f.vz = -f.vz;
          }
        }
        const depth = -this.H(f.x, f.z);
        const y = -Math.min(0.2, depth * 0.45) + Math.sin(t * 1.3 + f.ph) * 0.01;
        const yaw = Math.atan2(f.vx, f.vz) + Math.sin(t * 9 + f.ph) * 0.14;
        this.setInst(this.fishMesh, idx++, f.x, y, f.z, yaw, f.s);
      }
    }
    this.fishMesh.count = idx;
    this.fishMesh.instanceMatrix.needsUpdate = true;

    // Ripples and silt plumes: the visible sign of fish, shown with or without a survey.
    if (dt <= 0) return;
    const swirl = this.waterU.uSwirl.value as THREE.Vector4[];
    this.state.tiles.forEach((tile, ti) => {
      if (tile.fishCue <= 0.02) return;
      this.ripTimers[ti] = (this.ripTimers[ti] ?? rand() * 0.5) - dt;
      if (this.ripTimers[ti] > 0) return;
      this.ripTimers[ti] = (1.8 + rand() * 2.6) / (0.3 + 1.6 * tile.fishCue);
      let x = tile.col * TILE + 0.4 + rand() * (TILE - 0.8);
      let z = tile.row * TILE + 0.4 + rand() * (TILE - 0.8);
      const sc = this.schools.find((s) => s.tile === ti);
      if (sc) {
        const f = sc.members[Math.floor(rand() * sc.members.length)];
        x = f.x;
        z = f.z;
      }
      swirl[this.ripIdx].set(x - this.HX, z - this.HZ, (0.5 + 0.7 * tile.fishCue) * (0.7 + rand() * 0.6), t);
      this.ripIdx = (this.ripIdx + 1) % MAX_SWIRL;
    });
  }

  /* ---------------- Flow and drifting specks ---------------- */

  private rebuildFlow() {
    const { FNX, FR, WMIN } = this;
    const FH = 1 / FR;
    const depth = new Float32Array(FNX * FNX);
    for (let j = 0; j < FNX; j++) for (let i = 0; i < FNX; i++) depth[j * FNX + i] = -this.H(WMIN + (i + 0.5) * FH, WMIN + (j + 0.5) * FH);
    // Inflow and outflow are the world-edge cells of the inlet and outlet channels.
    const westIn = this.state.inlets.some((b) => b.face === 'W');
    this.flow = solveSteadyFlow({
      nx: FNX,
      nz: FNX,
      depth,
      isInflow: (i) => (westIn ? i === 0 : i === FNX - 1),
      isOutflow: (i) => (westIn ? i === FNX - 1 : i === 0),
      Q: 0.1 * this.state.discharge,
      h: FH,
    });
    const vmax = Math.max(0.05, this.flow.speedMax);
    for (let k = 0; k < FNX * FNX; k++) {
      this.flowData[k * 4] = Math.round(127 + Math.max(-1, Math.min(1, this.flow.vx[k] / vmax)) * 127);
      this.flowData[k * 4 + 1] = Math.round(127 + Math.max(-1, Math.min(1, this.flow.vz[k] / vmax)) * 127);
      this.flowData[k * 4 + 3] = 255;
    }
    this.flowTex.needsUpdate = true;
    (this.shared.uFlowRect.value as THREE.Vector4).w = vmax;
  }

  private flowAtCPU(x: number, z: number) {
    const out = { x: 0, z: 0 };
    if (!this.flow) return out;
    const { FNX, FR, WMIN } = this;
    const fx = (x - WMIN) * FR - 0.5;
    const fz = (z - WMIN) * FR - 0.5;
    const i0 = Math.max(0, Math.min(FNX - 2, Math.floor(fx)));
    const j0 = Math.max(0, Math.min(FNX - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - i0));
    const tz = Math.max(0, Math.min(1, fz - j0));
    const k = j0 * FNX + i0;
    const w = [(1 - tx) * (1 - tz), tx * (1 - tz), (1 - tx) * tz, tx * tz];
    const ks = [k, k + 1, k + FNX, k + FNX + 1];
    for (let q = 0; q < 4; q++) {
      out.x += this.flow.vx[ks[q]] * w[q];
      out.z += this.flow.vz[ks[q]] * w[q];
    }
    return out;
  }

  private buildSpecks() {
    const defs: [string, number, [number, number, number][]][] = [
      ['duckweed', 200, [[0, 0, 0.017], [0.025, 0.008, 0.014], [0.006, 0.026, 0.012]]],
      ['foam', 110, [[0, 0, 0.012], [0.016, 0.006, 0.008]]],
    ];
    for (const [tok, count, discs] of defs) {
      const rec = buildPlant(discs.map(([x, z, r]) => [xf(new THREE.CircleGeometry(r, 6), [x, 0, z], [-Math.PI / 2, 0, 0]), tok] as [THREE.BufferGeometry, string]));
      const { mat } = this.swayMaterials(4, 0.1, 0, 1);
      const mesh = new THREE.InstancedMesh(rec.geo, mat, count);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      const parts = Array.from({ length: count }, () => ({ x: 0, z: 0, age: 0, life: 0, rot: rand() * 6.28, s: 0.8 + rand() * 0.5, wa: rand() * 6.28 }));
      parts.forEach((p) => this.spawnSpeck(p, true));
      this.specks.push({ mesh, parts });
    }
  }

  private spawnSpeck(p: { x: number; z: number; age: number; life: number }, init: boolean) {
    const PAD = 3;
    for (let t = 0; t < 30; t++) {
      const x = -PAD + rand() * (this.NX + 2 * PAD);
      const z = -PAD + rand() * (this.NZ + 2 * PAD);
      if (-this.H(x, z) > 0.08) {
        p.x = x;
        p.z = z;
        p.life = 15 + rand() * 25;
        p.age = init ? rand() * p.life : 0;
        return;
      }
    }
    p.life = 0;
    p.age = 0;
  }

  private updateSpecks(dt: number) {
    const PAD = 3;
    for (const sp of this.specks) {
      sp.parts.forEach((p, i) => {
        if (dt > 0) {
          const v = this.flowAtCPU(p.x, p.z);
          p.wa += (rand() - 0.5) * 2.0 * dt;
          p.x += (v.x + Math.cos(p.wa) * 0.012) * dt;
          p.z += (v.z + Math.sin(p.wa) * 0.012) * dt;
          p.rot += 0.05 * dt;
          p.age += dt;
          if (p.age > p.life || -this.H(p.x, p.z) < 0.04 || p.x < -PAD || p.z < -PAD || p.x > this.NX + PAD || p.z > this.NZ + PAD) this.spawnSpeck(p, false);
        }
        const f = p.life > 0 ? Math.max(0.001, Math.min(1, p.age / 1.5, (p.life - p.age) / 1.5)) : 0.001;
        this.setInst(sp.mesh, i, p.x, 0.012, p.z, p.rot, f * p.s);
      });
      sp.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /* ---------------- Grid, selection, barrier ---------------- */

  private gridLines(): THREE.LineSegments {
    const p: number[] = [];
    const st = 0.25;
    for (let c = 1; c < this.NX / TILE; c++) {
      const x = c * TILE;
      for (let s = 0; s < this.NZ; s += st) p.push(x - this.HX, this.surfY(x, s), s - this.HZ, x - this.HX, this.surfY(x, s + st), s + st - this.HZ);
    }
    for (let r = 1; r < this.NZ / TILE; r++) {
      const z = r * TILE;
      for (let s = 0; s < this.NX; s += st) p.push(s - this.HX, this.surfY(s, z), z - this.HZ, s + st - this.HX, this.surfY(s + st, z), z - this.HZ);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false }));
    lines.renderOrder = 4;
    return lines;
  }

  /** A closed path around a rectangle, as [x, z, outward nx, outward nz] samples. */
  private borderPath(x0: number, z0: number, w: number, d: number): [number, number, number, number][] {
    const out: [number, number, number, number][] = [];
    const sides: [number, number, number, number, number, number, number][] = [
      [x0, z0, 1, 0, 0, -1, w],
      [x0 + w, z0, 0, 1, 1, 0, d],
      [x0 + w, z0 + d, -1, 0, 0, 1, w],
      [x0, z0 + d, 0, -1, -1, 0, d],
    ];
    for (const [sx, sz, dx, dz, nx, nz, len] of sides) for (let t = 0; t < len; t += 0.1) out.push([sx + dx * t, sz + dz * t, nx, nz]);
    return out;
  }

  /** A thin bright band draped on the surface along a closed path. */
  private strip(path: [number, number, number, number][], w: number, color: number, order: number): THREE.Mesh {
    const mesh = new THREE.Mesh(this.stripGeo(path, w), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: order < 5 }));
    mesh.renderOrder = order;
    return mesh;
  }

  private stripGeo(path: [number, number, number, number][], w: number): THREE.BufferGeometry {
    const b: number[] = [];
    const sy = (x: number, z: number) => this.surfY(x, z) + 0.03;
    for (let i = 0; i < path.length; i++) {
      const [ax, az, anx, anz] = path[i];
      const [bx, bz, bnx, bnz] = path[(i + 1) % path.length];
      const q = [
        [ax - anx * w, az - anz * w],
        [bx - bnx * w, bz - bnz * w],
        [bx + bnx * w, bz + bnz * w],
        [ax + anx * w, az + anz * w],
      ];
      for (const k of [0, 1, 2, 0, 2, 3]) b.push(q[k][0] - this.HX, sy(q[k][0], q[k][1]), q[k][1] - this.HZ);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b, 3));
    return g;
  }

  private setSelected(id: string) {
    const t = this.state.tiles.find((x) => x.id === id);
    if (!t) return;
    this.selStrip.geometry.dispose();
    this.selStrip.geometry = this.stripGeo(this.borderPath(t.col * TILE + 0.12, t.row * TILE + 0.12, TILE - 0.24, TILE - 0.24), 0.05);
  }

  private setHover(i: number | null) {
    this.hover = i;
    if (i === null) {
      this.hoverLoop.visible = false;
      this.hudTile.textContent = 'Hover a tile';
      this.hudInfo.textContent = 'Shows observable state only';
      return;
    }
    const t = this.state.tiles[i];
    const x0 = t.col * TILE;
    const z0 = t.row * TILE;
    const p: number[] = [];
    const y = (x: number, z: number) => this.surfY(x, z) + 0.02;
    for (let s = 0; s < TILE; s += 0.2) p.push(x0 + s - this.HX, y(x0 + s, z0), z0 - this.HZ);
    for (let s = 0; s < TILE; s += 0.2) p.push(x0 + TILE - this.HX, y(x0 + TILE, z0 + s), z0 + s - this.HZ);
    for (let s = TILE; s > 0; s -= 0.2) p.push(x0 + s - this.HX, y(x0 + s, z0 + TILE), z0 + TILE - this.HZ);
    for (let s = TILE; s > 0; s -= 0.2) p.push(x0 - this.HX, y(x0, z0 + s), z0 + s - this.HZ);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    this.hoverLoop.geometry.dispose();
    this.hoverLoop.geometry = g;
    this.hoverLoop.visible = true;
    this.hudTile.textContent = `Tile ${t.id} · ${t.description}`;
    this.hudInfo.textContent = `water depth ${t.depth.toFixed(1)} m (gauge)${t.overlay ? ` · ${t.overlay.label.replace(/<[^>]+>/g, '')}` : ''}`;
  }

  private buildBarrier(state: SceneState['barrier']) {
    this.barrierGroup.clear();
    if (state === 'none') return;
    const inlet = this.state.inlets[0];
    const t = this.state.tiles.find((x) => x.id === inlet.tile)!;
    // Posts across the inlet channel just outside the pond, plus a mesh screen once built.
    const along = inlet.face === 'W' || inlet.face === 'E';
    const cx = inlet.face === 'W' ? -1.6 : inlet.face === 'E' ? this.NX + 1.6 : (t.col + 0.5) * TILE;
    const cz = inlet.face === 'N' ? -1.6 : inlet.face === 'S' ? this.NZ + 1.6 : (t.row + 0.5) * TILE;
    const post = new THREE.MeshLambertMaterial({ color: COL.bark });
    for (let k = -2; k <= 2; k++) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.75, 6), post);
      m.position.set(cx + (along ? 0 : k * 0.35) - this.HX, 0.05, cz + (along ? k * 0.35 : 0) - this.HZ);
      m.castShadow = true;
      this.barrierGroup.add(m);
    }
    if (state === 'in_place') {
      const screen = new THREE.Mesh(
        new THREE.PlaneGeometry(1.5, 0.5),
        new THREE.MeshLambertMaterial({ color: COL.barrier, transparent: true, opacity: 0.75, side: THREE.DoubleSide }),
      );
      screen.position.set(cx - this.HX, 0.12, cz - this.HZ);
      if (along) screen.rotation.y = Math.PI / 2;
      this.barrierGroup.add(screen);
    }
  }

  private buildBoundaryLabels() {
    for (const b of this.boundaryLabels) b.el.remove();
    this.boundaryLabels = [];
    const place = (b: SceneBoundary, kind: 'in' | 'out') => {
      const t = this.state.tiles.find((x) => x.id === b.tile)!;
      const off = 4.2;
      const x = b.face === 'W' ? -off : b.face === 'E' ? this.NX + off : (t.col + 0.5) * TILE;
      const z = b.face === 'N' ? -off : b.face === 'S' ? this.NZ + off : (t.row + 0.5) * TILE;
      const el = document.createElement('div');
      el.className = `s-bnd ${kind}`;
      el.innerHTML = `<div class="t">${b.name}</div>${b.lines.map((l) => `<div>${l}</div>`).join('')}`;
      this.labelLayer.appendChild(el);
      this.boundaryLabels.push({ el, x, z });
    };
    this.state.inlets.forEach((b) => place(b, 'in'));
    this.state.outlets.forEach((b) => place(b, 'out'));
  }

  /* ---------------- Input ---------------- */

  private bindPointer() {
    const ray = new THREE.Raycaster();
    const ptr = new THREE.Vector2();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    const pick = (ev: PointerEvent): number | null => {
      const r = this.canvas.getBoundingClientRect();
      ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ptr, this.camera);
      if (!ray.ray.intersectPlane(plane, hit)) return null;
      return this.tileAt(hit.x + this.HX, hit.z + this.HZ);
    };
    let down: { x: number; y: number } | null = null;
    this.canvas.addEventListener('pointermove', (ev) => {
      const i = pick(ev);
      if (i !== this.hover) this.setHover(i);
      this.canvas.style.cursor = i === null ? 'grab' : 'pointer';
    });
    this.canvas.addEventListener('pointerleave', () => this.setHover(null));
    this.canvas.addEventListener('pointerdown', (ev) => (down = { x: ev.clientX, y: ev.clientY }));
    this.canvas.addEventListener('pointerup', (ev) => {
      // A click, not a drag to rotate.
      if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 5) {
        const i = pick(ev);
        if (i !== null) this.onTile(this.state.tiles[i].id);
      }
      down = null;
    });
  }

  /* ---------------- Loop ---------------- */

  private frame(now: number) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const step = this.paused ? 0 : dt;
    this.time += step;
    this.shared.uTime.value = this.time;
    this.updateFish(step, this.time);
    this.updateSpecks(step);
    this.controls.update();
    this.updateCompass();
    const vd = new THREE.Vector3();
    this.camera.getWorldDirection(vd);
    (this.waterU.uViewDir.value as THREE.Vector3).copy(vd).negate();
    this.renderer.render(this.scene, this.camera);
    this.positionLabels();
  }

  private project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    _v.set(x - this.HX, y, z - this.HZ).project(this.camera);
    return { x: ((_v.x + 1) / 2) * this.element.clientWidth, y: ((1 - _v.y) / 2) * this.element.clientHeight, visible: _v.z < 1 };
  }

  private positionLabels() {
    this.state.tiles.forEach((t, i) => {
      const p = this.project((t.col + 0.5) * TILE, 0.1, (t.row + 0.5) * TILE);
      this.tileLabels[i].style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%)`;
    });
    for (const b of this.boundaryLabels) {
      const p = this.project(b.x, 0.3, b.z);
      b.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%)`;
    }
  }

  private lastCompass: number | null = null;
  private updateCompass() {
    const a = new THREE.Vector3(0, 0, 0).project(this.camera);
    const b = new THREE.Vector3(0, 0, -1).project(this.camera);
    const dx = (b.x - a.x) * this.element.clientWidth;
    const dy = -(b.y - a.y) * this.element.clientHeight;
    const ang = Math.atan2(dx, -dy);
    if (this.lastCompass !== null && Math.abs(ang - this.lastCompass) < 1e-4) return;
    this.lastCompass = ang;
    this.needle.setAttribute('transform', `rotate(${(ang * 180) / Math.PI})`);
    this.cLetters.forEach((el, k) => {
      const t = ang + (k * Math.PI) / 2;
      el.setAttribute('x', (Math.sin(t) * 25).toFixed(2));
      el.setAttribute('y', (-Math.cos(t) * 25).toFixed(2));
    });
  }
}
