// Picture to part, headless: outlines traced from pixels, extruded, checked closed, and the
// area compared with the solid pixels. node tests/trace.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initKernel, extrudeRings } from '../src/core/kernel.js';
import { report, describe } from '../src/core/meshcheck.js';
import { trace } from '../src/core/trace.js';

await initKernel(readFileSync(createRequire(import.meta.url).resolve('manifold-3d/manifold.wasm')));
let fail = 0;
const ok = (name, cond, info = '') => { if (!cond) fail++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name.padEnd(34)} ${info}`); };
const picture = (W, H, solidAt) => {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, s = solidAt(x, y);
    data[i] = data[i + 1] = data[i + 2] = s ? 20 : 240; data[i + 3] = 255;
  }
  return { width: W, height: H, data };
};
const toRings = (loops, H, mm) => loops.map(l => { const r = []; for (let i = 0; i < l.length; i += 2) r.push([l[i] * mm, (H - l[i + 1]) * mm]); return r; });

const cases = [
  ['a square', picture(40, 40, (x, y) => x >= 10 && x < 30 && y >= 10 && y < 30)],
  ['a ring (hole inside)', picture(80, 80, (x, y) => { const d = Math.hypot(x - 39.5, y - 39.5); return d < 30 && d > 15; })],
  ['two pixels touching at a corner', picture(10, 10, (x, y) => (x === 3 && y === 3) || (x === 4 && y === 4))],
  ['a thin diagonal line', picture(60, 60, (x, y) => Math.abs(x - y) <= 1 && x > 5 && x < 55)],
  ['letters with holes (O and B like)', picture(120, 60, (x, y) => {
    const o = Math.hypot((x - 30) / 20, (y - 30) / 25); const b1 = x >= 70 && x < 100 && y >= 5 && y < 55;
    const h1 = x >= 78 && x < 92 && y >= 12 && y < 26, h2 = x >= 78 && x < 92 && y >= 34 && y < 48;
    return (o < 1 && o > 0.6) || (b1 && !h1 && !h2);
  })],
];
for (const [name, img] of cases) {
  const t = trace(img, { threshold: 128, dark: true, smooth: 0, speck: 0 });
  const mm = 0.5, h = 3;
  const tris = extrudeRings(toRings(t.loops, img.height, mm), h);
  const r = report(tris);
  const want = t.solid * mm * mm * h;
  // inside corners get a 0.01 mm round where touching outlines are joined: volume within 0.1 %
  ok(name, r.watertight && Math.abs(r.volume - want) < 1e-3 * want, `${t.loops.length} loops, ${describe(r)}, volume ${r.volume.toFixed(3)} vs ${want.toFixed(3)}`);
  const s = trace(img, { threshold: 128, dark: true, smooth: 1, speck: 4 });
  if (t.solid * 1 < 4 * 2) {   // all specks: nothing left, and it says so
    let msg = '';
    try { extrudeRings(toRings(s.loops, img.height, mm), h); } catch (e) { msg = e.message; }
    ok(name + ', specks dropped', /Nothing to extrude/.test(msg), msg);
    continue;
  }
  const ts = extrudeRings(toRings(s.loops, img.height, mm), h);
  const rs = report(ts);
  ok(name + ', smoothed', rs.watertight && Math.abs(rs.volume - want) / want < 0.1, `${s.loops.length} loops, ${s.loops.reduce((n, l) => n + l.length / 2, 0)} points, volume ${rs.volume.toFixed(2)} vs ${want.toFixed(2)}`);
}
// light on dark, and see-through pixels are empty
{
  const img = picture(20, 20, (x, y) => x > 4 && x < 15 && y > 4 && y < 15);
  for (let i = 0; i < 20 * 4; i += 4) img.data[i + 3] = 0;   // the first row see-through
  const t = trace(img, { threshold: 128, dark: false, smooth: 0, speck: 0 });
  ok('light is solid; see-through is empty', t.solid === 20 * 20 - 100 - 20, `${t.solid} solid pixels`);
}
console.log(fail ? `${fail} FAILED` : 'all passed');
if (fail) process.exitCode = 1;
