// Steady surface flow for the 3D water: purely visual (drifting duckweed, leaning plants,
// streaks on the water). The sim's own routing lives in src/sim/grid.ts.
// Solves div(T grad phi) = 0 with T = depth, phi = 1 on inflow cells and 0 on outflow
// cells, no flow at shores. Velocity = -grad(phi), scaled so total inflow equals Q.
// Ported from the Marsh Specimen Bench artifact.

export interface FlowField {
  vx: Float32Array;
  vz: Float32Array;
  wet: Uint8Array;
  speedMax: number;
}

export function solveSteadyFlow(opts: {
  nx: number;
  nz: number;
  depth: Float32Array;
  isInflow: (i: number, j: number) => boolean;
  isOutflow: (i: number, j: number) => boolean;
  Q: number;
  h: number;
  iters?: number;
  omega?: number;
}): FlowField {
  const { nx, nz, depth, isInflow, isOutflow, Q, h, iters = 1400, omega = 1.85 } = opts;
  const n = nx * nz;
  const wet = new Uint8Array(n);
  const fixed = new Uint8Array(n);
  const phi = new Float32Array(n);
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
  const NB = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const free: number[] = [];
  for (let k = 0; k < n; k++) if (wet[k] && !fixed[k]) free.push(k);
  const nb = new Int32Array(free.length * 4).fill(-1);
  const wt = new Float32Array(free.length * 4);
  free.forEach((k, f) => {
    const i = k % nx;
    const j = (k / nx) | 0;
    NB.forEach(([di, dj], q) => {
      const a = i + di;
      const b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= nz) return;
      const m = b * nx + a;
      if (!wet[m]) return;
      nb[f * 4 + q] = m;
      wt[f * 4 + q] = (2 * depth[k] * depth[m]) / (depth[k] + depth[m]);
    });
  });
  for (let it = 0; it < iters; it++)
    for (let f = 0; f < free.length; f++) {
      let s = 0;
      let w = 0;
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
  // Total inflow (solver units), and which water bodies connect inflow to outflow.
  let F = 0;
  free.forEach((k, f) => {
    for (let q = 0; q < 4; q++) {
      const m = nb[f * 4 + q];
      if (m >= 0 && fixed[m] === 1) F += wt[f * 4 + q] * (1 - phi[k]);
    }
  });
  const comp = new Int32Array(n).fill(-1);
  const active: boolean[] = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (!wet[s0] || comp[s0] >= 0) continue;
    const id = active.length;
    const st = [s0];
    let hasIn = false;
    let hasOut = false;
    comp[s0] = id;
    while (st.length) {
      const k = st.pop()!;
      if (fixed[k] === 1) hasIn = true;
      if (fixed[k] === 2) hasOut = true;
      const i = k % nx;
      const j = (k / nx) | 0;
      for (const [di, dj] of NB) {
        const a = i + di;
        const b = j + dj;
        if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
        const m = b * nx + a;
        if (wet[m] && comp[m] < 0) {
          comp[m] = id;
          st.push(m);
        }
      }
    }
    active.push(hasIn && hasOut);
  }
  const vx = new Float32Array(n);
  const vz = new Float32Array(n);
  const scale = F > 1e-6 ? Q / F : 0;
  let speedMax = 0;
  const P = (i: number, j: number) => (i < 0 || j < 0 || i >= nx || j >= nz || !wet[j * nx + i] ? null : phi[j * nx + i]);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!wet[k] || !active[comp[k]]) continue;
      const c = phi[k];
      const l = P(i - 1, j);
      const r = P(i + 1, j);
      const d = P(i, j - 1);
      const u = P(i, j + 1);
      const gx = l != null && r != null ? (r - l) / 2 : r != null ? r - c : l != null ? c - l : 0;
      const gz = d != null && u != null ? (u - d) / 2 : u != null ? u - c : d != null ? c - d : 0;
      vx[k] = (-gx * scale) / h;
      vz[k] = (-gz * scale) / h;
      speedMax = Math.max(speedMax, Math.hypot(vx[k], vz[k]));
    }
  return { vx, vz, wet, speedMax };
}
