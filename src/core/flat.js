// Flat parts: an outline pushed straight up (a plate, a cut-out). Finding one in a mesh, and
// its outline as clipper polygons. Shared by the edge shaper and the hollow, in the worker.
import ClipperLib from 'clipper-lib';
import { ToolError, weld } from './meshcheck.js';

export const S = 1e4;        // clipper units per mm (0.1 um), so shared ring vertices match exactly
const CLEAN = 1.415;         // clipper units: drop points closer than this to their neighbours' line

/** { z0, z1, region: [{outer, holes}] } of a flat part, or a ToolError saying why it is not one. */
export function flatPart(tris) {
  let z0 = Infinity, z1 = -Infinity;
  for (let i = 2; i < tris.length; i += 3) { z0 = Math.min(z0, tris[i]); z1 = Math.max(z1, tris[i]); }
  const span = z1 - z0;
  if (span < 1e-6) throw new ToolError('The part has no thickness.');
  const tol = Math.max(1e-3, span * 1e-4);
  let worst = 0;
  for (let i = 2; i < tris.length; i += 3) worst = Math.max(worst, Math.min(Math.abs(tris[i] - z0), Math.abs(tris[i] - z1)));
  if (worst > tol) {
    throw new ToolError(`Not a flat part: it has corners between the top and bottom faces (worst ${worst.toFixed(2)} mm off). `
      + 'This tool shapes outlines pushed straight up, like a plate or a cut-out.');
  }
  // the plan is the union of the bottom face; the top face must match it
  const face = level => {
    const paths = [];
    for (let i = 0; i < tris.length; i += 9) {
      if (Math.abs(tris[i + 2] - level) > tol || Math.abs(tris[i + 5] - level) > tol || Math.abs(tris[i + 8] - level) > tol) continue;
      paths.push([0, 3, 6].map(k => ({ X: Math.round(tris[i + k] * S), Y: Math.round(tris[i + k + 1] * S) })));
    }
    const c = new ClipperLib.Clipper();
    c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
    const out = new ClipperLib.Paths();
    c.Execute(ClipperLib.ClipType.ctUnion, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    return out;
  };
  const bottom = face(z0), top = face(z1);
  const area = ps => ps.reduce((s, q) => s + ClipperLib.Clipper.Area(q), 0) / (S * S);
  const a = Math.abs(area(bottom));
  if (a < 1e-6) throw new ToolError('Could not find the bottom face of the part.');
  const x = new ClipperLib.Clipper();
  x.AddPaths(bottom, ClipperLib.PolyType.ptSubject, true);
  x.AddPaths(top, ClipperLib.PolyType.ptClip, true);
  const diff = new ClipperLib.Paths();
  x.Execute(ClipperLib.ClipType.ctXor, diff, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const d = Math.abs(area(diff));
  if (d > Math.max(1e-3 * a, 0.01)) {
    throw new ToolError(`Not a flat part: the top and bottom outlines differ by ${d.toFixed(2)} mm2, so the side walls are not straight up.`);
  }
  const region = toPolys(bottom, ClipperLib.PolyFillType.pftNonZero);
  if (!region.length) throw new ToolError('The outline is empty.');
  return { z0, z1, region };
}

/**
 * A shaped flat part: an outline whose top and bottom heights depend only on the distance in
 * from the outline, as the edge shaper makes (a plate with a fillet, chamfer or cove, a disc
 * with a rounded rim). Returns { z0, z1, region, top, bottom }, profiles as [[distance in mm,
 * height above z0]] from the outline in to where the face goes flat (null: that face is flat),
 * or null when the part is not one. Every surface point is checked against the profile.
 */
export function shapedPart(tris, tol = 0.02) {
  let z0 = Infinity, z1 = -Infinity;
  for (let i = 2; i < tris.length; i += 3) { z0 = Math.min(z0, tris[i]); z1 = Math.max(z1, tris[i]); }
  if (!(z1 - z0 > 1e-6)) return null;
  // quick no: a shaped flat part keeps a flat face at its bottom and at its top (the middle
  // the profile ends in), so a part without both is not one, and nothing heavier is tried
  const lying = level => {
    for (let i = 0; i < tris.length; i += 9) if (Math.abs(tris[i + 2] - level) < 1e-6 && Math.abs(tris[i + 5] - level) < 1e-6 && Math.abs(tris[i + 8] - level) < 1e-6) return true;
    return false;
  };
  if (!lying(z0) || !lying(z1)) return null;
  // the plan: the faces looking up cover it all (the walls stand on its outline), so its outline
  // is their rim, the edges with no up-facing face on the other side, already running
  // counter-clockwise round the outside and clockwise round holes. One pass, no clipping of
  // every triangle (that took 33 s on a 108k-triangle plate).
  const { pos, idx, nv } = weld(tris);
  const nf = idx.length / 3;
  const rim = new Map();
  for (let f = 0; f < nf; f++) {
    const a = idx[f * 3] * 3, b = idx[f * 3 + 1] * 3, c3 = idx[f * 3 + 2] * 3;
    const nz = (pos[b] - pos[a]) * (pos[c3 + 1] - pos[a + 1]) - (pos[c3] - pos[a]) * (pos[b + 1] - pos[a + 1]);
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c3] - pos[a], vy = pos[c3 + 1] - pos[a + 1], vz = pos[c3 + 2] - pos[a + 2];
    const l = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, nz);
    if (!(nz > 1e-3 * l)) continue;
    for (let k = 0; k < 3; k++) {
      const p = idx[f * 3 + k], q = idx[f * 3 + (k + 1) % 3];
      const back = q * nv + p;
      if (rim.has(back)) rim.delete(back); else rim.set(p * nv + q, q);
    }
  }
  const nextOf = new Map();
  for (const [key, q] of rim) nextOf.set((key - q) / nv, q);
  const loops = [];
  for (const start of nextOf.keys()) {
    if (!nextOf.has(start)) continue;
    const loop = [];
    let p = start;
    while (nextOf.has(p)) { const q = nextOf.get(p); nextOf.delete(p); loop.push({ X: Math.round(pos[p * 3] * S), Y: Math.round(pos[p * 3 + 1] * S) }); p = q; }
    if (p !== start || loop.length < 3) return null;   // the rim does not close: not a simple plan
    loops.push(loop);
  }
  const region = toPolys(loops, ClipperLib.PolyFillType.pftNonZero);
  if (!region.length) return null;
  const segs = [];
  for (const P of region) for (const r of [P.outer, ...P.holes]) for (let k = 0; k < r.length; k++) {
    const a = r[k], b = r[(k + 1) % r.length];
    segs.push(a.X / S, a.Y / S, b.X / S, b.Y / S);
  }
  const dist = (x, y) => {
    let best = Infinity;
    for (let s = 0; s < segs.length; s += 4) {
      const ax = segs[s], ay = segs[s + 1], ex = segs[s + 2] - ax, ey = segs[s + 3] - ay;
      const l2 = ex * ex + ey * ey;
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2)) : 0;
      const dx = x - ax - u * ex, dy = y - ay - u * ey, d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
    return Math.sqrt(best);
  };
  // each corner of each face facing up (top) or down (bottom), as (distance in, height)
  const up = [], down = [];
  const seen = new Map();
  const dOf = (x, y) => { const k = x + ',' + y; let d = seen.get(k); if (d === undefined) seen.set(k, d = dist(x, y)); return d; };
  for (let i = 0; i < tris.length; i += 9) {
    const ux = tris[i + 3] - tris[i], uy = tris[i + 4] - tris[i + 1], uz = tris[i + 5] - tris[i + 2];
    const vx = tris[i + 6] - tris[i], vy = tris[i + 7] - tris[i + 1], vz = tris[i + 8] - tris[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (!(l > 0) || Math.abs(nz) < 1e-3 * l) continue;   // a wall
    const list = nz > 0 ? up : down;
    for (let k = 0; k < 9; k += 3) list.push(dOf(tris[i + k], tris[i + k + 1]), tris[i + k + 2] - z0);
  }
  const t = z1 - z0;
  // a profile: heights by distance (to 0.001 mm), a step where one distance has two heights
  const profile = (list, flatAt, rising) => {
    const g = new Map();
    for (let k = 0; k < list.length; k += 2) {
      const d = Math.round(list[k] * 1000) / 1000, z = list[k + 1];
      const e = g.get(d);
      if (!e) g.set(d, [z, z]); else { e[0] = Math.min(e[0], z); e[1] = Math.max(e[1], z); }
    }
    const ds = [...g.keys()].sort((a, b) => a - b);
    if (!ds.length || ds[0] > 1e-3) return undefined;
    const pts = [];
    for (const d of ds) {
      const [lo, hi] = g.get(d);
      if (hi - lo > tol) pts.push(...(rising ? [[d, lo], [d, hi]] : [[d, hi], [d, lo]]));
      else pts.push([d, rising ? hi : lo]);
    }
    pts[0][0] = 0;
    const end = pts.findIndex(([, z]) => Math.abs(z - flatAt) <= 1e-6);
    if (end === 0) return null;   // flat from the outline in
    if (end < 0) return undefined;
    const prof = pts.slice(0, end + 1);
    // every corner on it, within tol
    const at = d => {
      let a = 0, b = prof.length - 1;
      if (d >= prof[b][0]) return [flatAt, flatAt];
      while (b - a > 1) { const m = (a + b) >> 1; if (prof[m][0] <= d) a = m; else b = m; }
      const [d0, za] = prof[a], [d1, zb] = prof[b];
      if (d1 - d0 < 1e-9) return [Math.min(za, zb), Math.max(za, zb)];
      const z = za + (zb - za) * (d - d0) / (d1 - d0);
      return [z, z];
    };
    for (let k = 0; k < list.length; k += 2) {
      const [lo, hi] = at(list[k]);
      if (list[k + 1] < lo - tol || list[k + 1] > hi + tol) return undefined;
    }
    return prof;
  };
  const top = profile(up, t, true), bottom = profile(down, 0, false);
  if (top === undefined || bottom === undefined) return null;
  return { z0, z1, region, top, bottom };
}

/** Paths -> [{outer, holes}] with outer counter-clockwise and holes clockwise, cleaned. */
export function toPolys(paths, fill = ClipperLib.PolyFillType.pftEvenOdd) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, tree, fill, fill);
  return fromTree(tree);
}

export function fromTree(tree) {
  const out = [];
  for (const ex of ClipperLib.JS.PolyTreeToExPolygons(tree)) {
    const outer = orient(ClipperLib.Clipper.CleanPolygon(ex.outer, CLEAN), true);
    if (!outer) continue;
    const holes = (ex.holes || []).map(hh => orient(ClipperLib.Clipper.CleanPolygon(hh, CLEAN), false)).filter(Boolean);
    out.push({ outer, holes });
  }
  return out;
}

function orient(path, ccw) {
  if (!path || path.length < 3) return null;
  const a = ClipperLib.Clipper.Area(path);
  if (Math.abs(a) < 1) return null;
  return (a > 0) === ccw ? path : path.slice().reverse();
}
