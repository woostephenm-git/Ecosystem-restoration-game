// Bakes the Marsh Specimen Bench terrain into map data: npm run gen-map
// The terrain formula is ported unchanged from the bench artifact. Run once; the
// outputs are ordinary data files that can be edited by hand afterwards.
//   data/maps/clearwater_pond.json     tiles, bodies, inlets, outlets (read by the sim)
//   data/terrain/clearwater_pond.json  fine heightfield over the playable area and backdrop (read by the renderer)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const N = 12; // playable tiles per side
const TILE_M = 25;
const WATER_LEVEL = 0; // terrain units are metres vertically, tiles horizontally
const DATUM = 10; // bed elevation is stored above this datum so it stays positive
const MIN_DEPTH = 0.1; // a tile is water when its mean depth exceeds this
const WMIN = -18;
const WMAX = N + 18;
const RES = 3; // heightfield samples per tile

/* ---- Terrain formula, verbatim from the bench ---- */
function hash2(x: number, y: number) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number) {
  return 0.5 * vnoise(x, y) + 0.3 * vnoise(x * 2.1 + 5.2, y * 2.1 + 1.3) + 0.2 * vnoise(x * 4.3 + 9.1, y * 4.3 + 3.7);
}
function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
function distSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const vx = bx - ax, vz = bz - az, t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz)));
  return Math.hypot(px - ax - vx * t, pz - az - vz * t);
}
const CHANNELS: [number, number][][] = [
  [[-22, 0.5], [-16, 2.8], [-11, 2.2], [-6.5, 3.6], [-3, 3.9], [-0.2, 4.4], [1.3, 4.9], [2.6, 5.7], [3.8, 6.0], [4.8, 6.3]],
  [[10.0, 7.2], [12.4, 7.9], [14.8, 9.4], [18.5, 9.8], [23, 12.2], [32, 13.5]],
];
function H(x: number, z: number) {
  let h = 0.2 + 0.32 * fbm(x * 0.22 + 3, z * 0.22 + 7) + 0.35 * (fbm(x * 0.06 + 40, z * 0.06 + 12) - 0.45);
  h += 0.6 * Math.exp(-((x - 10.2) ** 2 + (z - 2.0) ** 2) / 5);
  h += 1.1 * Math.exp(-((x - 18) ** 2 + (z + 5) ** 2) / 30) + 0.9 * Math.exp(-((x + 7) ** 2 + (z + 4) ** 2) / 22);
  const lr = Math.hypot((x + 7) / 4.2, (z - 16) / 3.2) + 0.3 * (fbm(x * 0.4, z * 0.4 + 9) - 0.5);
  h -= 1.6 * smooth(1.2, 0.0, lr);
  const dx = (x - 7.0) / 3.5, dz = (z - 6.6) / 2.9;
  const r = Math.hypot(dx, dz) + 0.28 * (fbm(x * 0.5 + 11, z * 0.5 + 2) - 0.5);
  h -= 2.0 * smooth(1.25, 0.0, r);
  let dmin = 1e9;
  for (const C of CHANNELS) for (let i = 0; i < C.length - 1; i++) dmin = Math.min(dmin, distSeg(x, z, ...C[i], ...C[i + 1]));
  {
    const cb = smooth(0.9, 0.1, dmin + 0.15 * (vnoise(x * 1.5, z * 1.5) - 0.5));
    h = h + (Math.min(h, -0.32 + 0.08 * (vnoise(x * 0.7 + 3, z * 0.7) - 0.5)) - h) * cb;
  }
  const pr = Math.hypot(x - 2.3, z - 9.5) / 1.35 + 0.15 * (fbm(x + 4, z + 8) - 0.5);
  h -= 1.2 * smooth(1.15, 0.05, pr);
  return h;
}
/* ---- End of verbatim terrain ---- */

