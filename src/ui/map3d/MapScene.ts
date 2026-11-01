// The 3D map view, built on the Marsh Specimen Bench renderer. It draws only what the
// game hands it (observable tile state and knowledge), never the simulation's true state.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Terrain } from '../../sim/schema';
import {
  COL,
  GLSL_COMMON,
  OUT_FRAG,
  broadleafGeo,
  cattailGeo,
  coniferGeo,
  fbm,
  fishGeo,
  hash2,
  injectOutsideFrag,
  lilyFlowerGeo,
  lilyGeo,
  pebbleGeo,
  phragGeo,
  rand,
  sharedUniforms,
  smooth,
  speckGeo,
  submergedGeo,
  swayMaterials,
  grassGeo,
} from './assets';

export interface TileView {
  id: string;
  row: number;
  col: number;
  /** Part of the simulated pond. */
  water: boolean;
  /** Visible murk, 0 (clear) to 1 (opaque); null when the tile is not pond. */
  turbidity: number | null;
  /** Visible submerged plant cover, 0 to 1. */
  cover: number;
  /** Measured carp biomass (kg/ha) once surveyed; fish are only drawn then. */
  carpMeasured: number | null;
  /** Knowledge overlay for this tile, or null when no overlay is shown. */
  overlay: { color: string; state: 'unknown' | 'estimate' | 'measured' } | null;
  /** Hover readout lines. */
  title: string;
  info: string;
}

export interface MapViewState {
  tiles: TileView[];
  focus: string | null;
  selection: string[];
  windSpeed: number;
  flowOverlay: boolean;
  /** Net water flow on each tile (map units), from the simulation. */
  flow: { x: number; z: number }[];
  /** Land runoff target per tile: index, -1 for a pit, null for water. */
  runoff: (number | null)[];
  boundaries: { tile: string; face: 'N' | 'E' | 'S' | 'W'; name: string; kind: 'in' | 'out' }[];
  barrier: 'none' | 'building' | 'built';
}

export interface MapCallbacks {
  /** Tiles picked: 'replace' for a plain click, 'add' for Shift-click or Shift-drag. */
  onSelect(tileIds: string[], mode: 'replace' | 'add'): void;
  /** Double-click or Enter on a tile. */
  onOpen(tileId: string): void;
}

const VIEW_H = 15.5;
const START_CAMERA = new THREE.Vector3(18, 18, 18);
/** Opening zoom: frames the playable square rather than the whole backdrop. */
const START_ZOOM = 1.35;

export class MapScene {
  readonly element: HTMLDivElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  private readonly controls: OrbitControls;
  private readonly canvas: HTMLCanvasElement;
  private readonly N: number;
  private readonly HALF: number;
  private readonly WL: number;
  private readonly shared;
  private readonly sun: THREE.DirectionalLight;
  private view: MapViewState | null = null;
  private tileIndex = new Map<string, number>();
  private time = 0;
  private last = performance.now();
  private lowQuality = false;
  private autoQuality = true;
  private frameTimes: number[] = [];

