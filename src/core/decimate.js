// Quadric edge collapse. No DOM, runs in the worker.
//
// Each vertex carries the planes of the original faces around it (one plane per face, not
// weighted by area). An edge collapses to the point that is closest, in summed squares, to
// all the planes both ends carry; the cheapest collapse goes first.
//
// Preserve surface (tol > 0) is measured, not estimated, both ways round:
//  - nothing cut in: every original point a vertex has absorbed stays within tol of the
//    faces around it after the collapse;
//  - nothing bulged out: the new point and the middle of each new face stay within tol of
//    the original surface.
//
// A collapse is refused when it would make the surface non-manifold (link condition), turn
// a face over, or leave a sliver. Open edges get an extra plane at right angles so a rim
// keeps its line.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { weld, BigMap } from './meshcheck.js';

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
  const O = Float64Array.from(pos);   // original points
  let own = null, bvh = null;
  if (tol) {
    own = new Array(nv);
    for (let v = 0; v < nv; v++) own[v] = [v];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pos), 3));
    g.setIndex(new THREE.BufferAttribute(Uint32Array.from(idx), 1));
    bvh = new MeshBVH(g);
  }
  const vq = new THREE.Vector3(), hit = {};
  const nearOriginal = (x, y, z) => { vq.set(x, y, z); return !!bvh.closestPointToPoint(vq, hit, 0, tol); };
  const F = Int32Array.from(idx);
  const alive = new Uint8Array(nf).fill(1);
  const Q = new Float64Array(nv * 10);
  const stamp = new Int32Array(nv);
  const dead = new Uint8Array(nv);

  // vertex -> faces
  const deg = new Int32Array(nv);
  for (let i = 0; i < F.length; i++) deg[F[i]]++;
  const vf = new Array(nv);
  for (let v = 0; v < nv; v++) vf[v] = [];
  for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) vf[F[f * 3 + k]].push(f);

  const addPlane = (v, a, b, c, d, w = 1) => {
    const q = v * 10;
    Q[q] += w * a * a; Q[q + 1] += w * a * b; Q[q + 2] += w * a * c; Q[q + 3] += w * a * d;
    Q[q + 4] += w * b * b; Q[q + 5] += w * b * c; Q[q + 6] += w * b * d;
    Q[q + 7] += w * c * c; Q[q + 8] += w * c * d; Q[q + 9] += w * d * d;
  };
  const normal = (a, b, c, px, py, pz, out) => {
    // face (a, b, c) with vertex a moved to (px, py, pz) when px is not null
    const ax = px ?? V[a * 3], ay = py ?? V[a * 3 + 1], az = pz ?? V[a * 3 + 2];
    const ux = V[b * 3] - ax, uy = V[b * 3 + 1] - ay, uz = V[b * 3 + 2] - az;
    const vx = V[c * 3] - ax, vy = V[c * 3 + 1] - ay, vz = V[c * 3 + 2] - az;
    out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
    return Math.hypot(out[0], out[1], out[2]);
  };
  const nrm = [0, 0, 0];
  for (let f = 0; f < nf; f++) {
    const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
    const l = normal(a, b, c, null, null, null, nrm);
    if (!(l > 0)) continue;
    const nx = nrm[0] / l, ny = nrm[1] / l, nz = nrm[2] / l;
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
    const l = normal(p, q, r, null, null, null, nrm);
    if (!(l > 0)) continue;
    const ex = V[q * 3] - V[p * 3], ey = V[q * 3 + 1] - V[p * 3 + 1], ez = V[q * 3 + 2] - V[p * 3 + 2];
    let sx = ey * nrm[2] - ez * nrm[1], sy = ez * nrm[0] - ex * nrm[2], sz = ex * nrm[1] - ey * nrm[0];
    const sl = Math.hypot(sx, sy, sz);
    if (!(sl > 0)) continue;
    sx /= sl; sy /= sl; sz /= sl;
    const d = -(sx * V[p * 3] + sy * V[p * 3 + 1] + sz * V[p * 3 + 2]);
    addPlane(p, sx, sy, sz, d); addPlane(q, sx, sy, sz, d);
  }
  edgeCount.clear();

  // cost of collapsing (a, b): best point and its summed squared plane distance
  const qs = new Float64Array(10);
  const best = new Float64Array(4);
  const evalQ = (x, y, z) =>
    qs[0] * x * x + 2 * qs[1] * x * y + 2 * qs[2] * x * z + 2 * qs[3] * x
    + qs[4] * y * y + 2 * qs[5] * y * z + 2 * qs[6] * y + qs[7] * z * z + 2 * qs[8] * z + qs[9];
  const cost = (a, b) => {
    for (let i = 0; i < 10; i++) qs[i] = Q[a * 10 + i] + Q[b * 10 + i];
    const ax = V[a * 3], ay = V[a * 3 + 1], az = V[a * 3 + 2], bx = V[b * 3], by = V[b * 3 + 1], bz = V[b * 3 + 2];
    let bxp = 0, byp = 0, bzp = 0, bc = Infinity;
    const tryAt = (x, y, z) => { const c = evalQ(x, y, z); if (c < bc) { bc = c; bxp = x; byp = y; bzp = z; } };
    // solve the 3x3 system; keep the answer only if it lands near the edge
    const a11 = qs[0], a12 = qs[1], a13 = qs[2], a22 = qs[4], a23 = qs[5], a33 = qs[7];
    const det = a11 * (a22 * a33 - a23 * a23) - a12 * (a12 * a33 - a23 * a13) + a13 * (a12 * a23 - a22 * a13);
    const scale = Math.max(1e-30, a11 * a22 * a33);
    if (Math.abs(det) > 1e-9 * scale && !border[a] && !border[b]) {
      const r1 = -qs[3], r2 = -qs[6], r3 = -qs[8];
      const x = (r1 * (a22 * a33 - a23 * a23) - a12 * (r2 * a33 - a23 * r3) + a13 * (r2 * a23 - a22 * r3)) / det;
      const y = (a11 * (r2 * a33 - a23 * r3) - r1 * (a12 * a33 - a23 * a13) + a13 * (a12 * r3 - r2 * a13)) / det;
      const z = (a11 * (a22 * r3 - r2 * a23) - a12 * (a12 * r3 - r2 * a13) + r1 * (a12 * a23 - a22 * a13)) / det;
      const len = Math.hypot(bx - ax, by - ay, bz - az);
      const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
      if (Math.hypot(x - mx, y - my, z - mz) <= len) tryAt(x, y, z);
    }
    tryAt(ax, ay, az); tryAt(bx, by, bz); tryAt((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    best[0] = bxp; best[1] = byp; best[2] = bzp; best[3] = Math.max(0, bc);
    return best;
  };

  // heap of edge candidates (lazy: stale entries are skipped by stamp)
  let cap = 1 << 16, size = 0;
  let hc = new Float64Array(cap), ha = new Int32Array(cap), hb = new Int32Array(cap), hsa = new Int32Array(cap), hsb = new Int32Array(cap);
  let hx = new Float64Array(cap * 3);
  const grow = () => {
    cap *= 2;
    const g = (old, T, n = 1) => { const x = new T(cap * n); x.set(old); return x; };
    hc = g(hc, Float64Array); ha = g(ha, Int32Array); hb = g(hb, Int32Array); hsa = g(hsa, Int32Array); hsb = g(hsb, Int32Array); hx = g(hx, Float64Array, 3);
  };
  const swap = (i, j) => {
    let t = hc[i]; hc[i] = hc[j]; hc[j] = t;
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
    hc[i] = r[3]; ha[i] = a; hb[i] = b; hsa[i] = stamp[a]; hsb[i] = stamp[b];
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
  const na = new Set(), nb = new Set();
  for (let v = 0; v < nv; v++) {
    neighbours(v, na);
    for (const w of na) if (w > v) push(v, w);
  }

  let faces = nf;
  const n0 = [0, 0, 0], n1 = [0, 0, 0], fan = [];
  const total = nf - target;
  let steps = 0;
  while (size > 0 && faces > target) {
    const e = pop();
    const a = ha[e], b = hb[e];
    if (dead[a] || dead[b] || hsa[e] !== stamp[a] || hsb[e] !== stamp[b]) continue;
    const px = hx[e * 3], py = hx[e * 3 + 1], pz = hx[e * 3 + 2];

    // link condition: the ends may share only the far corners of the faces on the edge
    neighbours(a, na); neighbours(b, nb);
    if (!na.has(b)) continue;
    let shared = 0, onEdge = 0;
    for (const w of na) if (nb.has(w)) shared++;
    for (const f of vf[a]) if (alive[f] && (F[f * 3] === b || F[f * 3 + 1] === b || F[f * 3 + 2] === b)) onEdge++;
    if (shared !== onEdge || onEdge === 0) continue;
    if (border[a] && border[b] && onEdge !== 1) continue;   // would pinch a rim
    if (na.size + nb.size - shared - 2 < 3) continue;       // would leave a tetrahedron's last faces

    // no face may turn over or shrink to a sliver
    let ok = true;
    for (const v of [a, b]) {
      for (const f of vf[v]) {
        if (!alive[f]) continue;
        const i0 = F[f * 3], i1 = F[f * 3 + 1], i2 = F[f * 3 + 2];
        if ((i0 === a || i1 === a || i2 === a) && (i0 === b || i1 === b || i2 === b)) continue;
        const k = i0 === v ? 0 : i1 === v ? 1 : 2;
        const p = F[f * 3 + k], q = F[f * 3 + (k + 1) % 3], r = F[f * 3 + (k + 2) % 3];
        const l0 = normal(p, q, r, null, null, null, n0);
        const l1 = normal(p, q, r, px, py, pz, n1);
        if (!(l1 > 1e-12) || (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) < 0.2 * l0 * l1) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (!ok) continue;

    if (tol) {
      // the faces round a after the collapse
      fan.length = 0;
      for (const v of [a, b]) for (const f of vf[v]) {
        if (!alive[f]) continue;
        const i0 = F[f * 3], i1 = F[f * 3 + 1], i2 = F[f * 3 + 2];
        if ((i0 === a || i1 === a || i2 === a) && (i0 === b || i1 === b || i2 === b)) continue;
        for (const w of [i0, i1, i2]) {
          if (w === a || w === b) fan.push(px, py, pz);
          else fan.push(V[w * 3], V[w * 3 + 1], V[w * 3 + 2]);
        }
      }
      // on every plane it stands for (flat areas): the new faces lie in the old ones, so only
      // the absorbed points need checking
      const flat = hc[e] <= tol * tol * 1e-4;
      if (!flat && !nearOriginal(px, py, pz)) continue;
      for (let i = 0; i < fan.length && ok && !flat; i += 9) {
        if (!nearOriginal((fan[i] + fan[i + 3] + fan[i + 6]) / 3, (fan[i + 1] + fan[i + 4] + fan[i + 7]) / 3, (fan[i + 2] + fan[i + 5] + fan[i + 8]) / 3)) ok = false;
        // and the middle of the edge leaving the new point (the far edge has not moved; the
        // other edge at the point is the next face's)
        for (let e = 0; e < 3 && ok; e++) {
          const j = i + e * 3, k = i + ((e + 1) % 3) * 3;
          if (fan[j] !== px || fan[j + 1] !== py || fan[j + 2] !== pz) continue;
          if (!nearOriginal((fan[j] + fan[k]) / 2, (fan[j + 1] + fan[k + 1]) / 2, (fan[j + 2] + fan[k + 2]) / 2)) ok = false;
        }
      }
      if (!ok) continue;
      const tt = tol * tol;
      for (const list of flat ? [] : [own[a], own[b]]) {
        for (const o of list) {
          const ox = O[o * 3], oy = O[o * 3 + 1], oz = O[o * 3 + 2];
          let near = false;
          for (let i = 0; i < fan.length; i += 9) if (triDist2(fan, i, ox, oy, oz) <= tt) { near = true; break; }
          if (!near) { ok = false; break; }
        }
        if (!ok) break;
      }
      if (!ok) continue;
    }

    // collapse b into a
    for (const f of vf[b]) {
      if (!alive[f]) continue;
      const i0 = F[f * 3], i1 = F[f * 3 + 1], i2 = F[f * 3 + 2];
      if (i0 === a || i1 === a || i2 === a) { alive[f] = 0; faces--; continue; }
      for (let k = 0; k < 3; k++) if (F[f * 3 + k] === b) F[f * 3 + k] = a;
      vf[a].push(f);
    }
    vf[a] = vf[a].filter(f => alive[f]);
    vf[b] = [];
    dead[b] = 1;
    border[a] = border[a] | border[b];
    V[a * 3] = px; V[a * 3 + 1] = py; V[a * 3 + 2] = pz;
    for (let i = 0; i < 10; i++) Q[a * 10 + i] += Q[b * 10 + i];
    if (own) { for (const o of own[b]) own[a].push(o); own[b] = null; }
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
