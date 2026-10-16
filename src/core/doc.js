// The document: parts (recipes), stored meshes, and the step history. No DOM.
// Every change is one command holding the before and after of the top-level parts it
// touched, so undo is small (recipes, not meshes) and any part can be rolled back alone.
// Listeners hear every change, which is how the project folder journals each step.
import { Matrix4, Euler, Quaternion, Vector3 } from 'three';

const clone = o => JSON.parse(JSON.stringify(o));

/** What decides a part's shape in its own frame (not where it sits, not its name). */
export function shapeKey(p) {
  if (p.kind === 'group') {
    return 'g' + (p.mode || '') + '[' + p.children.map(c => (c.hole ? 'h' : 's') + JSON.stringify(c.xform) + shapeKey(c)).join(',') + ']' + JSON.stringify(p.ops || []);
  }
  return p.kind + JSON.stringify(p.params || {}) + (p.blob || '') + JSON.stringify(p.ops || []);
}
/** What makes a part's form: its shape, turn, scale and solid or hole. Not where it sits,
 *  its name, color, or whether it is hidden or locked. A part's history is its forms. */
export function formKey(p) {
  return shapeKey(p) + '|' + JSON.stringify(p.xform?.rot || []) + JSON.stringify(p.xform?.scale || []) + (p.hole ? 'h' : 's');
}
/** Top-level parts after one command, run forward (dir 1) or back (dir -1). */
function applyCmd(list, cmd, dir) {
  const parts = dir > 0 ? cmd.after : cmd.before;
  const order = dir > 0 ? cmd.afterOrder : cmd.beforeOrder;
  const map = new Map(list.map(p => [p.id, p]));
  for (const id of cmd.touched) { if (parts[id]) map.set(id, clone(parts[id])); else map.delete(id); }
  return order.map(id => map.get(id)).filter(Boolean);
}

export const IDENT = () => ({ pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] });

export function matrix(x) {
  const r = (x?.rot || [0, 0, 0]).map(d => (d * Math.PI) / 180);
  return new Matrix4().compose(new Vector3(...(x?.pos || [0, 0, 0])), new Quaternion().setFromEuler(new Euler(r[0], r[1], r[2], 'XYZ')),
    new Vector3(...(x?.scale || [1, 1, 1])));
}
export function xformOf(m) {
  const p = new Vector3(), q = new Quaternion(), s = new Vector3();
  m.decompose(p, q, s);
  const e = new Euler().setFromQuaternion(q, 'XYZ');
  const r = v => Math.abs(v) < 1e-9 ? 0 : +v.toFixed(9);
  return { pos: p.toArray().map(r), rot: [e.x, e.y, e.z].map(a => r((a * 180) / Math.PI)), scale: s.toArray().map(r) };
}

/** Fast content id for a mesh (FNV-1a over the bytes), so a mesh is stored once. */
export function blobId(tris) {
  const b = new Uint8Array(tris.buffer, tris.byteOffset, tris.byteLength);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < b.length; i++) { h1 = Math.imul(h1 ^ b[i], 16777619); h2 = Math.imul(h2 ^ b[i], 2246822519); }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0') + '-' + tris.length;
}

