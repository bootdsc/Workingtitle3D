// Mesh welding, repair and the closed-solid check. No DOM, runs in the worker.
import { triangulate } from './tri2d.js';
// A model is a triangle soup: Float32Array, 9 numbers per triangle, normals out.

export const WELD = 1e-4; // mm

/** A Map for numeric keys split over 64: one Map holds at most about 16.7 million entries, and a
 *  big model (or a fine hollow) has more edges than that. Same calls as a Map, as used here. */
export class BigMap {
  constructor() { this.m = Array.from({ length: 64 }, () => new Map()); }
  part(k) { return this.m[((k % 64) + 64) % 64 | 0]; }
  get(k) { return this.part(k).get(k); }
  set(k, v) { this.part(k).set(k, v); return this; }
  has(k) { return this.part(k).has(k); }
  delete(k) { return this.part(k).delete(k); }
  clear() { for (const x of this.m) x.clear(); }
  get size() { return this.m.reduce((s, x) => s + x.size, 0); }
  *entries() { for (const x of this.m) yield* x.entries(); }
  *values() { for (const x of this.m) yield* x.values(); }
  *keys() { for (const x of this.m) yield* x.keys(); }
  [Symbol.iterator]() { return this.entries(); }
}

/** Weld coincident vertices on a WELD grid. Returns positions and a 3-per-triangle index.
 *  An open-addressing table of grid cells: no strings, a few typed arrays. */
export function weld(tris, tol = WELD) {
  const n = tris.length / 3;
  const idx = new Int32Array(n);
  let cap = 16;
  while (cap < n * 2) cap *= 2;
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const Q = new Float64Array(n * 3);   // grid cell of each kept vertex
  const pos = new Float64Array(n * 3);
  let nv = 0;
  for (let i = 0; i < n; i++) {
    const x = tris[i * 3], y = tris[i * 3 + 1], z = tris[i * 3 + 2];
    const qx = Math.round(x / tol), qy = Math.round(y / tol), qz = Math.round(z / tol);
    let h = (Math.imul(qx | 0, 73856093) ^ Math.imul(qy | 0, 19349663) ^ Math.imul(qz | 0, 83492791)) & mask;
    let v;
    for (;;) {
      v = table[h];
      if (v < 0) {
        v = nv++;
        table[h] = v;
        Q[v * 3] = qx; Q[v * 3 + 1] = qy; Q[v * 3 + 2] = qz;
        pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
        break;
      }
      if (Q[v * 3] === qx && Q[v * 3 + 1] === qy && Q[v * 3 + 2] === qz) break;
      h = (h + 1) & mask;
    }
    idx[i] = v;
  }
  return { pos: pos.slice(0, nv * 3), idx, nv };
}

export function volume(tris) {
  let v = 0;
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
    const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
    const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

export function bounds(tris) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = tris[i + a];
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
  }
  return { lo, hi };
}

/** Is this a closed solid? After welding every edge is used by exactly two
 *  triangles, in opposite directions, and the volume is positive. */
export function report(tris, tol = WELD) {
  const n = tris.length / 9;
  if (!n) return { triangles: 0, openEdges: 0, oversharedEdges: 0, flippedEdges: 0, volume: 0, watertight: false, overEdges: [] };
  const { pos, idx, nv } = weld(tris, tol);
  // every edge as a number, both ways round (und) and as it runs (dir); sorted, equal edges sit
  // together and are counted in one pass (typed arrays: a fraction of the time and memory of maps)
  const und = new Float64Array(n * 3), dir = new Float64Array(n * 3);
  let m = 0;
  for (let t = 0; t < n; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    for (let e = 0; e < 3; e++) {
      const p = e === 0 ? a : e === 1 ? b : c, q = e === 0 ? b : e === 1 ? c : a;
      und[m] = p < q ? p * nv + q : q * nv + p;
      dir[m++] = p * nv + q;
    }
  }
  const U = und.subarray(0, m).sort(), D = dir.subarray(0, m).sort();
  let open = 0, over = 0, flip = 0;
  const overEdges = [];   // [x1, y1, z1, x2, y2, z2] of each over-shared edge: where pieces only touch
  for (let i = 0; i < m;) {
    let j = i + 1;
    while (j < m && U[j] === U[i]) j++;
    const c = j - i;
    if (c === 1) open++;
    else if (c > 2) {
      over++;
      const p = Math.floor(U[i] / nv), q = U[i] % nv;
      if (overEdges.length < 20000) overEdges.push([pos[p * 3], pos[p * 3 + 1], pos[p * 3 + 2], pos[q * 3], pos[q * 3 + 1], pos[q * 3 + 2]]);
    }
    i = j;
  }
  for (let i = 0; i < m;) {
    let j = i + 1;
    while (j < m && D[j] === D[i]) j++;
    if (j - i > 1) flip++;
    i = j;
  }
  const vol = volume(tris);
  return { triangles: n, openEdges: open, oversharedEdges: over, flippedEdges: flip, volume: vol,
    watertight: open === 0 && over === 0 && flip === 0 && vol > 0, overEdges };
}

