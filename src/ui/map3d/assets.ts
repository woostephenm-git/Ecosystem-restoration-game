// Art assets for the 3D map, ported from the Marsh Specimen Bench artifact:
// OKLCH palette tokens, shared shader code, and procedural plant geometry.
import * as THREE from 'three';

/* ---------------- Palette ---------------- */
/** OKLCH [L, C, h]. The sky is lightened from the bench for the map's light theme. */
export const TOKENS: Record<string, [number, number, number]> = {
  sky: [0.93, 0.02, 230],
  grass_lt: [0.76, 0.15, 128],
  grass_md: [0.66, 0.15, 134],
  grass_dk: [0.53, 0.125, 140],
  wet_meadow: [0.57, 0.095, 112],
  mud: [0.52, 0.06, 72],
  sediment: [0.45, 0.05, 66],
  sediment_deep: [0.33, 0.04, 58],
  soil: [0.47, 0.085, 52],
  soil_dk: [0.37, 0.07, 46],
  rock: [0.48, 0.02, 255],
  bark: [0.43, 0.075, 50],
  conifer: [0.66, 0.15, 138],
  conifer_dk: [0.48, 0.115, 146],
  broadleaf: [0.72, 0.155, 122],
  broadleaf_dk: [0.53, 0.125, 132],
  water_shallow: [0.74, 0.115, 205],
  water_deep: [0.47, 0.11, 238],
  water_turbid: [0.6, 0.09, 72], // milky tea, warmer than the bench
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
};
const CHROMA = 0.95;
export const COL: Record<string, THREE.Color> = {};

function oklchToLinear(L: number, C: number, h: number): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v))) as [number, number, number];
}
for (const [k, [L, C, h]] of Object.entries(TOKENS)) {
  const [r, g, b] = oklchToLinear(L, C * CHROMA, h);
  COL[k] = new THREE.Color().setRGB(r, g, b);
}

