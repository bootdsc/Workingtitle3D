// STEP files (ISO 10303-21, AP214) written from a triangle mesh, for the tests only: they make
// STEP files for the import tests. The app does not export STEP (a mesh as STEP
// is many times the size of the STL and gains nothing).
//
// Our parts are triangle meshes, so the STEP solid is made of flat faces: every flat region
// of the mesh (neighbouring triangles on one plane) becomes one face, with its holes, so a
// box is 6 faces and only curved surfaces stay one face per triangle. Every point and edge
// is shared between the faces that meet there, so a closed mesh is a closed solid, which a
// slicer or CAD program reads as a solid. Nothing is lost against the mesh; nothing is finer.
//
// Reading STEP needs a real geometry kernel (curved surfaces); see cadworker.js.
import { weld } from '../src/core/meshcheck.js';

/** STEP real: always a decimal point, exponent as E. */
function real(v) {
  if (!Number.isFinite(v) || Math.abs(v) < 1e-12) return '0.';
  let s = String(+v.toPrecision(10));
  if (s.includes('e')) {
    let [m, e] = s.split('e');
    if (!m.includes('.')) m += '.';
    return m + 'E' + e;
  }
  return s.includes('.') ? s : s + '.';
}
const str = s => "'" + String(s).replace(/[^\x20-\x7e]/g, '_').replace(/'/g, "''") + "'";

/**
 * tris: Float32Array soup, normals out, millimetres. Returns { chunks: [Uint8Array], faces,
 * triangles, closed } where faces is the number of STEP faces written.
 */
export function writeSTEP(tris, { name = 'model', progress = () => {} } = {}) {
  const { pos, idx, nv } = weld(tris);
  const nf = idx.length / 3;
  // bounding box: the planarity tolerance scales with the model, as float coordinates do
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < nv; v++) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], pos[v * 3 + a]); hi[a] = Math.max(hi[a], pos[v * 3 + a]); }
  const diag = nv ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : 1;
  const tol = Math.max(1e-6, diag * 2e-8);

  // per triangle plane
  const N = new Float64Array(nf * 3), D = new Float64Array(nf), live = new Uint8Array(nf);
  for (let f = 0; f < nf; f++) {
    const a = idx[f * 3] * 3, b = idx[f * 3 + 1] * 3, c = idx[f * 3 + 2] * 3;
    if (a === b || b === c || a === c) continue;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z);
    if (!(l > 1e-18)) continue;
    x /= l; y /= l; z /= l;
    N[f * 3] = x; N[f * 3 + 1] = y; N[f * 3 + 2] = z;
    D[f] = x * pos[a] + y * pos[a + 1] + z * pos[a + 2];
    live[f] = 1;
  }

  // undirected edges: key -> list of directed uses (face * 3 + corner)
  const key = (a, b) => (a < b ? a * nv + b : b * nv + a);
  const edges = new Map();
  for (let f = 0; f < nf; f++) {
    if (!live[f]) continue;
    for (let k = 0; k < 3; k++) {
      const a = idx[f * 3 + k], b = idx[f * 3 + (k + 1) % 3], u = key(a, b);
      const l = edges.get(u);
      if (l) l.push(f * 3 + k); else edges.set(u, [f * 3 + k]);
    }
  }
  let closed = true;
  for (const l of edges.values()) {
    if (l.length !== 2) { closed = false; break; }
    const [p, q] = l, fp = (p / 3) | 0, fq = (q / 3) | 0;
    if (idx[p] === idx[fq * 3 + q % 3] && fp !== fq) { closed = false; break; }   // both run the same way: flipped
  }
  progress(0.15, 'finding flat faces');

  // flat regions: neighbours across a two-face edge on the same plane
  const parent = new Int32Array(nf).map((_, i) => i);
  const find = x => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  const same = (f, g) => N[f * 3] * N[g * 3] + N[f * 3 + 1] * N[g * 3 + 1] + N[f * 3 + 2] * N[g * 3 + 2] > 1 - 1e-12 && Math.abs(D[f] - D[g]) < tol;
  for (const l of edges.values()) {
    if (l.length !== 2) continue;
    const f = (l[0] / 3) | 0, g = (l[1] / 3) | 0;
    if (f !== g && same(f, g)) { const a = find(f), b = find(g); if (a !== b) parent[a] = b; }
  }
  const regions = new Map();
  for (let f = 0; f < nf; f++) if (live[f]) { const r = find(f); const g = regions.get(r); if (g) g.push(f); else regions.set(r, [f]); }

  // each region's boundary as loops; a region whose boundary pinches or does not nest
  // simply goes back to one face per triangle
  const faces = [];   // { n, d, loops: [[v...]] } first loop outer
  const signedArea = (loop, n) => {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] * 3, b = loop[(i + 1) % loop.length] * 3;
      x += pos[a + 1] * pos[b + 2] - pos[a + 2] * pos[b + 1];
      y += pos[a + 2] * pos[b] - pos[a] * pos[b + 2];
      z += pos[a] * pos[b + 1] - pos[a + 1] * pos[b];
    }
    return (x * n[0] + y * n[1] + z * n[2]) / 2;
  };
  const single = f => faces.push({ n: [N[f * 3], N[f * 3 + 1], N[f * 3 + 2]], d: D[f], loops: [[idx[f * 3], idx[f * 3 + 1], idx[f * 3 + 2]]], tris: [f] });
  let done = 0;
  for (const list of regions.values()) {
    if ((++done & 4095) === 0) progress(0.15 + 0.35 * done / regions.size, 'finding flat faces');
    if (list.length === 1) { single(list[0]); continue; }
    // the region's plane: from its largest triangle
    let best = list[0], bestA = -1;
    const inR = new Set(list);
    const next = new Map();
    let ok = true;
    for (const f of list) {
      const a = idx[f * 3] * 3, b = idx[f * 3 + 1] * 3, c = idx[f * 3 + 2] * 3;
      const ar = Math.hypot((pos[b + 1] - pos[a + 1]) * (pos[c + 2] - pos[a + 2]) - (pos[b + 2] - pos[a + 2]) * (pos[c + 1] - pos[a + 1]),
        (pos[b + 2] - pos[a + 2]) * (pos[c] - pos[a]) - (pos[b] - pos[a]) * (pos[c + 2] - pos[a + 2]),
        (pos[b] - pos[a]) * (pos[c + 1] - pos[a + 1]) - (pos[b + 1] - pos[a + 1]) * (pos[c] - pos[a]));
      if (ar > bestA) { bestA = ar; best = f; }
      for (let k = 0; k < 3; k++) {
        const p = idx[f * 3 + k], q = idx[f * 3 + (k + 1) % 3];
        const uses = edges.get(key(p, q));
        const inside = uses.length === 2 && uses.every(u => inR.has((u / 3) | 0));
        if (inside) continue;
        if (next.has(p)) { ok = false; break; }   // two boundary edges leave one point: pinched
        next.set(p, q);
      }
      if (!ok) break;
    }
    const n = [N[best * 3], N[best * 3 + 1], N[best * 3 + 2]];
    const loops = [];
    if (ok) {
      const seen = new Set();
      for (const s of next.keys()) {
        if (seen.has(s)) continue;
        const loop = [];
        let v = s;
        while (!seen.has(v)) { seen.add(v); loop.push(v); v = next.get(v); if (v === undefined) { ok = false; break; } }
        if (!ok || v !== s || loop.length < 3) { ok = false; break; }
        loops.push(loop);
      }
    }
    if (ok) {
      const areas = loops.map(l => signedArea(l, n));
      const outer = areas.filter(a => a > 0).length;
      if (outer !== 1) ok = false;
      else {
        const o = areas.findIndex(a => a > 0);
        loops.unshift(...loops.splice(o, 1));
      }
    }
    if (!ok) { for (const f of list) single(f); continue; }
    faces.push({ n, d: D[best], loops, tris: list });
  }
  progress(0.5, 'writing');

  // shells: faces joined through shared edges
  const fParent = new Int32Array(faces.length).map((_, i) => i);
  const ffind = x => { while (fParent[x] !== x) x = fParent[x] = fParent[fParent[x]]; return x; };
  const owner = new Map();   // undirected edge -> first face using it
  faces.forEach((fc, i) => {
    for (const loop of fc.loops) for (let k = 0; k < loop.length; k++) {
      const u = key(loop[k], loop[(k + 1) % loop.length]);
      const o = owner.get(u);
      if (o === undefined) owner.set(u, i); else { const a = ffind(o), b = ffind(i); if (a !== b) fParent[a] = b; }
    }
  });
  const shellMap = new Map();
  faces.forEach((_, i) => { const r = ffind(i); const s = shellMap.get(r); if (s) s.push(i); else shellMap.set(r, [i]); });
  // a closed shell with its faces turned inwards (negative volume) is a void: the inside
  // wall of a hollow part. It belongs to the solid round it, not beside it.
  const shellTris = list => list.flatMap(fi => faces[fi].tris);
  const shellInfo = [...shellMap.values()].map(list => {
    const ts = shellTris(list);
    let vol = 0;
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const f of ts) {
      const a = idx[f * 3] * 3, c = idx[f * 3 + 1] * 3, e = idx[f * 3 + 2] * 3;
      vol += (pos[a] * (pos[c + 1] * pos[e + 2] - pos[c + 2] * pos[e + 1]) - pos[a + 1] * (pos[c] * pos[e + 2] - pos[c + 2] * pos[e]) + pos[a + 2] * (pos[c] * pos[e + 1] - pos[c + 1] * pos[e])) / 6;
      for (const v of [a, c, e]) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], pos[v + k]); b[k + 3] = Math.max(b[k + 3], pos[v + k]); }
    }
    return { list, ts, vol, b, voids: [] };
  });
  // which solid a point is in: count crossings of a ray along +x (slightly tilted)
  const inside = (sh, px, py, pz) => {
    let k = 0;
    const dy = 1.3e-4, dz = 1.7e-4;   // ray direction (1, dy, dz), off the axes so it misses edges
    for (const f of sh.ts) {
      const a = idx[f * 3] * 3, c = idx[f * 3 + 1] * 3, e = idx[f * 3 + 2] * 3;
      // Moller-Trumbore
      const e1 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]], e2 = [pos[e] - pos[a], pos[e + 1] - pos[a + 1], pos[e + 2] - pos[a + 2]];
      const h = [dy * e2[2] - dz * e2[1], dz * e2[0] - 1 * e2[2], 1 * e2[1] - dy * e2[0]];
      const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
      if (Math.abs(det) < 1e-18) continue;
      const s = [px - pos[a], py - pos[a + 1], pz - pos[a + 2]];
      const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det;
      if (u < 0 || u > 1) continue;
      const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
      const v = (1 * q[0] + dy * q[1] + dz * q[2]) / det;
      if (v < 0 || u + v > 1) continue;
      if ((e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det > 0) k++;
    }
    return k % 2 === 1;
  };
  const solids = closed ? shellInfo.filter(s => s.vol > 0) : shellInfo;
  if (closed) {
    for (const v of shellInfo.filter(s => s.vol <= 0)) {
      const p = idx[v.ts[0] * 3] * 3;
      const round = solids.filter(s => s.b[0] <= v.b[0] && s.b[1] <= v.b[1] && s.b[2] <= v.b[2] && s.b[3] >= v.b[3] && s.b[4] >= v.b[4] && s.b[5] >= v.b[5])
        .sort((s, t) => s.vol - t.vol).find(s => inside(s, pos[p], pos[p + 1], pos[p + 2]));
      if (round) round.voids.push(v); else solids.push(v);   // nothing round it: written as it is
    }
  }

  // ---- write ----
  const enc = new TextEncoder(), chunks = [];
  let buf = [], len = 0, id = 0;
  const flush = () => { if (buf.length) { chunks.push(enc.encode(buf.join(''))); buf = []; len = 0; } };
  const put = s => { buf.push(s); len += s.length; if (len > 1 << 22) flush(); };
  const ent = s => { put(`#${++id}=${s};\n`); return id; };
  const nm = str(name);
  const stamp = new Date().toISOString().slice(0, 19);
  put(`ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Workingtitle3D export: flat faces from a triangle mesh'),'2;1');\n`
    + `FILE_NAME(${nm},'${stamp}',(''),(''),'Workingtitle3D','Workingtitle3D','');\n`
    + `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n`);
  const appCtx = ent(`APPLICATION_CONTEXT('core data for automotive mechanical design processes')`);
  ent(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appCtx})`);
  const prodCtx = ent(`PRODUCT_CONTEXT('',#${appCtx},'mechanical')`);
  const defCtx = ent(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design')`);
  const prod = ent(`PRODUCT(${nm},${nm},'',(#${prodCtx}))`);
  ent(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${prod}))`);
  const form = ent(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`);
  const pdef = ent(`PRODUCT_DEFINITION('design','',#${form},#${defCtx})`);
  const pshape = ent(`PRODUCT_DEFINITION_SHAPE('','',#${pdef})`);
  const lenU = ent(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
  const angU = ent(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const solU = ent(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const unc = ent(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(${real(tol * 10)}),#${lenU},'distance_accuracy_value','confusion accuracy')`);
  const ctx = ent(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lenU},#${angU},#${solU}))REPRESENTATION_CONTEXT('Context','3D'))`);
  const o0 = ent(`CARTESIAN_POINT('',(0.,0.,0.))`);
  const z0 = ent(`DIRECTION('',(0.,0.,1.))`);
  const x0 = ent(`DIRECTION('',(1.,0.,0.))`);
  const axis = ent(`AXIS2_PLACEMENT_3D('',#${o0},#${z0},#${x0})`);

  const vtx = new Int32Array(nv).fill(-1);
  const vertex = v => {
    if (vtx[v] >= 0) return vtx[v];
    const p = ent(`CARTESIAN_POINT('',(${real(pos[v * 3])},${real(pos[v * 3 + 1])},${real(pos[v * 3 + 2])}))`);
    return (vtx[v] = ent(`VERTEX_POINT('',#${p})`));
  };
  const curve = new Map();   // undirected edge -> [EDGE_CURVE id, start vertex]
  const edge = (a, b) => {
    const u = key(a, b);
    let c = curve.get(u);
    if (!c) {
      const dx = pos[b * 3] - pos[a * 3], dy = pos[b * 3 + 1] - pos[a * 3 + 1], dz = pos[b * 3 + 2] - pos[a * 3 + 2];
      const l = Math.hypot(dx, dy, dz) || 1;
      const va = vertex(a), vb = vertex(b);
      const p = ent(`CARTESIAN_POINT('',(${real(pos[a * 3])},${real(pos[a * 3 + 1])},${real(pos[a * 3 + 2])}))`);
      const dir = ent(`DIRECTION('',(${real(dx / l)},${real(dy / l)},${real(dz / l)}))`);
      const vec = ent(`VECTOR('',#${dir},${real(l)})`);
      const line = ent(`LINE('',#${p},#${vec})`);
      c = [ent(`EDGE_CURVE('',#${va},#${vb},#${line},.T.)`), a];
      curve.set(u, c);
    }
    return `#${ent(`ORIENTED_EDGE('',*,*,#${c[0]},${c[1] === a ? '.T.' : '.F.'})`)}`;
  };
  const items = [];
  let written = 0;
  const shellFaces = list => {
    const ids = [];
    for (const fi of list) {
      const fc = faces[fi];
      const bounds = fc.loops.map((loop, k) => {
        const oes = loop.map((v, i) => edge(v, loop[(i + 1) % loop.length]));
        const el = ent(`EDGE_LOOP('',(${oes.join(',')}))`);
        return `#${ent(`${k ? 'FACE_BOUND' : 'FACE_OUTER_BOUND'}('',#${el},.T.)`)}`;
      });
      const v0 = fc.loops[0][0];
      const p = ent(`CARTESIAN_POINT('',(${real(pos[v0 * 3])},${real(pos[v0 * 3 + 1])},${real(pos[v0 * 3 + 2])}))`);
      const n = fc.n, r = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      // reference direction: in the plane, at right angles to the normal
      let rx = r[0] - n[0] * (r[0] * n[0] + r[1] * n[1] + r[2] * n[2]), ry = r[1] - n[1] * (r[0] * n[0] + r[1] * n[1] + r[2] * n[2]), rz = r[2] - n[2] * (r[0] * n[0] + r[1] * n[1] + r[2] * n[2]);
      const rl = Math.hypot(rx, ry, rz); rx /= rl; ry /= rl; rz /= rl;
      const nd = ent(`DIRECTION('',(${real(n[0])},${real(n[1])},${real(n[2])}))`);
      const rd = ent(`DIRECTION('',(${real(rx)},${real(ry)},${real(rz)}))`);
      const ax = ent(`AXIS2_PLACEMENT_3D('',#${p},#${nd},#${rd})`);
      const pl = ent(`PLANE('',#${ax})`);
      ids.push(`#${ent(`ADVANCED_FACE('',(${bounds.join(',')}),#${pl},.T.)`)}`);
      if ((++written & 4095) === 0) progress(0.5 + 0.45 * written / faces.length, 'writing');
    }
    return ids.join(',');
  };
  for (const s of solids) {
    if (!closed) { items.push(ent(`OPEN_SHELL('',(${shellFaces(s.list)}))`)); continue; }
    const outer = ent(`CLOSED_SHELL('',(${shellFaces(s.list)}))`);
    if (!s.voids.length) { items.push(ent(`MANIFOLD_SOLID_BREP(${nm},#${outer})`)); continue; }
    // a void is written as a shell facing out of the hole, then used turned round (.F.)
    const voids = s.voids.map(v => `#${ent(`ORIENTED_CLOSED_SHELL('',*,#${ent(`CLOSED_SHELL('',(${shellFaces(v.list)}))`)},.F.)`)}`);
    items.push(ent(`BREP_WITH_VOIDS(${nm},#${outer},(${voids.join(',')}))`));
  }
  let rep;
  if (closed) rep = ent(`ADVANCED_BREP_SHAPE_REPRESENTATION(${nm},(#${axis}${items.map(i => ',#' + i).join('')}),#${ctx})`);
  else {
    const sbsm = ent(`SHELL_BASED_SURFACE_MODEL('',(${items.map(i => '#' + i).join(',')}))`);
    rep = ent(`MANIFOLD_SURFACE_SHAPE_REPRESENTATION(${nm},(#${axis},#${sbsm}),#${ctx})`);
  }
  ent(`SHAPE_DEFINITION_REPRESENTATION(#${pshape},#${rep})`);
  put('ENDSEC;\nEND-ISO-10303-21;\n');
  flush();
  progress(1, 'written');
  return { chunks, faces: faces.length, triangles: nf, closed };
}