/** Feature lines: every edge where the two faces meet at more than `angle` degrees, and every
 *  open edge, as segments (6 numbers each). Typed arrays and one sort, for the worker: the
 *  view's own version took 4 s on the page for 1.2 million triangles. */
export function featureEdges(tris, angle = 40) {
  const n = tris.length / 9;
  const { pos, idx, nv } = weld(tris);
  const N = new Float32Array(n * 3);
  for (let f = 0; f < n; f++) {
    const a = idx[f * 3] * 3, b = idx[f * 3 + 1] * 3, c = idx[f * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z) || 1;
    N[f * 3] = x / l; N[f * 3 + 1] = y / l; N[f * 3 + 2] = z / l;
  }
  // edges sorted by key; the face of each edge kept alongside
  const m = n * 3, K = new Float64Array(m), order = new Uint32Array(m);
  for (let i = 0; i < m; i++) {
    const p = idx[i], q = idx[i - i % 3 + (i % 3 + 1) % 3];
    K[i] = p < q ? p * nv + q : q * nv + p;
    order[i] = i;
  }
  order.sort((x, y) => K[x] - K[y]);
  const cos = Math.cos((angle * Math.PI) / 180);
  const out = [];
  const seg = i => { const p = idx[i], q = idx[i - i % 3 + (i % 3 + 1) % 3]; out.push(pos[p * 3], pos[p * 3 + 1], pos[p * 3 + 2], pos[q * 3], pos[q * 3 + 1], pos[q * 3 + 2]); };
  for (let s = 0; s < m;) {
    let e = s + 1;
    while (e < m && K[order[e]] === K[order[s]]) e++;
    const i0 = order[s];
    if (idx[i0] !== idx[i0 - i0 % 3 + (i0 % 3 + 1) % 3]) {
      if (e - s === 2) {
        const f = (order[s] / 3) | 0, g = (order[s + 1] / 3) | 0;
        if (N[f * 3] * N[g * 3] + N[f * 3 + 1] * N[g * 3 + 1] + N[f * 3 + 2] * N[g * 3 + 2] <= cos) seg(i0);
      } else seg(i0);   // open or over-shared: always drawn
    }
    s = e;
  }
  return Float32Array.from(out);
}

/** Where a mesh is not closed: every open, over-shared or wrongly turned edge as a segment
 *  (6 numbers each), for drawing. */
export function faultEdges(tris, tol = WELD) {
  const n = tris.length / 9;
  const { pos, idx, nv } = weld(tris, tol);
  const und = new BigMap(), dir = new BigMap();
  for (let t = 0; t < n; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const u = p < q ? p * nv + q : q * nv + p;
      und.set(u, (und.get(u) || 0) + 1);
      dir.set(p * nv + q, (dir.get(p * nv + q) || 0) + 1);
    }
  }
  const out = [];
  let open = 0, over = 0, flipped = 0;
  for (const [u, c] of und) {
    const p = Math.floor(u / nv), q = u % nv;
    const bad = c === 1 ? (open++, 1) : c > 2 ? (over++, 1) : (dir.get(p * nv + q) > 1 || dir.get(q * nv + p) > 1) ? (flipped++, 1) : 0;
    if (bad) out.push(pos[p * 3], pos[p * 3 + 1], pos[p * 3 + 2], pos[q * 3], pos[q * 3 + 1], pos[q * 3 + 2]);
  }
  return { segs: Float32Array.from(out), open, over, flipped };
}

