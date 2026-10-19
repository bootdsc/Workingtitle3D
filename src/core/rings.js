// Shaped outlines, in the worker: an outline pushed up from z0, its top and bottom faces
// shaped by a profile of height against distance in from the outline. The outline is offset
// inward in rings (clipper, integer coords), each ring lifted to the profile height for its
// distance, rings zipped into bands, then walls and the flat middle added, all on shared
// vertices. Closed by construction; on narrow strips the rings run out and the slopes meet
// in a ridge. Used by the edge shaper (the part) and the hollow (its cavity).
import ClipperLib from 'clipper-lib';
import { triangulate } from './tri2d.js';
import { S, fromTree } from './flat.js';

const ARC_TOL = 0.01;       // mm, rounded inner corners

/**
 * base: clipper polygons; top, bottom: [[distance in from the outline, height above z0]],
 * first at distance 0, last where the face goes flat; null leaves that face flat at t or 0.
 */
export function shapeOutline(base, z0, t, top, bottom, progress = () => {}) {
  const m = new Builder();
  let top0 = t, bot0 = 0;
  if (top) {
    surface(m, base, top, t, true, f => progress(0.15 + 0.4 * f, 'top rings'));
    top0 = top[0][1];
  } else fillFlat(m, base, t, true);
  if (bottom) {
    surface(m, base, bottom, 0, false, f => progress(0.55 + 0.4 * f, 'bottom rings'));
    bot0 = bottom[0][1];
  } else fillFlat(m, base, 0, false);
  for (const P of base) for (const r of [P.outer, ...P.holes]) wall(m, r, bot0, top0);
  return m.array(z0);
}

/** The outline moved in by dmm (round where it turns inward), as clipper polygons. */
export function inset(polys, dmm) {
  const co = new ClipperLib.ClipperOffset(2, ARC_TOL * S);
  for (const P of polys) co.AddPaths([P.outer, ...P.holes], ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const tree = new ClipperLib.PolyTree();
  co.Execute(tree, -dmm * S);
  return fromTree(tree);
}

const pip = (pt, path) => ClipperLib.Clipper.PointInPolygon(pt, path);   // 1 in, 0 out, -1 on

class Builder {
  constructor() { this.ix = new Map(); this.v = []; this.f = []; }
  vid(X, Y, z) {
    const k = X + ',' + Y + ',' + z;
    let i = this.ix.get(k);
    if (i === undefined) { i = this.v.length / 3; this.ix.set(k, i); this.v.push(X / S, Y / S, z); }
    return i;
  }
  tri(a, b, c) { if (a !== b && b !== c && a !== c) this.f.push(a, b, c); }
  array(z0) {
    const out = new Float32Array(this.f.length * 3);
    for (let i = 0; i < this.f.length; i++) {
      const v = this.f[i] * 3;
      out[i * 3] = this.v[v]; out[i * 3 + 1] = this.v[v + 1]; out[i * 3 + 2] = this.v[v + 2] + z0;
    }
    return out;
  }
}

/** Fill plan regions. pieces: [{rings: [path...], zs: [z...]}], rings[0] outer. up: faces +Z. */
function fill(m, pieces, up) {
  for (const { rings, zs } of pieces) {
    // one loop inside another at a different height: a band, zipped (see stitch)
    if (rings.length === 2 && zs[0] !== zs[1]) { stitch(m, rings[0], zs[0], rings[1], zs[1], up); continue; }
    const pts = rings.map(r => r.map(q => [q.X, q.Y]));
    const ids = [], zz = [];
    rings.forEach((r, k) => r.forEach(q => { ids.push(m.vid(q.X, q.Y, zs[k])); zz.push(zs[k]); }));
    const { tris, extra } = triangulate(pts);
    for (const [x, y, a, b, c] of extra) {
      const z = (zz[a] + zz[b] + zz[c]) / 3;
      ids.push(m.vid(Math.round(x), Math.round(y), z));
    }
    for (let i = 0; i < tris.length; i += 3) {
      const a = ids[tris[i]], b = ids[tris[i + 1]], c = ids[tris[i + 2]];
      if (up) m.tri(a, b, c); else m.tri(a, c, b);
    }
  }
}

/** A band between two loops running the same way, b inside a: zipped, so every triangle has
 *  corners on both loops and the band slopes evenly. A plan triangulation of a thin band puts
 *  all three corners of many triangles on one loop: those lie flat and the band reads as
 *  terraces, each with a feature line. Starts at b's point nearest a[0], then steps whichever
 *  loop gives the shorter new edge. */
function stitch(m, a, za, b, zb, up) {
  const na = a.length, nb = b.length;
  const d2 = (p, q) => (p.X - q.X) ** 2 + (p.Y - q.Y) ** 2;
  let j0 = 0;
  for (let j = 1; j < nb; j++) if (d2(a[0], b[j]) < d2(a[0], b[j0])) j0 = j;
  const A = i => m.vid(a[i % na].X, a[i % na].Y, za), B = j => m.vid(b[(j0 + j) % nb].X, b[(j0 + j) % nb].Y, zb);
  const pa = i => a[i % na], pb = j => b[(j0 + j) % nb];
  // loops run counter-clockwise (outer) or clockwise (holes); the band's own sense decides
  const flip = (ClipperLib.Clipper.Area(a) < 0) !== !up;
  const tri = (x, y, z) => (flip ? m.tri(x, z, y) : m.tri(x, y, z));
  let i = 0, j = 0;
  while (i < na || j < nb) {
    const stepA = j >= nb || (i < na && d2(pa(i + 1), pb(j)) <= d2(pa(i), pb(j + 1)));
    if (stepA) { tri(A(i), A(i + 1), B(j)); i++; } else { tri(A(i), B(j + 1), B(j)); j++; }
  }
}

function fillFlat(m, polys, z, up) {
  fill(m, polys.map(P => ({ rings: [P.outer, ...P.holes], zs: [z, ...P.holes.map(() => z)] })), up);
}

/** Vertical band along a ring. Outer rings run counter-clockwise and holes clockwise,
 *  so the right-hand side is always outside. */
function wall(m, ring, lo, hi) {
  if (hi - lo <= 1e-9) return;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const a0 = m.vid(a.X, a.Y, lo), b0 = m.vid(b.X, b.Y, lo);
    const a1 = m.vid(a.X, a.Y, hi), b1 = m.vid(b.X, b.Y, hi);
    m.tri(a0, b0, b1);
    m.tri(a0, b1, a1);
  }
}

