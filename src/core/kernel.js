// The modelling core, in the worker. A part is a recipe; its mesh is rebuilt from it.
//
//   part = { id, name, kind, params, xform: {pos, rot, scale}, hole, ops: [{tool, params, sel}],
//            children: [part] (groups), blob: id (imported meshes) }
//
// kind: box | cylinder | cone | sphere | torus | wedge | tube | mesh | group.
// Shapes are built in the part's own frame, sitting on z = 0 and centred in x and y;
// xform places them. A group joins its solid children and cuts its hole children.
// Results are cached by recipe key, so moving one part never rebuilds another.
import Module from 'manifold-3d';
import { Matrix4, Euler, Quaternion, Vector3 } from 'three';
import { weld, report, volume, flipAll, repair, bounds, WELD, ToolError } from './meshcheck.js';
import { solidify } from './solidify.js';
import { decimate } from './decimate.js';

let M = null, starting = null;
export async function initKernel(wasmBinary) {
  // one engine per worker: two jobs arriving together must not each start their own
  starting ||= Module({ wasmBinary }).then(m => { m.setup(); M = m; });
  return starting;
}

/** What a tool step gets as ctx.kernel: the solid engine and the mesh converters (tests use it too). */
export const toolKernel = () => ({ M, toManifold, toTris });

// ---- recipe keys -------------------------------------------------------------------------
import { shapeKey } from './doc.js';
export { shapeKey };

const cache = new Map();   // key -> Manifold, oldest first
const CACHE_MAX = 400;
function remember(key, man) {
  cache.set(key, man);
  while (cache.size > CACHE_MAX) {
    const [k, m] = cache.entries().next().value;
    cache.delete(k);
    m.man?.delete();
  }
}

// ---- transforms -----------------------------------------------------------------------------
export function matrix(x) {
  const m = new Matrix4();
  const r = (x?.rot || [0, 0, 0]).map(d => (d * Math.PI) / 180);
  m.compose(new Vector3(...(x?.pos || [0, 0, 0])), new Quaternion().setFromEuler(new Euler(r[0], r[1], r[2], 'XYZ')),
    new Vector3(...(x?.scale || [1, 1, 1])));
  return m;
}
const isIdentity = x => !x || ((!x.pos || x.pos.every(v => v === 0)) && (!x.rot || x.rot.every(v => v === 0)) && (!x.scale || x.scale.every(v => v === 1)));
function place(man, xform) {
  if (isIdentity(xform)) return man;
  const e = matrix(xform).elements;
  return man.transform(Array.from(e));
}

// ---- shapes --------------------------------------------------------------------------------
export const SHAPES = {
  box: { x: 20, y: 20, z: 20 },
  cylinder: { d: 20, h: 20, sides: 64 },
  cone: { d1: 20, d2: 0, h: 20, sides: 64 },
  sphere: { d: 20, sides: 64 },
  torus: { d: 20, tube: 4, sides: 64, tubeSides: 24 },
  wedge: { x: 20, y: 20, z: 20 },
  tube: { d: 20, wall: 2, h: 20, sides: 64 },
  fillet: { r: 5, length: 20, sides: 64 },
};