  constructor(
    private readonly terrain: Terrain,
    private readonly cb: MapCallbacks,
  ) {
    this.N = terrain.playable;
    this.HALF = this.N / 2;
    this.WL = terrain.water_level;
    this.shared = sharedUniforms(this.HALF);

    this.element = document.createElement('div');
    this.element.className = 'stage3d';
    this.element.innerHTML = `
      <canvas tabindex="0" aria-label="3D map of Clearwater Pond. Arrow keys move between tiles, Enter investigates, Shift adds tiles to the selection."></canvas>
      <div class="hud" aria-live="polite"><div class="hud-tile">Hover or use arrow keys to inspect a tile</div><div class="hud-info">Shows observable state only</div></div>
      <div class="map-hint">Drag to rotate · Scroll to zoom · Click a tile, click again to investigate · Shift-drag to select an area</div>
      <div class="map-tools">
        <button type="button" class="btn small" data-map="reset">Reset view</button>
        <button type="button" class="btn small" data-map="quality" aria-pressed="false">Graphics: high</button>
      </div>
      <div class="compass" aria-hidden="true"><svg viewBox="-32 -32 64 64">
        <circle r="17" fill="none" stroke="#56666c" stroke-opacity="0.45" stroke-width="1"/>
        <g class="needle"><path d="M0 -15 L3.6 0 L0 2.5 L-3.6 0 Z" fill="#182226"/><path d="M0 15 L3.6 0 L0 -2.5 L-3.6 0 Z" fill="#56666c" fill-opacity="0.55"/></g>
        <text class="n">N</text><text>E</text><text>S</text><text>W</text>
      </svg></div>
      <div class="map-labels"></div>`;
    this.canvas = this.element.querySelector('canvas')!;

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = COL.sky;
    this.shared.uFogCol.value.copy(COL.sky).convertLinearToSRGB();

    this.camera.position.copy(START_CAMERA);
    this.camera.zoom = START_ZOOM;
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

    const SUN = new THREE.Vector3(-0.55, 1.0, 0.35).normalize();
    const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1.35);
    hemi.color.copy(COL.sky).lerp(new THREE.Color(1, 1, 1), 0.75);
    hemi.groundColor.copy(COL.soil_dk).lerp(new THREE.Color(0.2, 0.2, 0.2), 0.3);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff3df, 2.3);
    this.sun.position.copy(SUN).multiplyScalar(20);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 50 });
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun);
    this.waterU.uSun.value.copy(SUN);

    this.buildTerrain();
    this.buildWater();
    this.buildPlants();
    this.buildFish();
    this.buildSpecks();
    this.buildFlowTexture();
    this.buildMarkers();
    this.wireInput();
    requestAnimationFrame((t) => this.frame(t));
  }

  /* ---------------- Terrain ---------------- */

  /** Bed height at map coordinates (0..N), bilinear from the baked heightfield. */
  H = (x: number, z: number): number => {
    const t = this.terrain;
    const g = t.size * t.resolution;
    const fx = Math.min(g, Math.max(0, (x - t.origin) * t.resolution));
    const fz = Math.min(g, Math.max(0, (z - t.origin) * t.resolution));
    const i = Math.min(g - 1, Math.floor(fx)), j = Math.min(g - 1, Math.floor(fz));
    const tx = fx - i, tz = fz - j;
    const h = (a: number, b: number) => t.heights[b * (g + 1) + a];
    return (h(i, j) * (1 - tx) + h(i + 1, j) * tx) * (1 - tz) + (h(i, j + 1) * (1 - tx) + h(i + 1, j + 1) * tx) * tz;
  };
  private surfY = (x: number, z: number) => {
    const h = this.H(x, z);
    return h > this.WL ? h + 0.015 : this.WL + 0.05;
  };
  private get wmin() {
    return this.terrain.origin;
  }
  private get wmax() {
    return this.terrain.origin + this.terrain.size;
  }

  private terrainGeo = new THREE.BufferGeometry();
  private buildTerrain() {
    const RES = 3, WMIN = this.wmin, G = (this.wmax - WMIN) * RES, N = this.N, HALF = this.HALF;
    const tv: [number, number, number][] = [];
    for (let j = 0; j <= G; j++)
      for (let i = 0; i <= G; i++) {
        let x = WMIN + i / RES, z = WMIN + j / RES;
        const onEdge = i === 0 || j === 0 || i === G || j === G;
        const onBorder = Math.abs(x) < 1e-6 || Math.abs(x - N) < 1e-6 || Math.abs(z) < 1e-6 || Math.abs(z - N) < 1e-6;
        if (!onEdge && !onBorder) {
          x += (hash2(i * 1.7, j * 2.3) - 0.5) * 0.14;
          z += (hash2(i * 3.1, j * 0.7) - 0.5) * 0.14;
        }
        tv.push([x, z, this.H(x, z)]);
      }
    const pos: number[] = [];
    const V = (i: number, j: number) => tv[j * (G + 1) + i];
    const push = (p: [number, number, number]) => pos.push(p[0] - HALF, p[2], p[1] - HALF);
    for (let j = 0; j < G; j++)
      for (let i = 0; i < G; i++) {
        const a = V(i, j), b = V(i + 1, j), c = V(i, j + 1), d = V(i + 1, j + 1);
        if ((i + j) & 1) [a, c, d, a, d, b].forEach(push);
        else [a, c, b, b, c, d].forEach(push);
      }
    const geo = this.terrainGeo;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.shared);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vPlayW;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvPlayW = (modelMatrix * vec4(transformed, 1.0)).xz;');
      injectOutsideFrag(sh);
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.terrainMesh = mesh;
    this.scene.add(mesh);

    // Colour by height above the water, as the bench does.
    const p = geo.attributes.position.array, c = geo.attributes.color as THREE.BufferAttribute, nrm = geo.attributes.normal.array;
    const col = new THREE.Color();
    for (let f = 0; f < p.length / 9; f++) {
      const o = f * 9;
      const x = (p[o] + p[o + 3] + p[o + 6]) / 3 + HALF, y = (p[o + 1] + p[o + 4] + p[o + 7]) / 3, z = (p[o + 2] + p[o + 5] + p[o + 8]) / 3 + HALF;
      const dw = y - this.WL;
      if (dw < -0.03) col.copy(COL.sediment).lerp(COL.sediment_deep, smooth(0, 1.6, -dw));
      else if (dw < 0.05) col.copy(COL.mud);
      else if (dw < 0.15) col.copy(COL.wet_meadow);
      else if (nrm[o + 1] < 0.62) col.copy(COL.soil);
      else {
        const n = fbm(x * 0.55 + 20, z * 0.55 + 4);
        if (n < 0.5) col.copy(COL.grass_dk).lerp(COL.grass_md, smooth(0.3, 0.5, n));
        else col.copy(COL.grass_md).lerp(COL.grass_lt, smooth(0.5, 0.68, n));
      }
      col.multiplyScalar(1 + (hash2(f * 1.37, 3.1) - 0.5) * 0.09);
      for (let k = 0; k < 3; k++) c.setXYZ(f * 3 + k, col.r, col.g, col.b);
    }
    c.needsUpdate = true;
  }
  private terrainMesh!: THREE.Mesh;

  /* ---------------- Water ---------------- */
  private turbData!: Uint8Array<ArrayBuffer>;
  private turbTex!: THREE.DataTexture;
  private waterU = {
    uWaterLevel: { value: 0 },
    uTurbOut: { value: 0.35 },
    uTurbTex: { value: null as THREE.Texture | null },
    uN: { value: 12 },
    uShallow: { value: new THREE.Color() },
    uDeep: { value: new THREE.Color() },
    uTurbid: { value: new THREE.Color() },
    uFoam: { value: new THREE.Color() },
    uSun: { value: new THREE.Vector3() },
    uViewDir: { value: new THREE.Vector3(1, 1, 1).normalize() },
  };
  private buildWater() {
    const WSPAN = this.wmax - this.wmin, HALF = this.HALF;
    const geo = new THREE.PlaneGeometry(WSPAN, WSPAN, WSPAN * 4, WSPAN * 4).rotateX(-Math.PI / 2);
    // Centre the plane on the world, which is not centred on the playable square.
    const centre = (this.wmin + this.wmax) / 2 - HALF;
    geo.translate(centre, 0, centre);
    const p = geo.attributes.position.array, bed = new Float32Array(p.length / 3);
    for (let i = 0; i < bed.length; i++) bed[i] = this.H(p[i * 3] + HALF, p[i * 3 + 2] + HALF);
    geo.setAttribute('aBed', new THREE.BufferAttribute(bed, 1));

    this.turbData = new Uint8Array(this.N * this.N * 4);
    this.turbTex = new THREE.DataTexture(this.turbData, this.N, this.N, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.turbTex.magFilter = THREE.LinearFilter;
    this.turbTex.minFilter = THREE.LinearFilter;
    this.waterU.uTurbTex.value = this.turbTex;
    this.waterU.uN.value = this.N;
    this.waterU.uWaterLevel.value = this.WL;
    this.waterU.uShallow.value.copy(COL.water_shallow);
    this.waterU.uDeep.value.copy(COL.water_deep);
    this.waterU.uTurbid.value.copy(COL.water_turbid);
    this.waterU.uFoam.value.copy(COL.foam);
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
        uniform sampler2D uTurbTex; uniform float uTurbOut; uniform float uN;
        uniform vec3 uShallow; uniform vec3 uDeep; uniform vec3 uTurbid; uniform vec3 uFoam;
        uniform vec3 uSun; uniform vec3 uViewDir; varying vec3 vW; varying float vDepth;
        void main(){
          vec3 n = normalize(cross(dFdx(vW), dFdy(vW))); if (n.y < 0.0) n = -n;
          float d = max(vDepth, 0.0);
          vec2 mp = vW.xz + uHalf;
          float uTurbidity = (mp.x >= 0.0 && mp.y >= 0.0 && mp.x <= uN && mp.y <= uN) ? texture2D(uTurbTex, mp / uN).r : uTurbOut;
          vec3 clearC = mix(uShallow, uDeep, smoothstep(0.0, 1.8, d));
          vec3 base = mix(clearC, uTurbid, clamp(uTurbidity, 0.0, 1.0));
          float diff = clamp(dot(n, uSun), 0.0, 1.0);
          vec3 col = base * (0.62 + 0.5 * diff);
          vec3 hv = normalize(uSun + uViewDir);
          col += vec3(pow(max(dot(n, hv), 0.0), 48.0) * 0.35);
          vec2 fv = flowAt(vW.xz); float fsp = length(fv);
          float fph0 = fract(uTime / 2.0), fph1 = fract(uTime / 2.0 + 0.5), fw = abs(fph0 * 2.0 - 1.0);
          vec2 fp = vW.xz * 7.0;
          float fn0 = vnoise(fp - fv * fph0 * 2.0 * 7.0), fn1 = vnoise(fp + vec2(3.7, 1.3) - fv * fph1 * 2.0 * 7.0);
          float streak = smoothstep(0.55, 0.9, mix(fn0, fn1, fw)) * smoothstep(0.01, 0.12, fsp);
          col += uFoam * streak * 0.16;
          float fn = vnoise(vW.xz*5.0 + vec2(uTime*0.35, -uTime*0.25));
          float foam = 1.0 - smoothstep(0.004, 0.025 + 0.035*fn, d);
          float k = mix(0.55, 6.5, uTurbidity);
          float a = mix(0.12, 0.9, 1.0 - exp(-d * k));
          a = max(a, (0.12 + 0.8*uTurbidity) * smoothstep(0.0, 0.12, d));
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

  /* ---------------- Plants and props ---------------- */
  private types: PlantType[] = [];
  private flowerMesh!: THREE.InstancedMesh;
  private treeTypes: { mesh: THREE.InstancedMesh }[] = [];
  private treeCands: { x: number; z: number; h: number; rot: number; s: number; conifer: boolean; ins: boolean }[] = [];

  private buildPlants() {
    const N = this.N, EXT = 10;
    const inside = (x: number, z: number) => x >= 0 && x <= N && z >= 0 && z <= N;
    const genCands = (def: PlantDef, n: number, outer: boolean) => {
      const out: Cand[] = [];
      let guard = 0;
      while (out.length < n && guard++ < n * 4) {
        const x = outer ? -EXT + rand() * (N + 2 * EXT) : 0.08 + rand() * (N - 0.16);
        const z = outer ? -EXT + rand() * (N + 2 * EXT) : 0.08 + rand() * (N - 0.16);
        if (outer && inside(x, z)) continue;
        out.push({ x, z, h: this.H(x, z), rot: rand() * 6.283, s: def.scale[0] + rand() * (def.scale[1] - def.scale[0]), v: fbm(x * def.clump + def.off, z * def.clump + def.off * 0.7) + rand() * 0.22, flower: rand() < 0.3, u: 0 });
      }
      out.sort((a, b) => b.v - a.v);
      // Rank within the list, so per-tile cover thresholds keep the clumping.
      out.forEach((c, i) => (c.u = i / out.length));
      return out;
    };
    const make = (def: PlantDef): PlantType => {
      const rec = def.geo();
      const { mat, depth } = swayMaterials(this.shared, def.mode, def.height, def.flex, def.curve);
      const maxOut = def.maxOut ?? def.max * 2;
      const mesh = new THREE.InstancedMesh(rec.geo, mat, def.max + maxOut);
      mesh.customDepthMaterial = depth;
      mesh.castShadow = !!def.cast;
      mesh.receiveShadow = def.mode !== 2;
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      return { ...def, maxOut, mesh, cands: genCands(def, def.cand, false), outCands: genCands(def, Math.round(def.cand * 2.2), true) };
    };
    // Submerged cover comes from the game, tile by tile. The rest is scenery (decision 6).
    this.types = [
      make({ key: 'cat', cover: 0.6, geo: cattailGeo, mode: 0, height: 0.62, flex: 0.11, curve: 2.0, max: 800, maxOut: 1400, cand: 9000, clump: 0.9, off: 7, scale: [0.8, 1.15], cast: true, outCover: 0.55, hab: (d) => d > -0.12 && d < 0.42 }),
      make({ key: 'phr', cover: 0.35, geo: phragGeo, mode: 0, height: 0.42, flex: 0.08, curve: 2.6, max: 650, maxOut: 1000, cand: 9000, clump: 0.7, off: 13, scale: [0.38, 0.52], cast: true, outCover: 0.4, hab: (d) => d > -0.32 && d < 0.3 }),
      make({ key: 'grass', cover: 0.75, geo: grassGeo, mode: 0, height: 0.2, flex: 0.07, curve: 1.5, max: 2600, maxOut: 4500, cand: 4200, clump: 0.5, off: 1, scale: [0.75, 1.3], outCover: 0.7, hab: (d) => d < -0.07 }),
      make({ key: 'lily', cover: 0.3, geo: lilyGeo, mode: 1, height: 0.1, flex: 0, curve: 1, max: 300, maxOut: 500, cand: 5000, clump: 0.8, off: 19, scale: [0.8, 1.3], outCover: 0.45, hab: (d) => d > 0.32 && d < 1.3, surface: true }),
      make({ key: 'sub', cover: 0, perTile: true, geo: submergedGeo, mode: 2, height: 0.6, flex: 0.12, curve: 1.4, max: 1600, maxOut: 1500, cand: 7000, clump: 0.6, off: 23, scale: [0.9, 1.3], outCover: 0.5, hab: (d) => d > 0.12 && d < 2.1, fitDepth: true }),
      make({ key: 'peb', cover: 0.75, geo: pebbleGeo, mode: 3, height: 0.1, flex: 0, curve: 1, max: 700, maxOut: 1200, cand: 9000, clump: 1.3, off: 41, scale: [0.7, 1.4], outCover: 0.6, hab: (d) => d > -0.14 && d < 0.16, sink: 0.012 }),
    ];
    const flower = make({ key: 'flower', cover: 0, geo: lilyFlowerGeo, mode: 1, height: 0.1, flex: 0, curve: 1, max: 300, maxOut: 500, cand: 0, clump: 1, off: 0, scale: [1, 1], hab: () => false });
    this.flowerMesh = flower.mesh;

    for (let tries = 0; tries < 6000 && this.treeCands.length < 700; tries++) {
      const x = -EXT + rand() * (N + 2 * EXT), z = -EXT + rand() * (N + 2 * EXT);
      const ins = x > 0.35 && x < N - 0.35 && z > 0.35 && z < N - 0.35;
      if (!ins && inside(x, z)) continue;
      if (this.treeCands.some((t) => Math.hypot(t.x - x, t.z - z) < 0.85)) continue;
      this.treeCands.push({ x, z, ins, h: this.H(x, z), rot: rand() * 6.283, s: 0.8 + rand() * 0.45, conifer: rand() < 0.55 });
    }
    this.treeTypes = [true, false].map((con) => {
      const rec = con ? coniferGeo() : broadleafGeo();
      const { mat, depth } = swayMaterials(this.shared, 0, 1.45, 0.06, 2.0);
      const mesh = new THREE.InstancedMesh(rec.geo, mat, 700);
      mesh.customDepthMaterial = depth;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      return { mesh };
    });
  }

  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _e = new THREE.Euler();
  private readonly _v = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();
  private setInst(mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number, rot: number, sx: number, sy = sx, sz = sx) {
    this._m.compose(this._v.set(x - this.HALF, y, z - this.HALF), this._q.setFromEuler(this._e.set(0, rot, 0)), this._s.set(sx, sy, sz));
    mesh.setMatrixAt(i, this._m);
  }

  /** Per-tile submerged cover, by map position; scenery water outside the pond keeps a default. */
  private coverAt(x: number, z: number): number {
    if (!this.view) return 0;
    const i = Math.floor(x), j = Math.floor(z);
    if (i < 0 || j < 0 || i >= this.N || j >= this.N) return 0.5;
    const t = this.view.tiles[this.tileAt(i, j)];
    return t?.water ? t.cover : 0.35;
  }
  private isPondAt(x: number, z: number): boolean {
    const i = Math.floor(x), j = Math.floor(z);
    if (!this.view || i < 0 || j < 0 || i >= this.N || j >= this.N) return false;
    return !!this.view.tiles[this.tileAt(i, j)]?.water;
  }
  private tileAtCache = new Map<string, number>();
  private tileAt(col: number, row: number): number {
    return this.tileAtCache.get(`${row},${col}`) ?? -1;
  }

  private rebuildPlants() {
    const q = this.lowQuality ? 0.5 : 1;
    const WL = this.WL;
    for (const T of this.types) {
      // Scenery plants stay off simulated pond tiles, so what grows there is what the sim tracks.
      const vin = T.cands.filter((c) => T.hab(WL - c.h) && (T.perTile || T.key === 'peb' || T.key === 'grass' || !this.isPondAt(c.x, c.z)));
      const vout = T.outCands.filter((c) => T.hab(WL - c.h));
      const inList = T.perTile ? vin.filter((c) => c.u < this.coverAt(c.x, c.z)) : vin.slice(0, Math.round(T.cover * vin.length));
      const list = inList.slice(0, Math.round(T.max * q)).concat(vout.slice(0, Math.round(T.outCover! * Math.min(vout.length, T.maxOut) * q)));
      let fi = 0;
      list.forEach((c, i) => {
        const d = WL - c.h;
        if (T.surface) {
          this.setInst(T.mesh, i, c.x, WL + 0.008, c.z, c.rot, c.s);
          if (c.flower) this.setInst(this.flowerMesh, fi++, c.x, WL + 0.008, c.z, c.rot, c.s);
        } else if (T.fitDepth) {
          const sy = Math.max(0.3, Math.min(2.2, (d * 0.85) / 0.6));
          this.setInst(T.mesh, i, c.x, c.h - 0.02, c.z, c.rot, c.s, sy, c.s);
        } else this.setInst(T.mesh, i, c.x, c.h - (T.sink ?? 0.02), c.z, c.rot, c.s);
      });
      T.mesh.count = list.length;
      T.mesh.instanceMatrix.needsUpdate = true;
      if (T.surface) {
        this.flowerMesh.count = fi;
        this.flowerMesh.instanceMatrix.needsUpdate = true;
      }
    }
    const valid = this.treeCands.filter((c) => WL - c.h < -0.2);
    const tin = valid.filter((c) => c.ins), tout = valid.filter((c) => !c.ins);
    const list = tin.slice(0, Math.round(0.4 * tin.length * q)).concat(tout.slice(0, Math.round(0.22 * tout.length * q)));
    const counts = [0, 0];
    for (const c of list) {
      const k = c.conifer ? 0 : 1;
      this.setInst(this.treeTypes[k].mesh, counts[k]++, c.x, c.h - 0.03, c.z, c.rot, c.s);
    }
    this.treeTypes.forEach((t, k) => {
      t.mesh.count = counts[k];
      t.mesh.instanceMatrix.needsUpdate = true;
    });
  }

  /* ---------------- Fish and ripples ---------------- */
  private fishMesh!: THREE.InstancedMesh;
  private schools: { members: { x: number; z: number; vx: number; vz: number; s: number; ph: number }[]; tx: number; tz: number; timer: number }[] = [];
  private buildFish() {
    const rec = fishGeo();
    this.fishMesh = new THREE.InstancedMesh(rec.geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 500);
    this.fishMesh.count = 0;
    this.fishMesh.frustumCulled = false;
    this.scene.add(this.fishMesh);
  }
  private pondTiles(): TileView[] {
    return this.view ? this.view.tiles.filter((t) => t.water && this.WL - this.H(t.col + 0.5, t.row + 0.5) > 0.22) : [];
  }
  private fishValid(x: number, z: number) {
    if (!this.view) return false;
    const i = Math.floor(x), j = Math.floor(z);
    if (i < 0 || j < 0 || i >= this.N || j >= this.N) return false;
    return !!this.view.tiles[this.tileAt(i, j)]?.water && this.WL - this.H(x, z) > 0.22;
  }
  /** Fish appear only after a survey; school count follows the measured biomass. */
  private rebuildFish() {
    this.schools = [];
    const tiles = this.pondTiles();
    const measured = tiles.map((t) => t.carpMeasured).filter((x): x is number => x !== null);
    if (!measured.length || !tiles.length) return;
    const mean = measured.reduce((s, x) => s + x, 0) / measured.length;
    const nS = Math.max(0, Math.min(8, Math.round(mean / 70)));
    for (let s = 0; s < nS; s++) {
      const t = tiles[Math.floor(rand() * tiles.length)];
      const members = [];
      for (let k = 0; k < 8; k++) {
        const a = rand() * 6.283;
        members.push({ x: t.col + 0.5 + (rand() - 0.5) * 0.3, z: t.row + 0.5 + (rand() - 0.5) * 0.3, vx: Math.cos(a) * 0.3, vz: Math.sin(a) * 0.3, s: 1.25 + rand() * 0.4, ph: rand() * 6.28 });
      }
      const tt = tiles[Math.floor(rand() * tiles.length)];
      this.schools.push({ members, tx: tt.col + 0.5, tz: tt.row + 0.5, timer: 0 });
    }
  }
  private updateFish(dt: number, t: number) {
    let idx = 0;
    const tiles = this.pondTiles();
    const TRY = [0.6, -0.6, 1.2, -1.2, 2.0, -2.0, Math.PI];
    for (const sc of this.schools) {
      let cx = 0, cz = 0, avx = 0, avz = 0;
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
      if ((Math.hypot(cx - sc.tx, cz - sc.tz) < 0.7 || sc.timer > 12) && tiles.length) {
        const tt = tiles[Math.floor(rand() * tiles.length)];
        sc.tx = tt.col + 0.5;
        sc.tz = tt.row + 0.5;
        sc.timer = 0;
      }
      for (const f of sc.members) {
        if (dt > 0) {
          let ax = (cx - f.x) * 0.9 + (avx - f.vx) * 0.9, az = (cz - f.z) * 0.9 + (avz - f.vz) * 0.9;
          const tdx = sc.tx - f.x, tdz = sc.tz - f.z, tl = Math.hypot(tdx, tdz) || 1;
          ax += (tdx / tl) * 0.35;
          az += (tdz / tl) * 0.35;
          for (const o of sc.members) {
            if (o === f) continue;
            const dx = f.x - o.x, dz = f.z - o.z, d = Math.hypot(dx, dz);
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
          if (!this.fishValid(f.x + (f.vx / sp) * 0.3, f.z + (f.vz / sp) * 0.3)) {
            const base = Math.atan2(f.vz, f.vx);
            for (const da of TRY) {
              const a = base + da;
              if (this.fishValid(f.x + Math.cos(a) * 0.3, f.z + Math.sin(a) * 0.3)) {
                f.vx = Math.cos(a) * sp;
                f.vz = Math.sin(a) * sp;
                break;
              }
            }
          }
          const nx = f.x + f.vx * dt, nz = f.z + f.vz * dt;
          if (this.fishValid(nx, nz)) {
            f.x = nx;
            f.z = nz;
          } else {
            f.vx = -f.vx;
            f.vz = -f.vz;
          }
        }
        const depth = this.WL - this.H(f.x, f.z);
        const y = this.WL - Math.min(0.2, depth * 0.45) + Math.sin(t * 1.3 + f.ph) * 0.01;
        const yaw = Math.atan2(f.vx, f.vz) + Math.sin(t * 9 + f.ph) * 0.14;
        this.setInst(this.fishMesh, idx++, f.x, y, f.z, yaw, f.s);
      }
    }
    this.fishMesh.count = idx;
    this.fishMesh.instanceMatrix.needsUpdate = true;

  }

  /* ---------------- Visual flow field (bench solver, for surface texture and drifting specks) ---------------- */
  private flowVX = new Float32Array(0);
  private flowVZ = new Float32Array(0);
  private FNX = 0;
  private buildFlowTexture() {
    const FR = 2, FNX = (this.wmax - this.wmin) * FR, FH = 1 / FR, WMIN = this.wmin;
    this.FNX = FNX;
    const depth = new Float32Array(FNX * FNX);
    for (let j = 0; j < FNX; j++) for (let i = 0; i < FNX; i++) depth[j * FNX + i] = this.WL - this.H(WMIN + (i + 0.5) * FH, WMIN + (j + 0.5) * FH);
    const flow = solveSteadyFlow({ nx: FNX, nz: FNX, depth, isInflow: (i) => i === 0, isOutflow: (i) => i === FNX - 1, Q: 0.1, h: FH });
    this.flowVX = flow.vx;
    this.flowVZ = flow.vz;
    const data = new Uint8Array(FNX * FNX * 4);
    const vmax = Math.max(0.05, flow.speedMax);
    for (let k = 0; k < FNX * FNX; k++) {
      data[k * 4] = Math.round(127 + Math.max(-1, Math.min(1, flow.vx[k] / vmax)) * 127);
      data[k * 4 + 1] = Math.round(127 + Math.max(-1, Math.min(1, flow.vz[k] / vmax)) * 127);
      data[k * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, FNX, FNX, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.shared.uFlowTex.value = tex;
    this.shared.uFlowRect.value.set(WMIN - this.HALF, WMIN - this.HALF, this.wmax - WMIN, vmax);
  }
  private flowAtCPU(x: number, z: number) {
    const FR = 2, FNX = this.FNX;
    const fx = (x - this.wmin) * FR - 0.5, fz = (z - this.wmin) * FR - 0.5;
    const i0 = Math.max(0, Math.min(FNX - 2, Math.floor(fx))), j0 = Math.max(0, Math.min(FNX - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - i0)), tz = Math.max(0, Math.min(1, fz - j0));
    const k = j0 * FNX + i0;
    const w = [(1 - tx) * (1 - tz), tx * (1 - tz), (1 - tx) * tz, tx * tz], ks = [k, k + 1, k + FNX, k + FNX + 1];
    let vx = 0, vz = 0;
    for (let q = 0; q < 4; q++) {
      vx += this.flowVX[ks[q]] * w[q];
      vz += this.flowVZ[ks[q]] * w[q];
    }
    return { x: vx, z: vz };
  }

  private specks: { mesh: THREE.InstancedMesh; parts: { x: number; z: number; age: number; life: number; rot: number; s: number; wa: number }[] }[] = [];
  private buildSpecks() {
    const defs: [string, number, [number, number, number][]][] = [
      ['duckweed', 200, [[0, 0, 0.017], [0.025, 0.008, 0.014], [0.006, 0.026, 0.012]]],
      ['foam', 110, [[0, 0, 0.012], [0.016, 0.006, 0.008]]],
    ];
    this.specks = defs.map(([tok, count, discs]) => {
      const rec = speckGeo(tok, discs);
      const { mat } = swayMaterials(this.shared, 4, 0.1, 0, 1);
      const mesh = new THREE.InstancedMesh(rec.geo, mat, count);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      const parts = Array.from({ length: count }, () => ({ x: 0, z: 0, age: 0, life: 0, rot: rand() * 6.28, s: 0.8 + rand() * 0.5, wa: rand() * 6.28 }));
      parts.forEach((p) => this.spawnSpeck(p, true));
      return { mesh, parts };
    });
  }
  private spawnSpeck(p: { x: number; z: number; age: number; life: number }, init: boolean) {
    const PAD = 3, N = this.N;
    for (let t = 0; t < 30; t++) {
      const x = -PAD + rand() * (N + 2 * PAD), z = -PAD + rand() * (N + 2 * PAD);
      if (this.WL - this.H(x, z) > 0.08) {
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
    const PAD = 3, N = this.N;
    for (const sp of this.specks) {
      sp.parts.forEach((p, i) => {
        if (dt > 0) {
          const v = this.flowAtCPU(p.x, p.z);
          p.wa += (rand() - 0.5) * 2.0 * dt;
          p.x += (v.x + Math.cos(p.wa) * 0.012) * dt;
          p.z += (v.z + Math.sin(p.wa) * 0.012) * dt;
          p.rot += 0.05 * dt;
          p.age += dt;
          if (p.age > p.life || this.WL - this.H(p.x, p.z) < 0.04 || p.x < -PAD || p.z < -PAD || p.x > N + PAD || p.z > N + PAD) this.spawnSpeck(p, false);
        }
        const f = p.life > 0 ? Math.max(0.001, Math.min(1, p.age / 1.5, (p.life - p.age) / 1.5)) : 0.001;
        this.setInst(sp.mesh, i, p.x, this.WL + 0.012, p.z, p.rot, f * p.s);
      });
      sp.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /* ---------------- Grid, selection, overlays, flow arrows, barrier ---------------- */
  private grid!: THREE.LineSegments;
  private hover!: THREE.LineLoop;
  private focusLoop!: THREE.LineLoop;
  private selMesh!: THREE.InstancedMesh;
  private overlayMesh!: THREE.InstancedMesh;
  private hatchMesh!: THREE.InstancedMesh;
  private unknownMesh!: THREE.InstancedMesh;
  private arrows!: THREE.LineSegments;
  private barrierMesh!: THREE.Group;
  private labels!: HTMLDivElement;

  private buildMarkers() {
    const N = this.N, HALF = this.HALF;
    // Tile grid and the bright playable border, draped on the surface.
    const p: number[] = [];
    const st = 0.25;
    for (let i = 0; i <= N; i++)
      for (let s = 0; s < N; s += st) {
        p.push(i - HALF, this.surfY(i, s), s - HALF, i - HALF, this.surfY(i, s + st), s + st - HALF);
        p.push(s - HALF, this.surfY(s, i), i - HALF, s + st - HALF, this.surfY(s + st, i), i - HALF);
      }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    this.grid = new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }));
    this.grid.renderOrder = 4;
    this.scene.add(this.grid);
    const b: number[] = [];
    const w = 0.045, sy = (x: number, z: number) => this.surfY(x, z) + 0.025;
    const sides = [[0, 0, 1, 0, 0, 1], [N, 0, 0, 1, -1, 0], [N, N, -1, 0, 0, -1], [0, N, 0, -1, 1, 0]];
    for (const [x0, z0, dx, dz, nx, nz] of sides)
      for (let t = 0; t < N; t += 0.1) {
        const ax = x0 + dx * t, az = z0 + dz * t, bx = x0 + dx * (t + 0.1), bz = z0 + dz * (t + 0.1);
        const q = [[ax - nx * w, az - nz * w], [bx - nx * w, bz - nz * w], [bx + nx * w, bz + nz * w], [ax + nx * w, az + nz * w]];
        for (const i of [0, 1, 2, 0, 2, 3]) b.push(q[i][0] - HALF, sy(q[i][0], q[i][1]), q[i][1] - HALF);
      }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(b, 3));
    const border = new THREE.Mesh(bg, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
    border.renderOrder = 1;
    this.scene.add(border);

    const loopMat = (color: number) => new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false });
    this.hover = new THREE.LineLoop(new THREE.BufferGeometry(), loopMat(0xffffff));
    this.hover.renderOrder = 7;
    this.hover.visible = false;
    this.scene.add(this.hover);
    this.focusLoop = new THREE.LineLoop(new THREE.BufferGeometry(), loopMat(0x0e3a5c));
    this.focusLoop.renderOrder = 8;
    this.focusLoop.visible = false;
    this.scene.add(this.focusLoop);

    const quad = new THREE.PlaneGeometry(0.94, 0.94).rotateX(-Math.PI / 2);
    const flat = (mat: THREE.Material, count: number) => {
      const m = new THREE.InstancedMesh(quad, mat, count);
      m.count = 0;
      m.renderOrder = 5;
      m.frustumCulled = false;
      this.scene.add(m);
      return m;
    };
    const cells = N * N;
    this.selMesh = flat(new THREE.MeshBasicMaterial({ color: 0x2b78b0, transparent: true, opacity: 0.38, depthWrite: false }), cells);
    this.overlayMesh = flat(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.82, depthWrite: false }), cells);
    this.hatchMesh = flat(new THREE.MeshBasicMaterial({ map: stripeTexture(), transparent: true, depthWrite: false }), cells);
    this.unknownMesh = flat(new THREE.MeshBasicMaterial({ map: questionTexture(), transparent: true, depthWrite: false }), cells);
    this.hatchMesh.renderOrder = 6;
    this.unknownMesh.renderOrder = 6;

    this.arrows = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
    this.arrows.renderOrder = 9;
    this.arrows.visible = false;
    this.scene.add(this.arrows);

    // A screen of posts across the inlet, shown once the carp barrier is built.
    this.barrierMesh = new THREE.Group();
    const postMat = new THREE.MeshLambertMaterial({ color: 0x4a4a52 });
    for (let k = 0; k < 7; k++) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 5), postMat);
      post.position.set(0, 0.1, (k - 3) * 0.1);
      post.castShadow = true;
      this.barrierMesh.add(post);
    }
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.66), postMat);
    rail.position.set(0, 0.3, 0);
    this.barrierMesh.add(rail);
    this.barrierMesh.visible = false;
    this.scene.add(this.barrierMesh);

    this.labels = this.element.querySelector('.map-labels')!;
  }

  private tileLoop(line: THREE.LineLoop, col: number, row: number) {
    const p: number[] = [], st = 0.1, HALF = this.HALF;
    for (let s = 0; s < 1; s += st) p.push(col + s - HALF, this.surfY(col + s, row) + 0.01, row - HALF);
    for (let s = 0; s < 1; s += st) p.push(col + 1 - HALF, this.surfY(col + 1, row + s) + 0.01, row + s - HALF);
    for (let s = 1; s > 0; s -= st) p.push(col + s - HALF, this.surfY(col + s, row + 1) + 0.01, row + 1 - HALF);
    for (let s = 1; s > 0; s -= st) p.push(col - HALF, this.surfY(col, row + s) + 0.01, row + s - HALF);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    line.geometry.dispose();
    line.geometry = g;
    line.visible = true;
  }

  private placeFlat(mesh: THREE.InstancedMesh, i: number, t: TileView, lift: number) {
    const x = t.col + 0.5, z = t.row + 0.5;
    this._m.makeTranslation(x - this.HALF, this.surfY(x, z) + lift, z - this.HALF);
    mesh.setMatrixAt(i, this._m);
  }

  private rebuildMarkers() {
    const v = this.view!;
    // Selection.
    let k = 0;
    for (const id of v.selection) {
      const t = v.tiles[this.tileIndex.get(id)!];
      if (t) this.placeFlat(this.selMesh, k++, t, 0.035);
    }
    this.selMesh.count = k;
    this.selMesh.instanceMatrix.needsUpdate = true;
    const f = v.focus ? v.tiles[this.tileIndex.get(v.focus)!] : null;
    if (f) this.tileLoop(this.focusLoop, f.col, f.row);
    else this.focusLoop.visible = false;

    // Knowledge overlay: solid colour when measured, hatched when estimated, "?" when unknown.
    let o = 0, h = 0, u = 0;
    const c = new THREE.Color();
    for (const t of v.tiles) {
      if (!t.overlay) continue;
      if (t.overlay.state === 'unknown') {
        this.placeFlat(this.unknownMesh, u++, t, 0.03);
        continue;
      }
      this.placeFlat(this.overlayMesh, o, t, 0.03);
      this.overlayMesh.setColorAt(o++, c.set(t.overlay.color));
      if (t.overlay.state === 'estimate') this.placeFlat(this.hatchMesh, h++, t, 0.032);
    }
    for (const [mesh, n] of [[this.overlayMesh, o], [this.hatchMesh, h], [this.unknownMesh, u]] as const) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    // Flow arrows: blue for water flow from the sim, brown for land runoff.
    const pts: number[] = [], cols: number[] = [];
    const blue = new THREE.Color('#1f5f8e'), brown = new THREE.Color('#8a5a2b');
    const seg = (x0: number, z0: number, x1: number, z1: number, y: number, col: THREE.Color) => {
      pts.push(x0 - this.HALF, y, z0 - this.HALF, x1 - this.HALF, y, z1 - this.HALF);
      cols.push(col.r, col.g, col.b, col.r, col.g, col.b);
    };
    const arrow = (x: number, z: number, dx: number, dz: number, len: number, y: number, col: THREE.Color) => {
      const ax = x - (dx * len) / 2, az = z - (dz * len) / 2, bx = x + (dx * len) / 2, bz = z + (dz * len) / 2, hl = Math.min(0.12, len * 0.45);
      seg(ax, az, bx, bz, y, col);
      for (const s of [1, -1]) {
        const ca = Math.cos(2.6 * s), sa = Math.sin(2.6 * s);
        seg(bx, bz, bx + (dx * ca - dz * sa) * hl, bz + (dx * sa + dz * ca) * hl, y, col);
      }
    };
    const vmax = Math.max(1e-6, ...v.flow.map((q) => Math.hypot(q.x, q.z)));
    v.tiles.forEach((t, i) => {
      const x = t.col + 0.5, z = t.row + 0.5, y = this.surfY(x, z) + 0.06;
      if (t.water) {
        const q = v.flow[i], sp = Math.hypot(q.x, q.z);
        if (sp < 1e-6) {
          seg(x - 0.06, z, x + 0.06, z, y, blue);
          seg(x, z - 0.06, x, z + 0.06, y, blue);
        } else arrow(x, z, q.x / sp, q.z / sp, 0.18 + 0.55 * Math.sqrt(sp / vmax), y, blue);
      } else {
        const r = v.runoff[i];
        if (r === null) return;
        if (r < 0) {
          seg(x - 0.07, z - 0.07, x + 0.07, z + 0.07, y, brown);
          seg(x - 0.07, z + 0.07, x + 0.07, z - 0.07, y, brown);
        } else {
          const d = v.tiles[r], dx = d.col - t.col, dz = d.row - t.row, l = Math.hypot(dx, dz);
          arrow(x, z, dx / l, dz / l, 0.42, y, brown);
        }
      }
    });
    const ag = new THREE.BufferGeometry();
    ag.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    ag.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    this.arrows.geometry.dispose();
    this.arrows.geometry = ag;
    this.arrows.visible = v.flowOverlay;

    // Barrier at the inlet face.
    const inlet = v.boundaries.find((b) => b.kind === 'in');
    this.barrierMesh.visible = !!inlet && v.barrier !== 'none';
    if (inlet && this.barrierMesh.visible) {
      const t = v.tiles[this.tileIndex.get(inlet.tile)!];
      const e = this.faceMid(t, inlet.face);
      this.barrierMesh.position.set(e.x - this.HALF, this.WL, e.z - this.HALF);
      this.barrierMesh.rotation.y = inlet.face === 'N' || inlet.face === 'S' ? Math.PI / 2 : 0;
      this.barrierMesh.scale.setScalar(v.barrier === 'building' ? 0.6 : 1);
    }

    // Boundary labels, positioned every frame.
    this.labels.innerHTML = v.boundaries
      .map((b) => `<div class="map-label ${b.kind}" data-tile="${b.tile}" data-face="${b.face}">${b.kind === 'in' ? '→ ' : ''}${b.name}${b.kind === 'out' ? ' →' : ''}${b.kind === 'in' && v.barrier !== 'none' ? `<span>Carp barrier ${v.barrier === 'building' ? 'being built' : 'in place'}</span>` : ''}</div>`)
      .join('');
  }

  private faceMid(t: TileView, face: 'N' | 'E' | 'S' | 'W') {
    const x = t.col + (face === 'E' ? 1 : face === 'W' ? 0 : 0.5);
    const z = t.row + (face === 'S' ? 1 : face === 'N' ? 0 : 0.5);
    return { x, z };
  }

  /* ---------------- Game state in ---------------- */

  update(view: MapViewState) {
    const first = !this.view;
    const prev = this.view;
    this.view = view;
    if (first || prev!.tiles.length !== view.tiles.length) {
      this.tileIndex = new Map(view.tiles.map((t, i) => [t.id, i]));
      this.tileAtCache = new Map(view.tiles.map((t, i) => [`${t.row},${t.col}`, i]));
    }
    // Water colour per tile from visible clarity.
    let sum = 0, n = 0;
    for (const t of view.tiles) if (t.turbidity !== null) (sum += t.turbidity), n++;
    const outside = n ? sum / n : 0.35;
    this.waterU.uTurbOut.value = outside;
    for (const t of view.tiles) {
      const k = (t.row * this.N + t.col) * 4;
      this.turbData[k] = Math.round(255 * (t.turbidity ?? outside));
      this.turbData[k + 3] = 255;
    }
    this.turbTex.needsUpdate = true;

    const coverKey = view.tiles.map((t) => t.cover.toFixed(2)).join();
    if (coverKey !== this.lastCoverKey) {
      this.lastCoverKey = coverKey;
      this.rebuildPlants();
    }
    const fishKey = view.tiles.map((t) => t.carpMeasured ?? '').join();
    if (fishKey !== this.lastFishKey) {
      this.lastFishKey = fishKey;
      this.rebuildFish();
    }
    const a = (120 * Math.PI) / 180;
    this.shared.uWindDir.value.set(Math.sin(a), -Math.cos(a));
    const strength = Math.min(1, view.windSpeed / 10);
    this.shared.uWindStrength.value = strength;
    this.shared.uGust.value = 0.5;
    this.shared.uWaveAmp.value = 0.018 + 0.06 * strength;
    this.rebuildMarkers();
    if (this.hoverTile) this.setHover(this.hoverTile[0], this.hoverTile[1]);
  }
  private lastCoverKey = '';
  private lastFishKey = '';

  resetView() {
    this.camera.position.copy(START_CAMERA);
    this.camera.zoom = START_ZOOM;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, -0.4, 0);
    this.controls.update();
  }

  setLowQuality(low: boolean, auto = false) {
    if (!auto) this.autoQuality = false;
    if (low === this.lowQuality) return;
    this.lowQuality = low;
    this.renderer.setPixelRatio(low ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = !low;
    this.sun.castShadow = !low;
    this.resize();
    if (this.view) this.rebuildPlants();
    const btn = this.element.querySelector<HTMLButtonElement>('[data-map="quality"]')!;
    btn.textContent = `Graphics: ${low ? 'low' : 'high'}`;
    btn.setAttribute('aria-pressed', String(low));
  }

  /* ---------------- Input ---------------- */
  private hoverTile: [number, number] | null = null;
  private readonly ray = new THREE.Raycaster();
  private readonly ptr = new THREE.Vector2();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly hit = new THREE.Vector3();

  private pickTile(ev: PointerEvent | MouseEvent): [number, number] | null {
    const r = this.canvas.getBoundingClientRect();
    this.ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ptr, this.camera);
    this.plane.constant = -this.WL;
    let p: THREE.Vector3 | null = null;
    if (this.ray.ray.intersectPlane(this.plane, this.hit) && this.H(this.hit.x + this.HALF, this.hit.z + this.HALF) < this.WL) p = this.hit.clone();
    if (!p) {
      const hs = this.ray.intersectObject(this.terrainMesh);
      if (hs.length) p = hs[0].point;
    }
    if (!p) return null;
    const i = Math.floor(p.x + this.HALF), j = Math.floor(p.z + this.HALF);
    if (i < 0 || j < 0 || i >= this.N || j >= this.N) return null;
    return [i, j];
  }

  private setHover(col: number | null, row?: number) {
    const hud = this.element.querySelector('.hud')!;
    if (col === null || !this.view) {
      this.hover.visible = false;
      this.hoverTile = null;
      hud.querySelector('.hud-tile')!.textContent = 'Hover or use arrow keys to inspect a tile';
      hud.querySelector('.hud-info')!.textContent = 'Shows observable state only';
      return;
    }
    this.hoverTile = [col, row!];
    this.tileLoop(this.hover, col, row!);
    const t = this.view.tiles[this.tileAt(col, row!)];
    if (!t) return;
    hud.querySelector('.hud-tile')!.textContent = t.title;
    hud.querySelector('.hud-info')!.textContent = t.info;
  }

  private tileId(col: number, row: number) {
    return this.view?.tiles[this.tileAt(col, row)]?.id ?? null;
  }

  private wireInput() {
    const canvas = this.canvas;
    let down: { x: number; y: number; tile: [number, number] | null; shift: boolean } | null = null;
    canvas.addEventListener('pointermove', (ev) => {
      const t = this.pickTile(ev);
      if (!t) this.setHover(null);
      else if (!this.hoverTile || this.hoverTile[0] !== t[0] || this.hoverTile[1] !== t[1]) this.setHover(t[0], t[1]);
      // Shift-drag paints a rectangle preview by moving the hover loop; the selection lands on release.
    });
    canvas.addEventListener('pointerleave', () => this.setHover(null));
    canvas.addEventListener('pointerdown', (ev) => {
      down = { x: ev.clientX, y: ev.clientY, tile: this.pickTile(ev), shift: ev.shiftKey };
      // Shift-drag selects an area instead of rotating the camera.
      this.controls.enabled = !ev.shiftKey;
    });
    window.addEventListener('pointerup', (ev) => {
      if (!down) return;
      const start = down;
      down = null;
      this.controls.enabled = true;
      if (ev.target !== canvas && !start.shift) return;
      const moved = Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 5;
      const end = this.pickTile(ev);
      if (start.shift && start.tile && end) {
        const ids: string[] = [];
        for (let c = Math.min(start.tile[0], end[0]); c <= Math.max(start.tile[0], end[0]); c++)
          for (let r = Math.min(start.tile[1], end[1]); r <= Math.max(start.tile[1], end[1]); r++) {
            const id = this.tileId(c, r);
            if (id) ids.push(id);
          }
        this.cb.onSelect(ids, 'add');
      } else if (!moved && end) {
        const id = this.tileId(end[0], end[1]);
        if (id) this.cb.onSelect([id], 'replace');
      }
    });
    canvas.addEventListener('dblclick', (ev) => {
      const t = this.pickTile(ev);
      const id = t && this.tileId(t[0], t[1]);
      if (id) this.cb.onOpen(id);
    });
    canvas.addEventListener('keydown', (ev) => {
      if (!this.view) return;
      const f = this.view.focus ? this.view.tiles[this.tileIndex.get(this.view.focus)!] : this.view.tiles[0];
      const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (moves[ev.key]) {
        ev.preventDefault();
        const [dc, dr] = moves[ev.key];
        const c = Math.min(this.N - 1, Math.max(0, f.col + dc)), r = Math.min(this.N - 1, Math.max(0, f.row + dr));
        const id = this.tileId(c, r);
        if (id) {
          this.cb.onSelect([id], ev.shiftKey ? 'add' : 'replace');
          this.setHover(c, r);
        }
      } else if (ev.key === 'Enter' && this.view.focus) {
        ev.preventDefault();
        this.cb.onOpen(this.view.focus);
      } else if (ev.key === ' ' && this.view.focus) {
        ev.preventDefault();
        this.cb.onSelect([this.view.focus], 'add');
      }
    });
    this.element.querySelector('[data-map="reset"]')!.addEventListener('click', () => this.resetView());
    this.element.querySelector('[data-map="quality"]')!.addEventListener('click', () => this.setLowQuality(!this.lowQuality));
  }

  /* ---------------- Loop ---------------- */
  private resize() {
    const w = this.element.clientWidth, h = this.element.clientHeight;
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

  private readonly _ca = new THREE.Vector3();
  private readonly _cb = new THREE.Vector3();
  private updateOverlays() {
    // Compass: north is map −z.
    this._ca.set(0, 0, 0).project(this.camera);
    this._cb.set(0, 0, -1).project(this.camera);
    const W = this.element.clientWidth, Hh = this.element.clientHeight;
    const ang = Math.atan2((this._cb.x - this._ca.x) * W, (this._cb.y - this._ca.y) * Hh);
    this.element.querySelector('.needle')!.setAttribute('transform', `rotate(${(ang * 180) / Math.PI})`);
    this.element.querySelectorAll('.compass text').forEach((el, k) => {
      const a = ang + (k * Math.PI) / 2;
      el.setAttribute('x', (Math.sin(a) * 25).toFixed(2));
      el.setAttribute('y', (-Math.cos(a) * 25).toFixed(2));
    });
    // Boundary labels follow their tile faces.
    if (!this.view) return;
    this.labels.querySelectorAll<HTMLElement>('.map-label').forEach((el) => {
      const t = this.view!.tiles[this.tileIndex.get(el.dataset.tile!)!];
      const m = this.faceMid(t, el.dataset.face as 'N' | 'E' | 'S' | 'W');
      this._ca.set(m.x - this.HALF, this.WL + 0.3, m.z - this.HALF).project(this.camera);
      el.style.left = `${((this._ca.x + 1) / 2) * W}px`;
      el.style.top = `${((1 - this._ca.y) / 2) * Hh}px`;
    });
  }

  private frame(now: number) {
    requestAnimationFrame((t) => this.frame(t));
    if (!this.element.isConnected) {
      this.last = now;
      return;
    }
    const dt = Math.min(0.05, (now - this.last) / 1000);
    // Drop to low quality automatically if the machine struggles (decision 11).
    if (this.autoQuality && !this.lowQuality) {
      this.frameTimes.push(now - this.last);
      if (this.frameTimes.length > 120) {
        this.frameTimes.shift();
        const mean = this.frameTimes.reduce((s, x) => s + x, 0) / this.frameTimes.length;
        if (mean > 45) this.setLowQuality(true, true);
      }
    }
    this.last = now;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const step = reduced ? 0 : dt;
    this.time += step;
    this.shared.uTime.value = this.time;
    this.updateFish(step, this.time);
    this.updateSpecks(step);
    this.controls.update();
    const vd = new THREE.Vector3();
    this.camera.getWorldDirection(vd);
    this.waterU.uViewDir.value.copy(vd).negate();
    this.updateOverlays();
    this.renderer.render(this.scene, this.camera);
  }
}

