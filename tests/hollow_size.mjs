// Hollow output size on a dense model, cavity thinned (default) against not thinned.
// node tests/hollow_size.mjs [triangles in, default about 400k]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initKernel, partMesh } from '../src/core/kernel.js';
import { report, describe } from '../src/core/meshcheck.js';
import { run } from '../src/tools/hollower/compute.js';

await initKernel(readFileSync(createRequire(import.meta.url).resolve('manifold-3d/manifold.wasm')));
const want = +(process.argv[2] || 400000);
// a dense sphere, 60 mm, so the outer surface is curved everywhere (sides ~ sqrt(triangles))
const n = Math.round(Math.sqrt(want / 4));
const { tris } = await partMesh({ id: 'b', kind: 'sphere', params: { d: 60, sides: n }, xform: { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }, ops: [] }, { blobs: new Map(), tools: {} });
const inT = tris.length / 9;
let fail = 0;
const ctx = { progress: () => {}, selection: [] };
const res = {};
for (const thin of [false, true]) {
  const t0 = performance.now(), m0 = process.memoryUsage().rss;
  const out = await run(tris, { wall: +(process.argv[3] || 1), voxel: +(process.argv[4] || 0.8), open: false, thin }, ctx);
  const r = report(out.tris);
  res[thin] = r;
  console.log(`${thin ? 'thinned  ' : 'as before'}  in ${inT.toLocaleString('en-US')} tris -> out ${r.triangles.toLocaleString('en-US')}, ${describe(r)}, volume ${r.volume.toFixed(0)} mm3, ${((performance.now() - t0) / 1000).toFixed(1)} s, rss +${((process.memoryUsage().rss - m0) / 1048576).toFixed(0)} MB`);
  if (!r.watertight) fail++;
}
const dv = Math.abs(res.true.volume - res.false.volume) / res.false.volume;
console.log(`volume change from thinning ${(dv * 100).toFixed(3)} %`);
if (dv > 0.001 || res.true.triangles >= res.false.triangles) fail++;
console.log(fail ? `${fail} FAILED` : 'all passed');
if (fail) process.exitCode = 1;