const channelDist = (x: number, z: number, c: number) => {
  let d = 1e9;
  const C = CHANNELS[c];
  for (let i = 0; i < C.length - 1; i++) d = Math.min(d, distSeg(x, z, ...C[i], ...C[i + 1]));
  return d;
};
const id = (i: number, j: number) => `${'ABCDEFGHIJKL'[i]}${j + 1}`;
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

// Mean bed height of each tile, from a 6x6 sample.
const bed: number[][] = [];
for (let j = 0; j < N; j++) {
  bed.push([]);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) s += H(i + (a + 0.5) / 6, j + (b + 0.5) / 6);
    bed[j].push(s / 36);
  }
}
// Channels are narrower than a tile, so a tile's mean depth can miss them. A tile that a
// channel runs through counts as water with the channel's own depth.
const channelDepth: number[][] = [];
for (let j = 0; j < N; j++) {
  channelDepth.push([]);
  for (let i = 0; i < N; i++) {
    let deepest = 0;
    for (let a = 0; a < 6; a++)
      for (let b = 0; b < 6; b++) {
        const x = i + (a + 0.5) / 6, z = j + (b + 0.5) / 6;
        if (Math.min(channelDist(x, z, 0), channelDist(x, z, 1)) < 0.35) deepest = Math.max(deepest, WATER_LEVEL - H(x, z));
      }
    channelDepth[j].push(deepest);
  }
}
const depthAt = (i: number, j: number) => Math.max(WATER_LEVEL - bed[j][i], channelDepth[j][i] > 0.2 ? channelDepth[j][i] : -Infinity);
const wet = (i: number, j: number) => depthAt(i, j) > MIN_DEPTH;

// Water bodies: 4-connected components of water tiles.
const body = bed.map((row) => row.map(() => -1));
const bodies: { i: number; j: number }[][] = [];
for (let j = 0; j < N; j++)
  for (let i = 0; i < N; i++) {
    if (!wet(i, j) || body[j][i] >= 0) continue;
    const k = bodies.length;
    const st = [{ i, j }];
    const tiles: { i: number; j: number }[] = [];
    body[j][i] = k;
    while (st.length) {
      const t = st.pop()!;
      tiles.push(t);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = t.i + di, b = t.j + dj;
        if (a < 0 || b < 0 || a >= N || b >= N || body[b][a] >= 0 || !wet(a, b)) continue;
        body[b][a] = k;
        st.push({ i: a, j: b });
      }
    }
    bodies.push(tiles);
  }

// Inlet: the wet tile on the west edge nearest the inflow channel. Outlet: same on the east edge.
const edgeTile = (i: number, channel: number) => {
  const cands = Array.from({ length: N }, (_, j) => j).filter((j) => wet(i, j));
  cands.sort((a, b) => channelDist(i + 0.5, a + 0.5, channel) - channelDist(i + 0.5, b + 0.5, channel));
  if (!cands.length) throw new Error(`No wet tile on column ${i} for channel ${channel}`);
  return cands[0];
};
const inletJ = edgeTile(0, 0);
const outletJ = edgeTile(N - 1, 1);
const pondBody = body[inletJ][0];
if (body[outletJ][N - 1] !== pondBody) console.warn(`WARNING: inlet ${id(0, inletJ)} and outlet ${id(N - 1, outletJ)} are in different water bodies`);
const bodyIds = bodies.map((_, k) => (k === pondBody ? 'clearwater_pond' : `pond_${k}`));

function describe(i: number, j: number): string {
  const d = depthAt(i, j);
  const near = (c: number) => channelDist(i + 0.5, j + 0.5, c) < 0.8;
  if (wet(i, j) && near(0)) return 'Inlet channel';
  if (wet(i, j) && near(1)) return 'Outlet channel';
  if (d > 1.2) return 'Open water';
  if (d > 0.3) return 'Shallow water';
  if (d > 0) return 'Littoral margin';
  if (d > -0.3) return 'Wet meadow';
  return 'Upland';
}

