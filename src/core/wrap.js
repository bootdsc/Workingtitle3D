// Bending flat text onto a part's surface. The text is made flat first (edge shaping included);
// here each point (x, y, z) of that flat mesh goes to the surface point x along and y up from
// where it is put, z out along the surface's normal there.
//
// The chart: from the anchor, a line is walked along the surface to the right and to the left
// (a geodesic: on a cylinder it runs round, or climbs as a helix when tilted for a spiral); from
// every point on it, a column is walked upward. Grid points every g mm; between them, plain
// interpolation. Known flaw: a letter on a curve tighter than about twice its height bends less
// than the surface, so its edges lift or sink a little; across a sharp edge it folds.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import ClipperLib from 'clipper-lib';
import { triangulate } from './tri2d.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const CREASE = Math.cos((40 * Math.PI) / 180);   // normals blend across edges flatter than this

/** A part's surface in world coordinates: closest point and a smoothed normal there. */
export class Surface {
  constructor(tris) {
    this.tris = tris;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tris, 3));
    this.bvh = new MeshBVH(g);
    this.index = g.index.array;
    this.cn = cornerNormals(tris);
    this.tri = new THREE.Triangle();
    this.bary = V();
  }
  /** {p, n} on the surface nearest q. */
  closest(q) {
    const hit = this.bvh.closestPointToPoint(q, {});
    const f = hit.faceIndex, ix = this.index, t = this.tris, cn = this.cn;
    const ia = ix[f * 3], ib = ix[f * 3 + 1], ic = ix[f * 3 + 2];
    this.tri.set(V(t[ia * 3], t[ia * 3 + 1], t[ia * 3 + 2]), V(t[ib * 3], t[ib * 3 + 1], t[ib * 3 + 2]), V(t[ic * 3], t[ic * 3 + 1], t[ic * 3 + 2]));
    this.tri.getBarycoord(hit.point, this.bary);
    const b = this.bary, n = V(
      b.x * cn[ia * 3] + b.y * cn[ib * 3] + b.z * cn[ic * 3],
      b.x * cn[ia * 3 + 1] + b.y * cn[ib * 3 + 1] + b.z * cn[ic * 3 + 1],
      b.x * cn[ia * 3 + 2] + b.y * cn[ib * 3 + 2] + b.z * cn[ic * 3 + 2]);
    if (!(n.lengthSq() > 1e-12)) this.tri.getNormal(n);
    return { p: hit.point.clone(), n: n.normalize() };
  }
  /** Walk ds along the surface from s = {p, n, d}; d stays along the surface. */
  step(s, ds) {
    let from = s, left = ds;
    for (let tries = 0; tries < 6 && left > 1e-6; tries++) {
      // straight on; if that gets little way, over an outside edge (aim down past it) or out of
      // an inside corner (aim up off the face ahead), whichever gets furthest
      let c = this.closest(from.p.clone().addScaledVector(from.d, left));
      let moved = c.p.distanceTo(from.p);
      if (moved < 0.9 * left) {
        for (const k of [-1, 1]) {
          const c2 = this.closest(from.p.clone().addScaledVector(from.d, left * Math.SQRT1_2).addScaledVector(from.n, k * left * Math.SQRT1_2));
          const m2 = c2.p.distanceTo(from.p);
          if (m2 > moved) { c = c2; moved = m2; }
        }
      }
      if (moved < 1e-6) break;
      // the direction carried over: turned as the normal turns (over a sharp edge too, where the
      // way taken would point straight off the new face)
      const d = from.d.clone().applyQuaternion(new THREE.Quaternion().setFromUnitVectors(from.n, c.n));
      d.addScaledVector(c.n, -d.dot(c.n));
      if (!(d.lengthSq() > 1e-12)) d.copy(from.d);
      from = { p: c.p, n: c.n, d: d.normalize() };
      left -= moved;
      if (moved > 0.5 * (left + moved)) break;   // went most of the way: good enough
    }
    return from;
  }
}

