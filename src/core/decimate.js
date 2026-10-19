// Fewer triangles by edge collapse (quadric error). No DOM, runs in the worker.
//
// Choosing what goes: each point carries the planes of the original faces round it; an edge
// collapses to the point closest, in summed squares, to all the planes both ends carry. That
// sum alone is zero across any flat area, and then one point swallows everything round it, a
// fan of long thin triangles that grows slower to handle with every collapse (minutes on a
// hollowed plate) and reads as spikes. So a small share of the edge's squared length is added:
// on flat ground the shortest edges go first and the mesh thins evenly.
//
// Refused: a collapse that would make the surface non-manifold (link condition), turn a face
// over, make a face a sliver it was not already, gather more than MAX_FAN faces at one point,
// or pinch a rim. Open edges carry an extra plane at right angles so a rim keeps its line.
//
// Preserve surface (tol > 0) is measured, not estimated, both ways round:
//  - nothing cut in: every original point a vertex has absorbed stays within tol of the
//    faces round it after the collapse;
//  - nothing bulged out: the new point, the middle of each new face and of each new edge stay
//    within tol of the original surface.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { weld, BigMap } from './meshcheck.js';

const LEN_W = 1e-6;      // share of the squared edge length (mm2) added to a collapse's cost
const MAX_FAN = 16;      // most faces one point may gather
const SLIVER = 0.05;     // face quality (1 = equilateral) below which a new face is a sliver

/**
 * tris: Float32Array soup. opts: { target: triangle count to stop at, tol: mm (0 = no limit),
 * progress(frac, text) }. Returns { tris, before, after }.
 */