// Distance (in tiles) to the inlet, for seeding legacy phosphorus where inflow sediment settles.
const tiles = [];
for (let j = 0; j < N; j++)
  for (let i = 0; i < N; i++) {
    const d = depthAt(i, j);
    const w = wet(i, j);
    const initial: Record<string, number> = { bed_elevation: round(DATUM + bed[j][i]), water_depth: w ? round(d, 2) : 0 };
    if (w) {
      const fromInlet = Math.hypot(i, j - inletJ);
      initial.legacy_p = round(1.0 + 0.45 * Math.min(d, 1.8) + (fromInlet < 3 ? 0.4 : 0), 2);
    }
    const t: Record<string, unknown> = { id: id(i, j), row: j, col: i, description: describe(i, j), initial };
    if (w) t.body = bodyIds[body[j][i]];
    tiles.push(t);
  }

const pondTiles = bodies[pondBody];
const volume = pondTiles.reduce((s, t) => s + TILE_M * TILE_M * depthAt(t.i, t.j), 0);

const map = {
  id: 'clearwater_pond',
  name: 'Clearwater Pond',
  rows: N,
  cols: N,
  tile_size_m: TILE_M,
  terrain: 'terrain/clearwater_pond.json',
  water_level: DATUM + WATER_LEVEL,
  mixing_m2_per_day: 125,
  // Raising the outlet weir lifts the pond surface; low meadow floods once under 10 cm of water.
  // Flooded meadow starts bare and fish-free, and rewetted soil releases some phosphorus.
  level_variable: 'weir_rise',
  flood_depth: MIN_DEPTH,
  flood_initial: { plant_cover: 0, carp: 0, legacy_p: 2.5 },
  bodies: bodies.map((_, k) => ({
    id: bodyIds[k],
    name: k === pondBody ? 'Clearwater Pond' : `Hollow pond ${String.fromCharCode(65 + bodyIds.slice(0, k).filter((b) => b !== 'clearwater_pond').length)}`,
    simulated: k === pondBody,
  })),
  defaults: { suspended_sediment: 40, chla: 50, total_p: 100, nitrate: 1.5, legacy_p: 1.4, carp: 400, plant_cover: 0.5 },
  tiles,
  inlets: [{ tile: id(0, inletJ), face: 'W', name: 'West inlet channel', share: 1 }],
  outlets: [{ tile: id(N - 1, outletJ), face: 'E', name: 'East outlet channel' }],
};

const heights: number[] = [];
const G = (WMAX - WMIN) * RES;
for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) heights.push(round(H(WMIN + i / RES, WMIN + j / RES)));
const terrain = { id: 'clearwater_pond', origin: WMIN, size: WMAX - WMIN, resolution: RES, playable: N, water_level: WATER_LEVEL, channels: CHANNELS, heights };

const out = (p: string) => fileURLToPath(new URL(`../data/${p}`, import.meta.url));
writeFileSync(out('maps/clearwater_pond.json'), JSON.stringify(map, null, 1) + '\n');
writeFileSync(out('terrain/clearwater_pond.json'), JSON.stringify(terrain) + '\n');

// Summary for the person running the script.
console.log(`Water bodies: ${bodies.map((b, k) => `${bodyIds[k]} (${b.length} tiles)`).join(', ')}`);
console.log(`Pond: ${pondTiles.length} tiles, volume ${Math.round(volume)} m³, inlet ${id(0, inletJ)}, outlet ${id(N - 1, outletJ)}`);
console.log('    ' + Array.from({ length: N }, (_, i) => 'ABCDEFGHIJKL'[i].padStart(4)).join(''));
for (let j = 0; j < N; j++) {
  console.log(
    String(j + 1).padStart(3) +
      ' ' +
      Array.from({ length: N }, (_, i) => {
        if (!wet(i, j)) return depthAt(i, j) > -0.3 ? '   ,' : '   .';
        const tag = body[j][i] === pondBody ? '' : '*';
        return (tag + depthAt(i, j).toFixed(1)).padStart(4);
      }).join(''),
  );
}
console.log("Legend: depth in m for water tiles, * = not the main pond, ',' wet meadow, '.' upland");