function primitive(kind, p) {
  const { Manifold, CrossSection } = M;
  const pos = v => { if (!(v > 0)) throw new ToolError(`${kind}: every size must be above zero.`); return v; };
  const sides = s => Math.max(3, Math.round(s || 64));
  switch (kind) {
    case 'box': return Manifold.cube([pos(p.x), pos(p.y), pos(p.z)], true).translate([0, 0, p.z / 2]);
    case 'cylinder': return Manifold.cylinder(pos(p.h), pos(p.d) / 2, p.d / 2, sides(p.sides));
    case 'cone': {
      if (!(p.d1 >= 0 && p.d2 >= 0) || p.d1 + p.d2 <= 0) throw new ToolError('cone: a diameter must be above zero.');
      // the library wants the wide end down; flip if the top is the wide end
      if (p.d1 >= p.d2) return Manifold.cylinder(pos(p.h), p.d1 / 2, p.d2 / 2, sides(p.sides));
      return Manifold.cylinder(pos(p.h), p.d2 / 2, p.d1 / 2, sides(p.sides)).mirror([0, 0, 1]).translate([0, 0, p.h]);
    }
    case 'sphere': return Manifold.sphere(pos(p.d) / 2, sides(p.sides)).translate([0, 0, p.d / 2]);
    case 'torus': {
      const R = (pos(p.d) - pos(p.tube)) / 2;
      if (R <= p.tube / 2) throw new ToolError('torus: the tube is too thick for that diameter.');
      return Manifold.revolve(CrossSection.circle(p.tube / 2, sides(p.tubeSides)).translate([R, 0]), sides(p.sides)).translate([0, 0, p.tube / 2]);
    }
    case 'wedge': {
      const x = pos(p.x) / 2, y = pos(p.y) / 2, z = pos(p.z);
      return Manifold.hull([[-x, -y, 0], [x, -y, 0], [-x, y, 0], [x, y, 0], [-x, -y, z], [-x, y, z]]);
    }
    case 'fillet': {
      // fills an inside corner: an r x r square with a quarter circle scooped from it,
      // curve facing +X/+Z, run along Y; centred in X and Y like every other shape
      const r = pos(p.r), L = pos(p.length);
      const sq = CrossSection.square([r, r]);
      const disk = CrossSection.circle(r, sides(p.sides)).translate([r, r]);
      const prof = sq.subtract(disk);
      sq.delete(); disk.delete();
      const solid = Manifold.extrude(prof, L).rotate([90, 0, 0]).translate([-r / 2, L / 2, 0]);
      prof.delete();
      return solid;
    }
    case 'path': {
      // a drawn line: each stretch a stadium (two circles of the line's width and the hull round
      // them), all joined, so bends and ends are round; a closed loop's inside filled when asked;
      // pushed up h. Points are [x, y] in the part's own plane.
      const pts = p.pts || [];
      if (pts.length < 2) throw new ToolError('path: it needs two points or more.');
      const r = pos(p.width) / 2, n = sides(p.sides);
      const pieces = [];
      const runs = p.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < runs; i++) {
        const a = CrossSection.circle(r, n).translate(pts[i]), b = CrossSection.circle(r, n).translate(pts[(i + 1) % pts.length]);
        pieces.push(CrossSection.hull([a, b]));
        a.delete(); b.delete();
      }
      if (p.closed && p.fill === 'fill' && pts.length >= 3) pieces.push(new CrossSection([pts], 'NonZero'));
      const cs = CrossSection.union(pieces);
      for (const x of pieces) x.delete();
      const m = Manifold.extrude(cs, pos(p.h));
      cs.delete();
      return m;
    }
    case 'tube': {
      if (!(p.wall > 0) || p.wall * 2 >= p.d) throw new ToolError('tube: the wall must be above zero and under half the diameter.');
      const outer = Manifold.cylinder(pos(p.h), p.d / 2, p.d / 2, sides(p.sides));
      const inner = Manifold.cylinder(p.h + 2, p.d / 2 - p.wall, p.d / 2 - p.wall, sides(p.sides)).translate([0, 0, -1]);
      const r = outer.subtract(inner);
      outer.delete(); inner.delete();
      return r;
    }
  }
  throw new ToolError(`No shape called ${kind}.`);
}

// ---- mesh conversion -------------------------------------------------------------------------
// Where surfaces cross, a boolean can leave points a hair apart. Every file reader and our
// own check weld points closer than WELD, which would fold those slivers into bad edges,
// so collapse them in the library first, where the result stays a valid solid.
const TIDY = 2e-4;   // mm, above the 1e-4 weld
const BRIDGE = 0.1;  // mm, half-width of the bridge laid along an edge where two pieces only touch
function tidy(man) {
  return man.simplify(TIDY);
}

export function toManifold(tris) {
  const { pos, idx } = weld(tris);
  const mesh = new M.Mesh({ numProp: 3, vertProperties: Float32Array.from(pos), triVerts: Uint32Array.from(idx) });
  mesh.merge();
  try {
    return M.Manifold.ofMesh(mesh);
  } catch {
    throw new ToolError('An imported mesh is not a closed solid, so it cannot be joined, cut or given a step. It can still be moved and viewed.');
  }
}

