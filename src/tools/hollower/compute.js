// Hollow a closed solid to a set wall, open through any flat faces picked (or closed).
//
// The outer surface is kept exactly. The cavity is the surface g = 0 of
//   g = inside ? d - t : -t        (d = distance to the mesh, t = wall)
// g is 1-Lipschitz, so a cell whose centre has |g| > half its diagonal cannot hold the
// surface; cells are refined from 8 voxels down to 1 only where it can. The surface is
// cut by marching tetrahedra (no ambiguous cases, always closed). Cavity vertices are
// shared by grid edge, so the cavity is closed by construction.
//
// Open faces (any number, picked): distances ignore them, so the cavity runs up to them; beyond
// each face's plane g is taken from just inside the plane, so the cavity leaves through it as a
// straight tunnel, capped at the grid's edge. The solid engine then cuts that cavity out of the
// whole outside, so faces that meet at an edge open into one another cleanly.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { weld, ToolError, BigMap } from '../../core/meshcheck.js';
import { problem } from './limits.js';
import { decimate } from '../../core/decimate.js';
import ClipperLib from 'clipper-lib';
import { S, flatPart, shapedPart } from '../../core/flat.js';
import { shapeOutline, inset } from '../../core/rings.js';

const THIN_TOL = 0.01;         // mm: how far the thinned cavity may move from the one the grid made
const TOP = 3;                // top cells are 2^3 = 8 voxels a side
const NUDGE = 0.01;            // |g| kept at least this many voxels from zero

// tets of a cube, corners numbered x + 2y + 4z; all share the 0-7 diagonal, so
// neighbouring cubes split their shared faces the same way
const TETS = [[0, 1, 3, 7], [0, 3, 2, 7], [0, 2, 6, 7], [0, 6, 4, 7], [0, 4, 5, 7], [0, 5, 1, 7]];

