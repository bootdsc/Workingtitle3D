// STEP import, headless: shapes and groups made into STEP files (tests/stepfixture.mjs), read by
// the same CAD reader the app uses for STEP import, and compared with the mesh they came from.
// node tests/step.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initKernel, partMesh, SHAPES } from '../src/core/kernel.js';
import { report, describe, bounds } from '../src/core/meshcheck.js';
import { writeSTEP } from './stepfixture.mjs';
import { stepToTris } from '../src/core/cadread.js';
import * as hollower from '../src/tools/hollower/compute.js';

const require = createRequire(import.meta.url);
await initKernel(readFileSync(require.resolve('manifold-3d/manifold.wasm')));
const occt = await require('occt-import-js')({ wasmBinary: readFileSync(require.resolve('occt-import-js/dist/occt-import-js.wasm')) });
const ctx = { blobs: new Map(), tools: { hollower } };
let fail = 0;
const ok = (name, cond, info = '') => { if (!cond) fail++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name.padEnd(30)} ${info}`); };
const part = (kind, params = {}, extra = {}) => ({ id: Math.random().toString(36).slice(2), kind, params: { ...SHAPES[kind], ...params }, xform: { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }, hole: false, ops: [], ...extra });
const join = chunks => { const n = chunks.reduce((s, c) => s + c.length, 0), o = new Uint8Array(n); let k = 0; for (const c of chunks) { o.set(c, k); k += c.length; } return o; };

const cases = [
  ['box', part('box')],
  ['cylinder', part('cylinder')],
  ['cone', part('cone')],
  ['sphere', part('sphere', { sides: 48 })],
  ['torus', part('torus')],
  ['tube (a hole through)', part('tube')],
  ['plate with a hole', part('group', {}, { children: [part('box', { x: 40, y: 40, z: 5 }), part('cylinder', { d: 10, h: 5 }, { hole: true })] })],
  ['hollow box (a void)', part('box', { x: 30, y: 20, z: 15 }, { ops: [{ tool: 'hollower', params: { wall: 2, voxel: 1, open: false } }] })],
  ['two separate boxes', part('group', {}, { children: [part('box'), part('box', {}, { xform: { pos: [40, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] } })] })],
];
for (const [name, p] of cases) {
  const { tris } = await partMesh(p, ctx);
  const r0 = report(tris), b0 = bounds(tris);
  const t0 = performance.now();
  const w = writeSTEP(tris, { name });
  const bytes = join(w.chunks);
  const back = stepToTris(occt, bytes);
  const r1 = report(back), b1 = bounds(back);
  const dv = Math.abs(r1.volume - r0.volume) / r0.volume;
  const db = Math.max(...[0, 1, 2].flatMap(i => [Math.abs(b1.lo[i] - b0.lo[i]), Math.abs(b1.hi[i] - b0.hi[i])]));
  ok(name, r1.watertight && dv < 1e-4 && db < 1e-3,
    `${r0.triangles} tris -> ${w.faces} faces, ${(bytes.length / 1024).toFixed(0)} KB, back ${describe(r1)}, volume ${r0.volume.toFixed(3)} vs ${r1.volume.toFixed(3)}, box off ${db.toExponential(1)}, ${(performance.now() - t0).toFixed(0)} ms`);
}

// an open surface goes out as an open shell and comes back open, same triangles' area
{
  const t = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0]);
  const w = writeSTEP(t, { name: 'sheet' });
  const back = stepToTris(occt, join(w.chunks));
  ok('open sheet', !w.closed && back.length >= 18, `${w.faces} faces, ${back.length / 9} tris back`);
}
console.log(fail ? `${fail} FAILED` : 'all passed');
if (fail) process.exitCode = 1;
