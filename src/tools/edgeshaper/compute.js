// Edge profiles on flat parts, in the worker. Every edge: the outline shaped in rings (core/rings.js).
// Some edges: the profile swept along each and cut away by the solid engine.
import { ToolError } from '../../core/meshcheck.js';
import { S, flatPart } from '../../core/flat.js';
import { shapeOutline } from '../../core/rings.js';
import { levels, problem, RING_STEP } from './profile.js';

export async function run(tris, p, ctx) {
  if (p.edges && p.edges !== 'all') return picked(tris, p, ctx);
  const part = flatPart(tris);
  const t = part.z1 - part.z0;
  const bad = problem(p, t);
  if (bad) throw new ToolError(bad);
  ctx.progress(0.1, 'outline');
  const lv = levels(p, t);
  const top = p.face === 'top' || p.face === 'both' ? lv : null;
  const bottom = p.face === 'bottom' || p.face === 'both' ? lv.map(([d, z]) => [d, t - z]) : null;
  return { tris: shapeOutline(part.region, part.z0, t, top, bottom, ctx.progress), notes: [`Rings: ${lv.length}. Part ${t.toFixed(2)} mm thick.`] };
}

// ---- some edges only ----------------------------------------------------------------------
// The rings above measure each point's distance to the whole outline. For some edges only, the
// same profile is measured to those edges alone: each chosen edge gets the cut-away part of the
// section swept along it, and turned round its ends, and all of that is taken out of the part
// at once. A cut beside an edge left alone runs straight out through that wall. With every
// edge chosen this matches the ring result.
const LIFT = 1;   // mm the cutters reach past the treated face

async function picked(tris, p, ctx) {
  const K = ctx.kernel;
  if (!K) throw new ToolError('Picked edges need the solid kernel.');
  const part = flatPart(tris);
  const t = part.z1 - part.z0;
  const bad = problem(p, t);
  if (bad) throw new ToolError(bad);
  const segs = ctx.selection?.segs || [];
  if (!segs.length) throw new ToolError(p.edges === 'only' ? 'Pick the side walls whose edges to shape.' : 'Pick the side walls to leave alone.');
  ctx.progress(0.1, 'edges');
  // the outline's edges, in mm, and which of them were picked (a picked wall lies along it)
  const edges = [];
  for (const P of part.region) for (const r of [P.outer, ...P.holes]) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      edges.push([a.X / S, a.Y / S, b.X / S, b.Y / S]);
    }
  }
  const onPick = e => {
    const mx = (e[0] + e[2]) / 2, my = (e[1] + e[3]) / 2, ex = e[2] - e[0], ey = e[3] - e[1], el = Math.hypot(ex, ey) || 1;
    return segs.some(([x1, y1, x2, y2]) => {
      const sx = x2 - x1, sy = y2 - y1, sl = Math.hypot(sx, sy) || 1;
      if (Math.abs(ex * sy - ey * sx) / (el * sl) > 1e-3) return false;   // not parallel
      const u = Math.max(0, Math.min(1, ((mx - x1) * sx + (my - y1) * sy) / (sl * sl)));
      return Math.hypot(mx - x1 - u * sx, my - y1 - u * sy) < 0.01;
    });
  };
  const hits = edges.map(onPick);
  if (!hits.some(Boolean)) throw new ToolError('None of the picked walls is a side wall of this part as it is now. Pick them again.');
  const chosen = edges.filter((e, i) => (p.edges === 'only') === hits[i]);
  if (!chosen.length) throw new ToolError('Every edge is picked to be left alone, so nothing would change.');

  const { M } = K;
  const lv = levels(p, t);
  const w = lv[lv.length - 1][0];
  const faces = [];
  if (p.face === 'top' || p.face === 'both') faces.push({ prof: lv, past: t + LIFT });
  if (p.face === 'bottom' || p.face === 'both') faces.push({ prof: lv.map(([d, z]) => [d, t - z]), past: -LIFT });
  const area = poly => poly.reduce((s, q, i) => { const r = poly[(i + 1) % poly.length]; return s + q[0] * r[1] - r[0] * q[1]; }, 0);
  const ccw = poly => (area(poly) < 0 ? poly.slice().reverse() : poly);
  const cutters = [];
  const segsRound = Math.min(128, Math.max(16, Math.ceil((2 * Math.PI * w) / RING_STEP)));
  for (const { prof, past } of faces) {
    // section of what is cut away, (across the edge, height): one side for turning round an
    // end, both sides (mirrored) for sweeping along an edge
    const right = ccw([...prof, [w, past], [0, past]]);
    const whole = ccw([[w, past], ...prof.slice().reverse(), ...prof.slice(1).map(([d, z]) => [-d, z]), [-w, past]]);
    const across = new M.CrossSection([whole]);
    const round = new M.CrossSection([right]);
    const ends = new Set();
    for (const [x1, y1, x2, y2] of chosen) {
      const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
      if (L < 1e-9) continue;
      const ux = dx / L, uy = dy / L;
      // columns: section x -> across the edge, section y -> up, extrude -> along the edge
      const m = [-uy, ux, 0, 0, 0, 0, 1, 0, ux, uy, 0, 0, x1, y1, part.z0, 1];
      const bar = across.extrude(L);
      cutters.push(bar.transform(m));
      bar.delete();
      for (const [x, y] of [[x1, y1], [x2, y2]]) {
        const k = `${x.toFixed(5)},${y.toFixed(5)}`;
        if (ends.has(k)) continue;
        ends.add(k);
        const r = M.Manifold.revolve(round, segsRound);
        cutters.push(r.translate([x, y, part.z0]));
        r.delete();
      }
    }
    across.delete(); round.delete();
  }
  ctx.progress(0.5, 'cutting');
  const solid = K.toManifold(tris);
  const cut = M.Manifold.union(cutters);
  const out = solid.subtract(cut);
  const res = K.toTris(out);
  for (const m of [...cutters, cut, out, solid]) m.delete();
  const n = chosen.length;
  return { tris: res, notes: [`${n} edge${n === 1 ? '' : 's'} shaped. Part ${t.toFixed(2)} mm thick.`] };
}