/* ---------------- Seeded randomness for visuals only ---------------- */
export const rand = (() => {
  let a = 1337;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();
export function hash2(x: number, y: number) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
export function vnoise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x: number, y: number) {
  return 0.5 * vnoise(x, y) + 0.3 * vnoise(x * 2.1 + 5.2, y * 2.1 + 1.3) + 0.2 * vnoise(x * 4.3 + 9.1, y * 4.3 + 3.7);
}
export function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/* ---------------- Shared shader code ---------------- */
export function sharedUniforms(half: number) {
  return {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindStrength: { value: 0.45 },
    uGust: { value: 0.5 },
    uWaveAmp: { value: 0.04 },
    uFogCol: { value: new THREE.Color() },
    uHalf: { value: half },
    uFlowTex: { value: null as THREE.Texture | null },
    uFlowRect: { value: new THREE.Vector4(0, 0, 1, 0.1) },
  };
}
export type Shared = ReturnType<typeof sharedUniforms>;

/** Everything outside the playable square is desaturated, dimmed and fades into the background. */
export const OUT_FRAG = `
uniform vec3 uFogCol; uniform float uHalf;
vec3 outsideFx(vec3 c, vec2 p){
  float o = max(abs(p.x), abs(p.y)) - uHalf;
  float out1 = smoothstep(0.0, 0.2, o);
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 g = mix(c, vec3(l), 0.72 * out1) * mix(1.0, 0.8, out1);
  float fog = smoothstep(0.5, 15.0, o);
  return mix(g, uFogCol, fog);
}`;
export function injectOutsideFrag(sh: THREE.WebGLProgramParametersWithUniforms) {
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vPlayW;\n' + OUT_FRAG)
    .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.rgb = outsideFx(gl_FragColor.rgb, vPlayW);');
}
export const GLSL_COMMON = `
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
function swayProject(mode: number) {
  return `
    vec4 wp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
    vec4 root = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float hn = clamp((wp.y - root.y) / uHeight, 0.0, 1.2);
    float ph = hash21(root.xz*3.17) * 6.2831;
    ${SWAY[mode]}
    vPlayW = root.xz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;`;
}
function patchSway(mat: THREE.Material, shared: Shared, mode: number, local: Record<string, { value: number }>, isDepth = false) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared, local);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + GLSL_COMMON + '\nuniform float uHeight; uniform float uFlex; uniform float uCurve; varying vec2 vPlayW;')
      .replace('#include <project_vertex>', swayProject(mode));
    if (!isDepth) injectOutsideFrag(sh);
  };
  mat.customProgramCacheKey = () => 'sway' + mode + (isDepth ? 'd' : '');
}
export function swayMaterials(shared: Shared, mode: number, height: number, flex: number, curve: number) {
  const local = { uHeight: { value: height }, uFlex: { value: flex }, uCurve: { value: curve } };
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  patchSway(mat, shared, mode, local);
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  patchSway(depth, shared, mode, local, true);
  return { mat, depth };
}

/* ---------------- Geometry helpers ---------------- */
type Spine = [number, number, number, number][];
function ribbon(spine: Spine) {
  const pos: number[] = [];
  for (let k = 0; k < spine.length - 1; k++) {
    const [x0, y0, z0, w0] = spine[k], [x1, y1, z1, w1] = spine[k + 1];
    pos.push(x0 - w0, y0, z0, x0 + w0, y0, z0, x1 + w1, y1, z1, x0 - w0, y0, z0, x1 + w1, y1, z1, x1 - w1, y1, z1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
type V3 = [number, number, number];
function xf(geo: THREE.BufferGeometry, t: V3 = [0, 0, 0], r: V3 = [0, 0, 0], s: V3 = [1, 1, 1]) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  _m.compose(_v.set(...t), _q.setFromEuler(_e.set(...r)), _s.set(...s));
  return g.applyMatrix4(_m);
}
function cyl(rt: number, rb: number, h: number, seg = 5) {
  return new THREE.CylinderGeometry(rt, rb, h, seg).translate(0, h / 2, 0);
}

export interface PlantRec {
  geo: THREE.BufferGeometry;
  ta: string[];
  tb: string[];
  tt: number[];
}
type Part = [THREE.BufferGeometry, string, string?];
function buildPlant(parts: Part[]): PlantRec {
  const pos: number[] = [], ta: string[] = [], tb: string[] = [], tt: number[] = [];
  for (const [geo, a, b] of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.computeBoundingBox();
    const { min, max } = g.boundingBox!, arr = g.attributes.position.array, span = max.y - min.y;
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
  const rec = { geo, ta, tb, tt };
  const c = geo.attributes.color as THREE.BufferAttribute;
  const col = new THREE.Color();
  for (let i = 0; i < ta.length; i++) {
    col.copy(COL[ta[i]]).lerp(COL[tb[i]], tt[i]);
    c.setXYZ(i, col.r, col.g, col.b);
  }
  return rec;
}

export function grassGeo() {
  const parts: Part[] = [];
  for (let k = 0; k < 6; k++) {
    const h = 0.13 + rand() * 0.07, lean = 0.04 + rand() * 0.05;
    parts.push([xf(ribbon([[0, 0, 0, 0.022], [0, h * 0.5, lean * 0.4, 0.016], [0, h, lean, 0]]), [(rand() - 0.5) * 0.06, 0, (rand() - 0.5) * 0.06], [0, k * 1.05 + rand(), 0]), 'grass_dk', 'grass_lt']);
  }
  return buildPlant(parts);
}
export function cattailGeo() {
  const parts: Part[] = [];
  for (let k = 0; k < 5; k++) {
    const h = 0.48 + rand() * 0.16, lean = 0.12 + rand() * 0.14;
    parts.push([xf(ribbon([[0, 0, 0, 0.026], [0, h * 0.5, lean * 0.25, 0.022], [0, h * 0.85, lean * 0.65, 0.012], [0, h, lean, 0]]), [0, 0, 0], [0, k * 1.26 + rand() * 0.5, 0]), 'cattail_leaf', 'phrag_stem']);
  }
  for (const [ox, oz, h] of [[0.015, 0.01, 0.62], [-0.03, -0.02, 0.54]]) {
    parts.push([xf(cyl(0.007, 0.009, h, 4), [ox, 0, oz]), 'cattail_leaf']);
    parts.push([xf(cyl(0.024, 0.024, 0.1, 6), [ox, h - 0.16, oz]), 'cattail_head']);
    parts.push([xf(cyl(0.003, 0.004, 0.07, 3), [ox, h - 0.06, oz]), 'phrag_stem']);
  }
  return buildPlant(parts);
}
export function phragGeo() {
  const parts: Part[] = [];
  for (const [ox, oz, h] of [[0, 0, 0.95], [0.05, 0.03, 0.86], [-0.04, 0.04, 0.9]]) {
    parts.push([xf(cyl(0.006, 0.009, h, 4), [ox, 0, oz]), 'phrag_stem']);
    for (let k = 0; k < 4; k++) {
      const y = 0.22 + k * 0.16;
      parts.push([xf(ribbon([[0, 0, 0, 0.02], [0, 0.05, 0.12, 0.014], [0, 0.02, 0.22, 0]]), [ox, y, oz], [0, rand() * 6.28, 0]), 'phrag_stem', 'cattail_leaf']);
    }
    parts.push([xf(new THREE.ConeGeometry(0.05, 0.22, 5), [ox + 0.03, h - 0.02, oz], [Math.PI, 0, 0.45]), 'phrag_plume', 'phrag_stem']);
  }
  return buildPlant(parts);
}
export function lilyGeo() {
  const parts: Part[] = [];
  for (const [ox, oz, r, rot] of [[0, 0, 0.1, 0], [0.15, 0.05, 0.08, 2], [-0.06, 0.14, 0.065, 4]]) {
    parts.push([xf(new THREE.CircleGeometry(r, 10, 0.3, Math.PI * 2 - 0.6), [ox, 0, oz], [-Math.PI / 2, 0, rot]), 'lily_pad']);
  }
  return buildPlant(parts);
}
export function lilyFlowerGeo() {
  return buildPlant([
    [xf(new THREE.ConeGeometry(0.045, 0.04, 7, 1, true), [0.02, 0.025, 0.02], [Math.PI, 0, 0]), 'lily_flower'],
    [xf(new THREE.ConeGeometry(0.03, 0.035, 7, 1, true), [0.02, 0.035, 0.02], [Math.PI, 0.4, 0]), 'lily_flower'],
    [xf(new THREE.IcosahedronGeometry(0.012, 0), [0.02, 0.03, 0.02]), 'lily_center'],
  ]);
}
export function submergedGeo() {
  const parts: Part[] = [];
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
export function pebbleGeo() {
  const parts: Part[] = [];
  const n = 3 + Math.floor(rand() * 3);
  for (let k = 0; k < n; k++) {
    const r = 0.022 + rand() * 0.03;
    parts.push([xf(new THREE.IcosahedronGeometry(r, 0), [(rand() - 0.5) * 0.18, r * 0.35, (rand() - 0.5) * 0.18], [rand() * 3, rand() * 3, rand() * 3], [1.2, 0.55, 1]), rand() < 0.5 ? 'pebble' : 'pebble_dk', 'pebble']);
  }
  return buildPlant(parts);
}
export function coniferGeo() {
  return buildPlant([
    [xf(cyl(0.045, 0.07, 0.55, 5)), 'bark'],
    [xf(new THREE.ConeGeometry(0.4, 0.6, 7), [0, 0.68, 0]), 'conifer_dk', 'conifer'],
    [xf(new THREE.ConeGeometry(0.31, 0.52, 7), [0, 0.98, 0], [0, 0.4, 0]), 'conifer_dk', 'conifer'],
    [xf(new THREE.ConeGeometry(0.2, 0.42, 7), [0, 1.26, 0], [0, 0.8, 0]), 'conifer_dk', 'conifer'],
  ]);
}
export function broadleafGeo() {
  return buildPlant([
    [xf(cyl(0.05, 0.075, 0.62, 5)), 'bark'],
    [xf(new THREE.IcosahedronGeometry(0.38, 0), [0, 0.95, 0], [0.3, 0.2, 0], [1, 1.1, 1]), 'broadleaf_dk', 'broadleaf'],
    [xf(new THREE.IcosahedronGeometry(0.24, 0), [0.2, 1.22, 0.08], [0.5, 0, 0.2]), 'broadleaf_dk', 'broadleaf'],
  ]);
}
export function fishGeo() {
  const tail = new THREE.BufferGeometry();
  tail.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.07, 0, 0.04, -0.13, 0, -0.04, -0.13], 3));
  return buildPlant([
    [xf(new THREE.OctahedronGeometry(0.05, 0), [0, 0, 0], [0, 0, 0], [0.55, 0.7, 1.7]), 'fish_belly', 'fish'],
    [xf(ribbon([[0, -0.03, 0, 0], [0, 0.03, 0, 0]])), 'fish'],
    [tail, 'fish'],
  ]);
}
export function speckGeo(tok: string, discs: [number, number, number][]) {
  return buildPlant(discs.map(([x, z, r]) => [xf(new THREE.CircleGeometry(r, 6), [x, 0, z], [-Math.PI / 2, 0, 0]), tok] as Part));
}