/** Join closed shells into one solid. Shells that will not close are left out; says how many. */
export function unionShells(list) {
  const mans = [];
  let dropped = 0;
  for (const t of list) {
    try { mans.push(toManifold(t)); } catch { dropped++; }
  }
  if (!mans.length) return null;
  let man = mans.length === 1 ? mans[0] : M.Manifold.union(mans);
  let tris = toTris(man), bridged = 0;
  const rep = report(tris);
  if (!rep.watertight && rep.overEdges.length) {
    // shells that only touch along an edge: the same thin bridge the export offers
    const r = BRIDGE, around = (x, y, z) => [[x - r, y, z], [x + r, y, z], [x, y - r, z], [x, y + r, z], [x, y, z - r], [x, y, z + r]];
    const bridges = rep.overEdges.map(e => M.Manifold.hull([...around(e[0], e[1], e[2]), ...around(e[3], e[4], e[5])]));
    const fused = M.Manifold.union([man, ...bridges]);
    tris = toTris(fused);
    bridged = bridges.length;
    for (const b of bridges) b.delete();
    fused.delete();
  }
  for (const x of mans) if (x !== man) x.delete();
  man.delete();
  return { tris, dropped, bridged };
}

export function toTris(man) {
  const mesh = man.getMesh();
  const t = mesh.triVerts, v = mesh.vertProperties, n = mesh.numProp;
  const out = new Float32Array(t.length * 3);
  for (let i = 0; i < t.length; i++) {
    const k = t[i] * n;
    out[i * 3] = v[k]; out[i * 3 + 1] = v[k + 1]; out[i * 3 + 2] = v[k + 2];
  }
  return out;
}

// ---- building ----------------------------------------------------------------------------------
// A part's shape is { man, soup }: man a closed Manifold (or null), soup the triangles of
// anything that is not a closed solid (or null), both in the part's own frame. STLs are
// often not closed and some never will be; such a part still shows, moves, groups and
// exports as it is. A step that needs a solid (cutting, intersecting, hollowing, edge
// shaping) closes it for that step and says how.

/**
 * The part's shape in its own frame, owned by the cache (do not delete it).
 * ctx: { blobs: Map(id -> Float32Array), tools: {id: {run}}, progress, notes }
 */
export async function local(part, ctx) {
  const key = shapeKey(part);
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const note = t => ctx.notes?.push(t);
  let shape, skip = 0;
  if (part.kind === 'group') {
    const solids = [], holes = [], owned = [], soups = [];
    let soupHole = false;
    for (const c of part.children) {
      const base = await local(c, ctx);
      if (base.man) {
        const m = place(base.man, c.xform);
        if (m !== base.man) owned.push(m);   // a placed copy is ours to free; the cached base is not
        (c.hole ? holes : solids).push(m);
      }
      if (base.soup) { soups.push({ tris: placeSoup(base.soup, c.xform), hole: !!c.hole, name: c.name }); if (c.hole) soupHole = true; }
    }
    const cutting = holes.length || soupHole || part.mode === 'intersect';
    if (cutting && soups.length) {
      // cutting needs solids: close each open piece for this group
      for (const s of soups) {
        const m = closeSoup(s.tris, s.name, ctx);
        owned.push(m);
        (s.hole ? holes : solids).push(m);
      }
      soups.length = 0;
    }
    let man = null;
    if (!solids.length && holes.length) man = M.Manifold.union(holes);   // a group of holes is one hole
    else if (solids.length) {
      const s = part.mode === 'intersect' ? M.Manifold.intersection(solids) : M.Manifold.union(solids);
      if (holes.length) { const h = M.Manifold.union(holes); man = s.subtract(h); s.delete(); h.delete(); } else man = s;
    }
    for (const m of owned) m.delete();
    if (man) { const t = tidy(man); if (t !== man) { man.delete(); man = t; } }
    shape = { man, soup: soups.length ? concat(soups.map(s => s.tris)) : null };
  } else if (part.kind === 'mesh') {
    let tris = ctx.blobs.get(part.blob);
    if (!tris) throw new ToolError(`The mesh for ${part.name || 'a part'} is missing from the project.`);
    // a first step that works on the file as read (repair) gets the raw triangles
    const first = part.ops?.[0] && ctx.tools[part.ops[0].tool];
    if (first?.raw) {
      const out = await first.run(tris, part.ops[0].params, { selection: [], progress: ctx.progress || (() => {}), kernel: toolKernel() });
      if (out.notes) for (const t of out.notes) note(t);
      tris = out.tris || out;
      skip = 1;
    }
    shape = asShape(tris);
  } else shape = { man: primitive(part.kind, part.params), soup: null };
  // steps work on the part at its real size: scale it, run the steps, then take the scale back
  // off, since the part's xform puts it on again (a 10 mm fillet on a part stretched 3x stays
  // 10 mm). Mirroring stays in the xform. Picks are stored unscaled and scaled here to match.
  const ops = (part.ops || []).slice(skip);
  const k = ops.length ? (part.xform?.scale || [1, 1, 1]).map(Math.abs) : [1, 1, 1];
  const scaled = k.some(v => v !== 1);
  if (scaled) shape = scaleShape(shape, k);
  for (const op0 of ops) {
    const op = scaled ? { ...op0, sel: scaleSel(op0.sel, k) } : op0;
    const tool = ctx.tools[op.tool];
    if (!tool) throw new ToolError(`No tool called ${op.tool}.`);
    let tris;
    if (shape.soup && !tool.openOk) {
      // this step needs a solid
      const m = closeSoup(shapeTris(shape), part.name, ctx);
      freeShape(shape);
      shape = { man: m, soup: null };
    }
    tris = shapeTris(shape);
    // picked edges travel as plan segments; several picked faces as a list, each found again here
    const sel = op.sel?.segs ? op.sel : op.sel?.faces ? op.sel.faces.map(s => resolveFace(tris, s)) : resolveFace(tris, op.sel);
    const out = await tool.run(tris, op.params, { selection: sel, progress: ctx.progress || (() => {}), kernel: toolKernel() });
    if (out.notes) for (const t of out.notes) note(t);
    freeShape(shape);
    shape = asShape(out.tris || out);
  }
  if (scaled) shape = scaleShape(shape, k.map(v => 1 / v));
  remember(key, shape);
  return shape;
}