export class Doc {
  constructor() {
    this.parts = [];
    this.blobs = new Map();
    this.history = [];      // commands
    this.at = 0;            // history[0..at) are applied
    this.seq = 1;
    this.listeners = new Set();
    this.names = {};
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { for (const f of this.listeners) f(ev); }

  newId() { return 'p' + (this.seq++).toString(36); }
  nameFor(kind) {
    const n = (this.names[kind] = (this.names[kind] || 0) + 1);
    return kind[0].toUpperCase() + kind.slice(1) + ' ' + n;
  }

  /** {part, list, index, parent} anywhere in the tree. */
  find(id, list = this.parts, parent = null) {
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.id === id) return { part: p, list, index: i, parent };
      if (p.children) { const r = this.find(id, p.children, p); if (r) return r; }
    }
    return null;
  }
  top(id) { return this.parts.find(p => p.id === id) || null; }

  addBlob(tris) {
    const id = blobId(tris);
    if (!this.blobs.has(id)) { this.blobs.set(id, tris); this.emit({ type: 'blob', id, tris }); }
    return id;
  }

  // ---- commands ------------------------------------------------------------------------------
  /** Run fn(parts) on a working copy; record what changed at the top level as one step. */
  commit(label, fn, extra = null) {
    const beforeList = this.parts;
    const work = clone(this.parts);
    const ret = fn(work);
    const before = {}, after = {};
    const bMap = new Map(beforeList.map(p => [p.id, p])), aMap = new Map(work.map(p => [p.id, p]));
    const touched = [];
    for (const id of new Set([...bMap.keys(), ...aMap.keys()])) {
      const b = bMap.get(id), a = aMap.get(id);
      const bj = b ? JSON.stringify(b) : null, aj = a ? JSON.stringify(a) : null;
      if (bj !== aj) { touched.push(id); before[id] = b ? clone(b) : null; after[id] = a ? clone(a) : null; }
    }
    const beforeOrder = beforeList.map(p => p.id), afterOrder = work.map(p => p.id);
    if (!touched.length && beforeOrder.join() === afterOrder.join()) return ret;
    const cmd = { t: Date.now(), label, touched, before, after, beforeOrder, afterOrder, ...extra };
    this.history.length = this.at;           // a new step drops the redo branch
    this.history.push(cmd);
    this.at++;
    this.parts = work;
    this.emit({ type: 'cmd', cmd, names: { ...this.names } });
    return ret;
  }

  apply(cmd, dir) { this.parts = applyCmd(this.parts, cmd, dir); }

  /** Every part id inside a part, itself included. */
  idsIn(part) { return [part.id, ...(part.children || []).flatMap(c => this.idsIn(c))]; }

  /** A part's history: each form it has had, oldest first, as [{step (1-based into history),
   *  label, state}]. Moving it is not a new form; nor is a roll back through this history,
   *  so stepping back and forth keeps the same list. */
  formHistory(id) {
    const out = [];
    let cur = null;
    for (let i = 0; i < this.at; i++) {
      const c = this.history[i];
      if (!c.touched.includes(id)) continue;
      const s = c.after[id];
      if (!s) { cur = null; continue; }
      const k = formKey(s);
      if (k !== cur && c.kind !== 'rollback') out.push({ step: i + 1, label: c.label, state: s, key: k });
      cur = k;
    }
    return out;
  }

  /** Top-level parts as they stood after the first t steps. */
  partsAt(t) {
    let parts = [];
    for (let i = 0; i < t; i++) parts = applyCmd(parts, this.history[i], 1);
    return parts;
  }

  /** Set one top-level part to an earlier state of itself, as one new step. */
  setPart(id, state, label) {
    return this.commit(label, parts => {
      const i = parts.findIndex(p => p.id === id);
      if (i >= 0) parts[i] = clone(state);
    });
  }

  undo() {
    if (!this.at) return null;
    const cmd = this.history[--this.at];
    this.apply(cmd, -1);
    this.emit({ type: 'undo', cmd });
    return cmd;
  }
  redo() {
    if (this.at >= this.history.length) return null;
    const cmd = this.history[this.at++];
    this.apply(cmd, 1);
    this.emit({ type: 'redo', cmd });
    return cmd;
  }

  /** The states one top-level part has been through, newest first: [{cmd, state}]. */
  partHistory(id) {
    const out = [];
    for (let i = this.at - 1; i >= 0; i--) {
      const c = this.history[i];
      if (c.touched.includes(id)) out.push({ cmd: c, state: c.after[id], before: c.before[id] });
    }
    return out;
  }

  /** Put one part back to how it was before a given step, leaving every other part alone. */
  rollbackPart(id, cmd) {
    const state = cmd.before[id];
    return this.commit(`Roll back ${state?.name || 'part'}: before "${cmd.label}"`, parts => {
      const i = parts.findIndex(p => p.id === id);
      if (state && i >= 0) parts[i] = clone(state);
      else if (state) parts.push(clone(state));
      else if (i >= 0) parts.splice(i, 1);
    });
  }

  // ---- edits ---------------------------------------------------------------------------------
  add(part, label) {
    const p = { id: this.newId(), name: this.nameFor(part.kind), xform: IDENT(), hole: false, ops: [], ...clone(part) };
    this.commit(label || `Add ${p.name}`, parts => parts.push(p));
    return p.id;
  }

  remove(ids) {
    const set = new Set(ids);
    this.commit(ids.length > 1 ? `Delete ${ids.length} parts` : `Delete ${this.top(ids[0])?.name || 'part'}`, parts => {
      for (let i = parts.length - 1; i >= 0; i--) if (set.has(parts[i].id)) parts.splice(i, 1);
    });
  }

  /** Change top-level parts in place: fn(part) per id. */
  update(ids, label, fn) {
    const set = new Set(ids);
    this.commit(label, parts => { for (const p of parts) if (set.has(p.id)) fn(p); });
  }

  group(ids, mode = '') {
    if (ids.length < 2) return null;
    const id = this.newId();
    this.commit(`${mode === 'intersect' ? 'Intersect' : 'Group'} ${ids.length} parts`, parts => {
      const set = new Set(ids);
      const kids = parts.filter(p => set.has(p.id));
      const at = parts.findIndex(p => set.has(p.id));
      for (let i = parts.length - 1; i >= 0; i--) if (set.has(parts[i].id)) parts.splice(i, 1);
      const allHoles = kids.every(k => k.hole);
      parts.splice(at, 0, { id, name: this.nameFor('group'), kind: 'group', mode, xform: IDENT(), hole: allHoles, ops: [], children: kids });
    });
    return id;
  }

  ungroup(id) {
    const g = this.top(id);
    if (!g || g.kind !== 'group') return [];
    const ids = g.children.map(c => c.id);
    this.commit(`Ungroup ${g.name}`, parts => {
      const i = parts.findIndex(p => p.id === id);
      const grp = parts[i];
      const gm = matrix(grp.xform);
      const kids = grp.children.map(c => ({ ...c, xform: xformOf(gm.clone().multiply(matrix(c.xform))) }));
      parts.splice(i, 1, ...kids);
    });
    return ids;
  }

  duplicate(ids, offset = [0, 0, 0]) {
    const set = new Set(ids), out = [];
    const reid = p => ({ ...p, id: this.newId(), children: p.children?.map(reid) });
    this.commit(ids.length > 1 ? `Duplicate ${ids.length} parts` : `Duplicate ${this.top(ids[0])?.name || 'part'}`, parts => {
      for (const p of parts.filter(q => set.has(q.id))) {
        const c = reid(clone(p));
        c.name = p.name.replace(/( copy( \d+)?)?$/, ' copy');
        c.xform.pos = c.xform.pos.map((v, k) => v + offset[k]);
        parts.push(c);
        out.push(c.id);
      }
    });
    return out;
  }

  /** Parts from another project (a .wt3d), added as one step with fresh ids. */
  importParts(parts, blobs, label) {
    for (const [id, tris] of blobs) if (!this.blobs.has(id)) { this.blobs.set(id, tris); this.emit({ type: 'blob', id, tris }); }
    const reid = p => ({ ...p, id: this.newId(), children: p.children?.map(reid) });
    const out = [];
    this.commit(label, list => { for (const p of parts) { const c = reid(clone(p)); list.push(c); out.push(c.id); } });
    return out;
  }

  // ---- saving -----------------------------------------------------------------------------
  /** The whole state as plain data (blobs listed by id; their bytes are stored separately). */
  snapshot() {
    return { version: 1, seq: this.seq, names: this.names, parts: clone(this.parts), blobs: [...this.blobs.keys()],
      history: this.history.slice(0, this.at), at: this.at };
  }
  load(s, blobs) {
    this.parts = s.parts; this.seq = s.seq; this.names = s.names || {};
    this.history = s.history || []; this.at = s.at ?? this.history.length;
    this.blobs = blobs || new Map();
  }
  /** Replay a journal line written by the project folder. */
  replay(ev) {
    if (ev.type === 'cmd') {
      this.history.length = this.at;
      this.history.push(ev.cmd);
      this.at++;
      this.apply(ev.cmd, 1);
      const m = /^p([0-9a-z]+)$/;
      for (const id of Object.keys(ev.cmd.after)) { const k = m.exec(id); if (k) this.seq = Math.max(this.seq, parseInt(k[1], 36) + 1); }
      if (ev.names) this.names = ev.names;
    } else if (ev.type === 'undo') { if (this.at) this.apply(this.history[--this.at], -1); }
    else if (ev.type === 'redo') { if (this.at < this.history.length) this.apply(this.history[this.at++], 1); }
    else if (ev.type === 'names') this.names = ev.names;
  }
}