/** The middle of the over-shared edges, rounded for a message. */
function overAt(rep) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const e of rep.overEdges) for (let i = 0; i < 6; i++) { lo[i % 3] = Math.min(lo[i % 3], e[i]); hi[i % 3] = Math.max(hi[i % 3], e[i]); }
  return lo.map((v, i) => +((v + hi[i]) / 2).toFixed(1));
}

/** Over-shared edges and no open ones: two pieces meet along an edge or face with nothing between them. */
export function thinWall(rep) {
  if (rep.watertight || !rep.oversharedEdges || rep.openEdges) return null;   // such an edge also counts as flipped
  const [x, y, z] = overAt(rep);
  return `Two parts touch with nothing between them, a wall of zero thickness, near X ${x}, Y ${y}, Z ${z} mm.`;
}

/** The clean-up every mesh tool owes its user: weld, drop zero-area and duplicate
 *  triangles, turn an inside-out mesh right way out. Says what it did. */
export function repair(tris, tol = WELD, opts = {}) {
  const gap = opts.gap ?? 1e-2;          // mm: points closer than this may be welded
  const maxHole = opts.maxHole ?? 0;     // mm of rim: bigger holes are left open; 0 = fill all
  const before = report(tris, tol);
  const n = tris.length / 9;
  // already a closed solid, the right way out: nothing to mend, so nothing is done (a clean
  // 800k-triangle model went from 9 s to the one check)
  if (before.watertight && before.volume > 0 && !opts.always) {
    return { tris, fixes: { welded: 0, degenerate: 0, duplicates: 0, tjunctions: 0, holes: 0, holesLeft: 0, reoriented: 0, flipped: false, before, after: before } };
  }
  let best = clean(tris, tol);
  // Gaps a little wider than the weld grid: try coarser welds up to the gap size, keep
  // whichever leaves fewest open edges. A quick repair (big imports) tries only the first; the
  // Repair tool does the full search.
  const tries = [1e-3, 1e-2, 0.03, 0.1, 0.3, 1].filter(t => t > tol && t <= gap).slice(0, opts.quick ? 1 : 99);
  if (gap > tol && !tries.includes(gap)) tries.push(gap);
  for (const t of tries) {
    if (!openCount(best.faces, best.pos.length / 3)) break;
    const c = clean(tris, t);
    if (openCount(c.faces, c.pos.length / 3) < openCount(best.faces, best.pos.length / 3)) best = c;
  }
  const pos = Array.from(best.pos), faces = best.faces;
  let reoriented = orient(pos, faces);   // holes are traced along the winding, so fix it first
  const tjunctions = splitTJunctions(pos, faces, Math.max(best.tol, Math.min(gap, 0.1)));
  const { holes, skipped } = fillHoles(pos, faces, maxHole);
  if (holes) reoriented += orient(pos, faces);
  let out = new Float32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    const v = faces[i];
    out[i * 3] = pos[v * 3]; out[i * 3 + 1] = pos[v * 3 + 1]; out[i * 3 + 2] = pos[v * 3 + 2];
  }
  let flipped = false;
  if (out.length && volume(out) < 0) { flipAll(out); flipped = true; }
  return { tris: out, fixes: { welded: n * 3 - best.nv, degenerate: best.degenerate, duplicates: best.duplicates,
    tjunctions, holes, holesLeft: skipped, reoriented, flipped, before, after: report(out, tol) } };
}

