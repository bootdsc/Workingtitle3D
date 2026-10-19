// Text parts: every letter of the app's own font makes a closed solid at small, usual and big
// sizes, thin and thick lines; vertical stacks; stretch and line width do what they say.
// node tests/text.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initKernel, partMesh, SHAPES } from '../src/core/kernel.js';
import { report, describe, bounds } from '../src/core/meshcheck.js';

await initKernel(readFileSync(createRequire(import.meta.url).resolve('manifold-3d/manifold.wasm')));
const ctx = { blobs: new Map(), tools: {} };
let fail = 0;
const ok = (name, cond, info = '') => { if (!cond) fail++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name.padEnd(40)} ${info}`); };
const part = params => ({ id: Math.random().toString(36).slice(2), kind: 'text', params: { ...SHAPES.text, ...params }, xform: { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }, hole: false, ops: [] });
const build = async params => {
  const t0 = performance.now();
  const { tris } = await partMesh(part(params), ctx);
  return { tris, r: report(tris), b: bounds(tris), ms: performance.now() - t0 };
};

const ALL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz\n0123456789\n.,:;!?-_+=/\\()[]\'"#*%$<>°';
for (const [size, width] of [[3, 0.4], [10, 1.7], [10, 0.6], [10, 3], [40, 6]]) {
  const { r, ms } = await build({ text: ALL, size, width });
  ok(`every letter, size ${size} line ${width}`, r.watertight && r.volume > 0, `${r.triangles} tris  ${describe(r)}  ${ms.toFixed(0)} ms`);
}
for (const ch of ALL.replace(/\n/g, '')) {
  const { r } = await build({ text: ch, size: 5, width: 0.8 });
  if (!(r.watertight && r.volume > 0)) ok(`letter ${ch}`, false, describe(r));
}
ok('each letter alone, size 5', true);

const a = await build({ text: 'HELLO' }), v = await build({ text: 'HELLO', vertical: true });
const ext = x => [x.b.hi[0] - x.b.lo[0], x.b.hi[1] - x.b.lo[1], x.b.hi[2] - x.b.lo[2]];
const [aw, ah, az] = ext(a), [vw, vh] = ext(v);
ok('vertical stacks top to bottom', vh > 4 * vw && aw > 2 * ah, `across ${aw.toFixed(1)} x ${ah.toFixed(1)}, vertical ${vw.toFixed(1)} x ${vh.toFixed(1)}`);
ok('height is h', Math.abs(az - 2) < 1e-6 && Math.abs(a.b.lo[2]) < 1e-6, `z ${a.b.lo[2].toFixed(4)} to ${a.b.hi[2].toFixed(4)}`);

const s2 = await build({ text: 'HELLO', sx: 200 });
const [sw, sh] = ext(s2);
const w = SHAPES.text.width;
ok('stretch across 200 % doubles the centre lines', Math.abs((sw - w) - 2 * (aw - w)) < 0.02 && Math.abs(sh - ah) < 0.02, `${aw.toFixed(3)} -> ${sw.toFixed(3)}`);

const g = await build({ text: 'HELLO', width: w + 1 });
const [gw, gh] = ext(g);
// up: 0.5 mm each side of the centre line; across: that, plus the clear gap kept at each of 4 joins
ok('line width grows about the centre line', Math.abs(gh - ah - 1) < 0.05 && gw - aw > 4.5 && gw - aw < 6, `+1 mm: ${(gw - aw).toFixed(3)} across, ${(gh - ah).toFixed(3)} up`);

// slant: a raised bar 2 wide, 1.5 out, down = -y: its underside goes 45 deg (half the bar's area
// at 1.5 out is gone: 1.5 of 2), the top side stays square; cut in, the ceiling slants instead
{
  const bar = { text: '-', size: 10, width: 2, h: 1.5 };
  const flat = await build(bar), sl = await build({ ...bar, slant: { u: [0, -1] } }), db = await build({ ...bar, slant: { u: [0, -1], deboss: true } });
  const zAt = (t, test) => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < t.length; i += 3) if (test(t[i + 2])) { lo = Math.min(lo, t[i + 1]); hi = Math.max(hi, t[i + 1]); } return [lo, hi]; };
  const [fy0, fy1] = zAt(flat.tris, z => z > 1.49), [sy0, sy1] = zAt(sl.tris, z => z > 1.49), [dy0, dy1] = zAt(db.tris, z => z < 0.01);
  ok('slant raised: underside 45 deg, top kept', sl.r.watertight && Math.abs((sy0 - fy0) - 1.5) < 0.02 && Math.abs(sy1 - fy1) < 0.02, `outer face y ${sy0.toFixed(3)} to ${sy1.toFixed(3)} (flat ${fy0.toFixed(3)} to ${fy1.toFixed(3)})`);
  ok('slant cut in: ceiling 45 deg', db.r.watertight && Math.abs((fy1 - dy1) - 1.5) < 0.02 && Math.abs(dy0 - fy0) < 0.02, `floor y ${dy0.toFixed(3)} to ${dy1.toFixed(3)}`);
  const all = await build({ text: ALL, slant: { u: [0.3, -0.95] } });
  ok('slant on every letter: closed', all.r.watertight, `${all.r.triangles} tris  ${all.ms.toFixed(0)} ms`);
}

// a round top wider than half a stroke: the top used to close with flat bridging triangles; now
// it ends in a clean flat face at the part's height
{
  const edgeshaper = await import('../src/tools/edgeshaper/compute.js');
  const ectx = { blobs: new Map(), tools: { edgeshaper } };
  for (const face of ['top', 'both']) {
    const pt = { ...part({ text: 'Text', size: 10, width: 1.7, h: 2 }), ops: [{ tool: 'edgeshaper', params: { kind: 'fillet', face, width: 1, height: face === 'both' ? 0.8 : 1, start: null } }] };
    const { tris } = await partMesh(pt, ectx);
    const r = report(tris), b = bounds(tris);
    let tilted = 0;
    for (let i = 0; i < tris.length; i += 9) {
      // a bridge: a big triangle reaching the top that is not flat (the round's own facets are small)
      if (Math.max(tris[i + 2], tris[i + 5], tris[i + 8]) < b.hi[2] - 1e-5) continue;
      const ax = tris[i + 3] - tris[i], ay = tris[i + 4] - tris[i + 1], az = tris[i + 5] - tris[i + 2];
      const bx = tris[i + 6] - tris[i], by = tris[i + 7] - tris[i + 1], bz = tris[i + 8] - tris[i + 2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx, l = Math.hypot(nx, ny, nz);
      const drop = b.hi[2] - Math.min(tris[i + 2], tris[i + 5], tris[i + 8]);
      const big = Math.max(Math.hypot(ax, ay, az), Math.hypot(bx, by, bz)) > 1 && drop > 0.05;
      if (big && l > 1e-12 && Math.abs(nz) / l < 0.999) tilted++;
    }
    ok(`round ${face}, wider than half a stroke: flat, closed`, r.watertight && Math.abs(b.hi[2] - 2) < 1e-4 && Math.abs(b.lo[2]) < 1e-4 && tilted === 0,
      `${describe(r)}  z ${b.lo[2].toFixed(4)} to ${b.hi[2].toFixed(4)}  tilted top triangles ${tilted}`);
  }
}

const big = await build({ text: 'The quick brown fox jumps\nover the lazy dog 0123456789' });
ok('two lines of 50 letters, time', big.r.watertight && big.ms < 1000, `${big.r.triangles} tris  ${big.ms.toFixed(0)} ms`);

console.log(fail ? `VERDICT FAIL (${fail})` : 'VERDICT PASS');
process.exit(fail ? 1 : 0);