export async function run(tris, p, ctx) {
  const bad = problem(p);
  if (bad) throw new ToolError(bad);
  const t = p.wall, h = p.voxel;
  // the picked faces, each one opening; none picked is a closed hollow (no
  // "open" switch, and as many openings as faces picked). A selection is one face's triangles
  // or a list of them.
  const raw = p.open === false ? [] : ctx.selection || [];   // (steps saved before 2026-10-16 had an open switch)
  const groups = (raw.length && Array.isArray(raw[0]) ? raw : raw.length ? [raw] : []).filter(g => g.length);
  const sel = groups.flat();

  // outer mesh, indexed
  const W = weld(tris);
  const nT = tris.length / 9;
  const inF = new Uint8Array(nT);
  for (const f of sel) inF[f] = 1;

  // each open face's plane, and the check that it is on the outside (nothing beyond its plane)
  const faces = groups.map((list, k) => {
    const nn = [0, 0, 0];
    for (const f of list) {
      const i = f * 9;
      const ux = tris[i + 3] - tris[i], uy = tris[i + 4] - tris[i + 1], uz = tris[i + 5] - tris[i + 2];
      const vx = tris[i + 6] - tris[i], vy = tris[i + 7] - tris[i + 1], vz = tris[i + 8] - tris[i + 2];
      nn[0] += uy * vz - uz * vy; nn[1] += uz * vx - ux * vz; nn[2] += ux * vy - uy * vx;
    }
    const l = Math.hypot(...nn), n = nn.map(v => v / l);
    const f0 = list[0] * 9;
    const d = n[0] * tris[f0] + n[1] * tris[f0 + 1] + n[2] * tris[f0 + 2];
    let beyond = 0;
    for (let v = 0; v < W.nv; v++) beyond = Math.max(beyond, n[0] * W.pos[v * 3] + n[1] * W.pos[v * 3 + 1] + n[2] * W.pos[v * 3 + 2] - d);
    if (beyond > 1e-3) {
      throw new ToolError(`Picked face ${k + 1} is not on the outside: the part reaches ${beyond.toFixed(2)} mm past its plane. Pick faces nothing sticks out beyond.`);
    }
    return { list, n, d };
  });

  // a flat part (an outline pushed straight up) is hollowed exactly, no grid
  if (ctx.kernel?.M) {
    let part = null;
    try { part = flatPart(tris); } catch { /* not flat: the grid below */ }
    if (part) return exactFlat(tris, part, faces, t, ctx);
    // shaped by distance from its outline (a fillet, chamfer or cove round a plate): exact too
    ctx.progress(0.05, 'reading the shape');
    const shaped = shapedPart(tris);
    if (shaped) {
      const r = exactShaped(tris, shaped, faces, t, ctx);
      if (r) return r;
    }
  }

  ctx.progress(0.02, 'indexing');
  const geo = (skipF) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(W.pos), 3));
    const idx = [];
    for (let f = 0; f < nT; f++) if (!(skipF && inF[f])) idx.push(W.idx[f * 3], W.idx[f * 3 + 1], W.idx[f * 3 + 2]);
    g.setIndex(new THREE.BufferAttribute(Uint32Array.from(idx), 1));
    return g;
  };
  const bvhAll = new MeshBVH(geo(false));
  const bvhDist = sel.length ? new MeshBVH(geo(true)) : bvhAll;   // distances ignore the open faces

  // grid
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < W.nv; v++) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], W.pos[v * 3 + a]); hi[a] = Math.max(hi[a], W.pos[v * 3 + a]); }
  const B = 1 << TOP;
  const jit = [0.000731, 0.000419, 0.000277];   // keep grid columns off round coordinates
  const org = lo.map((v, a) => v - 2 * h + jit[a] * h);
  const nc = lo.map((v, a) => Math.ceil((hi[a] - v + 4 * h) / h / B) * B);
  const NX = nc[0] + 1, NY = nc[1] + 1;
  const L = (i, j, k) => i + NX * (j + NY * k);
  const RTOP = (B * h * Math.sqrt(3)) / 2;
  const cap = t + RTOP + h;

  // inside test by +z columns: winding from the facing of each crossing
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
  const cols = new BigMap();
  const column = (i, j) => {
    const key = i + NX * j;
    let c = cols.get(key);
    if (c) return c;
    ray.origin.set(org[0] + i * h, org[1] + j * h, org[2] - h);
    ray.direction.set(0, 0, 1);
    c = crossings(bvhAll.raycast(ray, THREE.DoubleSide), ray.direction, ray.origin, 2);
    cols.set(key, c);
    return c;
  };
  const insideCol = (i, j, z) => {
    const c = column(i, j);
    let w = 0;
    for (let q = 0; q < c.z.length && c.z[q] < z; q++) w += c.s[q];
    return w > 0;
  };
  const oddDir = new THREE.Vector3(0.0123, 0.0371, 1).normalize();
  const insideRay = q => {
    ray.origin.set(q[0], q[1], q[2]);
    ray.direction.copy(oddDir);
    const c = crossings(bvhAll.raycast(ray, THREE.DoubleSide), ray.direction, null, -1);
    let w = 0;
    for (let k = 0; k < c.s.length; k++) w -= c.s[k];   // leaving counts +1
    return w > 0;
  };

  const vq = new THREE.Vector3(), hit = {};
  const dist = (x, y, z) => {
    vq.set(x, y, z);
    const r = bvhDist.closestPointToPoint(vq, hit, 0, cap);
    return r ? r.distance : cap;
  };
  const delta = Math.min(0.01, 0.05 * h);
  const G = new BigMap();   // every grid value worked out, by grid point
  let evals = 0;
  const g = (i, j, k) => {
    const key = L(i, j, k);
    let v = G.get(key);
    if (v !== undefined) return v;
    evals++;
    // the grid's outermost points are outside: a tunnel out through an open face ends there, closed
    if (faces.length && (i <= 0 || j <= 0 || k <= 0 || i >= nc[0] || j >= nc[1] || k >= nc[2])) { G.set(key, -t); return -t; }
    let x = org[0] + i * h, y = org[1] + j * h, z = org[2] + k * h;
    let inside, moved = false;
    // at or beyond an open face: take the value from just inside its plane (each face in turn)
    for (const F of faces) {
      const s = F.n[0] * x + F.n[1] * y + F.n[2] * z - F.d;
      if (s > -delta) { const m = s + delta; x -= F.n[0] * m; y -= F.n[1] * m; z -= F.n[2] * m; moved = true; }
    }
    if (moved) inside = insideRay([x, y, z]);
    else inside = insideCol(i, j, z);
    v = inside ? Math.min(dist(x, y, z), cap) - t : -t;
    if (Math.abs(v) < NUDGE * h) v = v >= 0 ? NUDGE * h : -NUDGE * h;
    G.set(key, v);
    return v;
  };

  // refine from top cells down to voxels, keeping cells that can hold g = 0
  // (typed lists that grow: a fine grid on a big part passes the length a plain list may have)
  let cells = new Grow(Int32Array);
  for (let k = 0; k < nc[2]; k += B) for (let j = 0; j < nc[1]; j += B) for (let i = 0; i < nc[0]; i += B) cells.push3(i, j, k);
  for (let m = TOP; m >= 1; m--) {
    const size = 1 << m, half = size >> 1;
    const R = (size * h * Math.sqrt(3)) / 2;
    const next = new Grow(Int32Array);
    const count = cells.n / 3, ca = cells.a;
    for (let c = 0; c < cells.n; c += 3) {
      const i = ca[c], j = ca[c + 1], k = ca[c + 2];
      // (with openings, cells on the grid's edge always go on down: the cavity's tunnels are capped there)
      const rim = faces.length && (i === 0 || j === 0 || k === 0 || i + size >= nc[0] || j + size >= nc[1] || k + size >= nc[2]);
      if (!rim && Math.abs(g(i + half, j + half, k + half)) > R + 1e-9) continue;
      for (let dz = 0; dz < size; dz += half) for (let dy = 0; dy < size; dy += half) for (let dx = 0; dx < size; dx += half) next.push3(i + dx, j + dy, k + dz);
      if ((c / 3) % 2000 === 0) ctx.progress(0.05 + 0.55 * ((TOP - m) + c / 3 / count) / TOP, `refining (${m === TOP ? 'coarse' : m === 1 ? 'fine' : 'medium'})`);
    }
    cells = next;
  }

  // march
  let cv = new Grow(Float64Array);   // cavity vertices, xyz
  const ce = new BigMap();           // grid edge -> cavity vertex
  let ct = new Grow(Int32Array);     // cavity triangles
  const P = (c) => [org[0] + (c % NX) * h, org[1] + (Math.floor(c / NX) % NY) * h, org[2] + Math.floor(c / (NX * NY)) * h];
  // a grid edge is its lower corner and the step to the other (each axis -1, 0 or +1)
  const edgeKey = (a, b) => {
    const dx = (b % NX) - (a % NX), dy = (Math.floor(b / NX) % NY) - (Math.floor(a / NX) % NY), dz = Math.floor(b / (NX * NY)) - Math.floor(a / (NX * NY));
    return a * 27 + (dx + 1) + 3 * (dy + 1) + 9 * (dz + 1);
  };
  const edgeVertex = (a, b, ga, gb) => {
    if (a > b) { [a, b] = [b, a]; [ga, gb] = [gb, ga]; }
    const key = edgeKey(a, b);
    let id = ce.get(key);
    if (id !== undefined) return id;
    const pa = P(a), pb = P(b), u = ga / (ga - gb);
    id = cv.n / 3;
    cv.push3(pa[0] + (pb[0] - pa[0]) * u, pa[1] + (pb[1] - pa[1]) * u, pa[2] + (pb[2] - pa[2]) * u);
    ce.set(key, id);
    return id;
  };
  const corner = new Array(8), val = new Array(8);
  const total = cells.n / 3, cA = cells.a;
  for (let c = 0; c < cells.n; c += 3) {
    const i = cA[c], j = cA[c + 1], k = cA[c + 2];
    let pos = 0;
    for (let q = 0; q < 8; q++) {
      const ii = i + (q & 1), jj = j + ((q >> 1) & 1), kk = k + ((q >> 2) & 1);
      corner[q] = L(ii, jj, kk);
      val[q] = g(ii, jj, kk);
      if (val[q] > 0) pos++;
    }
    if (pos === 0 || pos === 8) continue;
    for (const tet of TETS) {
      const pIn = [], pOut = [];
      for (const q of tet) (val[q] > 0 ? pIn : pOut).push(q);
      if (!pIn.length || !pOut.length) continue;
      const ev = (a, b) => edgeVertex(corner[a], corner[b], val[a], val[b]);
      let faces;
      if (pIn.length === 1) faces = [[ev(pIn[0], pOut[0]), ev(pIn[0], pOut[1]), ev(pIn[0], pOut[2])]];
      else if (pOut.length === 1) faces = [[ev(pOut[0], pIn[0]), ev(pOut[0], pIn[1]), ev(pOut[0], pIn[2])]];
      else {
        const [a, b] = pIn, [cc, d] = pOut;
        const q = [ev(a, cc), ev(a, d), ev(b, d), ev(b, cc)];
        faces = [[q[0], q[1], q[2]], [q[0], q[2], q[3]]];
      }
      // face the cavity (towards g > 0), away from the material
      const dir = [0, 0, 0];
      for (const q of pIn) { const p = P(corner[q]); dir[0] += p[0] / pIn.length; dir[1] += p[1] / pIn.length; dir[2] += p[2] / pIn.length; }
      for (const q of pOut) { const p = P(corner[q]); dir[0] -= p[0] / pOut.length; dir[1] -= p[1] / pOut.length; dir[2] -= p[2] / pOut.length; }
      for (const f of faces) {
        const nrm = triNormal(cv.a, f);
        if (nrm[0] * dir[0] + nrm[1] * dir[1] + nrm[2] * dir[2] >= 0) ct.push3(f[0], f[1], f[2]); else ct.push3(f[0], f[2], f[1]);
      }
    }
    if ((c / 3) % 5000 === 0) ctx.progress(0.6 + 0.3 * (c / 3 / total), 'cutting the cavity');
  }
  if (!ct.n) throw new ToolError(`Nothing to hollow: the part is thinner than twice the wall (${(2 * t).toFixed(2)} mm) everywhere.`);

  // The grid makes the cavity equally dense everywhere, flat walls as much as curves. Thinning
  // it to the working tolerance (0.01 mm, measured both ways by decimate) is off unless a step
  // asks for it (thin: true): on a 240 mm plate at 1 mm it took 189 s of a 193 s hollow (the
  // tool seemed never to finish), and it merged the grid's small steps at inside corners into
  // large flat triangles that read as teeth. Steps saved 2026-10-16 with thinning on by
  // default build unthinned now; the shape is the same within 0.01 mm.
  const before = ct.n / 3;
  if (p.thin === true) {
    ctx.progress(0.9, 'thinning the cavity');
    const soup = new Float32Array(ct.n * 3), ta = ct.a, va = cv.a;
    for (let q = 0; q < ct.n; q++) { const v = ta[q] * 3; soup[q * 3] = va[v]; soup[q * 3 + 1] = va[v + 1]; soup[q * 3 + 2] = va[v + 2]; }
    cv = ct = null;   // let the grid's lists go before thinning needs the memory
    const thin = decimate(soup, { target: 0, tol: THIN_TOL, progress: (f, s) => ctx.progress(0.9 + 0.02 * f, s) }).tris;
    const w = weld(thin);
    cv = Grow.of(Float64Array, w.pos); ct = Grow.of(Int32Array, w.idx);
  }

  // assemble: outer (minus F), cavity (cut at F's plane), rim
  const Vg = Grow.of(Float64Array, W.pos);
  const out = new Grow(Int32Array);
  for (let f = 0; f < nT; f++) if (!inF[f]) out.push3(W.idx[f * 3], W.idx[f * 3 + 1], W.idx[f * 3 + 2]);
  const base = Vg.n / 3;
  Vg.append(cv.a, cv.n);
  const vx = i => Vg.a[i];   // read through: the list moves as it grows
  // measured on a box (tests/hollow_accuracy.mjs): flat walls within ~0.01 mm, sharp inside edges cut by h/2
  const notes = [`Wall ${t.toFixed(2)} mm. Inside edges and corners are cut off by up to ${(h / 2).toFixed(2)} mm; a finer detail sharpens them.`];
  if (ct.n / 3 < before) notes.push(`Cavity thinned from ${before.toLocaleString('en-US')} to ${(ct.n / 3).toLocaleString('en-US')} triangles, within ${THIN_TOL} mm.`);

  if (!faces.length) {
    for (let q = 0; q < ct.n; q++) out.push1(base + ct.a[q]);
    notes.push('Closed hollow: pick faces in the view to open it through them.');
  } else {
    // Openings: the cavity already runs straight out through every picked face (its values are
    // taken from just inside each face's plane), so the part is the outside with that cavity cut
    // away, done by the solid engine. Faces that meet at an edge open into one another cleanly,
    // and any number of faces can be picked.
    ctx.progress(0.93, faces.length > 1 ? `opening ${faces.length} faces` : 'opening the face');
    const K = ctx.kernel || (await import('../../core/kernel.js'));
    const cav = new Float32Array(ct.n * 3);
    for (let q = 0; q < ct.n; q += 3) for (let k = 0; k < 3; k++) {
      // turned round: the grid faced it into the hollow; as a solid it must face out
      const v = ct.a[q + (k === 0 ? 0 : 3 - k)] * 3, o = (q + k) * 3;
      cav[o] = cv.a[v]; cav[o + 1] = cv.a[v + 1]; cav[o + 2] = cv.a[v + 2];
    }
    const outer = K.toManifold(tris), hole = K.toManifold(cav);
    const cutAway = outer.subtract(hole);
    const res = K.toTris(cutAway);
    outer.delete(); hole.delete(); cutAway.delete();
    notes.push(`${faces.length} face${faces.length > 1 ? 's' : ''} opened.`);
    return { tris: res, notes };
  }

  ctx.progress(0.97, 'assembling');
  const res = new Float32Array(out.n * 3), oa = out.a, va = Vg.a;
  for (let q = 0; q < out.n; q++) {
    const v = oa[q] * 3;
    res[q * 3] = va[v]; res[q * 3 + 1] = va[v + 1]; res[q * 3 + 2] = va[v + 2];
  }
  return { tris: res, notes };
}

