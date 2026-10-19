// The parts core, headless: shapes, placement, solid/hole groups, tool steps, the joined save.
// node tests/kernel.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initKernel, partMesh, flatten, SHAPES, shapeKey } from '../src/core/kernel.js';
import { report, describe, bounds, thinWall } from '../src/core/meshcheck.js';
import * as edgeshaper from '../src/tools/edgeshaper/compute.js';
import * as hollower from '../src/tools/hollower/compute.js';

await initKernel(readFileSync(createRequire(import.meta.url).resolve('manifold-3d/manifold.wasm')));
const ctx = { blobs: new Map(), tools: { edgeshaper, hollower } };
let fail = 0;
const ok = (name, cond, info = '') => { if (!cond) fail++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name.padEnd(36)} ${info}`); };
const part = (kind, params = {}, extra = {}) => ({ id: Math.random().toString(36).slice(2), kind, params: { ...SHAPES[kind], ...params }, xform: { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }, hole: false, ops: [], ...extra });
const vol = r => r.volume;

// every shape is a closed solid sitting on z = 0
for (const kind of Object.keys(SHAPES)) {
  const t0 = performance.now();
  const { tris } = await partMesh(part(kind), ctx);
  const r = report(tris), b = bounds(tris);
  ok(`shape ${kind}`, r.watertight && Math.abs(b.lo[2]) < 1e-6, `${r.triangles} tris  ${describe(r)}  floor ${b.lo[2].toFixed(6)}  ${(performance.now() - t0).toFixed(1)} ms`);
}

// a group: plate with a flush hole and a boss on top
{
  const plate = part('box', { x: 40, y: 40, z: 5 });
  const hole = part('cylinder', { d: 10, h: 5 }, { hole: true, xform: { pos: [10, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] } });
  const boss = part('cylinder', { d: 8, h: 10 }, { xform: { pos: [-10, 0, 5], rot: [0, 0, 0], scale: [1, 1, 1] } });
  const g = part('group', {}, { children: [plate, hole, boss] });
  const { tris } = await partMesh(g, ctx);
  const r = report(tris);
  const expect = 8000 - report((await partMesh(hole, ctx)).tris).volume + report((await partMesh(boss, ctx)).tris).volume;
  ok('group: plate + flush hole + boss', r.watertight && Math.abs(r.volume - expect) < 1e-3, `${describe(r)} vol ${r.volume.toFixed(2)} vs ${expect.toFixed(2)}`);

  // nested: the group, rotated 90 about x, inside another group with a hole through it
  const g2 = part('group', {}, { children: [{ ...g, xform: { pos: [0, 0, 20], rot: [90, 0, 0], scale: [1, 1, 1] } },
    part('box', { x: 6, y: 60, z: 6 }, { hole: true, xform: { pos: [0, 0, 17], rot: [0, 0, 0], scale: [1, 1, 1] } })] });
  const r2 = report((await partMesh(g2, ctx)).tris);
  ok('nested rotated group with a hole', r2.watertight && r2.volume < r.volume, `${describe(r2)} vol ${r2.volume.toFixed(2)}`);

  // moving a child changes the group key; moving the group does not
  const k1 = shapeKey(g2);
  const moved = { ...g2, xform: { pos: [5, 5, 5], rot: [0, 0, 0], scale: [1, 1, 1] } };
  ok('moving a group keeps its shape key', shapeKey(moved) === k1);
}

// tool steps as part of the recipe
{
  const p = part('box', { x: 40, y: 20, z: 6 }, { ops: [{ tool: 'edgeshaper', params: { kind: 'fillet', face: 'top', width: 2, height: 2, start: null } }] });
  const r = report((await partMesh(p, ctx)).tris);
  ok('box + fillet step', r.watertight && r.volume < 4800, `${describe(r)} vol ${r.volume.toFixed(1)}`);
  const h = part('box', { x: 40, y: 30, z: 20 }, { ops: [{ tool: 'hollower', params: { wall: 2, voxel: 0.5, open: true }, sel: { normal: [0, 0, 1], d: 20, point: [0, 0, 20] } }] });
  const t0 = performance.now();
  const rh = report((await partMesh(h, ctx)).tris);
  ok('box + hollow step, open top', rh.watertight && Math.abs(rh.volume - (24000 - 36 * 26 * 18)) / 7152 < 0.01, `${describe(rh)} vol ${rh.volume.toFixed(0)} vs 7152  ${(performance.now() - t0).toFixed(0)} ms`);
  const t1 = performance.now();
  await partMesh(h, ctx);
  ok('same recipe again comes from the cache', performance.now() - t1 < 200, `${(performance.now() - t1).toFixed(1)} ms`);
  // resize the box: the stored face pick still finds the top
  const h2 = { ...h, params: { ...h.params, z: 25 }, ops: [{ ...h.ops[0], sel: { normal: [0, 0, 1], d: 25, point: [0, 0, 25] } }] };
  ok('hollow step after a resize', report((await partMesh(h2, ctx)).tris).watertight);
}

// saving: top-level solids joined, loose holes ignored, bottom exactly flat
{
  const parts = [part('box', { x: 30, y: 30, z: 4 }), part('sphere', { d: 12 }, { xform: { pos: [0, 0, 2], rot: [0, 0, 0], scale: [1, 1, 1] } }),
    part('cylinder', { d: 4, h: 30 }, { hole: true }), part('torus', {}, { xform: { pos: [8, 8, 0], rot: [0, 0, 30], scale: [1, 1, 1] } })];
  const tris = await flatten(parts, ctx);
  const r = report(tris);
  let worst = 0;
  for (let i = 2; i < tris.length; i += 3) if (tris[i] < 0.01) worst = Math.max(worst, Math.abs(tris[i]));
  ok('flatten to one solid', r.watertight && worst === 0, `${describe(r)} ${r.triangles} tris  worst floor z ${worst}`);
}
// edge shaper on picked walls: the front edge only, then everything but the front
{
  const plate = part('box', { x: 40, y: 20, z: 5 });
  const front = { segs: [[-20, -10, 20, -10]] };
  const step = (edges, sel) => ({ ...plate, ops: [{ tool: 'edgeshaper', params: { kind: 'fillet', face: 'top', width: 2, height: 2, start: null, edges }, sel }] });
  const all = report((await partMesh({ ...plate, ops: [{ tool: 'edgeshaper', params: { kind: 'fillet', face: 'top', width: 2, height: 2, start: null } }] }, ctx)).tris);
  const only = report((await partMesh(step('only', front), ctx)).tris);
  const except = report((await partMesh(step('except', front), ctx)).tris);
  const strip = 4 * (1 - Math.PI / 4) * 40;   // a 2 mm fillet along 40 mm takes this much away
  ok('edge shaper: front edge only', only.watertight && Math.abs(4000 - only.volume - strip) < 0.2, `${describe(only)} took ${(4000 - only.volume).toFixed(2)} mm3, a straight 40 mm fillet ${strip.toFixed(2)}`);
  ok('edge shaper: all but the front', except.watertight && except.volume > all.volume && except.volume < only.volume,
    `${describe(except)} vol ${except.volume.toFixed(1)} (all ${all.volume.toFixed(1)}, front only ${only.volume.toFixed(1)})`);
  // every wall picked matches the ring method
  const every = { segs: [[-20, -10, 20, -10], [20, -10, 20, 10], [20, 10, -20, 10], [-20, 10, -20, -10]] };
  const same = report((await partMesh(step('only', every), ctx)).tris);
  ok('edge shaper: all picked = ring method', same.watertight && Math.abs(same.volume - all.volume) < 0.2, `${same.volume.toFixed(2)} vs ${all.volume.toFixed(2)}`);
}

// two boxes touching along one edge: the export refuses it and says where, in plain words
{
  const tris = await flatten([part('box', { x: 10, y: 10, z: 10 }), part('box', { x: 10, y: 10, z: 10 }, { xform: { pos: [10, 10, 0], rot: [0, 0, 0], scale: [1, 1, 1] } })], ctx);
  const msg = thinWall(report(tris)) || describe(report(tris));
  ok('zero-thickness wall named and placed', /zero thickness, near X 5, Y 5, Z 5/.test(msg), msg.slice(0, 90));
  const two = [part('box', { x: 10, y: 10, z: 10 }), part('box', { x: 10, y: 10, z: 10 }, { xform: { pos: [10, 10, 0], rot: [0, 0, 0], scale: [1, 1, 1] } })];
  const o = { bridge: true }, r = report(await flatten(two, ctx, o));
  ok('bridge joins edge-touching boxes', r.watertight && o.bridged > 0 && r.volume > 2000 && r.volume < 2000.5, `${describe(r)} vol ${r.volume.toFixed(3)}, ${o.bridged} edges`);
  // a hole as wide as the box it cuts: the box walls go to nothing where the hole touches them
  const g = part('group', {}, { children: [part('box', { x: 20, y: 20, z: 20 }), part('cylinder', { d: 20, h: 30 }, { hole: true, xform: { pos: [0, 0, -5], rot: [0, 0, 0], scale: [1, 1, 1] } })] });
  const r0 = report(await flatten([g], ctx)), o2 = { bridge: true }, r2 = report(await flatten([g], ctx, o2));
  ok('bridge joins a hole touching the walls', !r0.watertight && r2.watertight && o2.bridged > 0, `before ${describe(r0)}; after ${describe(r2)}, ${o2.bridged} edges`);
}
// steps run at the part's real size: a 10 mm box stretched to 30 mm in Z takes a 10 mm fillet
// exactly as a 30 mm box does (it used to see 10 mm and refuse, or stretch the fillet 3x)
{
  const fil = { tool: 'edgeshaper', params: { kind: 'fillet', face: 'top', width: 10, height: 10, start: null } };
  const S = (x, y, z) => ({ pos: [0, 0, 0], rot: [0, 0, 0], scale: [x, y, z] });
  const a = report(await flatten([part('box', { x: 40, y: 30, z: 10 }, { xform: S(1, 1, 3), ops: [fil] })], ctx));
  const b = report(await flatten([part('box', { x: 40, y: 30, z: 30 }, { ops: [fil] })], ctx));
  ok('fillet on a part scaled 300% in Z', a.watertight && Math.abs(a.volume - b.volume) < 0.5, `${a.volume.toFixed(2)} vs ${b.volume.toFixed(2)}`);
  // picked edge, stored unscaled: front edge of a 40 mm box stretched 2x in X = an 80 mm box's front edge
  const pick = (w, extra) => part('box', { x: w, y: 20, z: 6 }, { ...extra, ops: [{ tool: 'edgeshaper', params: { kind: 'fillet', face: 'top', width: 2, height: 2, start: null, edges: 'only' }, sel: { segs: [[-w / 2, -10, w / 2, -10]] } }] });
  const c = report(await flatten([pick(40, { xform: S(2, 1, 1) })], ctx)), d = report(await flatten([pick(80, {})], ctx));
  ok('picked edge on a part scaled 200% in X', c.watertight && Math.abs(c.volume - d.volume) < 0.5, `${c.volume.toFixed(2)} vs ${d.volume.toFixed(2)}`);
}
// a flat part is hollowed exactly: box 40 x 30 x 10, wall 2 -> cavity 36 x 26 x 6 (sharp corners);
// the top opened -> a 36 x 26 window through the 2 mm roof as well
{
  const hol = (sel, voxel = 1) => ({ tool: 'hollower', params: { wall: 2, voxel }, ...(sel ? { sel } : {}) });
  const t0 = performance.now();
  const closed = report((await partMesh(part('box', { x: 40, y: 30, z: 10 }, { ops: [hol()] }), ctx)).tris);
  ok('flat part hollowed exactly, closed', closed.watertight && Math.abs(closed.volume - (12000 - 36 * 26 * 6)) < 1e-3, `vol ${closed.volume.toFixed(3)} vs 6384, ${closed.triangles} tris, ${(performance.now() - t0).toFixed(0)} ms`);
  const top = { faces: [{ normal: [0, 0, 1], d: 10, point: [0, 0, 10] }] };
  const open = report((await partMesh(part('box', { x: 40, y: 30, z: 10 }, { ops: [hol(top)] }), ctx)).tris);
  ok('flat part hollowed exactly, top open', open.watertight && Math.abs(open.volume - (6384 - 36 * 26 * 2)) < 1e-3, `vol ${open.volume.toFixed(3)} vs 4512`);

  // a shaped part too: box 40 x 30 x 20, top chamfer 4 x 4, wall 2. Across an edge the wall
  // moves the 45 deg chamfer in by 2, so the cavity is a box 36 x 26 x 16 with a top chamfer of
  // 2 sqrt 2 (worked: lines d = 2, z = 18, z = d + 16 - 2 sqrt 2 meet at d 2 and 4.83).
  // A box L x W x H with a mitred top chamfer c: L W H minus L W c plus the frustum on top.
  const chamfered = (L, W, H, c) => L * W * H - L * W * c + (c / 6) * (L * W + 4 * (L - c) * (W - c) + (L - 2 * c) * (W - 2 * c));
  const expect = chamfered(40, 30, 20, 4) - chamfered(36, 26, 16, 2 * Math.SQRT2);
  const cham = { tool: 'edgeshaper', params: { kind: 'chamfer', face: 'top', width: 4, height: 4, start: null } };
  const t1 = performance.now();
  const sh = await partMesh(part('box', { x: 40, y: 30, z: 20 }, { ops: [cham, hol()] }), { ...ctx, notes: [] });
  const rs = report(sh.tris);
  ok('shaped part hollowed exactly (chamfer)', rs.watertight && Math.abs(rs.volume - expect) < 0.05, `vol ${rs.volume.toFixed(3)} vs ${expect.toFixed(3)}, ${rs.triangles} tris, ${(performance.now() - t1).toFixed(0)} ms`);
}
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exit(fail ? 1 : 0);