/** Put a shape the page already holds back in the cache (a fresh modeller after a restart). */
export function seed(key, tris) {
  if (!cache.has(key)) remember(key, asShape(tris));
}

/** Triangles to a shape: a closed solid when they make one, else kept as they are. */
function asShape(tris) {
  if (report(tris).watertight) {
    try { return { man: toManifold(tris), soup: null }; } catch { /* fall through: keep as is */ }
  }
  return { man: null, soup: tris };
}
function shapeTris(shape) {
  const parts = [];
  if (shape.man) parts.push(toTris(shape.man));
  if (shape.soup) parts.push(shape.soup);
  return parts.length === 1 ? parts[0] : concat(parts);
}
function freeShape(shape) { shape.man?.delete(); }
/** A shape this function owns, scaled per axis (k all positive); the old one is freed. */
function scaleShape(shape, k) {
  const x = { scale: k }, out = { man: shape.man ? place(shape.man, x) : null, soup: shape.soup ? placeSoup(shape.soup, x) : null };
  if (out.man !== shape.man) freeShape(shape);
  return out;
}
/** A stored pick in the unscaled frame to the frame scaled by k: points and plan segments
 *  stretch, a face's normal turns the other way (n / k), and its plane follows. */
function scaleSel(sel, k) {
  if (!sel) return sel;
  if (sel.segs) return { ...sel, segs: sel.segs.map(([x1, y1, x2, y2]) => [x1 * k[0], y1 * k[1], x2 * k[0], y2 * k[1]]) };
  const face = s => {
    const p = s.point.map((v, i) => v * k[i]), n = s.normal.map((v, i) => v / k[i]), l = Math.hypot(...n);
    const nn = n.map(v => v / l);
    return { ...s, normal: nn, point: p, d: nn[0] * p[0] + nn[1] * p[1] + nn[2] * p[2] };
  };
  return sel.faces ? { ...sel, faces: sel.faces.map(face) } : face(sel);
}

/** Close an open surface for a step that needs a solid: repair first, and if that cannot,
 *  rebuild it on a grid fine enough for its size. */
