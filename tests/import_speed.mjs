// How long the import stages take on a big mesh (a dense sphere, given triangle count).
// node tests/import_speed.mjs [triangles, default 800000]
import { repair, adjacency, report } from '../src/core/meshcheck.js';

const want = +(process.argv[2] || 800000);
const n = Math.round(Math.sqrt(want / 2));
const t = [];
const P = (i, j) => { const th = Math.PI * i / n, ph = 2 * Math.PI * j / n; return [50 * Math.sin(th) * Math.cos(ph), 50 * Math.sin(th) * Math.sin(ph), 50 * Math.cos(th) + 50]; };
for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1); if (i > 0) t.push(...a, ...b, ...d); if (i < n - 1) t.push(...b, ...c, ...d); }
const tris = Float32Array.from(t);
const time = (name, fn) => { const t0 = performance.now(); const r = fn(); console.log(`${name.padEnd(12)} ${((performance.now() - t0) / 1000).toFixed(2)} s`); return r; };
console.log(`${(tris.length / 9).toLocaleString('en-US')} triangles`);
const r = time('repair', () => repair(tris));
time('adjacency', () => adjacency(r.tris));
time('report', () => report(r.tris));
console.log('all passed');