export function decimate(tris, opts = {}) {
  const { pos, idx, nv } = weld(tris);
  const nf = idx.length / 3;
  const target = Math.max(4, Math.floor(opts.target ?? 0));
  // measured on curved test parts: checking each collapse at half the limit keeps the whole
  // result inside it, since later collapses nearby move the same faces again
  const tol = opts.tol > 0 ? opts.tol * 0.5 : 0;
  const progress = opts.progress || (() => {});
  if (nf <= target) return { tris, before: nf, after: nf };

  const V = Float64Array.from(pos);
  const F = Int32Array.from(idx);
  const alive = new Uint8Array(nf).fill(1);
  const dead = new Uint8Array(nv);
  const stamp = new Int32Array(nv);
  const Q = new Float64Array(nv * 10);

  // the original points each vertex stands for, as linked lists (joining two is one step)
  let O = null, head = null, tail = null, next = null, bvh = null;
  if (tol) {
    O = Float64Array.from(pos);
    head = new Int32Array(nv); tail = new Int32Array(nv); next = new Int32Array(nv).fill(-1);
    for (let v = 0; v < nv; v++) head[v] = tail[v] = v;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pos), 3));
    g.setIndex(new THREE.BufferAttribute(Uint32Array.from(idx), 1));
    bvh = new MeshBVH(g);
  }
  const vq = new THREE.Vector3(), hit = {};
  const nearOriginal = (x, y, z) => { vq.set(x, y, z); return !!bvh.closestPointToPoint(vq, hit, 0, tol); };

  // vertex -> faces
  const vf = new Array(nv);
  for (let v = 0; v < nv; v++) vf[v] = [];
  for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) vf[F[f * 3 + k]].push(f);

  const addPlane = (v, a, b, c, d) => {
    const q = v * 10;
    Q[q] += a * a; Q[q + 1] += a * b; Q[q + 2] += a * c; Q[q + 3] += a * d;
    Q[q + 4] += b * b; Q[q + 5] += b * c; Q[q + 6] += b * d;
    Q[q + 7] += c * c; Q[q + 8] += c * d; Q[q + 9] += d * d;
  };
  // face (p, q, r) with p moved to (px, py, pz) when px is given: its normal (unnormalised) in
  // out, and its quality 4 sqrt3 area / sum of squared sides (1 equilateral, 0 flat) in out[3]
  const face = (p, q, r, px, py, pz, out) => {
    const ax = px ?? V[p * 3], ay = py ?? V[p * 3 + 1], az = pz ?? V[p * 3 + 2];
    const ux = V[q * 3] - ax, uy = V[q * 3 + 1] - ay, uz = V[q * 3 + 2] - az;
    const vx = V[r * 3] - ax, vy = V[r * 3 + 1] - ay, vz = V[r * 3 + 2] - az;
    out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
    const l = Math.hypot(out[0], out[1], out[2]);
    const s = ux * ux + uy * uy + uz * uz + vx * vx + vy * vy + vz * vz + (vx - ux) ** 2 + (vy - uy) ** 2 + (vz - uz) ** 2;
    out[3] = s > 0 ? (2 * Math.sqrt(3) * l) / s : 0;
    return l;
  };
  const n0 = new Float64Array(4), n1 = new Float64Array(4);
  for (let f = 0; f < nf; f++) {
    const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
    const l = face(a, b, c, null, null, null, n0);
    if (!(l > 0)) continue;
    const nx = n0[0] / l, ny = n0[1] / l, nz = n0[2] / l;
    const d = -(nx * V[a * 3] + ny * V[a * 3 + 1] + nz * V[a * 3 + 2]);
    addPlane(a, nx, ny, nz, d); addPlane(b, nx, ny, nz, d); addPlane(c, nx, ny, nz, d);
  }
  // open edges: a plane through the edge, at right angles to its face
  const edgeCount = new BigMap();
  const ek = (p, q) => (p < q ? p * nv + q : q * nv + p);
  for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) {
    const u = ek(F[f * 3 + k], F[f * 3 + (k + 1) % 3]);
    edgeCount.set(u, (edgeCount.get(u) || 0) + 1);
  }
  const border = new Uint8Array(nv);
  for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) {
    const p = F[f * 3 + k], q = F[f * 3 + (k + 1) % 3], r = F[f * 3 + (k + 2) % 3];
    if (edgeCount.get(ek(p, q)) !== 1) continue;
    border[p] = border[q] = 1;
    const l = face(p, q, r, null, null, null, n0);
    if (!(l > 0)) continue;
    const ex = V[q * 3] - V[p * 3], ey = V[q * 3 + 1] - V[p * 3 + 1], ez = V[q * 3 + 2] - V[p * 3 + 2];
    let sx = ey * n0[2] - ez * n0[1], sy = ez * n0[0] - ex * n0[2], sz = ex * n0[1] - ey * n0[0];
    const sl = Math.hypot(sx, sy, sz);
    if (!(sl > 0)) continue;
    sx /= sl; sy /= sl; sz /= sl;
    const d = -(sx * V[p * 3] + sy * V[p * 3 + 1] + sz * V[p * 3 + 2]);
    addPlane(p, sx, sy, sz, d); addPlane(q, sx, sy, sz, d);
  }
  edgeCount.clear();

  // collapsing (a, b): the best point, its summed squared plane distance (err), and the cost
  // that orders collapses (err plus the length share)
  const qs = new Float64Array(10);
  const best = new Float64Array(5);
  const evalQ = (x, y, z) =>
    qs[0] * x * x + 2 * qs[1] * x * y + 2 * qs[2] * x * z + 2 * qs[3] * x
    + qs[4] * y * y + 2 * qs[5] * y * z + 2 * qs[6] * y + qs[7] * z * z + 2 * qs[8] * z + qs[9];
  const cost = (a, b) => {
    for (let i = 0; i < 10; i++) qs[i] = Q[a * 10 + i] + Q[b * 10 + i];
    const ax = V[a * 3], ay = V[a * 3 + 1], az = V[a * 3 + 2], bx = V[b * 3], by = V[b * 3 + 1], bz = V[b * 3 + 2];
    let px = 0, py = 0, pz = 0, bc = Infinity;
    const tryAt = (x, y, z) => { const c = evalQ(x, y, z); if (c < bc) { bc = c; px = x; py = y; pz = z; } };
    // the 3x3 system; its answer is kept only if it lands near the edge
    const a11 = qs[0], a12 = qs[1], a13 = qs[2], a22 = qs[4], a23 = qs[5], a33 = qs[7];
    const det = a11 * (a22 * a33 - a23 * a23) - a12 * (a12 * a33 - a23 * a13) + a13 * (a12 * a23 - a22 * a13);
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2;
    if (Math.abs(det) > 1e-9 * Math.max(1e-30, a11 * a22 * a33) && !border[a] && !border[b]) {
      const r1 = -qs[3], r2 = -qs[6], r3 = -qs[8];
      const x = (r1 * (a22 * a33 - a23 * a23) - a12 * (r2 * a33 - a23 * r3) + a13 * (r2 * a23 - a22 * r3)) / det;
      const y = (a11 * (r2 * a33 - a23 * r3) - r1 * (a12 * a33 - a23 * a13) + a13 * (a12 * r3 - r2 * a13)) / det;
      const z = (a11 * (a22 * r3 - r2 * a23) - a12 * (a12 * r3 - r2 * a13) + r1 * (a12 * a23 - a22 * a13)) / det;
      if ((x - (ax + bx) / 2) ** 2 + (y - (ay + by) / 2) ** 2 + (z - (az + bz) / 2) ** 2 <= len2) tryAt(x, y, z);
    }
    tryAt((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2); tryAt(ax, ay, az); tryAt(bx, by, bz);
    const err = Math.max(0, bc);
    best[0] = px; best[1] = py; best[2] = pz; best[3] = err; best[4] = err + LEN_W * len2;
    return best;
  };

  // heap of candidate collapses (lazy: stale entries are skipped by stamp)
  let cap = 1 << 16, size = 0;
  let hc = new Float64Array(cap), he = new Float64Array(cap), ha = new Int32Array(cap), hb = new Int32Array(cap);
  let hsa = new Int32Array(cap), hsb = new Int32Array(cap), hx = new Float64Array(cap * 3);
  const grow = () => {
    cap *= 2;
    const g = (old, T, n = 1) => { const x = new T(cap * n); x.set(old); return x; };
    hc = g(hc, Float64Array); he = g(he, Float64Array); ha = g(ha, Int32Array); hb = g(hb, Int32Array);
    hsa = g(hsa, Int32Array); hsb = g(hsb, Int32Array); hx = g(hx, Float64Array, 3);
  };
  const swap = (i, j) => {
    let t = hc[i]; hc[i] = hc[j]; hc[j] = t;
    t = he[i]; he[i] = he[j]; he[j] = t;
    t = ha[i]; ha[i] = ha[j]; ha[j] = t; t = hb[i]; hb[i] = hb[j]; hb[j] = t;
    t = hsa[i]; hsa[i] = hsa[j]; hsa[j] = t; t = hsb[i]; hsb[i] = hsb[j]; hsb[j] = t;
    for (let k = 0; k < 3; k++) { t = hx[i * 3 + k]; hx[i * 3 + k] = hx[j * 3 + k]; hx[j * 3 + k] = t; }
  };
  const push = (a, b) => {
    const r = cost(a, b);
    // the summed squares are at least the worst single plane's: a collapse this far off any of
    // its own planes cannot pass the measured check, so it never enters the heap
    if (tol && r[3] > 16 * tol * tol) return;
    if (size === cap) grow();
    let i = size++;
    hc[i] = r[4]; he[i] = r[3]; ha[i] = a; hb[i] = b; hsa[i] = stamp[a]; hsb[i] = stamp[b];
    hx[i * 3] = r[0]; hx[i * 3 + 1] = r[1]; hx[i * 3 + 2] = r[2];
    while (i > 0) { const p = (i - 1) >> 1; if (hc[p] <= hc[i]) break; swap(i, p); i = p; }
  };
  const pop = () => {
    size--;
    if (size > 0) {
      swap(0, size);
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < size && hc[l] < hc[m]) m = l;
        if (r < size && hc[r] < hc[m]) m = r;
        if (m === i) break;
        swap(i, m); i = m;
      }
    }
    return size;   // the popped entry now sits at index size
  };

  const neighbours = (v, out) => {
    out.clear();
    for (const f of vf[v]) if (alive[f]) for (let k = 0; k < 3; k++) { const w = F[f * 3 + k]; if (w !== v) out.add(w); }
    return out;
  };
  const has = (f, v) => F[f * 3] === v || F[f * 3 + 1] === v || F[f * 3 + 2] === v;
  const na = new Set(), nb = new Set();
  for (let v = 0; v < nv; v++) {
    neighbours(v, na);
    for (const w of na) if (w > v) push(v, w);
  }

  let faces = nf, steps = 0;
  const fan = [];
  const total = nf - target;
  while (size > 0 && faces > target) {
    const e = pop();
    const a = ha[e], b = hb[e];
    if (dead[a] || dead[b] || hsa[e] !== stamp[a] || hsb[e] !== stamp[b]) continue;
    const px = hx[e * 3], py = hx[e * 3 + 1], pz = hx[e * 3 + 2];

    // link condition: the ends may share only the far corners of the faces on the edge
    neighbours(a, na); neighbours(b, nb);
    if (!na.has(b)) continue;
    let shared = 0, onEdge = 0, after = 0;
    for (const w of na) if (nb.has(w)) shared++;
    for (const f of vf[a]) if (alive[f]) { if (has(f, b)) onEdge++; else after++; }
    for (const f of vf[b]) if (alive[f] && !has(f, a)) after++;
    if (shared !== onEdge || onEdge === 0) continue;
    if (border[a] && border[b] && onEdge !== 1) continue;   // would pinch a rim
    if (na.size + nb.size - shared - 2 < 3) continue;       // would leave a tetrahedron's last faces
    if (after > MAX_FAN) continue;                         // one point gathering too much

    // no face may turn over, or become a sliver it was not
    let ok = true;
    fan.length = 0;
    for (const v of [a, b]) {
      for (const f of vf[v]) {
        if (!alive[f] || (has(f, a) && has(f, b))) continue;
        const k = F[f * 3] === v ? 0 : F[f * 3 + 1] === v ? 1 : 2;
        const p = F[f * 3 + k], q = F[f * 3 + (k + 1) % 3], r = F[f * 3 + (k + 2) % 3];
        const l0 = face(p, q, r, null, null, null, n0);
        const l1 = face(p, q, r, px, py, pz, n1);
        if (!(l1 > 1e-12) || (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) < 0.2 * l0 * l1) { ok = false; break; }
        if (n1[3] < SLIVER && n1[3] < n0[3]) { ok = false; break; }
        if (tol) fan.push(px, py, pz, V[q * 3], V[q * 3 + 1], V[q * 3 + 2], V[r * 3], V[r * 3 + 1], V[r * 3 + 2]);
      }
      if (!ok) break;
    }
    if (!ok) continue;

    if (tol && he[e] > tol * tol * 1e-4) {
      // (flat: on every plane it stands for, the new faces lie in the old ones; nothing to measure)
      if (!nearOriginal(px, py, pz)) continue;
      for (let i = 0; i < fan.length && ok; i += 9) {
        // the middle of each new face, and of its edge leaving the new point (the far edge has not moved)
        if (!nearOriginal((fan[i] + fan[i + 3] + fan[i + 6]) / 3, (fan[i + 1] + fan[i + 4] + fan[i + 7]) / 3, (fan[i + 2] + fan[i + 5] + fan[i + 8]) / 3)) ok = false;
        else if (!nearOriginal((fan[i] + fan[i + 3]) / 2, (fan[i + 1] + fan[i + 4]) / 2, (fan[i + 2] + fan[i + 5]) / 2)) ok = false;
      }
      const tt = tol * tol;
      for (const v of [a, b]) {
        for (let o = head[v]; o >= 0 && ok; o = next[o]) {
          const ox = O[o * 3], oy = O[o * 3 + 1], oz = O[o * 3 + 2];
          let near = false;
          for (let i = 0; i < fan.length; i += 9) if (triDist2(fan, i, ox, oy, oz) <= tt) { near = true; break; }
          if (!near) ok = false;
        }
      }
      if (!ok) continue;
    }

    // collapse b into a
    const keep = [];
    for (const f of vf[a]) if (alive[f]) keep.push(f);
    for (const f of vf[b]) {
      if (!alive[f]) continue;
      if (has(f, a)) { alive[f] = 0; faces--; continue; }
      for (let k = 0; k < 3; k++) if (F[f * 3 + k] === b) F[f * 3 + k] = a;
      keep.push(f);
    }
    vf[a] = keep.filter(f => alive[f]);
    vf[b] = [];
    dead[b] = 1;
    border[a] |= border[b];
    V[a * 3] = px; V[a * 3 + 1] = py; V[a * 3 + 2] = pz;
    for (let i = 0; i < 10; i++) Q[a * 10 + i] += Q[b * 10 + i];
    if (tol) { next[tail[a]] = head[b]; tail[a] = tail[b]; }
    stamp[a]++;
    neighbours(a, na);
    for (const w of na) push(a, w);
    if (++steps % 5000 === 0) progress(Math.min(0.99, (nf - faces) / total), 'simplifying');
  }

  const out = new Float32Array(faces * 9);
  let o = 0;
  for (let f = 0; f < nf; f++) {
    if (!alive[f]) continue;
    for (let k = 0; k < 3; k++) {
      const v = F[f * 3 + k] * 3;
      out[o++] = V[v]; out[o++] = V[v + 1]; out[o++] = V[v + 2];
    }
  }
  return { tris: out, before: nf, after: faces };
}

/** Bytes a binary STL of n triangles takes. */
export const stlBytes = n => 84 + 50 * n;

export function sizeText(bytes) {
  return bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
}

/** Squared distance from (px, py, pz) to triangle t[i..i+8] (closest point by region). */
function triDist2(t, i, px, py, pz) {
  const ax = t[i], ay = t[i + 1], az = t[i + 2], bx = t[i + 3], by = t[i + 4], bz = t[i + 5], cx = t[i + 6], cy = t[i + 7], cz = t[i + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; }
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v; }
    else if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; }
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w; }
    else if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
      const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      qx = bx + (cx - bx) * w; qy = by + (cy - by) * w; qz = bz + (cz - bz) * w;
    } else {
      const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
      qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}