/** Weld, then drop zero-area and duplicate triangles. Faces are a flat vertex-index list. */
function clean(tris, tol) {
  const n = tris.length / 9;
  const { pos, idx, nv } = weld(tris, tol);
  let degenerate = 0, duplicates = 0;
  // sorted corners of each usable triangle; duplicates found by sorting, not by a key per face
  const A = new Int32Array(n), B = new Int32Array(n), C = new Int32Array(n), W = new Uint8Array(n), ok = new Uint8Array(n);
  const order = [];
  for (let t = 0; t < n; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    if (a === b || b === c || a === c) { degenerate++; continue; }
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz <= 1e-24) { degenerate++; continue; }
    const lo = Math.min(a, b, c), hi = Math.max(a, b, c), mid = a + b + c - lo - hi;
    A[t] = lo; B[t] = mid; C[t] = hi;
    W[t] = (a === lo ? b : b === lo ? c : a) === mid ? 1 : 0;   // which way round the sorted corners run
    ok[t] = 1;
    order.push(t);
  }
  const ord = Int32Array.from(order).sort((p, q) => A[p] - A[q] || B[p] - B[q] || C[p] - C[q] || p - q);
  // same three points: same winding is a duplicate, opposite winding is an inside wall between
  // two touching pieces, and both go
  for (let g = 0; g < ord.length;) {
    let e = g + 1;
    while (e < ord.length && A[ord[e]] === A[ord[g]] && B[ord[e]] === B[ord[g]] && C[ord[e]] === C[ord[g]]) e++;
    const first = ord[g];
    for (let k = g + 1; k < e; k++) {
      const t = ord[k];
      duplicates++;
      ok[t] = 0;
      if (ok[first] && W[t] !== W[first]) ok[first] = 0;
    }
    g = e;
  }
  const faces = [];
  for (let t = 0; t < n; t++) if (ok[t]) faces.push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
  return { pos, faces, nv, tol, degenerate, duplicates };
}

/** Undirected edge -> list of face-edge slots (face * 3 + corner). */
function edgeMap(faces, nv) {
  const m = new BigMap();
  for (let i = 0; i < faces.length; i++) {
    const p = faces[i], q = faces[i - i % 3 + (i % 3 + 1) % 3];
    const u = p < q ? p * nv + q : q * nv + p;
    const l = m.get(u);
    if (l) l.push(i); else m.set(u, [i]);
  }
  return m;
}

function openCount(faces, nv) {
  let k = 0;
  for (const l of edgeMap(faces, nv).values()) if (l.length === 1) k++;
  return k;
}

/** A vertex lying on the middle of an open edge (a T-junction): split the triangle
 *  that owns the edge so the vertex becomes shared. Returns how many splits. */
function splitTJunctions(pos, faces, tol) {
  let splits = 0;
  for (let pass = 0; pass < 8; pass++) {
    const nv = pos.length / 3;
    const open = [];
    const onBoundary = new Set();
    for (const l of edgeMap(faces, nv).values()) {
      if (l.length !== 1) continue;
      open.push(l[0]);
      const i = l[0];
      onBoundary.add(faces[i]); onBoundary.add(faces[i - i % 3 + (i % 3 + 1) % 3]);
    }
    if (!open.length) break;
    const verts = [...onBoundary];
    const eps = Math.max(tol, 1e-4);
    const done = new Set();
    let did = 0;
    for (const i of open) {
      const f = (i / 3) | 0;
      if (done.has(f)) continue;
      const c = i % 3;
      const a = faces[f * 3 + c], b = faces[f * 3 + (c + 1) % 3], o = faces[f * 3 + (c + 2) % 3];
      const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
      const dx = pos[b * 3] - ax, dy = pos[b * 3 + 1] - ay, dz = pos[b * 3 + 2] - az;
      const len2 = dx * dx + dy * dy + dz * dz;
      if (len2 <= 0) continue;
      let hit = -1, hitT = 0;
      for (const v of verts) {
        if (v === a || v === b) continue;
        const wx = pos[v * 3] - ax, wy = pos[v * 3 + 1] - ay, wz = pos[v * 3 + 2] - az;
        const t = (wx * dx + wy * dy + wz * dz) / len2;
        if (t <= 1e-6 || t >= 1 - 1e-6) continue;
        const ex = wx - t * dx, ey = wy - t * dy, ez = wz - t * dz;
        if (ex * ex + ey * ey + ez * ez > eps * eps) continue;
        if (hit < 0 || t < hitT) { hit = v; hitT = t; }   // nearest to a; later passes take the rest
      }
      if (hit < 0) continue;
      faces[f * 3] = a; faces[f * 3 + 1] = hit; faces[f * 3 + 2] = o;
      faces.push(hit, b, o);
      done.add(f);
      did++;
    }
    if (!did) break;
    splits += did;
  }
  return splits;
}

/** Close every loop of open edges with a fan to a new point at its centre.
 *  Returns how many holes were filled. */
