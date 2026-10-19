// Small DOM helpers for panels. Tool plugins build their panel from these, so
// every tool looks and behaves the same.

/** Hover help for an element, shown only when tooltips are switched on. */
export function tip(el, text) { el.dataset.tip = text; return el; }

export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}

export function button(text, onclick, { go = false, small = false, title } = {}) {
  return h('button', { class: 'btn' + (go ? ' go' : '') + (small ? ' small' : ''), onclick, title, type: 'button' }, text);
}

/** One-of-N. Selected = filled and bold, so it never rides on hue alone. */
export function seg(options, value, onchange) {
  const el = h('div', { class: 'seg' });
  const btns = options.map(o => {
    const [v, label] = Array.isArray(o) ? o : [o, o];
    const b = h('button', { type: 'button', onclick: () => { el.set(v); onchange(v); } }, label);
    b.dataset.v = v;
    return b;
  });
  el.append(...btns);
  el.set = v => btns.forEach(b => b.classList.toggle('on', b.dataset.v === String(v)));
  el.set(value);
  return el;
}

/**
 * Number field. Wheel or up/down nudge by step (Shift x10). Empty is allowed only
 * with `empty` (the placeholder says what empty means, e.g. "auto").
 * onchange(value|null) fires only with a valid value.
 */
export function numfield(label, value, unit, onchange, { min = -Infinity, max = Infinity, step = 0.5, empty = null, digits = 2, lazy = false } = {}) {
  const input = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', placeholder: empty || '' });
  const el = h('div', { class: 'field' }, h('label', {}, label), h('div', { class: 'box' }, input, unit ? h('span', { class: 'unit' }, unit) : null));
  const fmt = v => (v == null ? '' : String(+v.toFixed(digits)));
  input.value = fmt(value);
  const parse = () => {
    const s = input.value.trim().replace(',', '.');
    if (s === '' && empty) return { ok: true, v: null };
    const v = Number(s);
    return { ok: s !== '' && Number.isFinite(v) && v >= min && v <= max, v };
  };
  const commit = () => {
    const r = parse();
    el.classList.toggle('bad', !r.ok);
    if (r.ok) onchange(r.v);
  };
  const nudge = (dir, big) => {
    const r = parse();
    const base = r.ok && r.v != null ? r.v : (value ?? 0);
    const v = Math.min(max, Math.max(min, +(base + dir * step * (big ? 10 : 1)).toFixed(6)));
    input.value = fmt(v);
    commit();
  };
  // lazy: every keystroke is checked, but the value is only sent on Enter, leaving the
  // field, or a nudge - so typing 12.5 is one step, not four
  input.addEventListener('input', lazy ? () => el.classList.toggle('bad', !parse().ok) : commit);
  if (lazy) input.addEventListener('change', commit);
  input.addEventListener('focus', () => input.select());   // typing replaces the old value
  input.addEventListener('keydown', e => {
    if (lazy && e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); nudge(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey); }
  });
  input.addEventListener('wheel', e => { if (document.activeElement === input) { e.preventDefault(); nudge(e.deltaY < 0 ? 1 : -1, e.shiftKey); } }, { passive: false });
  el.set = v => { input.value = fmt(v); el.classList.remove('bad'); };
  el.input = input;
  return el;
}

/** Slider with a number box to type the exact value; the two stay in step.
 *  oninput fires while dragging; onchange once the value settles (release, Enter, blur). */
export function slider(label, value, unit, { min = 0, max = 100, step = 1, digits = 0, limits = [min, max] } = {}, oninput, onchange = oninput) {
  // limits: what the box takes when typed; the slider's own reach (min, max) can be narrower
  const range = h('input', { type: 'range', min, max, step, value });
  let box;
  box = numfield(label, value, unit, v => { range.value = v; oninput(v); onchange(v); }, { min: limits[0], max: limits[1], step, digits, lazy: true });
  range.addEventListener('input', () => { box.set(+range.value); oninput(+range.value); });
  range.addEventListener('change', () => onchange(+range.value));
  const el = h('div', { class: 'slider' }, box, range);
  el.set = v => { range.value = v; box.set(v); };
  return el;
}

export function check(label, value, onchange) {
  const box = h('input', { type: 'checkbox' });
  box.checked = !!value;
  box.addEventListener('change', () => onchange(box.checked));
  const el = h('label', { class: 'check' }, box, label);
  el.set = v => { box.checked = !!v; };
  return el;
}

export function card(title, ...kids) {
  return h('div', { class: 'card' }, title ? h('h3', {}, title) : null, ...kids);
}

/** Key/value rows: [[k, v, cls?], ...] */
export function kv(rows) {
  return h('div', { class: 'kv' }, rows.flatMap(([k, v, cls]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' + (cls ? ' ' + cls : ''), title: String(v) }, v)]));
}

export function errorLine(msg) {
  return h('div', { class: 'err' }, msg);
}

/** In-page dialog. Resolves with the chosen button's value. */
export function ask(message, buttons = [['OK', true, true]]) {
  return new Promise(res => {
    const d = h('dialog', {}, h('div', {}, message));
    const row = h('div', { class: 'row' });
    for (const [label, val, go] of buttons) row.append(button(label, () => { d.close(); d.remove(); res(val); }, { go }));
    d.append(row);
    d.addEventListener('cancel', () => { d.remove(); res(null); });
    document.body.append(d);
    d.showModal();
  });
}

export const mm = v => (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2));
export const count = n => n.toLocaleString('en-US');