function closeSoup(tris, name, ctx) {
  const r = repair(tris, WELD, { gap: 0.01 });
  if (r.fixes.after.watertight) {
    try { const m = toManifold(r.tris); ctx.notes?.push(`${name || 'A part'} was not closed: repaired for this step.`); return m; } catch { /* rebuild */ }
  }
  const b = bounds(tris);
  const size = Math.max(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]);
  const h = Math.min(1, Math.max(0.1, Math.round(size / 300 * 20) / 20));
  const solid = decimate(solidify(tris, h).tris, { target: 0, tol: 0.01 }).tris;
  ctx.notes?.push(`${name || 'A part'} was not closed: rebuilt as a solid on a ${h} mm grid for this step. Repair with Make solid sets the grid.`);
  return toManifold(solid);
}

/** Soup in a part's own frame to its parent's frame; a mirror turns faces back out. */
function placeSoup(tris, xform) {
  if (isIdentity(xform)) return tris;
  const t = tris.slice(), m4 = matrix(xform), v = new Vector3();
  for (let i = 0; i < t.length; i += 3) { v.set(t[i], t[i + 1], t[i + 2]).applyMatrix4(m4); t[i] = v.x; t[i + 1] = v.y; t[i + 2] = v.z; }
  if (m4.determinant() < 0) flipAll(t);
  return t;
}

/** A stored face pick ({normal, d, point}) back to triangle indices on this mesh: the flat
 *  region round the triangle nearest the point. Survives size changes that keep the face. */
export function resolveFace(tris, sel) {
  if (!sel) return [];
  const { normal: n, d, point } = sel;
  const n3 = tris.length / 9;
  const on = new Uint8Array(n3);
  let seed = -1, best = Infinity;
  for (let f = 0; f < n3; f++) {
    const i = f * 9;
    const ux = tris[i + 3] - tris[i], uy = tris[i + 4] - tris[i + 1], uz = tris[i + 5] - tris[i + 2];
    const vx = tris[i + 6] - tris[i], vy = tris[i + 7] - tris[i + 1], vz = tris[i + 8] - tris[i + 2];
    let cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const l = Math.hypot(cx, cy, cz) || 1;
    cx /= l; cy /= l; cz /= l;
    if (cx * n[0] + cy * n[1] + cz * n[2] < 1 - 1e-6) continue;
    let ok = true;
    for (let k = 0; k < 9; k += 3) if (Math.abs(tris[i + k] * n[0] + tris[i + k + 1] * n[1] + tris[i + k + 2] * n[2] - d) > 1e-3) ok = false;
    if (!ok) continue;
    on[f] = 1;
    const mx = (tris[i] + tris[i + 3] + tris[i + 6]) / 3 - point[0], my = (tris[i + 1] + tris[i + 4] + tris[i + 7]) / 3 - point[1], mz = (tris[i + 2] + tris[i + 5] + tris[i + 8]) / 3 - point[2];
    const dd = mx * mx + my * my + mz * mz;
    if (dd < best) { best = dd; seed = f; }
  }
  if (seed < 0) throw new ToolError('The face a step was picked on is gone. Edit that step and pick the face again.');
  // flood over shared vertices among the coplanar triangles
  const { idx } = weld(tris);
  const byVert = new Map();
  for (let f = 0; f < n3; f++) if (on[f]) for (let k = 0; k < 3; k++) { const v = idx[f * 3 + k]; (byVert.get(v) || byVert.set(v, []).get(v)).push(f); }
  const seen = new Set([seed]), stack = [seed], out = [];
  while (stack.length) {
    const f = stack.pop();
    out.push(f);
    for (let k = 0; k < 3; k++) for (const g of byVert.get(idx[f * 3 + k]) || []) if (!seen.has(g)) { seen.add(g); stack.push(g); }
  }
  return out;
}

/** Display mesh for a part, in its own frame. open: some of it is not a closed solid. */
export async function partMesh(part, ctx) {
  const shape = await local(part, ctx);
  const tris = shapeTris(shape);
  const vol = (shape.man ? shape.man.volume() : 0) + (shape.soup ? Math.abs(volume(shape.soup)) : 0);
  return { key: shapeKey(part), tris: tris === shape.soup ? tris.slice() : tris, volume: vol, open: !!shape.soup };
}

/** Every top-level visible solid joined into one, in world space. Loose holes (not in a
 *  group) cut nothing, as on the plate. Open surfaces are written as they are beside the
 *  joined solid; opts.open says how many parts had one. With opts.bridge, pieces that only
 *  touch along an edge (a wall of zero thickness) get a thin bridge along that edge so the
 *  result is one closed solid; opts.bridged says how many edges. The parts are not changed. */