/** The profiled face: bands between offset rings, then the flat middle. lv: [[d, z]], z absolute. */
function surface(m, base, lv, topValue, up, progress) {
  const rings = [base];
  for (let k = 1; k < lv.length; k++) {
    const g = inset(base, lv[k][0]);
    if (!g.length) break;
    rings.push(g);
    progress((k / lv.length) * 0.7);
  }
  const zs = lv.slice(0, rings.length).map(([, z]) => z);
  const ranOut = rings.length < lv.length;   // narrow part: the rings vanished early
  const last = rings.length - 1;
  for (let k = 0; k < rings.length; k++) {
    const zk = zs[k], zn = k < last ? zs[k + 1] : null;
    const inner = k < last ? rings[k + 1] : [];
    const pieces = [];
    for (const C of rings[k]) {
      if (k === last) {
        // the flat middle. A rabbet (profile ends below the face) steps up first;
        // if the rings ran out, this is the ridge cap at the last ring's height.
        let cap = zk;
        if (!ranOut && Math.abs(zk - topValue) > 1e-9) {
          const [lo, hi] = zk < topValue ? [zk, topValue] : [topValue, zk];
          for (const r of [C.outer, ...C.holes]) wall(m, r, lo, hi);
          cap = topValue;
        }
        pieces.push({ rings: [C.outer, ...C.holes], zs: [cap, ...C.holes.map(() => cap)] });
        continue;
      }
      const inside = inner.filter(D => pip(D.outer[0], C.outer) === 1 && C.holes.every(H => pip(D.outer[0], H) === 0));
      // band: C minus the next ring's islands; C's own holes that sit in no island stay here
      const loose = C.holes.filter(I => inside.every(D => pip(I[0], D.outer) === 0));
      pieces.push({ rings: [C.outer, ...inside.map(D => D.outer), ...loose], zs: [zk, ...inside.map(() => zn), ...loose.map(() => zk)] });
      // round each hole of the next ring, down to this ring's holes inside it
      for (const D of inside) {
        for (const Hh of D.holes) {
          const mine = C.holes.filter(I => pip(I[0], Hh) !== 0);
          pieces.push({ rings: [Hh, ...mine], zs: [zn, ...mine.map(() => zk)] });
        }
      }
    }
    fill(m, pieces, up);
    progress(0.7 + (0.3 * (k + 1)) / rings.length);
  }
}