/** Per corner, the normal of the faces round that point that meet it at under 40 degrees. */
function cornerNormals(t) {
  const nt = t.length / 9, fn = new Float32Array(nt * 3);
  const a = V(), b = V(), c = V(), e1 = V(), e2 = V();
  for (let f = 0; f < nt; f++) {
    a.fromArray(t, f * 9); b.fromArray(t, f * 9 + 3); c.fromArray(t, f * 9 + 6);
    e1.subVectors(b, a); e2.subVectors(c, a); e1.cross(e2);   // length = twice the area: area weighted
    fn[f * 3] = e1.x; fn[f * 3 + 1] = e1.y; fn[f * 3 + 2] = e1.z;
  }
  const at = new Map();
  const key = i => `${Math.round(t[i] * 1e4)},${Math.round(t[i + 1] * 1e4)},${Math.round(t[i + 2] * 1e4)}`;
  for (let v = 0; v < nt * 3; v++) {
    const k = key(v * 3);
    let l = at.get(k);
    if (!l) at.set(k, (l = []));
    l.push((v / 3) | 0);
  }
  const out = new Float32Array(nt * 9), u = V(), w = V();
  for (let v = 0; v < nt * 3; v++) {
    const f = (v / 3) | 0;
    u.fromArray(fn, f * 3);
    const lu = u.length() || 1;
    let x = 0, y = 0, z = 0;
    for (const g of at.get(key(v * 3))) {
      w.fromArray(fn, g * 3);
      if (w.dot(u) / (lu * (w.length() || 1)) < CREASE) continue;
      x += w.x; y += w.y; z += w.z;
    }
    const l = Math.hypot(x, y, z) || 1;
    out[v * 3] = x / l; out[v * 3 + 1] = y / l; out[v * 3 + 2] = z / l;
  }
  return out;
}

/** Rotate v about unit axis n by a radians. */
const turn = (v, n, a) => v.clone().multiplyScalar(Math.cos(a)).add(n.clone().cross(v).multiplyScalar(Math.sin(a)));

/**
 * The grid of surface points under the text. box = the text's extent {x0, x1, y0, y1} in mm
 * round the anchor; up = the text's up at the anchor; rot and spiral in degrees. Spiral tilts the
 * line the letters sit on and keeps the letters upright (on a cylinder: a helix).
 * smooth (mm): surface detail smaller than this is bridged, not followed (the grid is blurred by
 * it); D keeps how far the real surface lies off the blurred one, so a foot can reach down to it.
 * smoothTop (mm, above smooth): the grid blurred this much again, as T: the letters follow it more
 * the further out they reach, so at an inside corner their tops round through it instead of
 * crossing themselves (cut-in letters likewise round an outside corner at their floor).
 */