function fillHoles(pos, faces, maxHole = 0) {
  const nv = pos.length / 3;
  const next = new Map();   // boundary walks opposite to the owning triangle: b -> a
  for (const l of edgeMap(faces, nv).values()) {
    if (l.length !== 1) continue;
    const i = l[0];
    const a = faces[i], b = faces[i - i % 3 + (i % 3 + 1) % 3];
    const list = next.get(b);
    if (list) list.push(a); else next.set(b, [a]);
  }
  let holes = 0, skipped = 0;
  const rim = loop => {
    let r = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] * 3, b = loop[(i + 1) % loop.length] * 3;
      r += Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]);
    }
    return r;
  };
  const close = loop => {
    if (maxHole > 0 && rim(loop) > maxHole) { skipped++; return; }
    fan(pos, faces, loop);
    holes++;
  };
  for (const start of [...next.keys()]) {
    while (next.get(start)?.length) {
      const loop = [start];
      let v = start, ok = false;
      for (let guard = 0; guard < 1e6; guard++) {
        const l = next.get(v);
        if (!l || !l.length) break;
        v = l.pop();
        if (v === start) { ok = true; break; }
        const seenAt = loop.indexOf(v);
        if (seenAt >= 0) {   // figure-eight: close the inner loop here, carry on with the outer one
          close([v, ...loop.splice(seenAt + 1)]);
          continue;
        }
        loop.push(v);
      }
      if (!ok || loop.length < 3) continue;
      close(loop);
    }
  }
  return { holes, skipped };
}

/** Close one rim. A rim that lies near a plane is triangulated in that plane, using every
 *  point; anything else gets a fan to its centre. */
function fan(pos, faces, loop) {
  if (loop.length < 2) return;
  if (loop.length === 3) { faces.push(loop[0], loop[1], loop[2]); return; }
  if (flatFill(pos, faces, loop)) return;
  let x = 0, y = 0, z = 0;
  for (const v of loop) { x += pos[v * 3]; y += pos[v * 3 + 1]; z += pos[v * 3 + 2]; }
  const c = pos.length / 3;
  pos.push(x / loop.length, y / loop.length, z / loop.length);
  for (let i = 0; i < loop.length; i++) faces.push(loop[i], loop[(i + 1) % loop.length], c);
}

function flatFill(pos, faces, loop) {
  const n = loop.length;
  // Newell normal: the rim's plane, facing the way the rim runs
  let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    const a = loop[i] * 3, b = loop[(i + 1) % n] * 3;
    nx += (pos[a + 1] - pos[b + 1]) * (pos[a + 2] + pos[b + 2]);
    ny += (pos[a + 2] - pos[b + 2]) * (pos[a] + pos[b]);
    nz += (pos[a] - pos[b]) * (pos[a + 1] + pos[b + 1]);
    cx += pos[a] / n; cy += pos[a + 1] / n; cz += pos[a + 2] / n;
  }
  const l = Math.hypot(nx, ny, nz);
  if (!(l > 0)) return false;
  nx /= l; ny /= l; nz /= l;
  // flat enough: no point further from the plane than a quarter of the rim's size
  let off = 0, size = 0;
  for (const v of loop) {
    const x = pos[v * 3] - cx, y = pos[v * 3 + 1] - cy, z = pos[v * 3 + 2] - cz;
    off = Math.max(off, Math.abs(x * nx + y * ny + z * nz));
    size = Math.max(size, Math.hypot(x, y, z));
  }
  if (off > 0.25 * size) return false;
  const ax = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ux = ax[1] * nz - ax[2] * ny, uy = ax[2] * nx - ax[0] * nz, uz = ax[0] * ny - ax[1] * nx;
  const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
  const wx = ny * uz - nz * uy, wy = nz * ux - nx * uz, wz = nx * uy - ny * ux;
  const pts = loop.map(v => [pos[v * 3] * ux + pos[v * 3 + 1] * uy + pos[v * 3 + 2] * uz, pos[v * 3] * wx + pos[v * 3 + 1] * wy + pos[v * 3 + 2] * wz]);
  let r;
  try { r = triangulate([pts]); } catch { return false; }
  if (r.tris.length / 3 < n - 2) return false;
  const ids = [...loop];
  for (const [, , a, b, c] of r.extra) {
    ids.push(pos.length / 3);
    for (let q = 0; q < 3; q++) pos.push((pos[ids[a] * 3 + q] + pos[ids[b] * 3 + q] + pos[ids[c] * 3 + q]) / 3);
  }
  for (const i of r.tris) faces.push(ids[i]);
  return true;
}