export async function flatten(parts, ctx, opts = {}) {
  const placed = [], owned = [], loose = [];
  for (const p of parts) {
    if (p.hole || p.hidden) continue;
    const base = await local(p, ctx);
    if (base.man) {
      const m = place(base.man, p.xform);
      if (m !== base.man) owned.push(m);
      placed.push(m);
    }
    if (base.soup) loose.push(placeSoup(base.soup, p.xform));
  }
  opts.open = loose.length;
  if (!placed.length) {
    if (!loose.length) throw new ToolError('Nothing solid to save.');
    return concat(loose);
  }
  const joined = M.Manifold.union(placed);
  const all = tidy(joined);
  let tris = toTris(all);
  if (opts.bridge) {
    const rep = report(tris);
    if (!rep.watertight && rep.overEdges.length && !rep.openEdges) {
      const r = BRIDGE, around = (x, y, z) => [[x - r, y, z], [x + r, y, z], [x, y - r, z], [x, y + r, z], [x, y, z - r], [x, y, z + r]];
      const bridges = rep.overEdges.map(e => M.Manifold.hull([...around(e[0], e[1], e[2]), ...around(e[3], e[4], e[5])]));
      const fused = M.Manifold.union([all, ...bridges]);
      const done = tidy(fused);
      tris = toTris(done);
      opts.bridged = rep.overEdges.length;
      for (const m of [...bridges, fused]) m.delete();
      if (done !== fused) done.delete();
    }
  }
  all.delete();
  if (joined !== all) joined.delete();
  for (const m of owned) m.delete();
  return loose.length ? concat([tris, ...loose]) : tris;
}

/** Split a part at a plane across one axis (0 x, 1 y, 2 z) at `at` mm, in world space. Both
 *  halves come back closed (the cut face is filled), as world triangles; a half the plane
 *  misses is null. An open mesh is closed first, as for any step that needs a solid. */
export async function splitPart(part, ctx, axis, at) {
  const base = await local(part, ctx);
  let man = base.man, owned = null;
  if (!man && base.soup) man = owned = closeSoup(base.soup, part.name, ctx);
  if (!man) throw new ToolError(`${part.name || 'The part'} has nothing to cut.`);
  const placed = place(man, part.xform);
  const n = [0, 0, 0]; n[axis] = 1;
  const [above, below] = placed.splitByPlane(n, at);
  const out = { a: below.isEmpty() ? null : toTris(below), b: above.isEmpty() ? null : toTris(above) };
  above.delete(); below.delete();
  if (placed !== man) placed.delete();
  owned?.delete();
  return out;
}

/** Flat outlines (rings of [x, y] in mm; even-odd: a ring inside another is a hole) pushed
 *  up by height mm from z = 0, as a closed solid's triangles. */
export function extrudeRings(rings, height) {
  if (!(height > 0)) throw new ToolError('The height must be above zero.');
  rings = rings.filter(r => r.length >= 3);
  if (!rings.length) throw new ToolError('Nothing to extrude: no outline encloses any area.');
  const raw = new M.CrossSection(rings, 'EvenOdd');
  // outlines that touch only at a corner would make an edge shared by four faces: grow by
  // 0.01 mm (square corners) and shrink back (round corners), which joins them there with a
  // neck about 0.008 mm wide; inside corners elsewhere get a 0.01 mm round, under 0.005 mm off
  const grown = raw.offset(0.01, 'Miter', 4);
  const cs = grown.offset(-0.01, 'Round', 4, 8);
  raw.delete(); grown.delete();
  if (cs.isEmpty()) { cs.delete(); throw new ToolError('Nothing to extrude: no outline encloses any area.'); }
  const man = M.Manifold.extrude(cs, height);
  cs.delete();
  const tris = toTris(man);
  man.delete();
  return tris;
}

function concat(list) {
  const out = new Float32Array(list.reduce((n, t) => n + t.length, 0));
  let k = 0;
  for (const t of list) { out.set(t, k); k += t.length; }
  return out;
}

export function clearCache() {
  for (const m of cache.values()) m.man?.delete();
  cache.clear();
}