/**
 * Hollow of a flat part, exact: the cavity is the outline shrunk by the wall, from one wall
 * above the floor to one wall under the roof. Each opening is its picked face shrunk by the
 * wall within its own plane, cut straight through. The solid engine takes all of it out of
 * the part at once. Walls are true, corners sharp (round only where the outline turns inward),
 * and the result is about as many triangles as the part.
 */
function exactFlat(tris, part, faces, t, ctx) {
  const { M } = ctx.kernel;
  const H = part.z1 - part.z0;
  // only the walls that stay closed take height: an opened top or bottom has none, and the cavity
  // runs out through it (a 4 mm tall box with both open is a ring, whatever the wall)
  const flat = (F, s, z) => F.n[2] * s > 0.9999 && Math.abs(F.d - s * z) < 1e-4;
  const openTop = faces.some(F => flat(F, 1, part.z1)), openBot = faces.some(F => flat(F, -1, part.z0));
  const closed = (openTop ? 0 : 1) + (openBot ? 0 : 1);
  if (H <= closed * t) throw new ToolError(`Nothing to hollow: the part is ${H.toFixed(2)} mm tall, no taller than its closed ${closed > 1 ? 'top and bottom walls' : openTop ? 'bottom wall' : 'top wall'} (${(closed * t).toFixed(2)} mm).`);
  const z0 = part.z0 + (openBot ? -1 : t), z1 = part.z1 + (openTop ? 1 : -t);
  const own = [];
  try {
    ctx.progress(0.2, 'the cavity');
    const rings = part.region.flatMap(P => [P.outer, ...P.holes].map(r => r.map(q => [q.X / S, q.Y / S])));
    const plan = new M.CrossSection(rings, 'EvenOdd'); own.push(plan);
    const inner = plan.offset(-t, 'Round', 2, arcSegs(t)); own.push(inner);
    if (inner.isEmpty()) throw new ToolError(`Nothing to hollow: the part is narrower than twice the wall (${(2 * t).toFixed(2)} mm) everywhere.`);
    const cav = M.Manifold.extrude(inner, z1 - z0); own.push(cav);
    // an open top or bottom is already open (the cavity runs out through it): no window cut there,
    // which reaching one wall in from the face would carry through the floor of a shallow part
    const rest = faces.filter(F => !(openTop && flat(F, 1, part.z1)) && !(openBot && flat(F, -1, part.z0)));
    return cutOut(tris, cav.translate([0, 0, z0]), rest, t, ctx,
      `Wall ${t.toFixed(2)} mm, exact: the part is flat, so the inside is its outline moved in by the wall (Detail is not used).`, faces.length - rest.length);
  } finally { for (const x of own) x.delete(); }
}