/** Make winding agree across each connected piece, then turn any inside-out piece
 *  right way out. Returns how many triangles were flipped. */
function orient(pos, faces) {
  const nf = faces.length / 3, nv = pos.length / 3;
  const em = edgeMap(faces, nv);
  const comp = new Int32Array(nf).fill(-1);
  let flips = 0, nc = 0;
  const swap = f => { const t = faces[f * 3 + 1]; faces[f * 3 + 1] = faces[f * 3 + 2]; faces[f * 3 + 2] = t; };
  for (let s = 0; s < nf; s++) {
    if (comp[s] >= 0) continue;
    const members = [s], stack = [s];
    comp[s] = nc;
    while (stack.length) {
      const f = stack.pop();
      for (let c = 0; c < 3; c++) {
        const p = faces[f * 3 + c], q = faces[f * 3 + (c + 1) % 3];
        const l = em.get(p < q ? p * nv + q : q * nv + p);
        if (!l || l.length !== 2) continue;
        const g = ((l[0] / 3) | 0) === f ? (l[1] / 3) | 0 : (l[0] / 3) | 0;
        if (g === f || comp[g] >= 0) continue;
        // Neighbour must run the shared edge q -> p; read its winding afresh, swaps move slots.
        let same = false;
        for (let k = 0; k < 3; k++) if (faces[g * 3 + k] === p && faces[g * 3 + (k + 1) % 3] === q) same = true;
        if (same) { swap(g); flips++; }
        comp[g] = nc; members.push(g); stack.push(g);
      }
    }
    // Inside-out piece: flip it whole.
    let v6 = 0;
    for (const f of members) {
      const a = faces[f * 3] * 3, b = faces[f * 3 + 1] * 3, c = faces[f * 3 + 2] * 3;
      v6 += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
        + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
    }
    if (v6 < 0 && members.length < nf) { for (const f of members) swap(f); flips += members.length; }
    nc++;
  }
  return flips;
}

export function flipAll(tris) {
  for (let i = 0; i < tris.length; i += 9) {
    for (let a = 0; a < 3; a++) {
      const t = tris[i + 3 + a]; tris[i + 3 + a] = tris[i + 6 + a]; tris[i + 6 + a] = t;
    }
  }
  return tris;
}

/** Neighbour triangle across each edge (ab, bc, ca); -1 where the edge is open
 *  or shared by more than two. Used for picking a connected face. */
export function adjacency(tris, tol = WELD) {
  const n = tris.length / 9;
  const { idx, nv } = weld(tris, tol);
  const first = new BigMap(), count = new BigMap();
  const adj = new Int32Array(n * 3).fill(-1);
  for (let t = 0; t < n; t++) {
    for (let e = 0; e < 3; e++) {
      const p = idx[t * 3 + e], q = idx[t * 3 + (e + 1) % 3];
      const u = p < q ? p * nv + q : q * nv + p;
      count.set(u, (count.get(u) || 0) + 1);
      if (!first.has(u)) first.set(u, t * 3 + e);
    }
  }
  for (let t = 0; t < n; t++) {
    for (let e = 0; e < 3; e++) {
      const p = idx[t * 3 + e], q = idx[t * 3 + (e + 1) % 3];
      const u = p < q ? p * nv + q : q * nv + p;
      if (count.get(u) !== 2) continue;
      const f = first.get(u);
      if (f !== t * 3 + e) { adj[t * 3 + e] = (f / 3) | 0; adj[f] = t; }
    }
  }
  return adj;
}