export function chart(surf, anchor, normal, up, box, g, rot = 0, spiral = 0, smooth = 0, smoothTop = 0) {
  const sm = Math.max(smooth, smoothTop);
  const n0 = normal.clone().normalize();
  let u0 = up.clone().addScaledVector(n0, -up.dot(n0)).normalize();
  u0 = turn(u0, n0, (rot * Math.PI) / 180);
  const right = u0.clone().cross(n0).normalize();
  const al = (Math.max(-80, Math.min(80, spiral)) * Math.PI) / 180;
  // smoothing: room for the blur, and for the length grooves take on the real surface (half again)
  const mx = sm > 0 ? Math.ceil((2 * sm + 0.5 * (box.x1 - box.x0)) / g) : 0;
  const my = sm > 0 ? Math.ceil((2 * sm + 0.5 * (box.y1 - box.y0)) / g) : 0;
  const i0 = Math.floor(box.x0 / g) - 1 - mx, i1 = Math.ceil(box.x1 / g) + 1 + mx;
  const j0 = Math.floor(box.y0 / g) - 1 - my, j1 = Math.ceil(box.y1 / g) + 1 + my;
  const ni = i1 - i0 + 1, nj = j1 - j0 + 1;
  const P = new Float32Array(ni * nj * 3), N = new Float32Array(ni * nj * 3);
  // the line the letters sit on, tilted by the spiral; columns g apart across
  const base = new Array(ni);
  const start = surf.closest(anchor);
  const tilt = turn(right, start.n, al);
  base[-i0] = { p: start.p, n: start.n, d: tilt };
  const along = g / Math.cos(al);
  for (let i = 1; i <= i1; i++) base[i - i0] = surf.step(base[i - 1 - i0], along);
  let back = { ...base[-i0], d: tilt.clone().negate() };
  for (let i = -1; i >= i0; i--) { back = surf.step(back, along); base[i - i0] = back; }
  for (let i = 0; i < ni; i++) {
    // along the line towards +x (the walk to the left ran the other way)
    const b = base[i], fwd = i + i0 < 0 ? b.d.clone().negate() : b.d;
    // straight up from the line, the spiral's tilt taken back off so the letters stand upright
    const upd = turn(fwd, b.n, Math.PI / 2 - al);
    const put = (j, s) => { const k = (i * nj + (j - j0)) * 3; P[k] = s.p.x; P[k + 1] = s.p.y; P[k + 2] = s.p.z; N[k] = s.n.x; N[k + 1] = s.n.y; N[k + 2] = s.n.z; };
    put(0, b);
    let s = { p: b.p, n: b.n, d: upd };
    for (let j = 1; j <= j1; j++) { s = surf.step(s, g); put(j, s); }
    s = { p: b.p, n: b.n, d: upd.clone().negate() };
    for (let j = -1; j >= j0; j--) { s = surf.step(s, g); put(j, s); }
  }
  const smoothed = s => {
    if (!(s > 0)) return { P, N, D: new Float32Array(ni * nj), i0, j0, ni, nj, g };
    const Ps = blur(P, ni, nj, s / g), Ns = blur(N, ni, nj, s / g), D = new Float32Array(ni * nj);
    for (let k = 0; k < ni * nj; k++) {
      const a = k * 3, l = Math.hypot(Ns[a], Ns[a + 1], Ns[a + 2]) || 1;
      Ns[a] /= l; Ns[a + 1] /= l; Ns[a + 2] /= l;
      D[k] = (P[a] - Ps[a]) * Ns[a] + (P[a + 1] - Ps[a + 1]) * Ns[a + 1] + (P[a + 2] - Ps[a + 2]) * Ns[a + 2];
    }
    // the walk measured the real surface, down and up every groove; bridged, the letters must keep
    // their spacing over the smooth one: grid points spaced g apart again along it
    const c = { P: Ps, N: Ns, D, i0, j0, ni, nj, g };
    respace(c, true); respace(c, false);
    return c;
  };
  const c = smoothed(smooth);
  c.T = smoothTop > smooth ? smoothed(smoothTop) : c;
  return c;
}

/** Grid points moved along rows (or columns) so they are g apart, measured along the grid, the
 *  anchor's row or column staying put. */
