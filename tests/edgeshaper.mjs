// Headless: shape test plates with every profile and face, check each result is a closed solid.
// node tests/edgeshaper.mjs
import { run } from '../src/tools/edgeshaper/compute.js';
import { repair, report, describe, featureEdges } from '../src/core/meshcheck.js';
import { extrude, rect, circle } from './shapes.mjs';

const parts = {
  plate: extrude(rect(0, 0, 40, 20), [], 0, 5),
  holes: extrude(rect(0, 0, 60, 30), [circle(15, 15, 6), rect(35, 8, 50, 22)], 0, 4),
  disc: extrude(circle(0, 0, 25, 96), [circle(0, 0, 10, 64)], 2, 8),
  strip: extrude(rect(0, 0, 50, 3), [], 0, 6),           // narrower than 2x width: ridge
  ell: extrude([[0, 0], [30, 0], [30, 8], [8, 8], [8, 30], [0, 30]], [], 0, 5),
};
const cases = [
  { kind: 'fillet', face: 'top', width: 2, height: 2, start: null },
  { kind: 'chamfer', face: 'both', width: 1, height: 1, start: null },
  { kind: 'cove', face: 'bottom', width: 1.5, height: 1.5, start: null },
  { kind: 'fillet', face: 'top', width: 3, height: 1, start: 1.5 },   // rabbet
];
let fail = 0;
const noop = { progress() {} };
for (const [name, raw] of Object.entries(parts)) {
  const { tris } = repair(raw);
  const r0 = report(tris);
  if (!r0.watertight) { console.log(`${name}: TEST PART BAD ${describe(r0)}`); fail++; continue; }
  for (const p of cases) {
    const t0 = performance.now();
    try {
      const out = await run(tris.slice(), p, noop);
      const r = report(out.tris);
      const ok = r.watertight && r.volume < r0.volume;
      if (!ok) fail++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(6)} ${p.kind.padEnd(7)} ${p.face.padEnd(6)} ${String(r.triangles).padStart(7)} tris  vol ${r0.volume.toFixed(0)} -> ${r.volume.toFixed(0)}  ${describe(r)}  ${(performance.now() - t0).toFixed(0)} ms`);
    } catch (e) {
      const expected = e.constructor.name === 'ToolError';
      console.log(`${expected ? 'msg ' : 'FAIL'} ${name.padEnd(6)} ${p.kind.padEnd(7)} ${p.face.padEnd(6)} ${e.message}`);
      if (!expected) { fail++; console.log(e.stack); }
    }
  }
}
// a smooth profile draws no feature lines of its own: on a disc with a hole, only the two
// bottom rims (96 + 64 edges) are left. Terraced bands drew over 10,000.
{
  const { tris } = repair(parts.disc);
  const out = (await run(tris.slice(), { kind: 'fillet', face: 'top', width: 3, height: 3, start: null }, noop)).tris;
  const lines = featureEdges(out, 40).length / 6;
  const ok = lines === 160;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} disc   fillet  smooth band: ${lines} feature lines, 160 expected (the bottom rims)`);
}
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exit(fail ? 1 : 0);