/** Round inside corners within 0.01 mm of a true arc: segments in a full circle of radius t. */
const arcSegs = t => Math.min(512, Math.max(16, Math.ceil((2 * Math.PI) / Math.acos(1 - Math.min(0.01 / t, 1)))));

/**
 * Hollow of a shaped flat part, exact: its section (height against distance in from the
 * outline) is moved in by the wall in two dimensions, which is exactly what the wall is across
 * a straight edge, and the cavity is that section's profile built round the outline moved in
 * by the wall, the way the edge shaper builds the part itself. null if the section cannot be
 * read back as a single cavity (the grid does those).
 */
function exactShaped(tris, part, faces, t, ctx) {
  const H = part.z1 - part.z0;
  // too thin for a floor and a roof: the grid decides (it knows which faces are open, and says so)
  if (H <= 2 * t) return null;
  ctx.progress(0.2, 'the cavity');
  // the section, counter-clockwise in (distance, height): along the bottom, up the far end, back
  // along the top, down the outside wall; carried well past where both faces go flat
  const top = part.top || [[0, H]], bottom = part.bottom || [[0, 0]];
  const D = Math.max(top[top.length - 1][0], bottom[bottom.length - 1][0]) + 2 * t + 2;
  const sec = [...bottom, [D, 0], [D, H], ...top.slice().reverse()];
  const P = sec.map(([d, z]) => ({ X: Math.round(d * S), Y: Math.round(z * S) }));
  const co = new ClipperLib.ClipperOffset(2, 0.01 * S);
  co.AddPath(P, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const res = new ClipperLib.Paths();
  co.Execute(res, -t * S);
  if (res.length !== 1) return null;   // the cavity's section is not one piece
  const Q = res[0].map(q => [q.X / S - t, q.Y / S - t]);   // distance in from the cavity's outline, height above its floor
  if (ClipperLib.Clipper.Area(res[0]) < 0) Q.reverse();
  // the cavity's two profiles: from its outline wall (d = 0) in, along the top and the bottom
  const n = Q.length, tc = H - 2 * t;
  let iL = 0, iR = 0;
  for (let i = 1; i < n; i++) {
    if (Q[i][0] < Q[iL][0] - 1e-6 || (Math.abs(Q[i][0] - Q[iL][0]) <= 1e-6 && Q[i][1] < Q[iL][1])) iL = i;   // bottom of the outline wall
    if (Q[i][0] > Q[iR][0] + 1e-6 || (Math.abs(Q[i][0] - Q[iR][0]) <= 1e-6 && Q[i][1] < Q[iR][1])) iR = i;   // bottom of the far end
  }
  const walk = (from, to) => { const out = []; for (let i = from; ; i = (i + 1) % n) { out.push(Q[i]); if (i === to) break; } return out; };
  const lower = walk(iL, iR);                       // along the bottom, distance rising
  const upper = walk(iR, iL).reverse();             // the far end, the top, the wall: turned round
  const wallTop = upper.findIndex(([d], i) => i > 0 && d > 1e-6) - 1;   // last point of the outline wall
  const prof = (pts, flatAt) => {
    const out = [];
    for (const [d, z] of pts) {
      out.push([Math.max(0, d), Math.abs(z - flatAt) < 1e-4 ? flatAt : z]);
      if (Math.abs(z - flatAt) < 1e-4 && d > 1e-6) break;
    }
    out[0][0] = 0;
    return out.length > 1 && Math.abs(out[out.length - 1][1] - flatAt) < 1e-4 ? out : null;
  };
  const topC = Math.abs(upper[Math.max(0, wallTop)][1] - tc) < 1e-4 ? null : prof(upper.slice(Math.max(0, wallTop)), tc);
  const botC = Math.abs(lower[0][1]) < 1e-4 ? null : prof(lower, 0);
  if ((part.top && !topC && Math.abs(upper[Math.max(0, wallTop)][1] - tc) >= 1e-4) || (part.bottom && !botC && Math.abs(lower[0][1]) >= 1e-4)) return null;
  const base = inset(part.region, t);
  if (!base.length) throw new ToolError(`Nothing to hollow: the part is narrower than twice the wall (${(2 * t).toFixed(2)} mm) everywhere.`);
  const cavTris = shapeOutline(base, part.z0 + t, tc, topC, botC);
  const cav = ctx.kernel.toManifold(cavTris);
  try {
    return cutOut(tris, cav, faces, t, ctx,
      `Wall ${t.toFixed(2)} mm, exact: the inside follows the part's shaped edge, moved in by the wall (Detail is not used).`);
  } finally { cav.delete(); }
}

/** The part with a cavity (a solid, not consumed) and an opening through each picked face cut away. */
function cutOut(tris, cavity, faces, t, ctx, first, already = 0) {   // already: faces the cavity opens itself
  const { M, toManifold, toTris } = ctx.kernel;
  const segs = arcSegs(t);
  const own = [];
  try {
    const parts = [cavity];
    const notes = [first];
    faces.forEach((F, k) => {
      ctx.progress(0.4 + 0.3 * (k / faces.length), 'openings');
      // the face in its own plane: u, v across it, n out of it (u x v = n, so faces stay counter-clockwise)
      const n = F.n, a = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      let u = [a[1] * n[2] - a[2] * n[1], a[2] * n[0] - a[0] * n[2], a[0] * n[1] - a[1] * n[0]];
      const ul = Math.hypot(...u); u = u.map(x => x / ul);
      const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
      const polys = F.list.map(f => [0, 3, 6].map(o => {
        const i = f * 9 + o;
        return [tris[i] * u[0] + tris[i + 1] * u[1] + tris[i + 2] * u[2], tris[i] * v[0] + tris[i + 1] * v[1] + tris[i + 2] * v[2]];
      }));
      const face = new M.CrossSection(polys, 'Positive'); own.push(face);
      const win = face.offset(-t, 'Round', 2, segs); own.push(win);
      if (win.isEmpty()) { notes.push(`Face ${k + 1} is too small to open with a ${t} mm wall round it: left closed.`); return; }
      // from just past the wall (0.05 mm into the cavity, which is exactly one wall in) to 1 mm
      // outside the face. (1 mm in went through the floor of a part under a wall plus 1 mm deep.)
      const bar = M.Manifold.extrude(win, t + 1.05); own.push(bar);
      const o = F.d - t - 0.05;
      const tunnel = bar.transform([u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, n[0], n[1], n[2], 0, n[0] * o, n[1] * o, n[2] * o, 1]);
      own.push(tunnel); parts.push(tunnel);
    });
    ctx.progress(0.75, 'cutting');
    const hole = M.Manifold.union(parts); own.push(hole);
    const outer = toManifold(tris); own.push(outer);
    const res = outer.subtract(hole); own.push(res);
    const opened = parts.length - 1 + already;
    notes.push(opened ? `${opened} face${opened > 1 ? 's' : ''} opened.` : 'Closed hollow: pick faces in the view to open it through them.');
    return { tris: toTris(res), notes };
  } finally { for (const x of own) x.delete(); }
}

/** A typed list that grows by doubling: no limit on length but memory. */
class Grow {
  constructor(T, cap = 1024) { this.T = T; this.a = new T(cap); this.n = 0; }
  static of(T, src) { const g = new Grow(T, Math.max(16, src.length)); g.a.set(src); g.n = src.length; return g; }
  room(k) { if (this.n + k > this.a.length) { const b = new this.T(Math.max(this.a.length * 2, this.n + k)); b.set(this.a.subarray(0, this.n)); this.a = b; } }
  push1(x) { this.room(1); this.a[this.n++] = x; }
  push3(x, y, z) { this.room(3); const a = this.a, n = this.n; a[n] = x; a[n + 1] = y; a[n + 2] = z; this.n = n + 3; }
  append(src, len) { this.room(len); this.a.set(src.subarray(0, len), this.n); this.n += len; }
}

/** Ray crossings, sorted, with doubles from shared edges merged. s: +1 entering, -1 leaving. */
function crossings(hits, dir, origin, axis) {
  const list = hits.map(hh => ({ d: axis === 2 ? hh.point.z : hh.distance, s: hh.face.normal.dot(dir) < 0 ? 1 : -1 }))
    .sort((a, b) => a.d - b.d);
  const z = [], s = [];
  for (const c of list) {
    const k = z.length - 1;
    if (k >= 0 && Math.abs(c.d - z[k]) < 1e-6 && s[k] === c.s) continue;
    z.push(c.d); s.push(c.s);
  }
  return { z, s };
}

function triNormal(V, f) {
  const a = f[0] * 3, b = f[1] * 3, c = f[2] * 3;
  const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
  const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}