function respace(c, rows) {
  const { ni, nj, g } = c, n = rows ? ni : nj, m = rows ? nj : ni, at0 = rows ? -c.i0 : -c.j0;
  const idx = (line, k) => (rows ? k * nj + line : line * nj + k);
  const P = Float32Array.from(c.P), N = Float32Array.from(c.N), D = Float32Array.from(c.D);
  const L = new Float64Array(n);
  for (let line = 0; line < m; line++) {
    for (let k = 1; k < n; k++) {
      const a = idx(line, k - 1) * 3, b = idx(line, k) * 3;
      L[k] = L[k - 1] + Math.hypot(c.P[b] - c.P[a], c.P[b + 1] - c.P[a + 1], c.P[b + 2] - c.P[a + 2]);
    }
    const off = L[at0];
    let f = 0;
    for (let k = 0; k < n; k++) {
      const want = (k - at0) * g + off;
      while (f < n - 2 && L[f + 1] < want) f++;
      while (f > 0 && L[f] > want) f--;
      const span = L[f + 1] - L[f] || 1e-9, t = (want - L[f]) / span;   // past an end: carried on straight
      const a = idx(line, f), b = idx(line, f + 1), o = idx(line, k);
      for (let e = 0; e < 3; e++) {
        P[o * 3 + e] = c.P[a * 3 + e] + (c.P[b * 3 + e] - c.P[a * 3 + e]) * t;
        N[o * 3 + e] = c.N[a * 3 + e] + (c.N[b * 3 + e] - c.N[a * 3 + e]) * Math.min(1, Math.max(0, t));
      }
      D[o] = c.D[a] + (c.D[b] - c.D[a]) * Math.min(1, Math.max(0, t));
    }
  }
  c.P = P; c.N = N; c.D = D;
}

/** Gaussian blur of a grid of 3-vectors (ni x nj), sigma in grid steps, edges held. */
function blur(A, ni, nj, sigma) {
  const r = Math.max(1, Math.ceil(2 * sigma)), w = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  const pass = (src, along) => {
    const out = new Float32Array(src.length);
    for (let i = 0; i < ni; i++) for (let j = 0; j < nj; j++) {
      let x = 0, y = 0, z = 0, ws = 0;
      for (let k = -r; k <= r; k++) {
        const ii = along ? i : Math.max(0, Math.min(ni - 1, i + k)), jj = along ? Math.max(0, Math.min(nj - 1, j + k)) : j;
        const a = (ii * nj + jj) * 3, wk = w[k + r];
        x += src[a] * wk; y += src[a + 1] * wk; z += src[a + 2] * wk; ws += wk;
      }
      const o = (i * nj + j) * 3;
      out[o] = x / ws; out[o + 1] = y / ws; out[o + 2] = z / ws;
    }
    return out;
  };
  return pass(pass(A, true), false);
}

/** Surface point and normal under text point (x, y), into p and n; returns D there. */
function look(c, x, y, p, n) {
  let fx = x / c.g - c.i0, fy = y / c.g - c.j0;
  const i = Math.max(0, Math.min(c.ni - 2, Math.floor(fx))), j = Math.max(0, Math.min(c.nj - 2, Math.floor(fy)));
  fx -= i; fy -= j;
  const k00 = (i * c.nj + j) * 3, k01 = k00 + 3, k10 = k00 + c.nj * 3, k11 = k10 + 3;
  const w00 = (1 - fx) * (1 - fy), w01 = (1 - fx) * fy, w10 = fx * (1 - fy), w11 = fx * fy;
  for (let a = 0; a < 3; a++) {
    p[a] = w00 * c.P[k00 + a] + w01 * c.P[k01 + a] + w10 * c.P[k10 + a] + w11 * c.P[k11 + a];
    n[a] = w00 * c.N[k00 + a] + w01 * c.N[k01 + a] + w10 * c.N[k10 + a] + w11 * c.N[k11 + a];
  }
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  n[0] /= l; n[1] /= l; n[2] /= l;
  const kd = (i * c.nj + j);
  return w00 * c.D[kd] + w01 * c.D[kd + 1] + w10 * c.D[kd + c.nj] + w11 * c.D[kd + c.nj + 1];
}

/**
 * The flat text (tris in mm, x and y round its middle, z from 0 to h) on the surface.
 * mode 'emboss': raised h, its foot sunk `sink` into the surface so it fuses; where the real
 * surface dips under a smoothed one, the foot reaches down to it.
 * mode 'deboss': cut h deep, its top `lift` above the surface so the cut is clean (above the
 * real surface where that bulges over a smoothed one). 1 mm: at 0.2, a curve or facet standing a
 * hair over the cutter's top left a skin over the letters.
 */
