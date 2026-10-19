// Headless: hollow test solids, closed and opened through a face; each must be a closed solid
// whose volume matches the expected shell. node tests/hollower.mjs
import { run } from '../src/tools/hollower/compute.js';
import { repair, report, describe } from '../src/core/meshcheck.js';
import { box, sphere, extrude, rect, circle } from './shapes.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initKernel, toolKernel } from '../src/core/kernel.js';
await initKernel(readFileSync(createRequire(import.meta.url).resolve('manifold-3d/manifold.wasm')));   // openings are cut by the solid engine

/** Triangles of the planar region facing `normal` at the extreme along it. */
function faceAt(tris, normal) {
  let best = -Infinity;
  for (let i = 0; i < tris.length; i += 3) best = Math.max(best, tris[i] * normal[0] + tris[i + 1] * normal[1] + tris[i + 2] * normal[2]);
  const out = [];
  for (let f = 0; f < tris.length / 9; f++) {
    let ok = true;
    for (let k = 0; k < 3; k++) {
      const j = f * 9 + k * 3;
      if (Math.abs(tris[j] * normal[0] + tris[j + 1] * normal[1] + tris[j + 2] * normal[2] - best) > 1e-4) ok = false;
    }
    if (ok) out.push(f);
  }
  return out;
}

const cases = [
  // name, solid, params, open-face normal, expected volume (mm3) or null
  ['box closed', box(0, 0, 0, 40, 30, 20), { wall: 2, voxel: 0.5 }, null, 40 * 30 * 20 - 36 * 26 * 16],
  ['box open top', box(0, 0, 0, 40, 30, 20), { wall: 2, voxel: 0.5 }, [0, 0, 1], 40 * 30 * 20 - 36 * 26 * 18],
  ['box open side', box(0, 0, 0, 40, 30, 20), { wall: 1.5, voxel: 0.5 }, [1, 0, 0], 40 * 30 * 20 - 38.5 * 27 * 17],
  ['sphere closed', sphere(20, 64, 32), { wall: 2, voxel: 0.5 }, null, null],
  ['plate+holes open top', extrude(rect(0, 0, 60, 30), [circle(15, 15, 6), rect(35, 8, 50, 22)], 0, 12), { wall: 1.6, voxel: 0.4 }, [0, 0, 1], null],
  ['box open both ends', box(0, 0, 0, 40, 30, 20), { wall: 2, voxel: 0.5 }, [[1, 0, 0], [-1, 0, 0]], 40 * 30 * 20 - 40 * 26 * 16],
  ['box open top, both ends', box(0, 0, 0, 40, 30, 20), { wall: 2, voxel: 0.5 }, [[0, 0, 1], [1, 0, 0], [-1, 0, 0]], 40 * 30 * 20 - 40 * 26 * 18],
  ['thin plate', box(0, 0, 0, 40, 30, 3), { wall: 2, voxel: 0.5 }, null, 'error'],
  // the owner's 20 x 20 x 4 box, 2.4 mm wall: only closed top and bottom walls take height
  ['4 mm box open top+bottom', box(0, 0, 0, 20, 20, 4), { wall: 2.4, voxel: 1 }, [[0, 0, 1], [0, 0, -1]], 20 * 20 * 4 - 15.2 * 15.2 * 4],
  ['4 mm box open top', box(0, 0, 0, 20, 20, 4), { wall: 2.4, voxel: 1 }, [0, 0, 1], 20 * 20 * 4 - 15.2 * 15.2 * 1.6],
  ['4 mm box closed', box(0, 0, 0, 20, 20, 4), { wall: 2.4, voxel: 1 }, null, 'error'],
  ['exact box open side', box(0, 0, 0, 40, 30, 20), { wall: 1.5, voxel: 0.5 }, [1, 0, 0], 40 * 30 * 20 - 38.5 * 27 * 17],
  ['exact box open top', box(0, 0, 0, 40, 30, 20), { wall: 2, voxel: 0.5 }, [0, 0, 1], 40 * 30 * 20 - 36 * 26 * 18],
];
let fail = 0;
for (const [name, raw, p, open, expect] of cases) {
  const { tris } = repair(raw);
  const r0 = report(tris);
  // one face, or several (each an opening)
  const selection = !open ? [] : Array.isArray(open[0]) ? open.map(nm => faceAt(tris, nm)) : faceAt(tris, open);
  const t0 = performance.now();
  try {
    // the 4 mm boxes take the app's exact path (the solid engine passed, as the app does); the rest the grid
    const out = await run(tris.slice(), p, { selection, progress() {}, ...(/^(4 mm|exact)/.test(name) ? { kernel: toolKernel() } : {}) });
    const r = report(out.tris);
    let ok = r.watertight && r.volume < r0.volume && expect !== 'error';
    let vol = '';
    if (typeof expect === 'number') {
      const err = (r.volume - expect) / expect;
      vol = `expect ${expect.toFixed(0)} (${(err * 100).toFixed(2)} %)`;
      if (Math.abs(err) > 0.03) ok = false;
    }
    if (!ok) fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(22)} ${String(r.triangles).padStart(7)} tris  vol ${r0.volume.toFixed(0)} -> ${r.volume.toFixed(0)} ${vol}  ${describe(r)}  ${(performance.now() - t0).toFixed(0)} ms`);
    for (const n of out.notes) console.log('       ' + n);
  } catch (e) {
    const expected = e.constructor.name === 'ToolError' && expect === 'error';
    if (!expected) fail++;
    console.log(`${expected ? 'msg ' : 'FAIL'} ${name.padEnd(22)} ${e.message}`);
    if (e.constructor.name !== 'ToolError') console.log(e.stack);
  }
}
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exit(fail ? 1 : 0);