/** One line a person can read: what is wrong with a mesh that is not closed. */
export function describe(rep) {
  if (rep.watertight) return 'closed solid';
  const bits = [];
  if (rep.openEdges) bits.push(`${rep.openEdges} open`);
  if (rep.oversharedEdges) bits.push(`${rep.oversharedEdges} over-shared`);
  if (rep.flippedEdges) bits.push(`${rep.flippedEdges} flipped`);
  let s = bits.length ? `not closed: ${bits.join(', ')} edges` : 'not closed';
  if (rep.volume <= 0) s += bits.length ? ', no volume' : ': no volume';
  return s;
}

export class ToolError extends Error {}

/** Split a mesh whose edges are over-shared (pieces that touch or overlap) into shells
 *  that can each close on their own. At each such edge the faces are sorted by angle
 *  around it and paired with their neighbours, so every pair bounds one wedge of solid.
 *  Returns a list of triangle soups; repair each, then union them. */
export function shells(tris, tol = WELD) {
  const n = tris.length / 9;
  const { pos, idx, nv } = weld(tris, tol);
  const em = new BigMap();
  for (let i = 0; i < n * 3; i++) {
    const p = idx[i], q = idx[i - i % 3 + (i % 3 + 1) % 3];
    if (p === q) continue;
    const u = p < q ? p * nv + q : q * nv + p;
    const l = em.get(u);
    if (l) l.push(i); else em.set(u, [i]);
  }
  const parent = new Int32Array(n).map((_, i) => i);
  const find = x => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  for (const l of em.values()) if (l.length === 2) join((l[0] / 3) | 0, (l[1] / 3) | 0);
  // over-shared edges second, so each face already knows its body and ties can go to it
  for (const [u, l] of em) {
    if (l.length < 3) continue;
    const p = Math.floor(u / nv), q = u % nv;
    const dx = pos[q * 3] - pos[p * 3], dy = pos[q * 3 + 1] - pos[p * 3 + 1], dz = pos[q * 3 + 2] - pos[p * 3 + 2];
    const dl = Math.hypot(dx, dy, dz) || 1;
    const d = [dx / dl, dy / dl, dz / dl];
    const ref = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const e1 = cr(d, ref), e2 = cr(d, e1);
    const items = l.map(i => {
      const f = (i / 3) | 0;
      let o = idx[f * 3];
      for (let k = 0; k < 3; k++) { const v = idx[f * 3 + k]; if (v !== p && v !== q) o = v; }
      const w = [pos[o * 3] - pos[p * 3], pos[o * 3 + 1] - pos[p * 3 + 1], pos[o * 3 + 2] - pos[p * 3 + 2]];
      const ang = Math.atan2(w[0] * e2[0] + w[1] * e2[1] + w[2] * e2[2], w[0] * e1[0] + w[1] * e1[1] + w[2] * e1[2]);
      return { f, ang, fwd: idx[i] === p };
    }).sort((a, b) => a.ang - b.ang);
    const m = items.length;
    for (const it of items) it.root = find(it.f);
    // faces at the same angle (coplanar, touching pieces): put the one from the previous face's body first
    for (let k = 0; k + 1 < m; k++) {
      const prev = items[(k + m - 1) % m];
      if (Math.abs(items[k + 1].ang - items[k].ang) < 1e-9 && items[k].root !== prev.root && items[k + 1].root === prev.root) {
        const t = items[k]; items[k] = items[k + 1]; items[k + 1] = t;
      }
    }
    // pick the pairing offset that keeps pairs within one body and runs each pair's edge both ways
    let off = 0, best = -1;
    for (const o of [0, 1]) {
      let score = 0;
      for (let k = 0; k + 1 < m; k += 2) {
        const a = items[(k + o) % m], b = items[(k + o + 1) % m];
        score += (a.root === b.root ? 2 : 0) + (a.fwd !== b.fwd ? 1 : 0);
      }
      if (score > best) { best = score; off = o; }
    }
    for (let k = 0; k + 1 < m; k += 2) join(items[(k + off) % m].f, items[(k + off + 1) % m].f);
  }
  const groups = new Map();
  for (let f = 0; f < n; f++) {
    const r = find(f);
    const g = groups.get(r);
    if (g) g.push(f); else groups.set(r, [f]);
  }
  return [...groups.values()].map(fs => {
    const out = new Float32Array(fs.length * 9);
    fs.forEach((f, j) => out.set(tris.subarray(f * 9, f * 9 + 9), j * 9));
    return out;
  });
}