export function deform(flat, c, h, mode = 'emboss', sink = 0.2, lift = 1) {
  const out = new Float32Array(flat.length), p = [0, 0, 0], n = [0, 0, 0], pt = [0, 0, 0], nt = [0, 0, 0];
  const T = c.T && c.T !== c ? c.T : null;
  for (let v = 0; v < flat.length; v += 3) {
    const z = flat[v + 2];
    const d = look(c, flat[v], flat[v + 1], p, n);
    const zz = mode === 'deboss' ? (z >= h - 1e-6 ? Math.max(lift, d + lift) : z - h) : (z > 1e-6 ? z : Math.min(-sink, d - sink));
    // the further from the surface (out, or in for a cut), the more the smoother grid leads
    const t = T ? Math.min(1, Math.max(0, mode === 'deboss' ? -zz : zz) / h) : 0;
    if (t > 0) {
      look(T, flat[v], flat[v + 1], pt, nt);
      for (let a = 0; a < 3; a++) out[v + a] = (1 - t) * (p[a] + n[a] * zz) + t * (pt[a] + nt[a] * zz);
    } else { out[v] = p[0] + n[0] * zz; out[v + 1] = p[1] + n[1] * zz; out[v + 2] = p[2] + n[2] * zz; }
  }
  return out;
}

/**
 * Flat letters (rings in mm) as a closed solid from z = 0 to h whose top and bottom are cut on a
 * square grid g apart: bent onto a curve, the faces then shade in even bands like the part they
 * sit on (long thin fan triangles, bent, each tilt their own way and look speckled).
 */
export function gridSolid(rings, h, g) {
  const S = 1e4, C = ClipperLib, G = Math.max(1, Math.round(g * S));
  const subj = rings.map(r => r.map(([x, y]) => ({ X: Math.round(x * S), Y: Math.round(y * S) })));
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const r of subj) for (const p of r) { x0 = Math.min(x0, p.X); x1 = Math.max(x1, p.X); y0 = Math.min(y0, p.Y); y1 = Math.max(y1, p.Y); }
  x0 = Math.floor(x0 / G) * G; y0 = Math.floor(y0 / G) * G;
  const rect = (a, b, c, d) => [{ X: a, Y: b }, { X: c, Y: b }, { X: c, Y: d }, { X: a, Y: d }];
  const cut = (paths, fill, box, tree) => {
    const c = new C.Clipper();
    c.AddPaths(paths, C.PolyType.ptSubject, true);
    c.AddPath(box, C.PolyType.ptClip, true);
    const out = tree ? new C.PolyTree() : new C.Paths();
    c.Execute(C.ClipType.ctIntersection, out, fill, C.PolyFillType.pftNonZero);
    return out;
  };
  const top = [];   // [x, y] int triples, counter-clockwise from above
  for (let y = y0; y < y1; y += G) {
    const strip = cut(subj, C.PolyFillType.pftPositive, rect(x0 - G, y, x1 + G, y + G), false);
    if (!strip.length) continue;
    let sx0 = Infinity, sx1 = -Infinity;
    for (const r of strip) for (const p of r) { sx0 = Math.min(sx0, p.X); sx1 = Math.max(sx1, p.X); }
    for (let x = x0; x < sx1; x += G) {
      if (x + G <= sx0) continue;
      const tree = cut(strip, C.PolyFillType.pftNonZero, rect(x, y, x + G, y + G), true);
      const walk = node => {
        for (const outer of node.Childs()) {
          const ringsI = [outer.Contour(), ...outer.Childs().map(hn => hn.Contour())].map(r => r.map(p => [p.X, p.Y]));
          if (ringsI[0].length < 3) continue;
          // outers counter-clockwise, holes clockwise
          ringsI.forEach((r, k) => { const a = ringArea2(r); if ((k === 0) !== (a > 0)) r.reverse(); });
          const { tris, extra } = triangulate(ringsI);
          const pts = ringsI.flat().concat(extra.map(e => [e[0], e[1]]));
          for (let k = 0; k < tris.length; k += 3) top.push([pts[tris[k]], pts[tris[k + 1]], pts[tris[k + 2]]]);
          for (const hn of outer.Childs()) walk(hn);   // an island inside a hole
        }
      };
      walk(tree);
    }
  }
  // walls on the edges only one top triangle uses
  const key = (a, b) => `${a[0]},${a[1]},${b[0]},${b[1]}`;
  const used = new Set();
  for (const t of top) for (let k = 0; k < 3; k++) used.add(key(t[k], t[(k + 1) % 3]));
  const out = [];
  const put = (p, z) => out.push(p[0] / S, p[1] / S, z);
  for (const t of top) {
    put(t[0], h); put(t[1], h); put(t[2], h);
    put(t[0], 0); put(t[2], 0); put(t[1], 0);
    for (let k = 0; k < 3; k++) {
      const a = t[k], b = t[(k + 1) % 3];
      if (used.has(key(b, a))) continue;
      put(a, h); put(a, 0); put(b, 0);
      put(a, h); put(b, 0); put(b, h);
    }
  }
  return Float32Array.from(out);
}
const ringArea2 = r => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return s; };

