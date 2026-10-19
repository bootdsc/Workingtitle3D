// Wrapping flat text onto surfaces: stays closed, sits on the surface, keeps its length round a
// cylinder, climbs as a helix with spiral, deboss sinks in; and how long a re-form takes.
// node tests/wrap.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Vector3 } from 'three';
import { initKernel, partMesh, SHAPES } from '../src/core/kernel.js';
import { report, describe } from '../src/core/meshcheck.js';
import { Surface, chart, deform, subdivide, gridSolid } from '../src/core/wrap.js';

await initKernel(readFileSync(createRequire(import.meta.url).resolve('manifold-3d/manifold.wasm')));
const ctx = { blobs: new Map(), tools: {} };
let fail = 0;
const ok = (name, cond, info = '') => { if (!cond) fail++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name.padEnd(44)} ${info}`); };
const mesh = async (kind, params) => (await partMesh({ id: kind, kind, params: { ...SHAPES[kind], ...params }, xform: { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }, hole: false, ops: [] }, ctx)).tris;
const box = t => { const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < t.length; i++) { lo[i % 3] = Math.min(lo[i % 3], t[i]); hi[i % 3] = Math.max(hi[i % 3], t[i]); } return { lo, hi }; };

// a cylinder r 15, 40 tall, 128 facets, standing on the plate
const R = 15;
const cyl = new Surface(await mesh('cylinder', { d: 2 * R, h: 40, sides: 128 }));
const text = await mesh('text', { text: 'HELLO', size: 6, width: 1, h: 1 });
const tb = box(text), cx = (tb.lo[0] + tb.hi[0]) / 2, cy = (tb.lo[1] + tb.hi[1]) / 2;
for (let i = 0; i < text.length; i += 3) { text[i] -= cx; text[i + 1] -= cy; }
const ext = { x0: tb.lo[0] - cx, x1: tb.hi[0] - cx, y0: tb.lo[1] - cy, y1: tb.hi[1] - cy };
const g = 0.5;
let t0 = performance.now();
const flat = subdivide(text, g);
const tSub = performance.now() - t0;
ok('subdivide keeps it closed', report(flat).watertight, `${text.length / 9} -> ${flat.length / 9} tris  ${tSub.toFixed(0)} ms`);

const anchor = new Vector3(R, 0, 20), n = new Vector3(1, 0, 0), up = new Vector3(0, 0, 1);
t0 = performance.now();
const c = chart(cyl, anchor, n, up, ext, g);
const out = deform(flat, c, 1);
const tForm = performance.now() - t0;
const r = report(out);
ok('wrapped text is closed', r.watertight, `${describe(r)}  re-form ${tForm.toFixed(1)} ms`);
// every point between r - 0.2 (sunk foot) and r + 1 (raised 1 mm)
let rmin = Infinity, rmax = -Infinity;
for (let i = 0; i < out.length; i += 3) { const rr = Math.hypot(out[i], out[i + 1]); rmin = Math.min(rmin, rr); rmax = Math.max(rmax, rr); }
ok('raised 1 mm, foot 0.2 mm into the surface', rmin > R - 0.25 && rmin < R - 0.1 && rmax > R + 0.9 && rmax < R + 1.05, `radius ${rmin.toFixed(3)} to ${rmax.toFixed(3)}`);
// length kept: the angle the text spans times the radius = its flat width
let amin = Infinity, amax = -Infinity;
for (let i = 0; i < out.length; i += 3) { const a = Math.atan2(out[i + 1], out[i]); amin = Math.min(amin, a); amax = Math.max(amax, a); }
const arc = (amax - amin) * R, flatW = ext.x1 - ext.x0;
ok('length round the cylinder kept (1 %)', Math.abs(arc - flatW) / flatW < 0.01, `flat ${flatW.toFixed(2)} mm, on the surface ${arc.toFixed(2)} mm`);
ok('height kept', Math.abs((box(out).hi[2] - box(out).lo[2]) - (ext.y1 - ext.y0)) < 0.05, `${(box(out).hi[2] - box(out).lo[2]).toFixed(3)} vs ${(ext.y1 - ext.y0).toFixed(3)}`);

// spiral 20 deg: the line rises tan(20) mm per mm across, letters stay upright
const cs = chart(cyl, anchor, n, up, ext, g, 0, 20);
// two baseline points 20 mm apart across, and one 5 mm straight up from the first
const pts = deform(Float32Array.from([-10, 0, 0.5, 10, 0, 0.5, -10, 5, 0.5]), cs, 1);
const rise = pts[5] - pts[2], want = 20 * Math.tan((20 * Math.PI) / 180);
const upright = Math.hypot(pts[6] - pts[0], pts[7] - pts[1]);
ok('spiral 20 deg climbs as a helix, letters upright', Math.abs(rise - want) < 0.02 * want && upright < 0.02 && Math.abs(pts[8] - pts[2] - 5) < 0.02,
  `rise ${rise.toFixed(3)} mm, helix ${want.toFixed(3)} mm, up drifts ${upright.toFixed(3)} mm`);
ok('spiral text closed', report(deform(flat, cs, 1)).watertight);
// across the cylinder the spacing is kept: 20 mm on the flat is 20 mm of arc round it, at every tilt
for (const deg of [15, 40]) {
  const q = deform(Float32Array.from([-10, 0, 0, 10, 0, 0, -10, 4, 0, 10, 4, 0]), chart(cyl, anchor, n, up, ext, g, 0, deg), 1);
  const arcAt = k => Math.atan2(q[k + 1], q[k]) * R;
  const a0 = arcAt(3) - arcAt(0), a1 = arcAt(9) - arcAt(6);
  ok(`spiral ${deg} deg keeps spacing across`, Math.abs(a0 - 20) < 0.2 && Math.abs(a1 - 20) < 0.2, `baseline ${a0.toFixed(3)} mm, 4 mm up ${a1.toFixed(3)} mm`);
}

// deboss: cut 1 mm in, top 0.2 above
const db = deform(flat, c, 1, 'deboss');
let dmin = Infinity, dmax = -Infinity;
for (let i = 0; i < db.length; i += 3) { const rr = Math.hypot(db[i], db[i + 1]); dmin = Math.min(dmin, rr); dmax = Math.max(dmax, rr); }
ok('deboss 1 mm deep, cutter top 1 mm out', report(db).watertight && dmin > R - 1.05 && dmin < R - 0.9 && dmax > R + 0.95 && dmax < R + 1.05, `radius ${dmin.toFixed(3)} to ${dmax.toFixed(3)}`);

// faces on a grid: closed, same outline and height as the plain text
{
  const { textRings } = await import('../src/core/text.js');
  const { rings } = textRings({ ...SHAPES.text, text: 'HELLO 8%', size: 6, width: 1 });
  t0 = performance.now();
  const gs = gridSolid(rings, 1, 0.5);
  const gr = report(gs), gb = box(gs), pt = await mesh('text', { text: 'HELLO 8%', size: 6, width: 1, h: 1 }), pb = box(pt);
  ok('grid faces: closed, same size as the text', gr.watertight && Math.abs(gr.volume - report(pt).volume) / report(pt).volume < 0.01 && Math.abs((gb.hi[0] - gb.lo[0]) - (pb.hi[0] - pb.lo[0])) < 0.02,
    `${describe(gr)}  vol ${gr.volume.toFixed(2)} vs ${report(pt).volume.toFixed(2)}  ${gs.length / 9} tris  ${(performance.now() - t0).toFixed(0)} ms`);
}

// round a box's vertical edge: closed, and every foot point on or in the box
{
  const bx = new Surface(await mesh('box', { x: 20, y: 20, z: 20 }));
  for (const sm of [0, 2]) {
    const o = deform(flat, chart(bx, new Vector3(6, -10, 10), new Vector3(0, -1, 0), up, ext, g, 0, 0, sm), 1);
    const ob = box(o);
    ok(`round a box edge, smooth ${sm} mm: closed, both faces`, report(o).watertight && ob.hi[0] > 10.5 && ob.lo[1] < -10.5, `x to ${ob.hi[0].toFixed(2)}, y to ${ob.lo[1].toFixed(2)}`);
  }
}

// smooth over: a box with 1 mm grooves; at 0 the foot follows them, at 3 mm it bridges them and
// the foot still reaches the groove floor
{
  const { initKernel: _i, ...K } = await import('../src/core/kernel.js');
  const slab = await mesh('box', { x: 40, y: 20, z: 10 });
  const grooves = [];
  for (const x of [-6, -2, 2, 6]) grooves.push(await mesh('box', { x: 1, y: 30, z: 2 }));
  // cut by hand: the grooves as a group would need the doc; build the surface from a group part
  const part = (kind, params, pos, hole = false) => ({ id: Math.random().toString(36).slice(2), kind, params: { ...SHAPES[kind], ...params }, xform: { pos, rot: [0, 0, 0], scale: [1, 1, 1] }, hole, ops: [] });
  const grp = { id: 'g', kind: 'group', xform: { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }, hole: false, ops: [],
    children: [part('box', { x: 40, y: 20, z: 10 }, [0, 0, 0]), ...[-6, -2, 2, 6].map(x => part('box', { x: 1, y: 30, z: 1 }, [x, 0, 9], true))] };
  const gsurf = new Surface((await partMesh(grp, ctx)).tris);
  // a row of top points (z 1) and foot points (z 0) every 0.1 mm across the middle
  const row = [];
  for (let x = -8; x <= 8; x += 0.1) row.push(x, 0, 1, x, 0, 0);
  const across = sm => {
    const o = deform(Float32Array.from(row), chart(gsurf, new Vector3(0, 0, 10), new Vector3(0, 0, 1), new Vector3(0, 1, 0), { x0: -9, x1: 9, y0: -1, y1: 1 }, 0.25, 0, 0, sm), 1);
    let topLo = Infinity, footLo = Infinity, span = o[o.length - 6] - o[0];
    for (let k = 0; k < o.length; k += 6) { topLo = Math.min(topLo, o[k + 2]); footLo = Math.min(footLo, o[k + 5]); }
    return { topLo, footLo, span };
  };
  const a0 = across(0), a3 = across(3);
  ok('smooth 0: the letters dip into the grooves', a0.topLo < 10.2, `lowest top z ${a0.topLo.toFixed(2)}`);
  ok('smooth 3 mm: rides over them, foot to the floor', a3.topLo > 10.5 && a3.footLo < 9.0, `lowest top ${a3.topLo.toFixed(2)}, lowest foot ${a3.footLo.toFixed(2)}`);
  ok('smooth 3 mm: spacing kept over the grooves (2 %)', Math.abs(a3.span - 16) < 0.32, `16 mm of text spans ${a3.span.toFixed(2)} mm`);
}

// an inside corner (a floor and a wall): text climbing from the floor up the wall. Its top, 2 mm
// out, must keep going forward through the corner (unrounded, it runs back on itself there)
{
  const part = (kind, params, pos) => ({ id: Math.random().toString(36).slice(2), kind, params: { ...SHAPES[kind], ...params }, xform: { pos, rot: [0, 0, 0], scale: [1, 1, 1] }, hole: false, ops: [] });
  const L = { id: 'L', kind: 'group', xform: { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }, hole: false, ops: [],
    children: [part('box', { x: 40, y: 40, z: 5 }, [0, 0, 0]), part('box', { x: 40, y: 5, z: 25 }, [0, 17.5, 0])] };
  const ls = new Surface((await partMesh(L, ctx)).tris);
  const col = [];
  for (let y = -6; y <= 6; y += 0.05) col.push(0, y, 2);
  const run = top => {
    const o = deform(Float32Array.from(col), chart(ls, new Vector3(0, 13, 5), new Vector3(0, 0, 1), new Vector3(0, 1, 0), { x0: -2, x1: 2, y0: -7, y1: 7 }, 0.25, 0, 0, 0, top), 2);
    let back = 0;
    for (let k = 6; k < o.length; k += 3) {
      const dx = o[k] - o[k - 3], dy = o[k + 1] - o[k - 2], dz = o[k + 2] - o[k - 1], ex = o[k - 3] - o[k - 6], ey = o[k - 2] - o[k - 5], ez = o[k - 1] - o[k - 4];
      if (dx * ex + dy * ey + dz * ez < 0) back++;
    }
    return back;
  };
  const b0 = run(0), b3 = run(3);
  ok('inside corner, no rounding: the top crosses itself', b0 > 0, `${b0} steps run backwards`);
  ok('inside corner, rounded: the top runs through it', b3 === 0, `${b3} steps run backwards`);
  const lt = deform(flat, chart(ls, new Vector3(0, 13, 5), new Vector3(0, 0, 1), new Vector3(0, 1, 0), ext, g, 0, 0, 0.5, 1.5), 1);
  ok('text over an inside corner: closed', report(lt).watertight);
}

// a flat face: the top of a box, exact
const top = new Surface(await mesh('box', { x: 60, y: 30, z: 10 }));
const ft = deform(flat, chart(top, new Vector3(0, 0, 10), new Vector3(0, 0, 1), new Vector3(0, 1, 0), ext, g), 1);
const fb = box(ft);
ok('flat face: exact', Math.abs(fb.lo[2] - 9.8) < 1e-4 && Math.abs(fb.hi[2] - 11) < 1e-4 && Math.abs((fb.hi[0] - fb.lo[0]) - flatW) < 1e-3, `z ${fb.lo[2].toFixed(4)} to ${fb.hi[2].toFixed(4)}`);

// a sphere d 40, 128 facets: closed and on the surface
const sph = new Surface(await mesh('sphere', { d: 40, sides: 128 }));
const so = deform(flat, chart(sph, new Vector3(20, 0, 20), new Vector3(1, 0, 0), up, ext, g), 1);
let smin = Infinity, smax = -Infinity;
for (let i = 0; i < so.length; i += 3) { const rr = Math.hypot(so[i], so[i + 1], so[i + 2] - 20); smin = Math.min(smin, rr); smax = Math.max(smax, rr); }
ok('sphere: closed, on the surface', report(so).watertight && smin > 19.7 && smax < 21.1, `radius ${smin.toFixed(3)} to ${smax.toFixed(3)}`);

// time for a longer text on a big mesh: 40 letters on a 100k-triangle sphere
const big = new Surface(await mesh('sphere', { d: 80, sides: 256 }));
const long = await mesh('text', { text: 'The quick brown fox jumps over the dog', size: 6, width: 1, h: 1 });
const lb = box(long), lcx = (lb.lo[0] + lb.hi[0]) / 2, lcy = (lb.lo[1] + lb.hi[1]) / 2;
for (let i = 0; i < long.length; i += 3) { long[i] -= lcx; long[i + 1] -= lcy; }
const lflat = subdivide(long, g);
t0 = performance.now();
const lc = chart(big, new Vector3(40, 0, 40), new Vector3(1, 0, 0), up, { x0: lb.lo[0] - lcx, x1: lb.hi[0] - lcx, y0: lb.lo[1] - lcy, y1: lb.hi[1] - lcy }, g);
const lo = deform(lflat, lc, 1);
const tl = performance.now() - t0;
ok('re-form, 38 letters on a 32k-tri sphere, under 60 ms', report(lo).watertight && tl < 60, `${(big.tris.length / 9) | 0} tris  ${lflat.length / 9} text tris  ${tl.toFixed(1)} ms`);

console.log(fail ? `VERDICT FAIL (${fail})` : 'VERDICT PASS');
process.exit(fail ? 1 : 0);