/* ---------------- Types and helpers ---------------- */
interface Cand {
  x: number;
  z: number;
  h: number;
  rot: number;
  s: number;
  v: number;
  flower: boolean;
  /** Rank within the candidate list, 0 to 1: lower ranks fill first. */
  u: number;
}
interface PlantDef {
  key: string;
  cover: number;
  perTile?: boolean;
  geo: () => { geo: THREE.BufferGeometry };
  mode: number;
  height: number;
  flex: number;
  curve: number;
  max: number;
  maxOut?: number;
  cand: number;
  clump: number;
  off: number;
  scale: [number, number];
  cast?: boolean;
  outCover?: number;
  hab: (depth: number) => boolean;
  surface?: boolean;
  fitDepth?: boolean;
  sink?: number;
}
interface PlantType extends PlantDef {
  maxOut: number;
  mesh: THREE.InstancedMesh;
  cands: Cand[];
  outCands: Cand[];
}

function stripeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.strokeStyle = 'rgba(24,34,38,0.55)';
  g.lineWidth = 6;
  for (let k = -64; k < 128; k += 16) {
    g.beginPath();
    g.moveTo(k, 0);
    g.lineTo(k + 64, 64);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function questionTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(213,220,218,0.85)';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#56666c';
  g.font = '600 40px IBM Plex Sans, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('?', 32, 35);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Steady flow through connected water (from the bench; visual only here): solve
 * div(T grad phi) = 0 with T = depth, phi = 1 on inflow cells and 0 on outflow cells.
 */
function solveSteadyFlow({ nx, nz, depth, isInflow, isOutflow, Q, h, iters = 900, omega = 1.85 }: {
  nx: number;
  nz: number;
  depth: Float32Array;
  isInflow: (i: number, j: number) => boolean;
  isOutflow: (i: number, j: number) => boolean;
  Q: number;
  h: number;
  iters?: number;
  omega?: number;
}) {
  const n = nx * nz, wet = new Uint8Array(n), fixed = new Uint8Array(n), phi = new Float32Array(n);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      phi[k] = 1 - i / (nx - 1);
      if (depth[k] <= 0.04) continue;
      wet[k] = 1;
      if (isInflow(i, j)) {
        fixed[k] = 1;
        phi[k] = 1;
      } else if (isOutflow(i, j)) {
        fixed[k] = 2;
        phi[k] = 0;
      }
    }
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const free: number[] = [];
  for (let k = 0; k < n; k++) if (wet[k] && !fixed[k]) free.push(k);
  const nb = new Int32Array(free.length * 4).fill(-1), wt = new Float32Array(free.length * 4);
  free.forEach((k, f) => {
    const i = k % nx, j = (k / nx) | 0;
    NB.forEach(([di, dj], q) => {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= nz) return;
      const m = b * nx + a;
      if (!wet[m]) return;
      nb[f * 4 + q] = m;
      wt[f * 4 + q] = (2 * depth[k] * depth[m]) / (depth[k] + depth[m]);
    });
  });
  for (let it = 0; it < iters; it++)
    for (let f = 0; f < free.length; f++) {
      let s = 0, w = 0;
      for (let q = 0; q < 4; q++) {
        const m = nb[f * 4 + q];
        if (m < 0) continue;
        s += wt[f * 4 + q] * phi[m];
        w += wt[f * 4 + q];
      }
      if (w > 0) {
        const k = free[f];
        phi[k] += omega * (s / w - phi[k]);
      }
    }
  let F = 0;
  free.forEach((k, f) => {
    for (let q = 0; q < 4; q++) {
      const m = nb[f * 4 + q];
      if (m >= 0 && fixed[m] === 1) F += wt[f * 4 + q] * (1 - phi[k]);
    }
  });
  const vx = new Float32Array(n), vz = new Float32Array(n), scale = F > 1e-6 ? Q / F : 0;
  let speedMax = 0;
  const P = (i: number, j: number) => (i < 0 || j < 0 || i >= nx || j >= nz || !wet[j * nx + i] ? null : phi[j * nx + i]);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!wet[k]) continue;
      const c = phi[k], l = P(i - 1, j), r = P(i + 1, j), d = P(i, j - 1), u = P(i, j + 1);
      const gx = l != null && r != null ? (r - l) / 2 : r != null ? r - c : l != null ? c - l : 0;
      const gz = d != null && u != null ? (u - d) / 2 : u != null ? u - c : d != null ? c - d : 0;
      vx[k] = (-gx * scale) / h;
      vz[k] = (-gz * scale) / h;
      speedMax = Math.max(speedMax, Math.hypot(vx[k], vz[k]));
    }
  return { vx, vz, speedMax };
}