/** Split triangles until no edge is longer than L across (x, y); shared edges split alike, so a
 *  closed mesh stays closed. */
export function subdivide(t, L) {
  const pos = [], idx = new Map(), key = (x, y, z) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
  const vert = (x, y, z) => { const k = key(x, y, z); let i = idx.get(k); if (i === undefined) { i = pos.length / 3; pos.push(x, y, z); idx.set(k, i); } return i; };
  const stack = [];
  for (let f = 0; f < t.length; f += 9) stack.push([vert(t[f], t[f + 1], t[f + 2]), vert(t[f + 3], t[f + 4], t[f + 5]), vert(t[f + 6], t[f + 7], t[f + 8])]);
  const mids = new Map(), L2 = L * L;
  const long = (a, b) => (pos[a * 3] - pos[b * 3]) ** 2 + (pos[a * 3 + 1] - pos[b * 3 + 1]) ** 2 > L2;
  const mid = (a, b) => {
    const k = a < b ? `${a},${b}` : `${b},${a}`;
    let m = mids.get(k);
    if (m === undefined) {
      m = pos.length / 3;
      pos.push((pos[a * 3] + pos[b * 3]) / 2, (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2, (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2);
      mids.set(k, m);
    }
    return m;
  };
  const done = [];
  while (stack.length) {
    const [a, b, c] = stack.pop();
    const s = [long(a, b), long(b, c), long(c, a)], n = s[0] + s[1] + s[2];
    if (!n) { done.push(a, b, c); continue; }
    // turn the corners so the split edges come first: patterns for one, two or three
    let q = [a, b, c], r = s;
    while (!(n === 1 ? r[0] : n === 2 ? r[0] && r[1] : true)) { q = [q[1], q[2], q[0]]; r = [r[1], r[2], r[0]]; }
    const [A, B, C] = q;
    if (n === 1) { const m = mid(A, B); stack.push([A, m, C], [m, B, C]); }
    else if (n === 2) { const m1 = mid(A, B), m2 = mid(B, C); stack.push([m1, B, m2], [A, m1, m2], [A, m2, C]); }
    else { const ab = mid(A, B), bc = mid(B, C), ca = mid(C, A); stack.push([A, ab, ca], [ab, B, bc], [ca, bc, C], [ab, bc, ca]); }
  }
  const out = new Float32Array(done.length * 3);
  for (let k = 0; k < done.length; k++) { out[k * 3] = pos[done[k] * 3]; out[k * 3 + 1] = pos[done[k] * 3 + 1]; out[k * 3 + 2] = pos[done[k] * 3 + 2]; }
  return out;
}
