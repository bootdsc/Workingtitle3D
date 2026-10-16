// The shell: shapes, parts, inspector, view, project folder, keys.
// Parts are recipes in the Doc; meshes come from the worker; tools are steps in a recipe.
import workerSrc from 'virtual:worker-src';
import cadSrc from 'virtual:cad-src';
import tools from 'virtual:tools-ui';
import { stlBytes, sizeText } from './decimate.js';
import { Viewer } from './viewer.js';
import * as ui from './ui.js';
import { Vector3, Box3, Quaternion, Euler, Matrix4 } from 'three';
import { Doc, shapeKey, formKey, IDENT, matrix } from './doc.js';
import { Project, packProject, unpackProject, PROJECT_EXT } from './project.js';
import * as folders from './folders.js';
import { browserHome } from './idbfs.js';
import { describe, weld, volume as meshVolume } from './meshcheck.js';
import { trace } from './trace.js';

const { h, button, seg, card, kv, errorLine, ask, mm, count } = ui;
const SHAPES = {
  box: { x: 20, y: 20, z: 20 },
  cylinder: { d: 20, h: 20, sides: 64 },
  cone: { d1: 20, d2: 0, h: 20, sides: 64 },
  sphere: { d: 20, sides: 64 },
  torus: { d: 20, tube: 4, sides: 64, tubeSides: 24 },
  wedge: { x: 20, y: 20, z: 20 },
  tube: { d: 20, wall: 2, h: 20, sides: 64 },
  fillet: { r: 5, length: 20, sides: 64 },
};
const LABELS = { x: 'Width', y: 'Depth', z: 'Height', h: 'Height', d: 'Diameter', d1: 'Bottom diameter', d2: 'Top diameter',
  tube: 'Tube', wall: 'Wall', sides: 'Facets', tubeSides: 'Tube facets', r: 'Radius', length: 'Length' };
const MOVE_STEPS = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 1, 5];
let moveStep = 1;   // mm per arrow press, drag snap and size handle; picked bottom left of the view
let plate = { w: 600, d: 600, every: 1 };   // the grid, for this session
// Part colors are the model's own content (filament colors), not interface color. The panel
// shows a color only by its name; the list it opens names every color. A part with no color
// set is Gray, the first-listed default, and the list says so.
const DEFAULT_COLOR = '#9c9c9c';
const COLORS = [
  ['White', '#f2f2f2'], ['Light gray', '#c4c4c4'], ['Gray', DEFAULT_COLOR], ['Dark gray', '#4a4a4a'], ['Black', '#1e1e1e'],
  ['Red', '#d32f2f'], ['Orange', '#f57c00'], ['Yellow', '#fbc02d'], ['Gold', '#c9a227'], ['Lime', '#9ccc65'], ['Green', '#388e3c'],
  ['Olive', '#827717'], ['Teal', '#00897b'], ['Cyan', '#00acc1'], ['Blue', '#1e88e5'], ['Navy', '#283593'], ['Purple', '#7b1fa2'],
  ['Magenta', '#c2185b'], ['Pink', '#f48fb1'], ['Brown', '#6d4c41'], ['Tan', '#c8a27a'], ['Silver', '#a8b0b8'], ['Copper', '#b87333'],
];
const OLD_GRAY = '#8a8a8a';   // Gray before 2026-10-15; projects may hold it
const colorName = hex => {
  const x = (hex || '').toLowerCase();
  if (!x || x === OLD_GRAY) return 'Gray';
  return (COLORS.find(c => c[1] === x) || [x.toUpperCase()])[0];
};

// ---- flyouts: lists that open to the left of the panel, over the view ---------------------------
// The panel never grows or jumps when one opens. Each lines up with what opened it and stays
// inside the window; a long one scrolls inside itself.
function flyout(cls) {
  const el = h('div', { class: 'card flyout ' + cls, style: 'display:none', role: 'dialog' });
  document.body.append(el);
  return el;
}
function placeFlyout(el, anchor) {
  const side = aside.getBoundingClientRect();
  el.style.display = '';
  // the color list goes beside the parts list when that is open, never under it
  const edge = el !== partFly && partFlyOpen ? partFly.getBoundingClientRect().left : side.left;
  el.style.right = Math.max(4, innerWidth - edge + 6) + 'px';
  // with no anchor: under the floating header, so its buttons stay reachable
  const want = anchor ? anchor.getBoundingClientRect().top - 6 : Math.max(side.top + 4, header.getBoundingClientRect().bottom + 6);
  const floor = anchor ? 6 : want;
  el.style.maxHeight = (innerHeight - floor - 6) + 'px';
  const hgt = el.offsetHeight;
  el.style.top = Math.max(floor, Math.min(want, innerHeight - hgt - 6)) + 'px';
}

// the color list: opened by the color's name in the panel, closed by a pick, Esc, a click elsewhere
const colorFly = flyout('colorfly');
let colorFor = null;   // {anchor, current, onpick} while open
function openColors(anchor, current, onpick) {
  colorFor = { anchor, current, onpick };
  const cur = (current || '').toLowerCase() === OLD_GRAY ? DEFAULT_COLOR : (current || DEFAULT_COLOR).toLowerCase();
  const pick = hex => { closeColors(); onpick(hex === DEFAULT_COLOR ? '' : hex); };
  const list = h('div', { class: 'clist', role: 'listbox', 'aria-label': 'Colors' }, ...COLORS.map(([name, hex]) => {
    const on = hex === cur;
    return h('button', { type: 'button', class: 'citem' + (on ? ' on' : ''), role: 'option', 'aria-selected': String(on), onclick: () => pick(hex) },
      h('span', { class: 'ctick' }, on ? '✓' : ''), h('span', { class: 'chip', style: `background:${hex}` }), name + (hex === DEFAULT_COLOR ? ' (default)' : ''));
  }));
  const hexIn = h('input', { type: 'text', class: 'hex-in', value: COLORS.some(c => c[1] === cur) ? '' : cur, placeholder: '#rrggbb', spellcheck: 'false', 'aria-label': 'Hex color' });
  hexIn.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') hexIn.blur(); if (e.key === 'Escape') closeColors(true); });
  hexIn.addEventListener('change', () => { const v = hexIn.value.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) pick((v[0] === '#' ? v : '#' + v).toLowerCase()); else hexIn.classList.add('bad'); });
  colorFly.replaceChildren(h('h3', {}, 'Color', h('span', { class: 'grow' }), button('Close', () => closeColors(true), { small: true })), list, h('div', { class: 'hexrow' }, 'Hex', hexIn));
  placeFlyout(colorFly, anchor);
  (list.querySelector('.on') || list.firstChild).focus({ preventScroll: true });
  list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}
function closeColors(refocus = false) {
  if (!colorFor) return;
  const a = colorFor.anchor;
  colorFor = null;
  colorFly.style.display = 'none';
  if (refocus && a.isConnected) a.focus();
}
document.addEventListener('pointerdown', e => { if (colorFor && !colorFly.contains(e.target) && !colorFor.anchor.contains(e.target)) closeColors(); });
// up and down walk the list
for (const fly of [colorFly]) fly.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.stopPropagation(); closeColors(true); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = [...fly.querySelectorAll('.citem')], i = items.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault(); e.stopPropagation();
  items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
});

// a hex box selects all on focus, so typing replaces the old value (as the number boxes do)
document.addEventListener('focusin', e => { if (e.target.matches?.('.hex-in')) setTimeout(() => e.target.select(), 0); });

/** Color row: the label, and one button with the color's name that opens the list. */
function colorPicker(current, onpick) {
  const b = h('button', { type: 'button', class: 'btn colorbtn', 'aria-haspopup': 'listbox', title: 'Pick a color' }, colorName(current));
  b.addEventListener('click', () => { if (colorFor?.anchor === b) closeColors(); else openColors(b, current, onpick); });
  // the panel redraws after a pick: an open list moves to the new button
  if (colorFor) requestAnimationFrame(() => { if (colorFor && b.isConnected) { colorFor.anchor = b; placeFlyout(colorFly, b); } });
  return h('div', { class: 'field' }, h('label', {}, 'Color'), b);
}

// ---- workers ------------------------------------------------------------------------------
// "io" reads, writes and checks files; "kern" builds part meshes and keeps their cache;
// "cad" reads STEP, started only when needed (its reader is large).
class Pool {
  constructor() {
    this.url = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
    this.jobs = new Map();
    this.seq = 0;
    this.w = { io: this.spawn('io'), kern: this.spawn('kern') };
  }
  spawn(kind) {
    if (kind === 'cad') this.cadUrl ||= URL.createObjectURL(new Blob([cadSrc], { type: 'text/javascript' }));
    const w = new Worker(kind === 'cad' ? this.cadUrl : this.url);
    w.onmessage = e => this.msg(e.data);
    w.onerror = e => {
      e.preventDefault();
      this.failAll(kind, new Error(`Internal error in the worker: ${e.message || 'it stopped'}`));
      this.w[kind] = this.spawn(kind);
      if (kind === 'kern') sentBlobs.clear();
    };
    return w;
  }
  failAll(kind, err) { for (const [id, j] of this.jobs) if (j.kind === kind) { this.jobs.delete(id); j.rej(err); } busyCheck(); }
  call(kind, msg, transfer = [], onProgress = null) {
    const id = ++this.seq;
    const t0 = performance.now();
    if (!this.w[kind]) this.w[kind] = this.spawn(kind);
    // handing meshes over is housekeeping: no busy bar for it, and it never counts as heavy work
    const chore = msg.type === 'blob' || msg.type === 'seed' || msg.type === 'edges' || msg.type === 'bvh';
    const p = new Promise((res, rej) => {
      this.jobs.set(id, { kind, res, rej, onProgress, chore }); busyCheck();
      this.w[kind].postMessage({ ...msg, id }, transfer);
    });
    // A browser keeps a worker's peak memory (and the solid engine's never shrinks), so a
    // worker that has done heavy work is replaced once idle. The new modeller is not refilled
    // up front (with big models that refill was itself heavy work, so it restarted again and
    // again, twice a second); meshes go over again only when a build needs them.
    p.finally(() => { if (!chore && (kind !== 'kern' || performance.now() - t0 > 3000)) this.recycleSoon(kind); }).catch(() => {});
    return p;
  }
  recycleSoon(kind) {
    clearTimeout(this.timers?.[kind]);
    (this.timers ||= {})[kind] = setTimeout(() => {
      if ([...this.jobs.values()].some(j => j.kind === kind)) { this.recycleSoon(kind); return; }
      this.w[kind].terminate();
      if (kind === 'cad') { this.w.cad = null; return; }   // started again when next needed
      this.w[kind] = this.spawn(kind);
      if (kind === 'kern') sentBlobs.clear();
    }, 1500);
  }
  msg(d) {
    const j = this.jobs.get(d.id);
    if (!j) return;
    if (d.type === 'progress') { j.onProgress?.(d.frac, d.text); return; }
    this.jobs.delete(d.id); busyCheck();
    if (d.type === 'done') j.res(d); else j.rej(Object.assign(new Error(d.message), { user: d.user }));
  }
}
const pool = new Pool();
const sentBlobs = new Set();

// ---- state --------------------------------------------------------------------------------
let doc = new Doc();
let project = null;
let projectAsked = false;
const meshes = new Map();      // part id -> {key, tris, volume}
let sel = [];                  // selected top-level part ids
let step = null;               // a tool step being set up: {tool, params, partId, face, previewKey}
let clipboard = null;
let lastDup = null;
let fmt = 'stl';
let fileName = null;   // the .wt3d this doc came from or was last saved to

// ---- layout -------------------------------------------------------------------------------
const app = document.getElementById('app');
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'];
const importInput = h('input', { type: 'file', accept: ['.stl', '.obj', '.3mf', '.step', '.stp', '.wt3d', ...IMAGE_EXT].join(','), multiple: true, style: 'display:none' });
const projInput = h('input', { type: 'file', accept: '.wt3d', style: 'display:none' });
// the project's name and whether it is saved: words only, nothing to click (File holds the actions)
// (the project's name lives in the window title; there is no name box in the view)
const projBtn = button('Save as project', () => pickProjectFolder(), { small: true });
let lastProject = null;   // the last project's name, offered under File while it is not open
// grid: width, depth and line spacing, in a small panel under its button
const gridPop = h('div', { class: 'card pop', style: 'display:none' });
function showGridPop(on) {
  gridPop.style.display = on ? '' : 'none';
  if (!on) return;
  const set = (k, v) => { plate = { ...plate, [k]: v }; viewer.setPlate(plate); status(`Grid ${+plate.w.toFixed(2)} x ${+plate.d.toFixed(2)} mm, a line every ${+plate.every.toFixed(2)} mm.`); };
  gridPop.replaceChildren(h('h3', {}, 'Grid'),
    ui.numfield('Width', plate.w, 'mm', v => set('w', v), { min: 0.1, step: 10, lazy: true, digits: 1 }),
    ui.numfield('Depth', plate.d, 'mm', v => set('d', v), { min: 0.1, step: 10, lazy: true, digits: 1 }),
    ui.numfield('Line every', plate.every, 'mm', v => set('every', v), { min: 0.01, step: 1, lazy: true, digits: 2 }),
    h('div', { class: 'note' }, 'Kept for this session.'),
    h('div', { class: 'row' }, button('Done', () => showGridPop(false), { small: true })));
}
// ---- tooltips and color schemes (remembered on this computer, with the home folder) ------------
// Tooltips: any control's title becomes its tip, shown only when switched on; a greyed control's
// tip says why it is off. Schemes: one accent family each, so nothing rests on telling hues apart.
let tipsOn = false, scheme = 'green';
const SCHEMES = [
  ['green', 'Green', 'The default: greens and grays'],
  ['blue', 'Blue', 'Blues and grays, for red-green color blindness'],
  ['mono', 'High contrast', 'White and grays only, the most contrast'],
];
const tipBox = h('div', { class: 'tipbox', role: 'tooltip' });
document.body.append(tipBox);
let tipTimer = 0, tipFor = null;
document.addEventListener('pointerover', e => {
  const el = e.target.closest?.('[title], [data-tip]');
  if (el?.title) { el.dataset.tip ||= el.title; el.removeAttribute('title'); }   // never the browser's own
  if (el === tipFor) return;
  tipFor = el; clearTimeout(tipTimer); tipBox.style.display = 'none';
  if (!el || !tipsOn || !el.dataset.tip) return;
  tipTimer = setTimeout(() => {
    tipBox.textContent = el.dataset.tip;
    tipBox.style.display = 'block';
    const r = el.getBoundingClientRect(), w = tipBox.offsetWidth, hh = tipBox.offsetHeight;
    tipBox.style.left = Math.max(4, Math.min(innerWidth - w - 4, r.left)) + 'px';
    tipBox.style.top = (r.bottom + 6 + hh > innerHeight ? r.top - hh - 6 : r.bottom + 6) + 'px';
  }, 400);
});
document.addEventListener('pointerdown', () => { clearTimeout(tipTimer); tipBox.style.display = 'none'; });
function setTips(on) { tipsOn = on; if (!on) tipBox.style.display = 'none'; folders.remember('tips', on).catch(() => {}); status(on ? 'Tooltips on.' : 'Tooltips off.'); }
function setScheme(id, quiet = false) {
  scheme = id;
  document.documentElement.dataset.scheme = id;
  viewer?.setScheme?.(id);
  // picking a built-in scheme from the menu drops the built theme
  if (!quiet && customTheme) { clearTheme(); folders.remember('theme', null).catch(() => {}); }
  else if (customTheme) applyTheme(customTheme.colors);   // a remembered scheme arriving late keeps the theme on top
  if (!quiet) { folders.remember('scheme', id).catch(() => {}); status(`Color scheme: ${SCHEMES.find(s => s[0] === id)[1]}.`); }
}
folders.recall('tips').then(v => { if (v) tipsOn = true; });
folders.recall('scheme').then(v => { if (SCHEMES.some(s => s[0] === v)) setScheme(v, true); });

// ---- menu bar: File, Edit, View ---------------------------------------------------------------
// items: [label, action, {key, tip, on: () => checked, off: () => disabled}] or '-' for a rule.
// A ticked item shows a tick mark, so the state never rests on color.
let openMenu = null;
function closeMenus() { if (openMenu) { openMenu.classList.remove('open'); openMenu = null; } }
function menu(title, items) {
  const list = h('div', { class: 'mlist', role: 'menu' });
  const head = h('button', { type: 'button', class: 'mtitle', 'aria-haspopup': 'true' }, title);
  const el = h('div', { class: 'menu' }, head, list);
  const fill = () => list.replaceChildren(...items.map(it => {
    if (it === '-') return h('div', { class: 'mrule' });
    const [lab, act, o = {}] = it;
    const label = typeof lab === 'function' ? lab() : lab;
    const b = h('button', { type: 'button', class: 'mitem', role: o.on ? 'menuitemcheckbox' : 'menuitem', title: o.tip || '' },
      h('span', { class: 'mtick' }, o.on ? (o.on() ? '\u2713' : '') : ''), h('span', { class: 'mlabel' }, label), h('span', { class: 'mkey' }, o.key || ''));
    if (o.on) b.setAttribute('aria-checked', String(!!o.on()));
    // greyed, never removed: why it is off goes in its tip (shown when tooltips are on)
    const why = o.off?.();
    b.disabled = !!why;
    if (why) b.dataset.tip = typeof why === 'string' ? why : (o.why || 'Not available with this selection');
    b.onclick = () => { closeMenus(); act(); };
    return b;
  }));
  const focusItem = d => { const items = [...list.querySelectorAll('.mitem:not(:disabled)')], i = items.indexOf(document.activeElement); items[i < 0 ? (d > 0 ? 0 : items.length - 1) : (i + d + items.length) % items.length]?.focus(); };
  head.onclick = e => {
    e.stopPropagation();
    const was = openMenu === el;
    closeMenus();
    if (!was) { fill(); el.classList.add('open'); openMenu = el; if (e.detail === 0) focusItem(1); }   // opened from the keyboard: into the list
  };
  head.onmouseenter = () => { if (openMenu && openMenu !== el) { closeMenus(); fill(); el.classList.add('open'); openMenu = el; } };
  // keyboard: down opens and walks the list, up walks back, left and right go to the next menu, Esc closes
  el.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      if (openMenu !== el) { closeMenus(); fill(); el.classList.add('open'); openMenu = el; }
      focusItem(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Escape' && openMenu === el) { e.preventDefault(); e.stopPropagation(); closeMenus(); head.focus(); }
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && openMenu === el) {
      e.preventDefault(); e.stopPropagation();
      const heads = [...document.querySelectorAll('.menubar .mtitle')], i = heads.indexOf(head);
      const n = heads[(i + (e.key === 'ArrowRight' ? 1 : heads.length - 1)) % heads.length];
      closeMenus(); n.focus(); n.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    }
  });
  return el;
}
document.addEventListener('pointerdown', e => { if (openMenu && !openMenu.contains(e.target)) closeMenus(); });
const none = () => !sel.length && 'Select a part first';
const menubar = h('nav', { class: 'menubar' },
  menu('File', [
    ['New', () => newProject(), { tip: 'Start an empty project' }],
    ['Open...', () => openProject(), { key: 'Ctrl+O', tip: 'Open a project folder, or a .wt3d project file' }],
    [() => lastProject ? `Reopen ${lastProject}` : 'Reopen last project', () => reopenLast(), { off: () => (!lastProject || project?.name === lastProject) && (lastProject ? 'It is open now' : 'No project opened before'), tip: 'Open the project you had open last time' }],
    ['Save as project...', () => pickProjectFolder(), { off: () => !!project && 'Already saving to a project folder', tip: 'Keep every step in a named project folder as you work' }],
    ['Rename project...', () => renameProject(), { off: () => !project && 'Save as a project first' }],
    ['Save file...', () => saveProjectFile(), { tip: 'The whole project as one .wt3d file: parts stay editable, meshes stay exact' }],
    '-',
    ['Import...', () => importInput.click(), { tip: 'Add an STL, 3MF, OBJ or STEP as a part, the parts of a .wt3d project, or a picture to trace or lay on the plate' }],
    ['Export...', () => exportDialog(), { key: 'Ctrl+E', tip: 'Write the model, or the selected parts, as STL, 3MF or OBJ' }],
  ]),
  menu('Edit', [
    ['Undo', () => undo(), { key: 'Ctrl+Z', off: () => !doc.at && 'Nothing to undo' }],
    ['Redo', () => redo(), { key: 'Ctrl+Y', off: () => doc.at >= doc.history.length && 'Nothing to redo' }],
    '-',
    ['Copy', () => copySel(), { key: 'Ctrl+C', off: none }],
    ['Paste', () => paste(), { key: 'Ctrl+V', off: () => !clipboard && 'Copy a part first' }],
    ['Duplicate', () => duplicateSel(), { key: 'Ctrl+D', off: none }],
    ['Delete', () => deleteSel(), { key: 'Del', off: none }],
    ['Select all', () => setSel(doc.parts.filter(p => !p.hidden).map(p => p.id)), { key: 'Ctrl+A' }],
    '-',
    ['Group', () => groupSel(), { key: 'Ctrl+G', off: () => sel.length < 2 && 'Select two or more parts' }],
    ['Intersect', () => groupSel('intersect'), { key: 'Ctrl+I', off: () => sel.length < 2 && 'Select two or more parts', tip: 'Keep only where the selected parts overlap' }],
    ['Ungroup', () => ungroupSel(), { key: 'Ctrl+Shift+G', off: () => !sel.some(id => doc.top(id)?.kind === 'group') && 'Select a group: this is a single piece' }],
    '-',
    ['Mirror X', () => mirrorSel(0), { key: 'M', off: none }],
    ['Mirror Y', () => mirrorSel(1), { key: 'Shift+M', off: none }],
    ['Mirror Z', () => mirrorSel(2), { key: 'Alt+M', off: none }],
    ['Drop to plate', () => dropToPlate(), { key: 'D', off: none }],
    ['Lock / unlock', () => toggleLock(), { key: 'Ctrl+L', off: none }],
    ['Hide', () => hideSel(), { key: 'Ctrl+H', off: none }],
    ['Show all', () => showAll(), { key: 'Ctrl+Shift+H' }],
  ]),
  menu('View', [
    ['Show faults', () => setFaults(!faultsOn), { on: () => faultsOn, tip: 'Mark where parts are not closed: open, over-shared and wrongly turned edges, in yellow' }],
    ['Show grid', () => { gridOn = !gridOn; viewer.setGrid(gridOn); }, { on: () => gridOn }],
    ['Grid...', () => showGridPop(true), { tip: 'Grid size and line spacing' }],
    '-',
    ['Background picture...', () => showBackdropPanel(), { tip: 'A picture behind the model, tilted and scaled to line up with it' }],
    ['Plate picture...', () => showPlatePicPanel(), { tip: 'A picture lying on the plate under the grid, to model over' }],
    '-',
    ['Key bindings', () => setKeysTab(!keysTab), { on: () => keysTab, tip: 'A Keys tab beside Parts listing every mouse move and key' }],
    ['Tooltips', () => setTips(!tipsOn), { on: () => tipsOn, tip: 'Show what a control does when the pointer rests on it' }],
    '-',
    ...SCHEMES.map(([id, label, tip]) => [label, () => setScheme(id), { on: () => scheme === id && !customTheme, tip }]),
    ['Theme builder...', () => showThemeBuilder(), { on: () => !!customTheme, tip: 'Make your own colors for the app and the view, see them live, save and load them as files' }],
  ]),
);
const header = h('header', {},
  menubar,
  h('span', { class: 'popwrap' }, gridPop),
  h('span', { class: 'spacer' }), projBtn, importInput, projInput);

const shapeGrid = h('div', { class: 'shapes' }, ...Object.keys(SHAPES).map(k => {
  const b = button(k[0].toUpperCase() + k.slice(1), () => addShape(k), { title: `Add a ${k} on the plate` });
  return b;
}));
const stepCard = h('div');
const inspector = h('div', { class: 'inspector', style: 'display:none' });
/** The Keys tab: every mouse move and key the app answers to. */
function keysCard() {
  const rows = [
    ['Mouse', [['Right drag', 'turn the view'], ['Ctrl + left drag', 'turn the view'], ['Middle drag', 'pan'], ['Wheel', 'zoom to the pointer'],
      ['Left drag on a part', 'move it'], ['Alt + drag', 'move a copy'], ['Left drag on empty space', 'select by box'], ['Shift + click', 'add to the selection']]],
    ['View', [['F', 'fit the selection, or all'], ['+  /  -', 'zoom'], ['Shift + F', 'slide along a face you click'], ['R (hold)', 'show the turn rings']]],
    ['Parts', [['Arrows', 'move one step (Shift: ten)'], ['Ctrl + Up / Down', 'raise / lower'], ['D', 'drop to the plate'], ['H  /  S', 'hole / solid'],
      ['M', 'mirror X (Shift: Y, Alt: Z)'], ['Delete', 'delete'], ['Esc', 'deselect, or close'], ['F2', 'rename (in the parts list)']]],
    ['Edit', [['Ctrl + Z', 'undo'], ['Ctrl + Y', 'redo'], ['Ctrl + A', 'select all'], ['Ctrl + C / X / V', 'copy / cut / paste'], ['Ctrl + D', 'duplicate'],
      ['Ctrl + G', 'group'], ['Ctrl + Shift + G', 'ungroup'], ['Ctrl + I', 'intersect'], ['Ctrl + L', 'lock'], ['Ctrl + H', 'hide'], ['Ctrl + Shift + H', 'show all']]],
    ['File', [['Ctrl + O', 'open'], ['Ctrl + E', 'export'], ['Ctrl + Shift + E', 'export again, to a place you pick']]],
  ];
  return card('Keys', ...rows.map(([head, list]) => h('div', {}, h('div', { class: 'sub' }, head),
    h('div', { class: 'kv keys' }, list.flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)])))));
}

// one panel on the right, full height, tabs at the very top, each tab scrolls:
// Shape tools (the shapes to add, then the selected part's options, so a new part is edited
// without changing tab) and Parts (the selected part's options and the tool step; the parts
// list opens beside the panel, to its left, over the view). The one options element moves to
// whichever tab is showing.
const shapeOpts = h('div', { class: 'card shapeopts', style: 'display:none' });
const partOpts = h('div', { class: 'card shapeopts', style: 'display:none' });
const partsHint = h('div', { class: 'card' }, h('p', {}, 'Select a part in the view or in the list.'),
  h('div', { class: 'row' }, button('Parts list', () => openPartList(true), { title: 'Open the list of parts beside the panel' })));
const panes = { shapes: h('div', { class: 'pane' }, card('Shapes', shapeGrid), shapeOpts),
  parts: h('div', { class: 'pane', style: 'display:none' }, partsHint, partOpts),
  keys: h('div', { class: 'pane', style: 'display:none' }, keysCard()) };
let curTab = 'shapes';
const tabs = seg([['shapes', 'Shape tools'], ['parts', 'Parts'], ['keys', 'Keys']], 'shapes', v => showTab(v));
const keysTabBtn = tabs.querySelector('[data-v="keys"]');
let keysTab = false;   // View > Key bindings shows the third tab
keysTabBtn.style.display = 'none';
function setKeysTab(on) {
  keysTab = on;
  keysTabBtn.style.display = on ? '' : 'none';
  folders.remember('keystab', on).catch(() => {});
  if (on) showTab('keys'); else if (curTab === 'keys') showTab('shapes');
}
folders.recall('keystab').then(v => { if (v) { keysTab = true; keysTabBtn.style.display = ''; } });
tabs.classList.add('tabs');
tabs.addEventListener('click', e => {
  if (app.classList.contains('folded')) fold.click();
  // Parts again while on Parts: the list opens (or closes)
  if (e.target.closest('button')?.dataset.v === 'parts' && curTab === 'parts' && !tabJustSet) openPartList(!partFlyOpen);
  tabJustSet = false;
});
let tabJustSet = false;
function showTab(v) {
  if (v === curTab) return;
  curTab = v;
  tabJustSet = true;
  tabs.set(v);
  for (const [k, el] of Object.entries(panes)) el.style.display = k === v ? '' : 'none';
  openPartList(v === 'parts');
  renderParts();
  renderInspector();
}

// the parts list: beside the panel, open while the Parts tab is (its Close shuts it; the tab
// or the Parts list button opens it again). Picking in the view marks the row and scrolls to it.
const partFly = flyout('partfly');
const partList = h('div', { class: 'parts', role: 'listbox', 'aria-label': 'Parts', 'aria-multiselectable': 'true' });
let partFlyOpen = false;
function openPartList(on) {
  partFlyOpen = on;
  partFly.style.display = on ? '' : 'none';
  if (on) { renderParts(); placeFlyout(partFly, null); }
  if (colorFor) placeFlyout(colorFly, colorFor.anchor);
}
partFly.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !e.target.closest('input')) { e.stopPropagation(); openPartList(false); tabs.querySelector('[data-v="parts"]')?.focus(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = [...partList.querySelectorAll('.prow')], i = rows.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault(); e.stopPropagation();
  rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
});
window.addEventListener('resize', () => { if (partFlyOpen) placeFlyout(partFly, null); if (colorFor) placeFlyout(colorFly, colorFor.anchor); });
// the arrow rolls the panel up to its tab row, and the view takes the width
const fold = h('button', { class: 'fold', title: 'Roll the panel up' }, '▴');
fold.onclick = () => {
  const up = app.classList.toggle('folded');
  fold.textContent = up ? '▾' : '▴';
  fold.title = up ? 'Roll the panel down' : 'Roll the panel up';
};
const aside = h('aside', {}, h('div', { class: 'tabrow' }, tabs, fold), panes.parts, panes.shapes, panes.keys);

const view = h('div', { id: 'view' });
const dropHint = h('div', { class: 'drop' }, h('b', {}, 'Add a shape, or drop an STL, 3MF, OBJ, STEP or a picture here'), 'Right drag orbits, middle drag pans, wheel zooms. Nothing leaves this computer.');
// the cut: a position in mm along X, Y or Z, in move steps like a part's moves; Cut here splits
let cutAxis = null, cutAt = 0;
const cutBox = h('span', { class: 'cut' });   // the slider, made for the axis's extent when an axis is picked
const cutBtn = button('Cut here', () => cutParts(), { small: true, title: 'Split the selected parts at this cut: two closed parts each' });
cutBtn.style.display = 'none';
const snapCut = v => +(Math.round(v / moveStep) * moveStep).toFixed(4);
function setCut(axis) {
  cutAxis = axis;
  cutBtn.style.display = axis ? '' : 'none';
  if (!axis) { cutBox.replaceChildren(); viewer.setClip(null, 0); return; }
  const r = viewer.cutRange(axis) || [-50, 50];
  const lo = Math.floor(r[0] / moveStep) * moveStep, hi = Math.ceil(r[1] / moveStep) * moveStep;
  cutAt = snapCut((r[0] + r[1]) / 2);
  const sl = ui.slider('at', cutAt, 'mm', { min: +lo.toFixed(4), max: +hi.toFixed(4), step: moveStep, digits: 2 }, v => { cutAt = snapCut(v); sl.set(cutAt); viewer.setClip(cutAxis, cutAt); });
  cutBox.replaceChildren(sl);
  viewer.setClip(axis, cutAt);
}
const cutSeg = seg([['off', 'Off'], ['x', 'X'], ['y', 'Y'], ['z', 'Z']], 'off', v => setCut(v === 'off' ? null : v));

/** Cut here: each selected part (or the only part) split at the cut into two closed parts, one step. */
async function cutParts() {
  const ids = (sel.length ? sel : doc.parts.length === 1 ? [doc.parts[0].id] : []).filter(id => !doc.top(id)?.locked);
  if (!ids.length) { status('Select the parts to cut.'); return; }
  const axis = { x: 0, y: 1, z: 2 }[cutAxis];
  status('Cutting...');
  const made = [];
  try {
    await sendBlobs();
    for (const id of ids) {
      const p = doc.top(id);
      const r = await pool.call('kern', { type: 'split', part: p, axis, at: cutAt });
      if (r.a && r.b) made.push({ p, halves: [r.a, r.b] });
    }
  } catch (err) { status(shortErr(err.message), true); return; }
  if (!made.length) { status('The cut does not pass through the selected parts.'); return; }
  const newIds = [];
  doc.commit(`Cut ${made.length > 1 ? made.length + ' parts' : made[0].p.name} at ${'XYZ'[axis]} ${mm(cutAt)} mm`, parts => {
    for (const { p, halves } of made) {
      const i = parts.findIndex(q => q.id === p.id);
      const halfParts = halves.map((t, k) => {
        // each half in its own frame: middle in X and Y, bottom at 0, placed back where it was
        const b = localBounds(t), c = [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, b.lo[2]];
        for (let q = 0; q < t.length; q += 3) { t[q] -= c[0]; t[q + 1] -= c[1]; t[q + 2] -= c[2]; }
        const id = doc.newId();
        newIds.push(id);
        const half = { id, name: `${p.name} ${k ? 'B' : 'A'}`, kind: 'mesh', blob: doc.addBlob(t), xform: { pos: c.map(v => +v.toFixed(6)), rot: [0, 0, 0], scale: [1, 1, 1] }, hole: !!p.hole, ops: [], ...(p.color ? { color: p.color } : {}) };
        ready.set(shapeKey(half), { tris: t, volume: Math.abs(meshVolume(t)) });   // built already: shows at once
        return half;
      });
      parts.splice(i, 1, ...halfParts);
    }
  });
  setSel(newIds);
  status(`Cut at ${'XYZ'[axis]} ${mm(cutAt)} mm: ${made.map(m => m.p.name).join(', ')} split in two, each closed.`);
}
let faultsOn = false, gridOn = true;

// ---- the 0.05 mm lattice --------------------------------------------------------------------------
// Every part's low corner (least X, least Y, bottom Z) sits on a 0.05 mm lattice, so parts that
// meet really meet. Moves go in whole steps and keep it there; anything that lands off it
// (rotate, scale, mirror, mid align, a typed position, an old project's first move) is moved
// by under 0.025 mm to the nearest point.
const LATTICE = 0.05;
const onLattice = v => Math.round(v / LATTICE) * LATTICE;
function cornerFix(p, xform = p.xform) {
  const b = worldBox(p, xform);
  if (!b) return [0, 0, 0];
  return [b.min.x, b.min.y, b.min.z].map(v => { const d = onLattice(v) - v; return Math.abs(d) < 1e-7 ? 0 : d; });
}
function snapped(p, xform) {
  const f = cornerFix(p, xform);
  return { ...xform, pos: xform.pos.map((v, i) => +(v + f[i]).toFixed(6)) };
}

let rotateOn = false, ringsHeld = false;   // turn rings: the Rotate box, or R held down
function setFaults(on) {
  faultsOn = on;
  viewer.setFaults(on);
  if (!on) { status('Faults hidden.'); return; }
  const found = [];
  for (const [id, o] of viewer.objs) {
    const f = o.faultCount;
    if (!f || !f.segs.length) continue;
    const bits = [f.open && `${f.open} open`, f.over && `${f.over} over-shared`, f.flipped && `${f.flipped} turned`].filter(Boolean);
    found.push(`${doc.top(id)?.name || 'a part'}: ${bits.join(', ')} edges`);
  }
  status(found.length ? `Faults in yellow. ${found.join('; ')}.` : 'No faults: every part is closed.');
}
// view icons: a cube with the face you will look at filled; Fit is four corners
const cube = (face, mirror) => `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"${mirror ? ' style="transform:scaleX(-1)"' : ''}>`
  + `<path d="M12 3 21 7.5 12 12 3 7.5Z" ${face === 'top' ? 'fill="currentColor"' : ''}/>`
  + `<path d="M3 7.5 12 12V21L3 16.5Z" ${face === 'front' ? 'fill="currentColor"' : ''}/>`
  + `<path d="M21 7.5 12 12V21L21 16.5Z" ${face === 'right' ? 'fill="currentColor"' : ''}/></svg>`;
const VIEW_ICONS = {
  iso: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>',
  top: cube('top'),
  // front: seen face on, the top just showing above it
  front: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M4 9 7 5H17L20 9Z"/><path d="M4 9H20V20H4Z" fill="currentColor"/></svg>',
  left: cube('front'), right: cube('right'),
  // bottom: the top icon turned over
  bottom: cube('top').replace('<svg ', '<svg style="transform:scaleY(-1)" '),
};
// beside Fit: the plate back in the middle of the view; beside Top: parts lying wholly off the
// plate brought back onto it
const PLATE_ICON = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M12 6 21 10.5 12 15 3 10.5Z"/><path d="M12 9V12M10.5 10.5H13.5" stroke-width="1.6"/><path d="M12 15V19M9 17.5 12 19 15 17.5" /></svg>';
const BRING_ICON = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="8" y="8" width="8" height="8" rx="1"/><path d="M2 12H6M4.5 10.5 6 12 4.5 13.5M22 12H18M19.5 10.5 18 12 19.5 13.5M12 2V6M10.5 4.5 12 6 13.5 4.5M12 22V18M10.5 19.5 12 18 13.5 19.5"/></svg>';
const views = h('div', { class: 'overlay tl' },
  ...[['iso', 'Fit (F)'], ['top', 'Top'], ['front', 'Front'], ['left', 'Left'], ['right', 'Right'], ['bottom', 'Bottom']].map(([k, l]) => {
    const b = h('button', { type: 'button', class: 'viewbtn', title: l, 'aria-label': l, onclick: () => viewer.view(k, k === 'iso' ? sel : []) });
    b.innerHTML = VIEW_ICONS[k];
    return b;
  }),
  (() => { const b = h('button', { type: 'button', class: 'viewbtn side r1', title: 'Plate to the middle: the whole plate in the middle of the view', 'aria-label': 'Plate to the middle', onclick: () => { viewer.viewPlate(); status('The plate is back in the middle of the view.'); } }); b.innerHTML = PLATE_ICON; return b; })(),
  (() => { const b = h('button', { type: 'button', class: 'viewbtn side r2', title: 'Bring in: parts lying wholly off the plate are moved back onto it', 'aria-label': 'Bring parts onto the plate', onclick: () => bringIn() }); b.innerHTML = BRING_ICON; return b; })());

/** Parts wholly off the plate (beside it, or wholly under it) come back: each just inside the
 *  nearest edge, 5 mm in, or centred on an axis where it is wider than the plate; one undo step.
 *  Parts partly on the plate stay where they are. */
function bringIn() {
  const hw = plate.w / 2, hd = plate.d / 2, M = 5;
  const moves = new Map();
  for (const p of doc.parts) {
    if (p.hidden || p.locked) continue;
    const b = worldBox(p);
    if (!b) continue;
    const offXY = b.max.x < -hw || b.min.x > hw || b.max.y < -hd || b.min.y > hd, under = b.max.z < 0;
    if (!offXY && !under) continue;
    const d = [0, 0, under ? -b.min.z : 0];
    if (offXY) [[0, 'x', hw], [1, 'y', hd]].forEach(([i, a, half]) => {
      const lo = b.min[a], hi = b.max[a], w = hi - lo;
      if (w > 2 * (half - M)) d[i] = -(lo + hi) / 2;
      else if (lo < -half + M) d[i] = -half + M - lo;
      else if (hi > half - M) d[i] = half - M - hi;
    });
    moves.set(p.id, d);
  }
  if (!moves.size) { status('Every shown part is at least partly on the plate: nothing to bring in.'); return; }
  const names = [...moves.keys()].map(id => doc.top(id).name);
  doc.update([...moves.keys()], `Bring ${moves.size > 1 ? moves.size + ' parts' : names[0]} onto the plate`, p => {
    const d = moves.get(p.id);
    p.xform.pos = p.xform.pos.map((v, i) => +(v + d[i]).toFixed(6));
    p.xform = snapped(p, p.xform);
  });
  status(`Brought onto the plate: ${names.join(', ')}.`);
}
cutSeg.title = 'Cut the view open along X, Y or Z';
const cut = h('div', { class: 'overlay cutbar' }, cutSeg, cutBox, cutBtn);
const pastBanner = h('div', { class: 'banner', style: 'display:none' });
// move step: one column of buttons, bottom left
const moveBtns = MOVE_STEPS.map(v => h('button', { type: 'button', class: 'movestep' + (v === moveStep ? ' on' : ''),
  title: `Move in ${v} mm steps (arrows, drag)`, onclick: () => setMoveStep(v) }, ...(v < 0.1 ? ['0.', h('br'), v.toFixed(2).slice(2)] : [v.toFixed(1)])));
const moveCol = h('div', { class: 'overlay bl' }, h('span', { class: 'lbl' }, 'mm'), ...moveBtns);
function setMoveStep(v) {
  moveStep = v;
  moveBtns.forEach((b, i) => b.classList.toggle('on', MOVE_STEPS[i] === v));
  status(`Moves go in ${v} mm steps. Shift + arrow: ${+(v * 10).toFixed(2)} mm.`);
  renderInspector();
}
// status: one thin line along the bottom of the view, no bar
const statusMsg = h('span', { class: 'msg' }, 'Ready.');
// busy: a barber pole beside the status that keeps moving while any work runs. It is a CSS
// animation, drawn by the browser's compositor, so it keeps moving even when the page itself is
// held up by a long job (the moment something stops it is the moment to worry).
const footer = h('footer', {}, statusMsg, h('span', { class: 'busybar', role: 'progressbar', 'aria-label': 'Working' }, h('i')));
let busyTimer = 0;
function busyCheck() {
  let on = /\.\.\.$/.test(statusMsg.textContent);
  try { on ||= [...pool.jobs.values()].some(j => !j.chore) || building.size > 0; } catch { /* still starting up */ }
  clearTimeout(busyTimer);
  if (on) busyTimer = setTimeout(() => footer.classList.add('busy'), 150);   // not for blinks of work
  else footer.classList.remove('busy');
}
const fatal = h('div', { class: 'fatal', style: 'display:none' });
view.append(header, dropHint, views, cut, moveCol, pastBanner, fatal, footer);
app.append(view, aside);
function showFatal(text) {
  fatal.replaceChildren(h('p', { class: 'err' }, text), button('Reload', () => location.reload()));
  fatal.style.display = '';
}

// The view needs WebGL. A browser that refuses it (often after a driver reset on resume
// from sleep) would otherwise leave a page that looks ready and does nothing.
let viewer;
try { viewer = new Viewer(view); }
catch (e) {
  showFatal('The browser will not give this page 3D graphics. That usually follows a graphics driver reset, often on resume from sleep. Close every window of the browser, open it again, then reload.');
  throw e;
}
view.viewer = viewer;   // for the browser test
let lostTimer = 0;
viewer.onContext = ok => {
  clearTimeout(lostTimer);
  if (ok) { fatal.style.display = 'none'; status('The 3D view is back.'); return; }
  status('The graphics driver reset. Waiting for the 3D view to come back.');
  lostTimer = setTimeout(() => showFatal('The 3D view did not come back after a graphics driver reset. '
    + (project ? 'Every step is already in the project folder. ' : 'Save as a project first, or the parts go with the reload. ')
    + 'If reloading does not bring it back, close every window of the browser and open it again.'), 4000);
};

function status(text, error = false) {
  statusMsg.textContent = text;
  busyCheck();
  statusMsg.className = 'msg' + (error ? ' err' : '');
}

// ---- document changes ----------------------------------------------------------------------
function bindDoc() {
  doc.on(ev => {
    if (ev.type === 'cmd' && !project && !projectAsked) { projectAsked = true; setTimeout(askForFolder, 0); }
    refresh();
  });
}
bindDoc();

let syncing = 0;
/** Bring meshes, view, lists and inspector up to date with the doc. */
async function refresh() {
  endPast(false);   // any change to the model ends the history view
  sel = sel.filter(id => doc.top(id));
  renderParts();
  renderInspector();
  updateHeader();
  dropHint.style.display = doc.parts.length ? 'none' : '';
  const my = ++syncing;
  for (const p of doc.parts) {   // meshes already in hand (a placed shape's ghost)
    const k = shapeKey(p), r = ready.get(k);
    if (r && meshes.get(p.id)?.key !== k) { meshes.set(p.id, { key: k, tris: r.tris, volume: r.volume, open: false }); ready.delete(k); }
  }
  const need = doc.parts.filter(p => meshes.get(p.id)?.key !== shapeKey(p));
  for (const p of need) building.add(p.id);
  // moves, hides and holes show at once; while anything builds, parts it replaces stay shown
  // (striped, not pickable) so nothing blinks out and nothing busy gets clicked
  const busyNow = () => [...building, ...(building.size ? viewer.kept : [])];
  viewer.sync(doc.parts, meshes, building.size > 0);
  viewer.setBusy(busyNow());
  busyCheck();
  if (!need.length) return;
  await sendBlobs();
  for (const p of need) {
    try {
      const key = shapeKey(p);
      const r = await pool.call('kern', { type: 'mesh', part: p }, [], (f, t) => status(`${p.name}: ${t}...`));
      meshes.set(p.id, { key, tris: r.tris, volume: r.volume, open: r.open });
    } catch (err) {
      status(`${p.name}: ${shortErr(err.message)}`, true);
    }
    building.delete(p.id);
  }
  for (const id of [...meshes.keys()]) if (!doc.find(id)) meshes.delete(id);
  void my;
  viewer.sync(doc.parts, meshes, building.size > 0);
  viewer.setBusy(busyNow());
  busyCheck();
  renderParts();
  renderInspector();
}
const building = new Set();   // part ids whose mesh is being built
const ready = new Map();      // shape key -> {tris, volume}: a mesh built ahead (the placing ghost)
/** An error short enough for one line; an internal one names what to try. */
function shortErr(msg) {
  if (/Invalid array length|out of memory|Array buffer allocation failed|maximum size exceeded/i.test(msg)) return 'Too big for memory at this detail: try a larger Detail value.';
  if (/^Internal error/.test(msg)) return 'Internal error. ' + msg.replace(/^Internal error:\s*/, '').split(/[.\n]/)[0] + '.';
  return msg;
}

async function sendBlobs() {
  for (const [id, tris] of doc.blobs) {
    if (sentBlobs.has(id)) continue;
    sentBlobs.add(id);
    await pool.call('kern', { type: 'blob', blobId: id, tris: tris.slice() });
  }
}

function setSel(ids) {
  endPast(false);
  if (facePlane && !(ids.length === 1 && ids[0] === facePlane.id)) facePlane = null;
  sel = ids.filter(id => doc.top(id));
  viewer.select(sel);
  viewer.solo(pastHideOthers && sel.length === 1 ? sel[0] : null);   // Hide other parts follows the selection
  renderParts();
  renderInspector();
}

// ---- shapes and parts list -------------------------------------------------------------------
// Adding a shape: a see-through copy follows the pointer. On a part's face it turns to sit flat
// on that face; on the plate it stands upright with its corner on the lattice. Click places it,
// Enter places it at the default spot, Esc cancels. A part placed on a face keeps that face's
// plane: until it is deselected, the arrows slide it along the plane.
let placing = null;     // {kind, params, lb, xform, face}
let facePlane = null;   // {id, n, u, v} while a part just placed on a face stays selected
/** A part name not yet used: name, then name 2, name 3 ... */
function uniqueName(base) {
  const taken = new Set(doc.parts.map(p => p.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}
function defaultSpot() {
  const n = doc.parts.length;
  // a loose spiral so new shapes do not land inside each other
  const a = n * 2.4, r = n ? 12 + 6 * Math.sqrt(n) : 0;
  return { pos: [Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a)), 0], rot: [0, 0, 0], scale: [1, 1, 1] };
}
async function addShape(kind) {
  cancelPlace();
  const params = { ...SHAPES[kind] };
  const my = placing = { kind, params, xform: null, face: null };
  try {
    // the reader worker builds the ghost, so a busy modeller (a big group, a hollow) never holds it up
    const r = await pool.call('io', { type: 'mesh', part: { id: 'ghost', kind, params, xform: IDENT() } });
    if (placing !== my) return;
    my.lb = localBounds(r.tris);
    my.mesh = { tris: r.tris.slice(), volume: r.volume };
    viewer.startPlace(r.tris);
    status(`Place the ${kind}: click a face or the plate. Enter: default spot. Esc: cancel.`);
  } catch (err) { placing = null; status(err.message, true); }
}
function cancelPlace() { if (placing) { placing = null; viewer.endPlace(); } }
function placeAt(hit) {
  if (!placing?.lb) return;
  if (hit?.normal) {
    // bottom (local -Z side, at z = 0) flat on the face: local +Z along the face's normal
    const n = hit.normal.clone().normalize();
    // two steps: turn about the vertical (in the grid plane) until a face points down
    // the slope, then tilt about that edge by the slope angle; never corner-first
    const q = n.z > 0.99996 ? new Quaternion() : new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.atan2(n.y, n.x))
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.acos(Math.max(-1, Math.min(1, n.z)))));
    const e = new Euler().setFromQuaternion(q, 'XYZ');
    placing.xform = { pos: [hit.point.x, hit.point.y, hit.point.z].map(v => +v.toFixed(6)), rot: [e.x, e.y, e.z].map(v => +(v * 180 / Math.PI).toFixed(6)), scale: [1, 1, 1] };
    placing.face = hit.normal.clone();
  } else if (hit) {
    const lb = placing.lb, cx = (lb.lo[0] + lb.hi[0]) / 2, cy = (lb.lo[1] + lb.hi[1]) / 2;
    // corner on the lattice
    const x = onLattice(hit.point.x - cx + lb.lo[0]) - lb.lo[0], y = onLattice(hit.point.y - cy + lb.lo[1]) - lb.lo[1];
    placing.xform = { pos: [+x.toFixed(6), +y.toFixed(6), +(-lb.lo[2]).toFixed(6)], rot: [0, 0, 0], scale: [1, 1, 1] };
    placing.face = null;
  } else return;
  viewer.setGhost(placing.xform);
}
function commitPlace(useDefault = false) {
  if (!placing) return;
  const p = placing;
  if (!useDefault && !p.xform) return;
  cancelPlace();
  // the ghost already is the part's mesh: hand it over, so the part shows at once
  if (p.mesh) ready.set(shapeKey({ kind: p.kind, params: p.params, ops: [] }), p.mesh);
  const id = doc.add({ kind: p.kind, params: p.params, xform: useDefault || !p.xform ? defaultSpot() : p.xform });
  setSel([id]);
  if (!useDefault && p.face) {
    const { u, v } = viewer.planeAxes(p.face);
    facePlane = { id, n: p.face, u, v };
  }
  status(`Added ${doc.top(id).name}${facePlane?.id === id ? ': arrows slide it along that face until you click off it' : ''}.`);
}
// Shift+F: click any face, and the selected part slides along that face's plane with the arrows
// until you click off it.
function startSlidePick() {
  if (sel.length !== 1) { status('Select one part, then Shift+F and click a face.'); return; }
  viewer.pickingFace = true;
  status('Click a face to slide along. Esc cancels.');
}
viewer.onPickFace = hit => {
  if (!hit?.normal) { status('No face there: slide not set.'); return; }
  const { u, v } = viewer.planeAxes(hit.normal);
  facePlane = { id: sel[0], n: hit.normal, u, v };
  status(`${doc.top(sel[0]).name} slides along that face: arrows, Ctrl+Up/Down off and into it. Click empty space to end.`);
};
viewer.onPlace = (what, hit) => { if (what === 'move') placeAt(hit); else { placeAt(hit); commitPlace(); } };

// The parts list (in its flyout) and where the options sit. The options element is never
// taken out while it is open, so typing in it is not interrupted by a redraw.
let lastSelShown = '';
function renderParts() {
  const home = curTab === 'shapes' ? shapeOpts : partOpts;
  if (inspector.parentNode !== home) home.append(inspector);
  partsHint.style.display = sel.length ? 'none' : '';
  if (!partFlyOpen) return;
  const focusedId = document.activeElement?.closest?.('.prow')?.dataset.id;
  const rows = doc.parts.map(p => {
    const on = sel.includes(p.id);
    const tags = [p.hole ? 'hole' : 'solid', p.mode === 'intersect' ? 'intersect' : '', p.hidden ? 'hidden' : '', p.locked ? 'locked' : '', p.kind === 'group' ? `${p.children.length} parts` : ''].filter(Boolean).join(' · ');
    const row = h('button', { type: 'button', class: 'prow' + (on ? ' on' : '') + (p.hidden ? ' dim' : ''), role: 'option', 'aria-selected': String(on),
      title: 'Click selects, Shift or Ctrl + click adds, double-click renames (or F2)', onclick: e => {
        if (e.detail === 2 && !e.shiftKey && !e.ctrlKey) return renamePart(p, row);   // the first click may have redrawn the row
        if (e.shiftKey || e.ctrlKey) setSel(on ? sel.filter(x => x !== p.id) : [...sel, p.id]);
        else setSel([p.id]);
      } }, h('span', { class: 'pn' }, h('span', { class: 'ptick' }, on ? '▸' : ''), p.name), h('span', { class: 'pt' }, tags));
    row.dataset.id = p.id;
    row.addEventListener('keydown', e => { if (e.key === 'F2') { e.preventDefault(); e.stopPropagation(); renamePart(p, row); } });
    return row;
  });
  partList.replaceChildren(...rows);
  if (!doc.parts.length) partList.append(h('p', {}, 'No parts yet.'));
  const n = doc.parts.length, ns = sel.length;
  const all = button('All', () => setSel(doc.parts.filter(p => !p.hidden).map(p => p.id)), { small: true, title: 'Select every shown part (Ctrl+A)' });
  const noneB = button('None', () => setSel([]), { small: true, title: 'Select nothing (Esc)' });
  all.disabled = !n; noneB.disabled = !ns;
  partFly.replaceChildren(h('h3', {}, `Parts (${ns ? ns + ' of ' : ''}${n})`, h('span', { class: 'grow' }), button('Close', () => openPartList(false), { small: true })),
    h('div', { class: 'row' }, all, noneB), partList);
  if (focusedId) partList.querySelector(`[data-id="${focusedId}"]`)?.focus({ preventScroll: true });
  // a new selection (from the view too) scrolls its first row into sight
  const key = sel.join();
  if (key !== lastSelShown) { lastSelShown = key; partList.querySelector('.prow.on')?.scrollIntoView({ block: 'nearest' }); }
  placeFlyout(partFly, null);
}
function renamePart(p, row) {
  const input = h('input', { type: 'text', class: 'name-in', value: p.name, spellcheck: 'false' });
  const done = ok => { const v = input.value.trim(); input.replaceWith(row); if (ok && v && v !== p.name) doc.update([p.id], `Rename to ${v}`, q => { q.name = v; }); };
  input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = p.name; input.blur(); } });
  input.addEventListener('blur', () => done(true), { once: true });
  row.replaceWith(input);
  input.select();
  input.focus();
}

// ---- inspector ----------------------------------------------------------------------------
let inspectorFor = null;
// never rebuild under a field being typed in; catch up when focus leaves
inspector.addEventListener('focusout', () => setTimeout(() => { if (document.activeElement?.tagName !== 'INPUT' || !inspector.contains(document.activeElement)) renderInspector(); }, 0));
/** live: the part as a handle drag would leave it, shown while dragging (with `view`, the
 *  placement of its current mesh that looks the same). */
function renderInspector(live = null) {
  viewer.setHandles(sel.length === 1 && !step && !past && !doc.top(sel[0])?.locked ? sel[0] : null);
  const hide = !sel.length;
  shapeOpts.style.display = hide || curTab !== 'shapes' ? 'none' : '';
  partOpts.style.display = hide || curTab !== 'parts' ? 'none' : '';
  if (hide) { inspector.style.display = 'none'; inspectorFor = null; return; }
  const key = sel.join();
  if (!live && inspectorFor === key && inspector.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  inspectorFor = key;
  inspector.style.display = '';
  if (sel.length > 1) {
    const first = doc.top(sel[0]);
    const ungroupBtn = button('Ungroup', () => ungroupSel(), { title: 'Ctrl+Shift+G' });
    inspector.replaceChildren(h('div', { class: 'sub' }, `${sel.length} parts selected`),
      colorPicker(sel.every(id => doc.top(id)?.color === first?.color) ? first?.color : '', hex => {
        const ids = editable();
        if (ids.length) doc.update(ids, `Color ${ids.length} parts: ${colorName(hex)}`, q => { if (hex) q.color = hex; else delete q.color; });
      }),
      h('div', { class: 'row' }, button('Group', () => groupSel(), { title: 'Ctrl+G' }), button('Intersect', () => groupSel('intersect'), { title: 'Ctrl+I' }), ungroupBtn),
      h('div', { class: 'sub' }, 'Align'),
      ...['X', 'Y', 'Z'].map((a, i) => h('div', { class: 'row align' }, h('span', { class: 'axis' }, a),
        ...[['Min', 0], ['Mid', 0.5], ['Max', 1]].map(([l, f]) => button(l, () => alignSel(i, f), { small: true })))),
      h('div', { class: 'row' }, button('Delete', () => deleteSel(), { title: 'Delete' })),
      selTotals());
    ungroupBtn.disabled = !sel.some(id => doc.top(id)?.kind === 'group');
    if (ungroupBtn.disabled) ui.tip(ungroupBtn, 'None of these is a group');
    return;
  }
  const p = live || doc.top(sel[0]);
  if (!p) return;
  const m = meshes.get(p.id);
  const lock = p.locked;
  const upd = (label, fn) => { if (lock) { status(`${p.name} is locked (Ctrl+L).`); return; } doc.update([p.id], label, fn); };
  const body = [
    seg([['solid', 'Solid'], ['hole', 'Hole']], p.hole ? 'hole' : 'solid', v => upd(v === 'hole' ? `${p.name} to hole` : `${p.name} to solid`, q => { q.hole = v === 'hole'; })),
  ];
  if (!p.hole) body.push(colorPicker(p.color, hex => upd(`${p.name} color: ${colorName(hex)}`, q => { if (hex) q.color = hex; else delete q.color; })));
  // every part, shape or import, history or not
  body.push(ui.tip(ui.check('Hide other parts', pastHideOthers, v => { pastHideOthers = v; viewer.solo(v ? p.id : null); if (past) scrubTo(past.k); }), 'Show only this part in the view while it is selected'));
  // history of this part: each form it has had (shape, sizes, steps, turn, scale), not where
  // it has been. Dragging shows that form where the part is now; letting go sets it (one undo
  // step). Later forms stay in the list, so it can be stepped forward again.
  const hist = live ? null : doc.formHistory(p.id);
  if (hist && hist.length > 1) {
    const n = hist.length, key = formKey(p);
    let cur = n;
    for (let i = n - 1; i >= 0; i--) if (hist[i].key === key) { cur = i + 1; break; }
    const at = past?.id === p.id ? past.k : cur;
    const label = h('div', { class: 'note' });
    pastUi = { label, n, hist, cur, id: p.id };
    body.push(h('div', { class: 'sub' }, 'History'),
      ui.slider(`Step (of ${n})`, at, '', { min: 1, max: n, step: 1 }, k => scrubTo(k), k => setPast(k)),
      label);
    pastLabel(at);
  } else pastUi = null;
  if (p.params) {
    for (const [k, v] of Object.entries(p.params)) {
      const facets = k === 'sides' || k === 'tubeSides';
      body.push(ui.numfield(LABELS[k] || k, v, facets ? '' : 'mm', nv => upd(`${p.name}: ${(LABELS[k] || k).toLowerCase()} ${nv}`, q => { q.params[k] = facets ? Math.round(nv) : nv; }),
        { min: facets ? 3 : k === 'd2' || k === 'd1' ? 0 : 0.0001, step: facets ? 4 : 1, lazy: true, digits: facets ? 0 : 4 }));
    }
  }
  if (p.kind === 'group') body.push(h('div', { class: 'row' }, button('Ungroup', () => ungroupSel(), { title: 'Ctrl+Shift+G' })));
  // where the part really is: its middle in X and Y, its lowest point in Z (0 = on the plate)
  const wb = worldBox(p, p.view || p.xform);
  body.push(h('div', { class: 'sub' }, 'Position'));
  if (wb) {
    const at = [(wb.min.x + wb.max.x) / 2, (wb.min.y + wb.max.y) / 2, wb.min.z];
    [['Center X', 0], ['Center Y', 1], ['Bottom Z', 2]].forEach(([label, i]) => body.push(ui.numfield(label, +at[i].toFixed(4), 'mm',
      v => upd(`Move ${p.name}`, q => { q.xform.pos[i] = +(q.xform.pos[i] + v - at[i]).toFixed(6); q.xform = snapped(q, q.xform); }), { step: moveStep, lazy: true, digits: 3 })));
  }
  body.push(ui.tip(h('div', { class: 'sub' }, 'Rotation'), 'Turns about the middle of the part'));
  const rot = ui.tip(ui.check('Rings', rotateOn, v => { rotateOn = v; viewer.setRings(v); }), 'Shows the turn rings. Holding R shows them too.');
  body.push(rot);
  ['X', 'Y', 'Z'].forEach((a, i) => body.push(ui.numfield(a, p.xform.rot[i], 'deg',
    v => upd(`Rotate ${p.name}`, q => { const r = [...q.xform.rot]; r[i] = v; q.xform = rotated(q, r); }), { step: 15, lazy: true, digits: 3 })));
  if (!p.params || p.xform.scale.some(v => v !== 1)) {
    body.push(h('div', { class: 'sub' }, 'Scale'));
    ['X', 'Y', 'Z'].forEach((a, i) => body.push(ui.numfield(a, p.xform.scale[i] * 100, '%', v => upd(`Scale ${p.name}`, q => { q.xform.scale[i] = v / 100; q.xform = snapped(q, q.xform); }), { min: 0.0001, step: 10, lazy: true, digits: 4 })));
  }
  // steps
  body.push(h('div', { class: 'sub' }, 'Steps'));
  (p.ops || []).forEach((op, i) => {
    const t = tools.find(x => x.id === op.tool);
    body.push(h('div', { class: 'steprow' }, h('span', {}, `${i + 1}. ${t?.stepLabel?.(op.params) || t?.title || op.tool}`),
      button('Remove', () => upd(`Remove step ${i + 1} from ${p.name}`, q => { q.ops.splice(i, 1); }), { small: true })));
  });
  // an open mesh can only be repaired; Repair itself only fits an imported mesh with no steps yet
  const open = m?.open;
  if (open) body.push(ui.tip(h('div', { class: 'note' }, 'Not closed'), 'It still moves, groups and exports as it is; cutting, hollowing and edge shaping close it for that step. Repair closes it for good.'));
  const usable = tools.filter(t => !t.appliesTo || t.appliesTo(p));
  body.push(h('div', { class: 'row wrap' }, ...usable.map(t => button(t.title, () => startStep(t, p.id), { small: true, title: t.blurb }))));
  // a tool's settings open right here, under the button that opened them
  if (step && step.partId === p.id) body.push(stepCard);
  if (lock) body.push(h('div', { class: 'note' }, 'Locked: Ctrl+L to unlock.'));
  // the numbers and Export sit at the foot of the panel, so they stay put while the rest changes
  const info = h('div', { class: 'infobox' });
  if (m) {
    const b = wb;
    info.append(kv([['size', b ? `${mm(b.max.x - b.min.x)} x ${mm(b.max.y - b.min.y)} x ${mm(b.max.z - b.min.z)}` : '-'], ['volume', `${(m.volume / 1000).toFixed(2)} cm3`], ['triangles', count(m.tris.length / 9)], ['STL', `about ${sizeText(stlBytes(m.tris.length / 9))}`]]));
  }
  info.append(h('div', { class: 'row' }, button('Export this part...', () => { expWhat = 'sel'; exportDialog(); }, { small: true, title: 'Export only this part (Ctrl+E exports with the last choices)' })));
  body.push(info);
  inspector.replaceChildren(...body);
}

/** Several parts selected: their numbers added up (size is the box round them all). */
function selTotals() {
  let tris = 0, vol = 0, all = true;
  const b = new Box3();
  for (const id of sel) {
    const p = doc.top(id), m = meshes.get(id);
    if (!p || !m) { all = false; continue; }
    tris += m.tris.length / 9;
    vol += m.volume || 0;
    const wb = worldBox(p);
    if (wb) b.union(wb);
  }
  const s = b.isEmpty() ? null : b.getSize(new Vector3());
  return h('div', { class: 'infobox' }, h('div', { class: 'sub' }, all ? 'Together' : 'Together (some still building)'),
    h('div', { class: 'row' }, button('Export these parts...', () => { expWhat = 'sel'; exportDialog(); }, { small: true, title: 'Export only the selected parts, joined or one file each' })),
    kv([['size', s ? `${mm(s.x)} x ${mm(s.y)} x ${mm(s.z)}` : '-'], ['volume', `${(vol / 1000).toFixed(2)} cm3`], ['triangles', count(tris)], ['STL', `about ${sizeText(stlBytes(tris))}`]]));
}

// ---- history view ---------------------------------------------------------------------------
let past = null;     // {id, k, part, ready} while showing another form of a part
let pastUi = null;
let pastSeq = 0;
let pastHideOthers = false;
function pastLabel(k) {
  if (!pastUi) return;
  const { n, hist, cur, label } = pastUi;
  label.textContent = `${k === cur ? 'Now: ' : ''}${hist[k - 1].label}`;
  pastBanner.style.display = k !== cur ? '' : 'none';
  pastBanner.textContent = `HISTORY  -  step ${k} of ${n}. Let go to set it; Esc leaves it as it is.`;
}
/** The part in form k of its history, standing where the part stands now: the same middle in
 *  X and Y and the same bottom, and keeping its name, color and switches. Resolves to the part
 *  and its mesh. */
async function formAt(id, k) {
  const p = doc.top(id), h0 = pastUi?.hist[k - 1];
  if (!p || !h0) return null;
  const s = h0.state;
  const q = { ...structuredClone(p), kind: s.kind, params: structuredClone(s.params), blob: s.blob, ops: structuredClone(s.ops || []), mode: s.mode,
    children: structuredClone(s.children), hole: s.hole, xform: { pos: [0, 0, 0], rot: [...s.xform.rot], scale: [...s.xform.scale] } };
  for (const k2 of Object.keys(q)) if (q[k2] === undefined) delete q[k2];
  await sendBlobs();
  const r = await pool.call('kern', { type: 'mesh', part: q });
  const now = worldBox(p);
  // where the form's own box lands with no move, then shift it onto the part's spot
  const M = matrix(q.xform).elements, t = r.tris, b = new Box3(), v = new Vector3();
  const stride = Math.max(1, Math.ceil(t.length / 3 / 600000));
  for (let i = 0; i < t.length / 3; i += stride) { const x = t[i * 3], y = t[i * 3 + 1], z = t[i * 3 + 2]; b.expandByPoint(v.set(M[0] * x + M[4] * y + M[8] * z, M[1] * x + M[5] * y + M[9] * z, M[2] * x + M[6] * y + M[10] * z)); }
  if (now && !b.isEmpty()) {
    const pos = [(now.min.x + now.max.x) / 2 - (b.min.x + b.max.x) / 2, (now.min.y + now.max.y) / 2 - (b.min.y + b.max.y) / 2, now.min.z - b.min.z];
    // its low corner on the lattice, as every placed part's is
    const lo = [b.min.x, b.min.y, b.min.z];
    q.xform.pos = pos.map((x, i) => +(x + onLattice(lo[i] + x) - (lo[i] + x)).toFixed(6));
  } else q.xform.pos = [...p.xform.pos];
  return { part: q, tris: r.tris, volume: r.volume, open: r.open };
}
async function scrubTo(k) {
  if (!pastUi) return;
  const { n, cur, id } = pastUi;
  k = Math.max(1, Math.min(n, Math.round(k)));
  if (k === cur) { endPast(false); past = null; pastLabel(k); return; }   // no redraw: the slider is still being dragged
  const my = ++pastSeq;
  past = { id, k, ready: null };
  viewer.setHandles(null);
  pastLabel(k);
  const job = formAt(id, k);
  past.ready = job;
  try {
    const f = await job;
    if (my !== pastSeq || !past || !f) return;
    viewer.showPast([{ tris: f.tris, xform: f.part.xform, color: f.part.color, hole: f.part.hole }], [id], true);
  } catch (err) { status(err.message, true); }
}
/** Let go of the slider (or Enter in its box): the part takes that form, as one step. */
async function setPast(k) {
  if (!pastUi) return;
  const { n, cur, id } = pastUi;
  k = Math.max(1, Math.min(n, Math.round(k)));
  if (k === cur) { endPast(); return; }
  if (!past || past.k !== k) scrubTo(k);
  let f;
  try { f = await past?.ready; } catch { f = null; }
  if (!f) { endPast(); return; }
  const name = doc.top(id)?.name;
  endPast(false);
  const q = f.part;
  meshes.set(id, { key: shapeKey(q), tris: f.tris, volume: f.volume, open: f.open });   // already built: no rebuild
  doc.commit(`${name}: history step ${k} of ${n}`, parts => { const i = parts.findIndex(x => x.id === id); if (i >= 0) parts[i] = q; }, { kind: 'rollback' });
  status(`${name} set to history step ${k} of ${n}: ${pastUi?.hist[k - 1]?.label || ''}. Ctrl+Z undoes that.`);
}
function endPast(redraw = true) {
  if (!past && !viewer.past) return;
  past = null;
  viewer.setHandles(sel.length === 1 && !step && !doc.top(sel[0])?.locked ? sel[0] : null);
  pastSeq++;
  pastBanner.style.display = 'none';
  viewer.showPast(null);
  if (redraw) renderInspector();
}

// ---- selection and editing ----------------------------------------------------------------------
// a big part's feature lines come from the reader worker, off the page (a copy goes over; the view keeps its own)
viewer.onNeedBvh = (id, key, tris) => {
  const copy = tris.slice();
  pool.call('io', { type: 'bvh', tris: copy }, [copy.buffer]).then(r => viewer.setBvh(id, key, r.data)).catch(() => {});
};
viewer.onNeedEdges = (id, key, tris) => {
  const copy = tris.slice();
  pool.call('io', { type: 'edges', tris: copy, angle: 40 }, [copy.buffer]).then(r => viewer.setEdges(id, key, r.segs)).catch(() => {});
};
viewer.onPick = (id, face, e) => {
  if (id && viewer.busy?.has(id)) { status('Still building: wait until the stripes go.'); return; }
  if (step && id === step.partId && step.tool.needsFace) { pickStepFace(face); return; }
  if (step && id === step.partId && step.tool.pickWalls?.(step.params)) { pickWall(face); return; }
  if (!id) { if (!e.shiftKey) setSel([]); return; }
  if (e.shiftKey) setSel(sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]);
  else setSel([id]);
};
viewer.onBox = (ids, e) => setSel(e.shiftKey ? [...new Set([...sel, ...ids])] : ids);

let drag = null;
viewer.onDragStart = (id, e) => {
  if (viewer.busy?.has(id)) { status('Still building: wait until the stripes go.'); return false; }
  // a tool step may stay open: moving a part never changes its shape, so it does not get in the way
  const p = doc.top(id);
  if (!p || p.locked) { if (p?.locked) status(`${p.name} is locked (Ctrl+L).`); return false; }
  if (!sel.includes(id)) setSel([id]);
  let ids = sel.filter(x => !doc.top(x)?.locked);
  if (e.altKey) { ids = doc.duplicate(ids); setSel(ids); }    // Alt: drag a copy
  drag = { ids, start: new Map(ids.map(x => { const p = doc.top(x), f = cornerFix(p); return [x, p.xform.pos.map((v, i) => v + f[i])]; })), d: [0, 0] };
  return true;
};
viewer.onDrag = (dx, dy, e) => {
  if (!drag) return;
  const snap = e.shiftKey ? 0.1 : moveStep;
  drag.d = [+(Math.round(dx / snap) * snap).toFixed(6), +(Math.round(dy / snap) * snap).toFixed(6)];
  for (const id of drag.ids) {
    const p = doc.top(id), s = drag.start.get(id);
    viewer.setXform(id, { ...p.xform, pos: [s[0] + drag.d[0], s[1] + drag.d[1], s[2]] });
  }
  status(`Move ${mm(drag.d[0])}, ${mm(drag.d[1])} mm${e.shiftKey || moveStep <= 0.1 ? '' : '  (Shift: 0.1 mm steps)'}`);
};
viewer.onDragEnd = () => {
  if (!drag) return;
  const d = drag; drag = null;
  if (!d.d[0] && !d.d[1]) { viewer.sync(doc.parts, meshes); return; }
  doc.update(d.ids, d.ids.length > 1 ? `Move ${d.ids.length} parts` : `Move ${doc.top(d.ids[0]).name}`, p => {
    const s = d.start.get(p.id);
    p.xform.pos = [+(s[0] + d.d[0]).toFixed(6), +(s[1] + d.d[1]).toFixed(6), s[2]];
  });
};

// ---- handles: size, lift, turn -----------------------------------------------------------------
// Size: the opposite side stays where it is and the new size snaps to the move step; Shift
// sizes every axis together. Round shapes stay round; a shape's own sizes change where they
// can (a box keeps scale 1), otherwise its scale. Lift: Z in move steps. Turn: about the
// part's middle, 15 degree steps (Shift: 1). The panel follows live; one undo step on release.
const ROUND = { cylinder: 1, tube: 1, cone: 1, torus: 1 };
let hdrag = null;
viewer.onHandle = (phase, h, e) => {
  if (phase === 'start') {
    const p = doc.top(sel[0]), m = p && meshes.get(p.id);
    if (!p || !m || p.locked || step || past) return false;
    hdrag = { p: structuredClone(p), lb: localBounds(m.tris), next: null };
    return true;
  }
  if (!hdrag) return;
  if (phase === 'move') {
    const r = handleResult(hdrag, h, e);
    hdrag.next = r;
    viewer.setXform(r.part.id, r.view);
    renderInspector({ ...r.part, view: r.view });
    status(r.text);
    return;
  }
  const d = hdrag; hdrag = null;
  if (!ringsHeld) viewer.setRings(rotateOn);   // R let go during the turn
  const r = d.next;
  if (!r || r.same) { viewer.sync(doc.parts, meshes); renderInspector(); return; }
  doc.update([d.p.id], r.label, q => { q.params = r.part.params; q.xform = r.part.xform; });
};

function handleResult(d, h, e) {
  const p = d.p, { lo, hi } = d.lb, x0 = p.xform, s = x0.scale;
  const part = structuredClone(p);
  const R = matrix({ pos: [0, 0, 0], rot: x0.rot, scale: [1, 1, 1] });
  if (h.kind === 'lift') {
    const dz = +(Math.round(h.delta / moveStep) * moveStep).toFixed(6);
    part.xform.pos = [x0.pos[0], x0.pos[1], +(x0.pos[2] + dz).toFixed(6)];
    return { part, view: part.xform, same: !dz, label: `Lift ${p.name} ${mm(dz)} mm`, text: `Lift ${mm(dz)} mm` };
  }
  if (h.kind === 'rot') {
    const st = e.shiftKey ? 1 : 15, deg = Math.round(h.deg / st) * st;
    const q0 = new Quaternion().setFromEuler(new Euler(...x0.rot.map(v => (v * Math.PI) / 180), 'XYZ'));
    const qa = new Quaternion().setFromAxisAngle(new Vector3().setComponent(h.axis, 1), (deg * Math.PI) / 180);
    const eu = new Euler().setFromQuaternion(qa.multiply(q0), 'XYZ');
    const rot = [eu.x, eu.y, eu.z].map(v => { const g = +((v * 180) / Math.PI).toFixed(4); return Object.is(g, -0) ? 0 : g; });
    part.xform = rotated(p, rot);
    return { part, view: part.xform, same: !deg, label: `Turn ${p.name} ${deg} deg about ${'XYZ'[h.axis]}`,
      text: `Turn ${deg} deg about ${'XYZ'[h.axis]}${e.shiftKey ? '' : '  (Shift: 1 deg steps)'}` };
  }
  // size
  const i = h.axis, size0 = (hi[i] - lo[i]) * s[i];
  const size = Math.max(moveStep, Math.round((size0 + h.delta) / moveStep) * moveStep);
  const k = size / size0, f = [1, 1, 1];
  if (e.shiftKey || p.kind === 'sphere') f.fill(k);
  else {
    f[i] = k;
    if (ROUND[p.kind] && i < 2) f[0] = f[1] = k;
    if (p.kind === 'fillet' && i !== 1) f[0] = f[2] = k;   // its corner stays square
  }
  // the point that must not move: the far side on this axis, the middle across, the bottom in Z
  const a = [0, 1, 2].map(j => j === i ? (h.side > 0 ? lo[j] : hi[j]) : j < 2 ? (lo[j] + hi[j]) / 2 : lo[2]);
  const shift = new Vector3(...a.map((v, j) => s[j] * (f[j] - 1) * v)).applyMatrix4(R);
  const view = { ...x0, pos: [x0.pos[0] - shift.x, x0.pos[1] - shift.y, x0.pos[2] - shift.z].map(v => +v.toFixed(6)), scale: s.map((v, j) => v * f[j]) };
  part.xform = { ...view, scale: [...s] };
  const P = part.params, mul = (key, j) => { if (P[key] != null) P[key] = +(P[key] * f[j]).toFixed(6); };
  const kind = p.kind;
  if (kind === 'box' || kind === 'wedge') { mul('x', 0); mul('y', 1); mul('z', 2); }
  else if (kind === 'cylinder' || kind === 'tube') { mul('d', 0); mul('h', 2); if (e.shiftKey) mul('wall', 0); }
  else if (kind === 'cone') { mul('d1', 0); mul('d2', 0); mul('h', 2); }
  else if (kind === 'sphere') mul('d', 0);
  else if (kind === 'fillet') { mul('r', 0); mul('length', 1); }
  else if (kind === 'torus' && e.shiftKey) { mul('d', 0); mul('tube', 0); }
  else part.xform.scale = view.scale.map(v => +v.toFixed(6));   // meshes, groups, a torus pulled out of round
  const names = ['Width', 'Depth', 'Height'];
  return { part, view, same: Math.abs(k - 1) < 1e-9, label: `Size ${p.name}: ${e.shiftKey ? 'all' : names[i].toLowerCase()} ${mm(size)} mm`,
    text: `${names[i]} ${mm(size)} mm${e.shiftKey ? ' (all sides together)' : '  (Shift: all sides together)'}` };
}

const editable = () => sel.filter(id => !doc.top(id)?.locked);
function nudge(dx, dy, dz) {
  const ids = editable();
  if (!ids.length) return;
  doc.update(ids, `Nudge ${ids.length > 1 ? ids.length + ' parts' : doc.top(ids[0]).name}`, p => {
    const f = cornerFix(p);
    p.xform.pos = p.xform.pos.map((v, i) => +(v + f[i] + [dx, dy, dz][i]).toFixed(6));
  });
}
function dropToPlate() {
  const ids = editable();
  for (const id of ids) {
    const b = worldBox(doc.top(id));
    if (b && Math.abs(b.min.z) > 1e-9) doc.update([id], `Drop ${doc.top(id).name} to the plate`, p => { p.xform.pos[2] = +(p.xform.pos[2] - b.min.z).toFixed(9); });
  }
}
function setHole(on) {
  const ids = editable();
  if (ids.length) doc.update(ids, on ? 'To hole' : 'To solid', p => { p.hole = on; });
}
function toggleLock() {
  if (!sel.length) return;
  const on = !doc.top(sel[0]).locked;
  doc.update(sel, on ? 'Lock' : 'Unlock', p => { p.locked = on; });
  status(on ? 'Locked.' : 'Unlocked.');
}
function hideSel() {
  if (!sel.length) return;
  doc.update(sel, 'Hide', p => { p.hidden = true; });
  setSel([]);
}
function showAll() {
  const ids = doc.parts.filter(p => p.hidden).map(p => p.id);
  if (ids.length) doc.update(ids, 'Show hidden', p => { p.hidden = false; });
}
function deleteSel() {
  const ids = editable();
  if (!ids.length) return;
  doc.remove(ids);
  setSel([]);
}
function groupSel(mode = '') {
  if (sel.length < 2) { status('Select two or more parts to group (Shift+click or drag a box).'); return; }
  const id = doc.group(editable(), mode);
  if (id) setSel([id]);
}
function ungroupSel() {
  const out = [];
  for (const id of editable()) if (doc.top(id)?.kind === 'group') out.push(...doc.ungroup(id));
  if (out.length) setSel(out);
}
/** Line the selected parts up on one axis: their low sides (0), middles (0.5) or high sides (1)
 *  to the same side of the box round them all. */
function alignSel(axis, f) {
  const ids = editable();
  if (ids.length < 2) return;
  const boxes = new Map(ids.map(id => [id, worldBox(doc.top(id))]).filter(([, b]) => b));
  let lo = Infinity, hi = -Infinity;
  for (const b of boxes.values()) { lo = Math.min(lo, b.min.getComponent(axis)); hi = Math.max(hi, b.max.getComponent(axis)); }
  const target = lo + (hi - lo) * f;
  doc.update([...boxes.keys()], `Align ${'XYZ'[axis]} ${['min', 'mid', 'max'][f * 2]}`, p => {
    const b = boxes.get(p.id), at = b.min.getComponent(axis) + (b.max.getComponent(axis) - b.min.getComponent(axis)) * f;
    p.xform.pos[axis] = +(p.xform.pos[axis] + target - at).toFixed(6);
    p.xform = snapped(p, p.xform);
  });
}
function mirrorSel(axis) {
  const ids = editable();
  if (ids.length) doc.update(ids, `Mirror ${'XYZ'[axis]}`, p => { p.xform.scale[axis] *= -1; p.xform = snapped(p, p.xform); });
}
function duplicateSel() {
  if (!sel.length) return;
  // repeat duplicate: if the last copy was moved, the next copy moves by the same amount
  let offset = [0, 0, 0];
  if (lastDup && lastDup.copies.join() === sel.join()) {
    const a = doc.top(lastDup.src[0]), b = doc.top(lastDup.copies[0]);
    if (a && b) offset = b.xform.pos.map((v, i) => v - a.xform.pos[i]);
  }
  const src = [...sel];
  const copies = doc.duplicate(src, offset);
  lastDup = { src, copies };
  setSel(copies);
}
function copySel() { if (sel.length) { clipboard = sel.map(id => JSON.parse(JSON.stringify(doc.top(id)))); status(`Copied ${sel.length}.`); } }
function paste() {
  if (!clipboard) return;
  const ids = [];
  doc.commit(`Paste ${clipboard.length}`, parts => {
    const reid = p => ({ ...p, id: doc.newId(), children: p.children?.map(reid) });
    for (const c of clipboard) { const n = reid(JSON.parse(JSON.stringify(c))); n.xform.pos[0] += 10; n.xform.pos[1] += 10; parts.push(n); ids.push(n.id); }
  });
  setSel(ids);
}

// ---- tool steps -----------------------------------------------------------------------------
function startStep(t, partId) {
  cancelStep();
  const p = doc.top(partId);
  if (!p) return;
  if (p.locked) { status(`${p.name} is locked (Ctrl+L).`); return; }
  step = { tool: t, partId, params: structuredClone(t.defaults || {}), face: null, seq: 0 };
  viewer.setHandles(null);
  const body = h('div'), statusEl = h('div'), prog = h('div', { class: 'prog', style: 'display:none' }, h('i'));
  const applyBtn = button('Apply', () => applyStep(), { go: true });
  const row = h('div', { class: 'row' }, button('Preview', () => previewStep()), applyBtn, button('Cancel', () => cancelStep()));
  stepCard.replaceChildren(ui.tip(card(`${t.title}: ${p.name}`, body, statusEl, prog, row), t.blurb || ''));
  renderInspector();
  stepCard.scrollIntoView({ block: 'nearest' });
  const m = meshes.get(partId);
  const lb = m ? localBounds(m.tris) : null;
  const api = {
    params: step.params, ui,
    set(k, v) { step.params[k] = v; stepChanged(); },
    model: () => lb && { bounds: lb, triangles: m.tris.length / 9 },
    selection: () => step?.face,
    clearSelection: () => { step.face = null; step.walls = []; viewer.setFacePick(null); stepChanged(); },
  };
  step.ui = { body, statusEl, prog, applyBtn, hooks: t.panel(body, api) || {} };
  status(t.needsFace ? `${t.title}: click a face on ${p.name} if the step needs one.` : `${t.title}: set it up, then Preview or Apply.`);
  stepChanged();
}

function stepProblem() {
  if (!step) return null;
  const m = meshes.get(step.partId);
  return step.tool.validate?.(step.params, { model: m && { bounds: localBounds(m.tris) }, selection: step.face }) || null;
}
function stepChanged() {
  if (!step) return;
  viewer.preview(step.partId, null);
  step.previewed = false;
  step.ui.hooks.update?.();
  const p = stepProblem();
  step.ui.statusEl.replaceChildren(...(!p ? [] : p.wait ? [h('div', { class: 'note' }, p.wait)] : [errorLine(p)]));
  step.ui.applyBtn.disabled = !!p;
  if (step.tool.live && !p) { clearTimeout(step.timer); step.timer = setTimeout(previewStep, 200); }
}
function stepOp() {
  const op = { tool: step.tool.id, params: structuredClone(step.params) };
  if (step.face?.segs) op.sel = { segs: step.face.segs };
  else if (step.face?.faces) op.sel = { faces: step.face.faces.map(r => ({ normal: r.normal, d: r.d, point: r.point })) };
  else if (step.face) op.sel = { normal: step.face.normal, d: step.face.d, point: step.face.point };
  return op;
}
async function previewStep() {
  if (!step || stepProblem()) return;
  const my = ++step.seq, s = step;
  const p = doc.top(s.partId);
  const part = { ...p, ops: [...(p.ops || []), stepOp()] };
  s.ui.prog.style.display = '';
  try {
    await sendBlobs();
    const r = await pool.call('kern', { type: 'mesh', part }, [], (f, t) => { if (step === s && my === s.seq) { s.ui.prog.firstChild.style.width = `${Math.round(f * 100)}%`; status(`${s.tool.title}: ${t}...`); } });
    if (step !== s || my !== s.seq) return;
    meshes.set('preview', { key: shapeKey(part), tris: r.tris, volume: r.volume });
    viewer.preview(s.partId, r.tris);
    s.previewed = true;
    s.ui.statusEl.replaceChildren(...(r.notes || []).map(t => h('div', { class: 'note' }, t)));
    status(`${s.tool.title}: preview ready. ${(r.notes || []).join(' ')} Apply keeps it.`);
  } catch (err) {
    if (step === s) { const m = shortErr(err.message); s.ui.statusEl.replaceChildren(ui.tip(errorLine(m), err.message)); status(`${s.tool.title} did not finish.`, true); }   // the reason is in the panel, once
  } finally { if (step === s) s.ui.prog.style.display = 'none'; }
}
async function applyStep() {
  if (!step || stepProblem()) return;
  const s = step;
  if (!s.previewed) await previewStep();
  if (step !== s || !s.previewed) return;
  const op = stepOp();
  const p = doc.top(s.partId);
  const pre = meshes.get('preview');
  cancelStep();
  // the preview already is the new mesh: hand it over so nothing is rebuilt
  if (pre) meshes.set(p.id, { ...pre, key: shapeKey({ ...p, ops: [...(p.ops || []), op] }) });
  doc.update([p.id], `${s.tool.title} on ${p.name}`, q => { q.ops = [...(q.ops || []), op]; });
  status(`${s.tool.title} added to ${p.name} as step ${doc.top(p.id).ops.length}.`);
}
function cancelStep() {
  if (!step) return;
  viewer.preview(step.partId, null);
  viewer.setFacePick(null);
  clearTimeout(step.timer);
  step = null;
  viewer.setHandles(sel.length === 1 && !past && !doc.top(sel[0])?.locked ? sel[0] : null);
  meshes.delete('preview');
  stepCard.replaceChildren();
}
function pickStepFace(face) {
  const m = meshes.get(step.partId);
  if (!m || face < 0) return;
  const region = faceRegion(m.tris, face);
  if (step.tool.multiFace) {
    // many faces: a click adds the face under it, or takes it away if it is already picked
    const list = step.face?.faces || [];
    const had = list.findIndex(r => r.tris.includes(face));
    if (had >= 0) list.splice(had, 1); else list.push(region);
    step.face = list.length ? { faces: list, area: list.reduce((s, r) => s + r.area, 0) } : null;
    viewer.setFacePick(step.partId, list.flatMap(r => r.tris));
    status(list.length ? `${list.length} face${list.length > 1 ? 's' : ''} picked. Click a face again to drop it.` : 'No face picked.');
    stepChanged();
    return;
  }
  step.face = region;
  viewer.setFacePick(step.partId, region.tris);
  status(`Face picked: ${mm(region.area)} mm2.`);
  stepChanged();
}

/** Picking side walls (several): a click adds the wall under it, or takes it away if it is
 *  already picked. A wall is one flat side, or a whole smooth round side. What the step keeps
 *  is each wall's foot on the bottom face, as plan segments. */
function pickWall(face) {
  const m = meshes.get(step.partId);
  if (!m || face < 0) return;
  step.walls = step.walls || [];
  const had = step.walls.findIndex(wl => wl.tris.includes(face));
  if (had >= 0) step.walls.splice(had, 1);
  else {
    const w = wallRegion(m.tris, face);
    if (!w) { status('That is not a side wall. Click the side of the part whose top or bottom edge to pick.'); return; }
    step.walls.push(w);
  }
  const all = step.walls.flatMap(wl => wl.tris);
  step.face = step.walls.length ? { segs: step.walls.flatMap(wl => wl.segs), walls: step.walls.length } : null;
  viewer.setFacePick(step.partId, all);
  status(`${step.walls.length} wall${step.walls.length === 1 ? '' : 's'} picked. Click a wall again to drop it.`);
  stepChanged();
}

function wallRegion(t, seed) {
  const nrm = f => {
    const i = f * 9;
    const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2];
    const vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(...n) || 1;
    return n.map(v => v / l);
  };
  const upright = f => Math.abs(nrm(f)[2]) < 1e-3;
  if (!upright(seed)) return null;
  const { idx } = weld(t);
  const byVert = new Map();
  for (let f = 0; f < t.length / 9; f++) for (let k = 0; k < 3; k++) { const v = idx[f * 3 + k]; (byVert.get(v) || byVert.set(v, []).get(v)).push(f); }
  const smooth = Math.cos((30 * Math.PI) / 180);   // round sides: neighbouring facets turn less than this
  const seen = new Set([seed]), stack = [seed], out = [];
  while (stack.length) {
    const f = stack.pop(), nf = nrm(f);
    out.push(f);
    for (let k = 0; k < 3; k++) for (const g of byVert.get(idx[f * 3 + k])) {
      if (seen.has(g) || !upright(g)) continue;
      const ng = nrm(g);
      if (ng[0] * nf[0] + ng[1] * nf[1] < smooth) continue;
      seen.add(g); stack.push(g);
    }
  }
  // feet: triangle edges lying on the bottom face
  const z0 = localBounds(t).lo[2], segs = [];
  for (const f of out) for (let k = 0; k < 3; k++) {
    const a = f * 9 + k * 3, b = f * 9 + ((k + 1) % 3) * 3;
    if (Math.abs(t[a + 2] - z0) < 1e-3 && Math.abs(t[b + 2] - z0) < 1e-3) segs.push([t[a], t[a + 1], t[b], t[b + 1]].map(v => +v.toFixed(5)));
  }
  return segs.length ? { tris: out, segs } : null;
}

/** The flat region round a triangle, in the part's own frame. */
function faceRegion(t, seed) {
  const nrm = f => {
    const i = f * 9;
    const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2];
    const vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const l = Math.hypot(...n) || 1;
    return { n: n.map(v => v / l), area: l / 2 };
  };
  const { n } = nrm(seed);
  const d = n[0] * t[seed * 9] + n[1] * t[seed * 9 + 1] + n[2] * t[seed * 9 + 2];
  const { idx } = weld(t);
  const flat = f => {
    if (nrm(f).n.reduce((s, v, k) => s + v * n[k], 0) < 1 - 1e-6) return false;
    for (let k = 0; k < 9; k += 3) if (Math.abs(n[0] * t[f * 9 + k] + n[1] * t[f * 9 + k + 1] + n[2] * t[f * 9 + k + 2] - d) > 1e-3) return false;
    return true;
  };
  const byVert = new Map();
  for (let f = 0; f < t.length / 9; f++) for (let k = 0; k < 3; k++) { const v = idx[f * 3 + k]; (byVert.get(v) || byVert.set(v, []).get(v)).push(f); }
  const seen = new Set([seed]), stack = [seed], out = [];
  let area = 0;
  while (stack.length) {
    const f = stack.pop();
    out.push(f); area += nrm(f).area;
    for (let k = 0; k < 3; k++) for (const g of byVert.get(idx[f * 3 + k])) if (!seen.has(g)) { seen.add(g); if (flat(g)) stack.push(g); }
  }
  const i = seed * 9;
  const point = [(t[i] + t[i + 3] + t[i + 6]) / 3, (t[i + 1] + t[i + 4] + t[i + 7]) / 3, (t[i + 2] + t[i + 5] + t[i + 8]) / 3];
  return { tris: out, normal: n, d, point, area };
}

/** A part's world box from its real points; the quick box of a rotated mesh is too big. */
function worldBox(p, xform = p.xform) {
  const m = meshes.get(p.id);
  if (!m) return null;
  const t = m.tris, M = matrix(xform), e = M.elements, b = new Box3();
  const v = new Vector3();
  const n = t.length / 3, stride = n > 600000 ? Math.ceil(n / 600000) : 1;
  for (let i = 0; i < n; i += stride) {
    const x = t[i * 3], y = t[i * 3 + 1], z = t[i * 3 + 2];
    v.set(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
    b.expandByPoint(v);
  }
  return b;
}

/** The part's xform with new rotations, turned about its own middle so it stays where it is. */
function rotated(p, rot) {
  const m = meshes.get(p.id);
  const nx = { ...p.xform, rot };
  if (!m) return nx;
  const lb = localBounds(m.tris);
  const c = new Vector3((lb.lo[0] + lb.hi[0]) / 2, (lb.lo[1] + lb.hi[1]) / 2, (lb.lo[2] + lb.hi[2]) / 2);
  const before = c.clone().applyMatrix4(matrix(p.xform));
  const after = c.clone().applyMatrix4(matrix({ ...nx, pos: [0, 0, 0] }));
  nx.pos = [before.x - after.x, before.y - after.y, before.z - after.z].map(v => +v.toFixed(6));
  return snapped(p, nx);
}

function localBounds(t) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], t[i + a]); hi[a] = Math.max(hi[a], t[i + a]); }
  return { lo, hi };
}

// ---- undo -----------------------------------------------------------------------------------
function undo() { cancelStep(); const c = doc.undo(); if (c) status(`Undone: ${c.label}.`); }
function redo() { cancelStep(); const c = doc.redo(); if (c) status(`Redone: ${c.label}.`); }

// ---- project folder ------------------------------------------------------------------------
function updateHeader() {
  // no name box in the view: the name and saved state go in the window title
  if (project) {
    document.title = `${project.name}, ${project.error ? 'NOT SAVED' : project.pending ? 'saving' : 'saved'}: Workingtitle3D`;
    projBtn.style.display = 'none';
    if (project.error) status(`Could not write to the project folder: ${project.error.message}`, true);
  } else {
    document.title = doc.history.length ? 'Not saved: Workingtitle3D' : 'Workingtitle3D';
    projBtn.style.display = doc.history.length ? '' : 'none';
  }
}

function watch(p) {
  project = p;
  p.onstate = () => updateHeader();
  updateHeader();
}

// ---- the home folder: projects/<name>/ inside it ----------------------------------------
let home = null;

// Browsers without folder access (Firefox, Safari, Brave unless its flag is on) keep projects in
// their own storage instead: the same autosave, the same projects list, kept on this computer.
const noFolders = () => typeof window.showDirectoryPicker !== 'function';
const inBrowser = () => !!home?.virtual;
/** The remembered home: the picked folder, or browser storage where there is no folder access. */
const savedHome = async () => (noFolders() ? { home: await browserHome(), state: 'granted' } : folders.savedHome());

/** The home folder, ready to write. Call from a click: it may need to ask. */
async function ensureHome() {
  if (home) return home;
  if (noFolders()) {
    try { home = await browserHome(); } catch (err) { status(`This browser will not keep projects: ${err.message}. Save file still writes a .wt3d.`, true); return false; }
    return home;
  }
  const saved = await folders.savedHome();
  try {
    if (saved.home && saved.state === 'granted') return (home = saved.home);
    if (saved.home) {
      // the browser wants a click before it gives the folder back
      const go = await ask(`Allow the projects folder (${saved.home.name}) again?`, [['Cancel', false], ['Allow', true, true]]);
      if (!go) return null;
      if (await folders.allow(saved.home)) return (home = saved.home);
    }
    const go = await ask(h('div', {}, h('p', {}, 'Pick the folder this app lives in (the Workingtitle3D folder).'),
      h('p', {}, 'Projects are kept in a projects folder inside it. This is asked once; after that the app remembers it.')),
      [['Cancel', false], ['Pick folder', true, true]]);
    if (!go) return null;
    home = await folders.pickHome();
    return home;
  } catch (err) {
    if (err.name === 'AbortError') return null;
    status(`Could not use that folder: ${err.message}`, true);
    return false;   // an error, already shown
  }
}

/** In-page dialog asking for a project name. */
function askName(message, def) {
  return new Promise(res => {
    const input = h('input', { type: 'text', class: 'name-in', value: def, spellcheck: 'false' });
    const d = h('dialog', {}, h('div', {}, message), h('div', { class: 'row' }, input));
    const done = v => { d.close(); d.remove(); res(v); };
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(folders.cleanName(input.value) || null); if (e.key === 'Escape') done(null); });
    d.append(h('div', { class: 'row' }, button('Cancel', () => done(null)), button('Save', () => done(folders.cleanName(input.value) || null), { go: true })));
    d.addEventListener('cancel', () => done(null));
    document.body.append(d);
    d.showModal();
    input.select();
  });
}

async function nextUntitled() {
  const names = home ? await folders.listProjects(home) : [];
  let n = 1;
  while (names.includes(`Untitled ${n}`)) n++;
  return `Untitled ${n}`;
}

async function askForFolder() { await saveToProjects(); }

/** Save the current parts as a new named project under projects/. */
async function saveToProjects() {
  const got = await ensureHome();
  if (!got) { if (got === null) status('Not saved to disk yet. "Save as project" (top right) when ready.'); return; }
  const taken = await folders.listProjects(home);
  let name = await askName(inBrowser() ? 'Name this project. Every step is saved as you work, in this browser on this computer (this browser has no folder access). Save file writes a copy you can keep anywhere.'
    : 'Name this project. Every step is saved in projects/ as you work.', await nextUntitled());
  while (name && taken.includes(name)) name = await askName(`"${name}" already exists. Pick another name.`, name + ' 2');
  if (!name) { status('Not saved to disk yet. "Save as project" (top right) when ready.'); return; }
  try {
    const dir = await folders.projectFolder(home, name, true);
    watch(await Project.create(dir, doc));
    await folders.remember('last', name); lastProject = name;
    status(inBrowser() ? `Saving ${name} in this browser. Every step is kept as you work.` : `Saving to projects/${name}. Every step is written there.`);
  } catch (err) { status(`Could not start the project: ${err.message}`, true); }
}
const pickProjectFolder = saveToProjects;

/** Rename the project: its folder under projects/ is copied to the new name, then the old one removed. */
async function renameProject() {
  if (!project) return saveToProjects();
  const pdir = home && await folders.projectsDir(home);
  const inside = pdir && (await pdir.resolve(project.dir).catch(() => null))?.length === 1;
  if (!inside) { status(`${project.name} is not in projects/, so rename its folder outside the app.`); return; }
  const old = project.name, taken = await folders.listProjects(home);
  let name = await askName('New name for this project.', old);
  while (name && name !== old && taken.includes(name)) name = await askName(`"${name}" already exists. Pick another name.`, name + ' 2');
  if (!name || name === old) return;
  try {
    await project.moveTo(await folders.projectFolder(home, name, true));
  } catch (err) {
    await pdir.removeEntry(name, { recursive: true }).catch(() => {});   // the half-made copy; the project stays where it was
    status(`Could not rename the project: ${err.message}`, true);
    return;
  }
  await pdir.removeEntry(old, { recursive: true }).catch(() => {});
  await folders.remember('last', name); lastProject = name;
  updateHeader();
  status(`Project renamed: ${old} is now ${name}.`);
}

function resetDoc() {
  cancelStep();
  project?.detach?.();
  project = null;
  doc = new Doc();
  bindDoc();
  meshes.clear();
  sel = [];
  lastDup = null;
  projectAsked = false;
  fileName = null;
}

async function newProject() {
  if (!project && doc.history.length && !(await ask('Drop the current parts? They are not saved to a folder.', [['Keep them', false], ['Drop them', true, true]]))) return;
  resetDoc();
  refresh();
  status('New project.');
}

/** Open: the list of projects, or another folder. */
async function openProject() {
  if (!(await ensureHome())) { projInput.click(); return; }   // no projects folder at all: files only
  const names = await folders.listProjects(home);
  const pick = await new Promise(res => {
    const d = h('dialog', {});
    const done = v => { d.close(); d.remove(); res(v); };
    const list = h('div', { class: 'projlist' }, ...names.map(n => button(n, () => done(n))));
    if (!names.length) list.append(h('p', {}, 'No projects yet.'));
    d.append(h('div', {}, 'Open a project'), list, h('div', { class: 'row' }, button('A .wt3d file...', () => done({ file: true })), noFolders() ? null : button('Other folder...', () => done({ other: true })), button('Cancel', () => done(null))));
    d.addEventListener('cancel', () => done(null));
    document.body.append(d);
    d.showModal();
  });
  if (!pick) return;
  if (pick.file) { projInput.click(); return; }
  if (pick.other) {
    try { await openFolder(await window.showDirectoryPicker({ mode: 'readwrite', id: 'wt3d-other' })); } catch (err) { if (err.name !== 'AbortError') status(err.message, true); }
    return;
  }
  await openFolder(await folders.projectFolder(home, pick));
  await folders.remember('last', pick); lastProject = pick;
}
async function openFolder(dir, { undoFirst = false } = {}) {
  if (!(await Project.exists(dir))) { status(`${dir.name} holds no project.`, true); return; }
  resetDoc();
  projectAsked = true;
  try {
    const { project: p, replayed, torn } = await Project.open(dir, doc);
    watch(p);
    // undone before anything is built, so a step that crashed the app is never run again
    const undone = undoFirst && doc.at ? doc.undo() : null;
    sentBlobs.clear();
    await refresh();
    viewer.view('iso');
    status(`Opened ${dir.name}: ${doc.parts.length} parts, ${doc.at} steps${replayed ? `, ${replayed} recovered from the log` : ''}${torn ? ', 1 unfinished step dropped' : ''}${undone ? `; undone: ${undone.label}` : ''}.`);
  } catch (err) { status(`Could not open ${dir.name}: ${err.message}`, true); }
}

// ---- project files (.wt3d) --------------------------------------------------------------------
async function openProjectFile(file) {
  if (!project && doc.history.length && !(await ask('Drop the current parts? They are not saved.', [['Keep them', false], ['Drop them', true, true]]))) return;
  try {
    const { snap, blobs } = await unpackProject(await file.arrayBuffer(), file.name);
    resetDoc();
    doc.load(snap, blobs);
    sentBlobs.clear();
    fileName = file.name;
    await refresh();
    viewer.view('iso');
    status(`Opened ${file.name}: ${doc.parts.length} parts, ${doc.at} steps. Changes ask for a project folder; Save file writes a .wt3d again.`);
  } catch (err) { status(`Could not open ${file.name}: ${err.message}`, true); }
}
async function saveProjectFile() {
  if (!doc.parts.length) { status('Nothing to save yet.'); return; }
  const bytes = packProject(doc);
  const name = (fileName || (project ? project.name + PROJECT_EXT : 'Untitled' + PROJECT_EXT));
  if (window.showSaveFilePicker) {
    let handle;
    try { handle = await window.showSaveFilePicker({ suggestedName: name, id: 'wt3d-project', types: [{ description: 'Workingtitle3D project', accept: { 'application/octet-stream': [PROJECT_EXT] } }] }); }
    catch (err) { if (err.name === 'AbortError') { status('Not saved.'); return; } }
    if (handle) {
      try {
        const w = await handle.createWritable(); await w.write(bytes); await w.close();
        // read it back: the same parts and every mesh
        await unpackProject(await (await handle.getFile()).arrayBuffer(), handle.name);
        fileName = handle.name;
        status(`Saved ${handle.name}: ${doc.parts.length} parts, ${doc.blobs.size} meshes, ${sizeText(bytes.length)}, read back and checked.`);
      } catch (err) { status(`Could not save: ${err.message}`, true); }
      return;
    }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  status(`Saved ${name} to downloads: ${doc.parts.length} parts, ${sizeText(bytes.length)}.`);
}
projInput.addEventListener('change', () => { const f = projInput.files[0]; projInput.value = ''; if (f) openProjectFile(f); });

/** Export: the file type, all parts or the selected ones (joined, or one file each), the
 *  name, then where. The choices are kept for Export as... (Ctrl+Shift+E). */
let expWhat = 'all', expSplit = 'joined', expName = '';
async function exportDialog() {
  const pick = await new Promise(res => {
    const d = h('dialog', { class: 'expdlg' });
    const done = v => { d.close(); d.remove(); res(v); };
    let f = fmt, what = sel.length ? 'sel' : 'all', split = expSplit;   // parts selected: those are what goes out, unless All is picked
    const nameIn = h('input', { type: 'text', class: 'name-in', spellcheck: 'false', 'aria-label': 'File name' });
    nameIn.value = defaultExportName(what);
    nameIn.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') go.click(); if (e.key === 'Escape') done(null); });
    const whatSeg = seg([['all', 'All'], ['sel', 'Selected']], what, v => { what = v; if (!nameTouched) nameIn.value = defaultExportName(v); upd(); });
    let nameTouched = false;
    nameIn.addEventListener('input', () => { nameTouched = true; upd(); });
    const selBtn = whatSeg.querySelector('[data-v="sel"]');
    if (!sel.length) { selBtn.disabled = true; ui.tip(selBtn, 'Select parts first'); }
    const splitSeg = seg([['joined', 'Joined'], ['each', 'One each']], split, v => { split = v; upd(); });
    const splitRow = h('div', { class: 'field wide' }, h('label', {}, 'Several'), splitSeg);
    const note = h('div', { class: 'note' });
    const upd = () => {
      const many = what === 'sel' && sel.length > 1;
      splitRow.style.display = many ? '' : 'none';
      const n = what === 'sel' ? sel.length : doc.parts.filter(p => !p.hidden && !p.hole).length;
      const base = folders.cleanName(nameIn.value) || 'model';
      const files = many && split === 'each' ? `${base}-0.${f} to ${base}-${n - 1}.${f}` : `${base}.${f}`;
      note.textContent = `Writes ${files}.`;
    };
    const go = button(home && !inBrowser() ? 'Export to exports/' : 'Export', () => done({ f, what, split, name: nameIn.value, pick: false }), { go: true });
    d.append(h('h3', {}, 'Export'),
      h('div', { class: 'field wide' }, h('label', {}, 'Type'), seg([['stl', 'STL'], ['3mf', '3MF'], ['obj', 'OBJ']], f, v => { f = v; upd(); })),
      h('div', { class: 'field wide' }, h('label', {}, 'Parts'), whatSeg),
      splitRow,
      h('div', { class: 'field wide' }, h('label', {}, 'Name'), nameIn),
      note,
      h('div', { class: 'row' }, go, button('Choose where...', () => done({ f, what, split, name: nameIn.value, pick: true })), button('Cancel', () => done(null))));
    upd();
    d.addEventListener('cancel', () => done(null));
    document.body.append(d);
    d.showModal();
  });
  if (!pick) return;
  fmt = pick.f; expWhat = pick.what; expSplit = pick.split; expName = folders.cleanName(pick.name) || '';
  await exportModel(pick.pick);
}
function defaultExportName(what) {
  if (what === 'sel' && sel.length === 1) return doc.top(sel[0])?.name || 'part';
  return project?.name || 'model';
}

// ---- import and export ----------------------------------------------------------------------
async function importFiles(files) {
  for (const file of files) {
    status(`Reading ${file.name}...`);
    if (file.name.toLowerCase().endsWith(PROJECT_EXT)) {
      try {
        const { snap, blobs } = await unpackProject(await file.arrayBuffer(), file.name);
        const ids = doc.importParts(snap.parts, blobs, `Import ${file.name}`);
        setSel(ids);
        status(`Imported ${ids.length} part${ids.length === 1 ? '' : 's'} from ${file.name}.`);
      } catch (err) { status(`${file.name}: ${err.message}`, true); }
      continue;
    }
    const lower = file.name.toLowerCase();
    if (IMAGE_EXT.some(x => lower.endsWith(x))) { await importPicture(file); continue; }
    try {
      const buf = await file.arrayBuffer();
      let r;
      if (lower.endsWith('.step') || lower.endsWith('.stp')) {
        // STEP: the CAD reader turns its surfaces into triangles (within 0.01 mm), then the
        // same repair and checks as any mesh
        const s = await pool.call('cad', { type: 'read', buf }, [buf], (f, t) => status(`${file.name}: ${t}...`));
        status(`${file.name}: checking...`);
        r = await pool.call('io', { type: 'load', name: file.name, tris: s.tris }, [s.tris.buffer]);
      } else r = await pool.call('io', { type: 'load', name: file.name, buf }, [buf]);
      const open = r.report.watertight ? '' : (() => { const f = r.fixes || {}; return ` Not fully closed (${describe(r.report).replace(/^not closed: /, '')}${f.shells ? `; ${f.shells} pieces, ${f.droppedShells || 0} will not close` : ''}). It still works; Repair in its options closes it.`; })();
      const blob = doc.addBlob(r.tris);
      const b = localBounds(r.tris);
      // out of the way: its corner nearest the middle at 100 mm left and 100 mm back (as the
      // view sees the plate), on the lattice; the model runs on left and back from there
      const ax = viewer.screenAxes(new Vector3(0, 0, 0));
      const pos = [0, 0, -b.lo[2]];
      for (const [dir, far] of [[ax.right, true], [ax.up, false]]) {
        const k = dir[0] ? 0 : 1, s = dir[k], a = (far ? -100 : 100) * s;
        pos[k] = far ? (s > 0 ? a - b.hi[k] : a - b.lo[k]) : (s > 0 ? a - b.lo[k] : a - b.hi[k]);
      }
      // the same file again: a name of its own (brick 2, brick 3) and a place beside the last
      // copy, so it does not sit exactly on top and look as if nothing came in
      const gap = (b.hi[0] - b.lo[0]) + 5;
      const others = doc.parts.filter(q => q.kind === 'mesh' && q.blob === blob).map(q => worldBox(q)).filter(Boolean);
      const overlaps = () => others.some(w => pos[0] + b.lo[0] < w.max.x && w.min.x < pos[0] + b.hi[0] && pos[1] + b.lo[1] < w.max.y && w.min.y < pos[1] + b.hi[1]);
      for (let k = 0; k < 1000 && overlaps(); k++) pos[0] -= gap;
      const id = doc.add({ kind: 'mesh', blob, name: uniqueName(file.name.replace(/\.[^.]+$/, '')),
        xform: { pos: pos.map(v => +v.toFixed(6)), rot: [0, 0, 0], scale: [1, 1, 1] } }, `Import ${file.name}`);
      setSel([id]);
      const f = r.fixes;
      const fixed = [f.degenerate && `${f.degenerate} zero-area dropped`, f.duplicates && `${f.duplicates} duplicates dropped`, f.tjunctions && `${f.tjunctions} T-junctions split`, f.holes && `${f.holes} holes filled`, f.reoriented && `${f.reoriented} faces re-wound`, f.flipped && 'turned right way out', f.shells > 1 && `${f.shells} shells joined`, f.droppedShells && `${f.droppedShells} unclosable shells left out`, f.bridged && `${f.bridged} touching edges bridged 0.2 mm wide`].filter(Boolean);
      status(`Imported ${file.name}${fixed.length ? ' (' + fixed.join(', ') + ')' : ''}.${open}`);
    } catch (err) { status(`${file.name}: ${err.message}`, true); }
  }
}

const MIME = { stl: 'model/stl', '3mf': 'model/3mf', obj: 'model/obj' };
/** A name not yet used in this folder: name.stl, name-1.stl, name-2.stl ... */
async function freeName(dir, base, ext) {
  const exists = async n => { try { await dir.getFileHandle(n); return true; } catch { return false; } };
  if (!(await exists(`${base}.${ext}`))) return `${base}.${ext}`;
  for (let i = 1; ; i++) if (!(await exists(`${base}-${i}.${ext}`))) return `${base}-${i}.${ext}`;
}
const fileExists = async (dir, n) => { try { await dir.getFileHandle(n); return true; } catch { return false; } };

/** Export with the dialog's choices: into exports/ next to projects/ (one file never
 *  overwrites: -1, -2 are added; numbered files ask before replacing), or pick = true
 *  (Export as...) asks where. Each file is read back and checked after it is written. */
async function exportModel(pick = false) {
  const chosen = expWhat === 'sel' ? sel.map(id => doc.top(id)).filter(Boolean) : doc.parts;
  if (!chosen.length) { status(expWhat === 'sel' ? 'Select the parts to export, or pick All parts.' : 'Nothing to export.'); return; }
  const base = expName || folders.cleanName(defaultExportName(expWhat)) || 'model';
  // one file per part only when several are chosen; numbers start at 0
  const jobs = expWhat === 'sel' && expSplit === 'each' && chosen.length > 1
    ? chosen.map((p, i) => ({ parts: [p], name: `${base}-${i}.${fmt}`, label: p.name }))
    : [{ parts: chosen, name: `${base}.${fmt}` }];
  // where: a folder (exports/ or one picked), one file picked, or downloads
  let dir = null, handle = null;
  if (!pick && home && !inBrowser()) {   // exports in browser storage could not be reached: those go to downloads
    try { dir = await home.getDirectoryHandle('exports', { create: true }); } catch (err) { status(`Could not use the exports folder: ${err.message}`, true); return; }
    if (jobs.length === 1) jobs[0].name = await freeName(dir, base, fmt);
  } else if (window.showSaveFilePicker) {
    // ask for the place first, while the click still counts as a click
    try {
      if (jobs.length > 1) dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'wt3d-export' });
      else handle = await window.showSaveFilePicker({ suggestedName: jobs[0].name, id: 'wt3d-export', types: [{ description: fmt.toUpperCase(), accept: { [MIME[fmt]]: ['.' + fmt] } }] });
    } catch (err) { if (err.name === 'AbortError') { status('Export cancelled.'); return; } status(err.message, true); return; }
  }
  if (dir && jobs.length > 1) {
    const there = [];
    for (const j of jobs) if (await fileExists(dir, j.name)) there.push(j.name);
    if (there.length && !(await ask(`${there.length} of these files are already in ${dir.name}/ (${there.slice(0, 3).join(', ')}${there.length > 3 ? ' ...' : ''}). Replace them?`, [['Cancel', false], ['Replace', true, true]]))) { status('Export cancelled.'); return; }
  }
  let bridge = null;   // asked once per export
  const done = [];
  const tExport = performance.now();
  for (const [i, j] of jobs.entries()) {
    const tag = jobs.length > 1 ? ` (${i + 1} of ${jobs.length})` : '';
    status(`Joining parts${tag}...`);
    let out, bridged = 0, openParts = 0, closedText = 'one closed solid';
    try {
      await sendBlobs();
      let { tris, thin, open } = await pool.call('kern', { type: 'flatten', parts: j.parts });
      if (thin) {
        // parts only touching along an edge: offer to join them for this file
        if (bridge === null) {
          bridge = await ask(h('div', {}, h('p', {}, thin),
            h('p', {}, 'Join them with a 0.2 mm wide bridge along where they touch? Only the exported file gets it; the model stays as it is. Or export it as it is.')),
            [['Cancel', 'cancel'], ['Export as it is', false], ['Join and export', true, true]]);
          if (bridge === 'cancel' || bridge == null) { status('Export cancelled.'); return; }
        }
        if (bridge) {
          status(`Joining parts with a bridge${tag}...`);
          ({ tris, bridged } = await pool.call('kern', { type: 'flatten', parts: j.parts, bridge: true }));
        } else closedText = 'parts touching along an edge, as they are';
      }
      openParts = open || 0;
      out = [(await pool.call('io', { type: 'save', tris, fmt, open: openParts }, [tris.buffer])).bytes];
    } catch (err) { status(`${j.label || j.name}: ${err.message}`, true); return; }
    const notClosed = openParts ? `not closed (${openParts} part${openParts > 1 ? 's are' : ' is'} open, written as ${openParts > 1 ? 'they are' : 'it is'})` : closedText;
    const fh = handle || (dir && await dir.getFileHandle(j.name, { create: true }).catch(err => { status(`Could not write ${j.name}: ${err.message}`, true); return null; }));
    if (dir && !fh) return;
    if (fh) {
      try {
        const w = await fh.createWritable();
        for (const c of out) await w.write(c);
        await w.close();
        const buf = await (await fh.getFile()).arrayBuffer();
        status(`Reading ${fh.name} back${tag}...`);
        const r = await pool.call('io', { type: 'check', name: fh.name, buf }, [buf]);
        if (!r.report.watertight && !openParts && closedText === 'one closed solid') closedText = describe(r.report);
        done.push(`${fh.name}: ${openParts ? notClosed : closedText}, ${count(r.report.triangles)} triangles${bridged ? `, bridged where parts touched (${bridged} edges)` : ''}`);
      } catch (err) { status(`Could not write ${fh.name}: ${err.message}`, true); return; }
      continue;
    }
    const url = URL.createObjectURL(new Blob(out, { type: MIME[fmt] }));
    const a = h('a', { href: url, download: j.name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    done.push(`${j.name}: ${notClosed}`);
  }
  const where = handle ? '' : dir ? `${pick ? dir.name : 'exports'}/` : 'downloads: ';
  status(`Exported ${where}${done.join('; ')}. ${handle || dir ? 'Read back and checked' : 'Checked before writing'}, ${((performance.now() - tExport) / 1000).toFixed(1)} s.`);
}

// ---- floating panels (plate picture, background picture, theme builder) --------------------------
// One at a time, over the top left of the view, beside the view buttons. They change things live
// and close with their Close button or Esc.
let floatEl = null;
function floatPanel(title, kids, cls = '') {
  closeFloat();
  floatEl = h('div', { class: 'card floatpanel ' + cls, role: 'dialog', 'aria-label': title },
    h('h3', {}, title, h('span', { class: 'grow' }), button('Close', () => closeFloat(), { small: true })), ...kids);
  floatEl.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeFloat(); } });
  // drag it by its title bar anywhere over the view; it stays where it was put while open
  const bar = floatEl.firstChild, el = floatEl;
  bar.classList.add('dragbar');
  bar.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    e.preventDefault();   // no text selection sweeping across the page
    const r = el.getBoundingClientRect(), v = view.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    bar.setPointerCapture(e.pointerId);
    const move = ev => {
      el.style.left = Math.max(0, Math.min(v.width - r.width, ev.clientX - v.left - dx)) + 'px';
      el.style.top = Math.max(0, Math.min(v.height - 40, ev.clientY - v.top - dy)) + 'px';
    };
    const up = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  });
  if (floatAt[cls]) Object.assign(el.style, floatAt[cls]);
  new MutationObserver(() => { floatAt[cls] = { left: el.style.left, top: el.style.top }; }).observe(el, { attributes: true, attributeFilter: ['style'] });
  view.append(floatEl);
  return floatEl;
}
const floatAt = {};   // where each kind of panel was last put, this session
function closeFloat() { floatEl?.remove(); floatEl = null; }
const pickFile = accept => new Promise(res => {
  const i = h('input', { type: 'file', accept, style: 'display:none' });
  i.addEventListener('change', () => { res(i.files[0] || null); i.remove(); });
  i.addEventListener('cancel', () => { res(null); i.remove(); });
  document.body.append(i);
  i.click();
});
const fieldRow = (label, el) => h('div', { class: 'field wide' }, h('label', {}, label), el);
const num = (label, v, unit, set, o = {}) => ui.numfield(label, v, unit, set, { lazy: true, digits: 2, step: 1, ...o });

// a picture on the plate, under the grid, to model over (session only)
let platePic = null;   // {image, name, w, d, x, y, rot, opacity, aspect}
function showPlatePic() { viewer.setPlateImage(platePic && { ...platePic }); }
async function loadPlatePic(file, w = 200) {
  // drawn into a canvas first: a bitmap handed to the view straight would land upside down
  const bmp = await createImageBitmap(file);
  const image = document.createElement('canvas');
  image.width = bmp.width; image.height = bmp.height;
  image.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  const aspect = image.height / image.width;
  platePic = { image, file, name: file.name, w, d: +(w * aspect).toFixed(2), x: 0, y: 0, rot: 0, opacity: 0.8, aspect, mirrorX: false, mirrorY: false };
  showPlatePic();
  status(`${file.name} lies on the plate, ${mm(platePic.w)} x ${mm(platePic.d)} mm. View > Plate picture sets its size and place.`);
}
function showPlatePicPanel() {
  const body = [];
  const load = button(platePic ? 'Other picture...' : 'Pick a picture...', async () => { const f = await pickFile(IMAGE_EXT.join(',')); if (f) { await loadPlatePic(f, platePic?.w || 200); showPlatePicPanel(); } });
  body.push(h('div', { class: 'row' }, load));
  if (platePic) {
    const P = platePic, set = (k, v) => { P[k] = v; if (k === 'w') P.d = +(v * P.aspect).toFixed(3); if (k === 'd') P.w = +(v / P.aspect).toFixed(3); showPlatePic(); };
    // width and depth keep the picture's shape: each follows the other
    const wField = num('Width', P.w, 'mm', v => { set('w', v); dField.set(P.d); }, { min: 0.1 });
    const dField = num('Depth', P.d, 'mm', v => { set('d', v); wField.set(P.w); }, { min: 0.1 });
    body.push(h('div', { class: 'note' }, P.name), wField, dField,
      num('Center X', P.x, 'mm', v => set('x', v)),
      num('Center Y', P.y, 'mm', v => set('y', v)),
      num('Turn', P.rot, 'deg', v => set('rot', v), { step: 15 }),
      ui.check('Mirror left to right', P.mirrorX, v => set('mirrorX', v)),
      ui.check('Mirror front to back', P.mirrorY, v => set('mirrorY', v)),
      ui.slider('See-through', Math.round((1 - P.opacity) * 100), '%', { min: 0, max: 95, step: 5 }, v => set('opacity', 1 - v / 100)),
      h('div', { class: 'row' }, button('Remove', () => { platePic = null; showPlatePic(); showPlatePicPanel(); status('Plate picture removed.'); })));
  }
  ui.tip(load, 'A picture lying flat on the plate under the grid, to model over. Not saved with the project.');
  floatPanel('Plate picture', body);
}

// a picture behind the view, tilted and scaled to line up with the model (session only)
const backdropImg = h('img', { class: 'backdrop', alt: '', style: 'display:none' });
view.prepend(backdropImg);
let backdrop = null;   // {url, file, name, opacity, x, y, scale, tiltX, tiltY, turn, depth}
const BACKDROP0 = { opacity: 1, x: 0, y: 0, scale: 100, tiltX: 0, tiltY: 0, turn: 0, depth: 1200, mirror: false };
function showBackdrop() {
  const b = backdrop;
  backdropImg.style.display = b ? '' : 'none';
  viewer.setBackdrop(!!b);
  if (!b) { backdropImg.removeAttribute('src'); return; }
  if (backdropImg.getAttribute('src') !== b.url) backdropImg.src = b.url;
  backdropImg.style.opacity = b.opacity;
  backdropImg.style.transform = `translate(${b.x}%, ${b.y}%) perspective(${b.depth}px) rotateX(${b.tiltX}deg) rotateY(${b.tiltY}deg) rotate(${b.turn}deg) scale(${b.scale / 100}) scaleX(${b.mirror ? -1 : 1})`;
}
async function setBackdropFile(file) {
  if (backdrop?.url?.startsWith('blob:')) URL.revokeObjectURL(backdrop.url);
  backdrop = { ...BACKDROP0, ...(backdrop && { ...backdrop }), url: URL.createObjectURL(file), file, name: file.name };
  showBackdrop();
  status(`${file.name} is behind the view. View > Background picture tilts and scales it; View > Show grid hides the grid.`);
}
function showBackdropPanel() {
  const body = [h('div', { class: 'row' }, button(backdrop ? 'Other picture...' : 'Pick a picture...', async () => { const f = await pickFile(IMAGE_EXT.join(',')); if (f) { await setBackdropFile(f); showBackdropPanel(); } }))];
  if (backdrop) {
    const B = backdrop, set = (k, v) => { B[k] = v; showBackdrop(); };
    body.push(h('div', { class: 'note' }, B.name),
      ui.slider('Scale', B.scale, '%', { min: 5, max: 400, step: 1 }, v => set('scale', v)),
      ui.slider('Move right', B.x, '%', { min: -100, max: 100, step: 0.5, digits: 1 }, v => set('x', v)),
      ui.slider('Move down', B.y, '%', { min: -100, max: 100, step: 0.5, digits: 1 }, v => set('y', v)),
      ui.slider('Tilt back', B.tiltX, 'deg', { min: -80, max: 80, step: 0.5, digits: 1 }, v => set('tiltX', v)),
      ui.slider('Tilt sideways', B.tiltY, 'deg', { min: -80, max: 80, step: 0.5, digits: 1 }, v => set('tiltY', v)),
      ui.slider('Turn', B.turn, 'deg', { min: -180, max: 180, step: 0.5, digits: 1 }, v => set('turn', v)),
      ui.check('Mirror', B.mirror, v => set('mirror', v)),
      ui.slider('Depth', B.depth, 'px', { min: 200, max: 4000, step: 10 }, v => set('depth', v)),
      ui.slider('See-through', Math.round((1 - B.opacity) * 100), '%', { min: 0, max: 95, step: 5 }, v => set('opacity', 1 - v / 100)),
      h('div', { class: 'row' }, button('Reset', () => { Object.assign(B, BACKDROP0); showBackdrop(); showBackdropPanel(); }), button('Remove', () => { URL.revokeObjectURL(B.url); backdrop = null; showBackdrop(); showBackdropPanel(); status('Background picture removed.'); })));
  }
  ui.tip(body[0].firstChild, 'A picture behind the model, to see a print in its place. It stays put on the screen, so it lines up from one view: turning the view moves the model, not the picture. Not saved with the project; a theme file can carry it.');
  floatPanel('Background picture', body);
}

// a picture opened or dropped: trace it into a part, lay it on the plate, or put it behind the view
async function importPicture(file) {
  let image;
  try { image = await createImageBitmap(file); } catch { status(`${file.name}: this picture could not be read.`, true); return; }
  const W = image.width, H = image.height;
  const cv = new OffscreenCanvas(W, H), cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(image, 0, 0);
  const data = cx.getImageData(0, 0, W, H);
  const o = { use: 'trace', threshold: 128, dark: true, smooth: 1, speck: 4, width: 100, height: 2 };
  let traced = null;
  const choice = await new Promise(res => {
    const d = h('dialog', { class: 'picdlg' });
    const done = v => { d.close(); d.remove(); res(v); };
    const prev = h('canvas', { class: 'picprev' });
    const scale = Math.min(1, 360 / W, 240 / H);
    prev.width = Math.max(1, Math.round(W * scale)); prev.height = Math.max(1, Math.round(H * scale));
    const pc = prev.getContext('2d');
    const note = h('div', { class: 'note' });
    const traceBox = h('div');
    let timer = 0;
    const redraw = () => {
      pc.imageSmoothingEnabled = true;
      pc.clearRect(0, 0, prev.width, prev.height);
      pc.globalAlpha = o.use === 'trace' ? 0.45 : 1;
      pc.drawImage(image, 0, 0, prev.width, prev.height);
      pc.globalAlpha = 1;
      if (o.use !== 'trace') { note.textContent = ''; return; }
      traced = trace(data, o);
      const glow = getComputedStyle(document.documentElement).getPropertyValue('--glow').trim() || '#7dcf7d';
      pc.strokeStyle = glow; pc.lineWidth = 1.5;
      for (const l of traced.loops) {
        pc.beginPath();
        for (let i = 0; i < l.length; i += 2) pc[i ? 'lineTo' : 'moveTo'](l[i] * scale, l[i + 1] * scale);
        pc.closePath(); pc.stroke();
      }
      const mmpx = o.width / W;
      note.textContent = traced.loops.length
        ? `${traced.loops.length} outline${traced.loops.length > 1 ? 's' : ''}, ${traced.loops.reduce((n, l) => n + l.length / 2, 0).toLocaleString('en-US')} points. Part ${mm(o.width)} x ${mm(H * mmpx)} x ${mm(o.height)} mm.`
        : 'No outline at this threshold: move it, or switch Solid between Dark and Light.';
    };
    const later = () => { clearTimeout(timer); timer = setTimeout(redraw, 120); };
    traceBox.append(
      ui.slider('Threshold', o.threshold, '', { min: 1, max: 255, step: 1 }, v => { o.threshold = v; later(); }),
      fieldRow('Solid is', seg([['dark', 'Dark'], ['light', 'Light']], 'dark', v => { o.dark = v === 'dark'; later(); })),
      num('Smoothing', o.smooth, 'px', v => { o.smooth = v; later(); }, { min: 0, step: 0.5 }),
      num('Drop specks under', o.speck, 'px2', v => { o.speck = v; later(); }, { min: 0, step: 1 }),
      num('Width', o.width, 'mm', v => { o.width = v; later(); }, { min: 0.01 }),
      num('Height', o.height, 'mm', v => { o.height = v; }, { min: 0.01, step: 0.5 }));
    const plateBox = h('div', { style: 'display:none' }, num('Width on the plate', 200, 'mm', v => { o.plateW = v; }, { min: 0.1 }),
      h('div', { class: 'note' }, 'View > Plate picture moves, turns and sizes it later.'));
    const bgBox = h('div', { style: 'display:none' }, h('div', { class: 'note' }, 'View > Background picture tilts, scales and moves it.'));
    const go = button('Add part', () => done(o.use), { go: true });
    const useSeg = seg([['trace', 'Trace'], ['plate', 'On the plate'], ['back', 'Background']], 'trace', v => {
      o.use = v;
      traceBox.style.display = v === 'trace' ? '' : 'none'; plateBox.style.display = v === 'plate' ? '' : 'none'; bgBox.style.display = v === 'back' ? '' : 'none';
      go.textContent = { trace: 'Add part', plate: 'Lay it down', back: 'Put it behind' }[v];
      redraw();
    });
    d.append(h('h3', {}, `${file.name}  (${W} x ${H} px)`), useSeg, prev, traceBox, plateBox, bgBox, note,
      h('div', { class: 'row' }, go, button('Cancel', () => done(null))));
    d.addEventListener('cancel', () => done(null));
    document.body.append(d);
    d.showModal();
    redraw();
  });
  if (!choice) { status('Picture not used.'); return; }
  if (choice === 'plate') { await loadPlatePic(file, o.plateW || 200); return; }
  if (choice === 'back') { await setBackdropFile(file); return; }
  traced ||= trace(data, o);
  if (!traced.loops.length) { status(`${file.name}: no outline at that threshold, so no part was made.`, true); return; }
  const k = o.width / W;
  const rings = traced.loops.map(l => { const r = []; for (let i = 0; i < l.length; i += 2) r.push([(l[i] - W / 2) * k, (H / 2 - l[i + 1]) * k]); return r; });
  try {
    status(`${file.name}: extruding...`);
    const r = await pool.call('kern', { type: 'extrude', rings, height: o.height });
    const blob = doc.addBlob(r.tris);
    const id = doc.add({ kind: 'mesh', blob, name: uniqueName(file.name.replace(/\.[^.]+$/, '')), xform: defaultSpot() }, `Trace ${file.name}`);
    setSel([id]);
    status(`Traced ${file.name}: ${traced.loops.length} outlines, ${mm(o.width)} mm wide, ${mm(o.height)} mm high.`);
  } catch (err) { status(`${file.name}: ${err.message}`, true); }
}

// ---- theme builder ------------------------------------------------------------------------------
// Every color of the app and the view, by what it is used for. Pick one, move it, and the app
// changes as you go; a small preview marks where it is used (in words and a dashed frame, not
// by hue). Saved and loaded as a file; the last one is remembered with the other settings.
const THEME_ROLES = [
  ['--bg', 'Background', 'Behind everything: the page, the panel'],
  ['--panel', 'Panels', 'Cards, menus, dialogs'],
  ['--hex', 'Controls', 'Buttons and lists'],
  ['--hex-hover', 'Control under the pointer'],
  ['--hex-active', 'Control pressed'],
  ['--black', 'Number boxes', 'Inside typing boxes'],
  ['--border', 'Borders', 'Lines round panels and controls'],
  ['--gray', 'Quiet text', 'Labels and notes'],
  ['--gray-lt', 'Text', 'Most text'],
  ['--green', 'Accent', 'Good-state words'],
  ['--green-dk', 'Accent fill', 'Chosen tab, chosen button'],
  ['--green-dim', 'Accent line', 'Focus frames, dialog borders'],
  ['--glow', 'Bright accent', 'Values, ticks, chosen text'],
  ['--yellow', 'Error', 'ERROR lines only'],
  ['view.bg', 'View background', 'Behind the plate'],
  ['view.plate', 'Plate'],
  ['view.grid', 'Grid, 1 mm lines'],
  ['view.gridMajor', 'Grid, 10 mm lines'],
  ['view.select', 'Selected part outline'],
  ['view.inside', 'Inside of a cut'],
  ['view.guide', 'Guide lines on the plate'],
];
const VIEW_DEFAULT = { bg: '#0a0a0a', plate: '#111411', grid: '#333333', gridMajor: '#555555' };
const SCHEME_VIEW = { green: { select: '#7dcf7d', inside: '#2d5a2d', guide: '#3d7a3d' }, blue: { select: '#8cc4ff', inside: '#1f3d66', guide: '#2f5f99' }, mono: { select: '#ffffff', inside: '#3a3a3a', guide: '#6a6a6a' } };
let customTheme = null;   // {colors: {role: '#rrggbb'}} while a built theme is on
let themeSaveTimer = 0;
function themeNow() {
  const cs = getComputedStyle(document.documentElement), out = {};
  for (const [r] of THEME_ROLES) {
    if (r.startsWith('--')) out[r] = toHex(cs.getPropertyValue(r).trim());
    else out[r] = customTheme?.colors[r] || { ...VIEW_DEFAULT, ...SCHEME_VIEW[scheme] }[r.slice(5)];
  }
  return out;
}
function applyTheme(colors) {
  const root = document.documentElement;
  const view = {};
  for (const [r, v] of Object.entries(colors)) {
    if (!/^#[0-9a-f]{6}$/i.test(v)) continue;
    if (r.startsWith('--')) root.style.setProperty(r, v);
    else if (r.startsWith('view.')) view[r.slice(5)] = v;
  }
  viewer.setViewColors(view);
}
function clearTheme() {
  for (const [r] of THEME_ROLES) if (r.startsWith('--')) document.documentElement.style.removeProperty(r);
  customTheme = null;
  viewer.setViewColors({ ...VIEW_DEFAULT, ...SCHEME_VIEW[scheme] });
}
function toHex(c) {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + [...c.slice(1)].map(x => x + x).join('').toLowerCase();
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  return m ? '#' + m.slice(1, 4).map(x => (+x).toString(16).padStart(2, '0')).join('') : '#000000';
}
const hexToRgb = x => [1, 3, 5].map(i => parseInt(x.slice(i, i + 2), 16) / 255);
function rgbToHsl([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l * 100];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hh * 60, s * 100, l * 100];
}
function hslToHex(hh, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + hh / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}
const luminance = x => hexToRgb(x).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

function showThemeBuilder() {
  const colors = themeNow();
  let role = '--glow';
  const list = h('div', { class: 'rolelist', role: 'listbox', 'aria-label': 'Colors of the app' });
  const editor = h('div');
  const prevBox = h('div', { class: 'themeprev' });
  prevBox.dataset.roles = '--bg';
  const used = h('div', { class: 'note' });
  // the preview: a small panel and a small view, each element tagged with the roles it uses
  const P = (tag, roles, attrs, ...kids) => { const e = h(tag, attrs, ...kids); e.dataset.roles = roles; return e; };
  prevBox.append(
    P('div', '--panel --border', { class: 'tp-card' },
      P('div', '--gray', { class: 'tp-label' }, 'Width'),
      P('div', '--black --glow', { class: 'tp-field' }, '20.00'),
      P('div', '--hex --gray-lt --border', { class: 'tp-btn' }, 'Button'),
      P('div', '--green-dk --glow', { class: 'tp-on' }, 'Chosen'),
      P('div', '--hex-hover --glow', { class: 'tp-hover' }, 'Under pointer'),
      P('div', '--yellow', { class: 'tp-err' }, 'ERROR  example'),
      P('div', '--green-dim', { class: 'tp-focus' }, 'Focus frame')),
    P('div', 'view.bg', { class: 'tp-view' },
      P('div', 'view.plate view.grid view.gridMajor', { class: 'tp-plate' }),
      P('div', 'view.select', { class: 'tp-part' }),
      P('div', 'view.inside', { class: 'tp-cut' }),
      P('div', 'view.guide', { class: 'tp-guide' })));
  const paintPreview = () => {
    const c = colors, s = (sel, css) => prevBox.querySelectorAll(sel).forEach(e => Object.assign(e.style, css));
    prevBox.style.background = c['--bg'];
    prevBox.classList.toggle('uses', role === '--bg');
    s('.tp-card', { background: c['--panel'], borderColor: c['--border'] });
    s('.tp-label', { color: c['--gray'] });
    s('.tp-field', { background: c['--black'], color: c['--glow'], borderColor: c['--border'] });
    s('.tp-btn', { background: c['--hex'], color: c['--gray-lt'], borderColor: c['--border'] });
    s('.tp-on', { background: c['--green-dk'], color: c['--glow'] });
    s('.tp-hover', { background: c['--hex-hover'], color: c['--glow'] });
    s('.tp-err', { color: c['--yellow'] });
    s('.tp-focus', { borderColor: c['--green-dim'], color: c['--gray-lt'] });
    s('.tp-view', { background: c['view.bg'] });
    s('.tp-plate', { background: `${c['view.plate']} repeating-linear-gradient(90deg, ${c['view.gridMajor']} 0 1px, transparent 1px 30px), repeating-linear-gradient(0deg, ${c['view.grid']} 0 1px, transparent 1px 6px)` });
    s('.tp-part', { outlineColor: c['view.select'] });
    s('.tp-cut', { background: c['view.inside'] });
    s('.tp-guide', { borderColor: c['view.guide'] });
    prevBox.querySelectorAll('[data-roles]').forEach(e => e.classList.toggle('uses', e.dataset.roles.split(' ').includes(role)));
    const r = THEME_ROLES.find(x => x[0] === role);
    used.textContent = `${r[1]}: ${r[2] || 'see the marked part of the preview'}. Marked with a dashed frame above.`;
  };
  const set = (r, v) => {
    colors[r] = v;
    customTheme = { colors: { ...colors } };
    applyTheme({ [r]: v });
    clearTimeout(themeSaveTimer); themeSaveTimer = setTimeout(() => folders.remember('theme', customTheme?.colors || null).catch(() => {}), 300);   // not on every drag step
    paintPreview();
    const row = list.querySelector(`[data-r="${r}"]`);
    row.querySelector(".rv").textContent = v; row.querySelector(".chip").style.background = v;
  };
  const edit = () => {
    const v = colors[role], [hh, ss, ll] = rgbToHsl(hexToRgb(v));
    // a background is measured against the text on it; anything else against its background
    const [againstRole, againstName] = role === '--bg' || role === '--panel' || role === '--hex' || role === '--black' ? ['--gray-lt', 'Text']
      : role === 'view.bg' ? ['view.gridMajor', 'Grid, 10 mm lines'] : role.startsWith('view.') ? ['view.bg', 'View background'] : ['--bg', 'Background'];
    const ratio = h('div', { class: 'note' });
    const showRatio = () => { ratio.textContent = `Contrast with ${againstName}: ${contrast(colors[role], colors[againstRole]).toFixed(2)} to 1.`; };
    let H0 = hh, S0 = ss, L0 = ll;
    const hexIn = h('input', { type: 'text', class: 'hex-in', value: v, spellcheck: 'false', 'aria-label': 'Hex' });
    // the picker: a field of strength (across) and lightness (down) for the hue, and a hue strip.
    // A click picks; dragging keeps picking; arrow keys move it one step (Shift: ten).
    const field = h('canvas', { class: 'cpick', width: 220, height: 130, tabindex: 0, 'aria-label': 'Strength across, lightness down' });
    const strip = h('canvas', { class: 'cstrip', width: 220, height: 14, tabindex: 0, 'aria-label': 'Hue' });
    const paint = () => {
      const fx = field.getContext('2d'), W = field.width, Hh = field.height;
      for (let y = 0; y < Hh; y += 2) for (let x = 0; x < W; x += 2) { fx.fillStyle = hslToHex(H0, x / (W - 1) * 100, 100 - y / (Hh - 1) * 100); fx.fillRect(x, y, 2, 2); }
      const px = S0 / 100 * (W - 1), py = (1 - L0 / 100) * (Hh - 1);
      fx.lineWidth = 2; fx.strokeStyle = L0 > 50 ? '#000000' : '#ffffff'; fx.beginPath(); fx.arc(px, py, 6, 0, Math.PI * 2); fx.stroke();
      const sx = strip.getContext('2d');
      for (let x = 0; x < strip.width; x++) { sx.fillStyle = hslToHex(x / (strip.width - 1) * 359, 100, 50); sx.fillRect(x, 0, 1, strip.height); }
      const hx = H0 / 359 * (strip.width - 1);
      sx.lineWidth = 2; sx.strokeStyle = '#000000'; sx.strokeRect(hx - 2, 1, 4, strip.height - 2); sx.strokeStyle = '#ffffff'; sx.strokeRect(hx - 3, 0, 6, strip.height);
    };
    const apply = () => { const x = hslToHex(H0, S0, L0); hexIn.value = x; set(role, x); showRatio(); paint(); };
    const drag = (el, fn) => {
      el.addEventListener('pointerdown', e => { e.preventDefault(); el.focus(); el.setPointerCapture(e.pointerId); fn(e); });
      el.addEventListener('pointermove', e => { if (el.hasPointerCapture(e.pointerId)) fn(e); });
    };
    const at = (el, e) => { const r = el.getBoundingClientRect(); return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))]; };
    drag(field, e => { const [x, y] = at(field, e); S0 = x * 100; L0 = (1 - y) * 100; apply(); });
    drag(strip, e => { H0 = at(strip, e)[0] * 359; apply(); });
    field.addEventListener('keydown', e => {
      const d = e.shiftKey ? 10 : 1, k = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] }[e.key];
      if (!k) return; e.preventDefault(); e.stopPropagation();
      S0 = Math.max(0, Math.min(100, S0 + k[0])); L0 = Math.max(0, Math.min(100, L0 + k[1])); apply();
    });
    strip.addEventListener('keydown', e => {
      const d = (e.shiftKey ? 10 : 1) * ({ ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key] || 0);
      if (!d) return; e.preventDefault(); e.stopPropagation();
      H0 = (H0 + d + 360) % 360; apply();
    });
    hexIn.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') hexIn.blur(); });
    hexIn.addEventListener('change', () => { const x = hexIn.value.trim(); if (/^#?[0-9a-f]{6}$/i.test(x)) { set(role, (x[0] === '#' ? x : '#' + x).toLowerCase()); edit(); } else hexIn.classList.add('bad'); });
    editor.replaceChildren(h('div', { class: 'sub' }, THEME_ROLES.find(x => x[0] === role)[1]), field, strip,
      h('div', { class: 'hexrow' }, 'Hex', hexIn), ratio);
    paint();
    showRatio();
  };
  const pickRole = r => { role = r; list.querySelectorAll('.citem').forEach(b => { const on = b.dataset.r === r; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); b.querySelector('.ctick').textContent = on ? '✓' : ''; }); edit(); paintPreview(); };
  for (const [r, name] of THEME_ROLES) {
    const b = h('button', { type: 'button', class: 'citem', role: 'option', onclick: () => pickRole(r) },
      h('span', { class: 'ctick' }), h('span', { class: 'chip', style: `background:${colors[r]}` }), h('span', { class: 'rn' }, name), h('span', { class: 'rv' }, colors[r]));
    b.dataset.r = r;
    list.append(b);
  }
  list.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...list.children], i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault(); e.stopPropagation();
    const n = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
    n.focus(); pickRole(n.dataset.r);
  });
  // which pictures go in the file: either, both or neither (a box is greyed when that picture is not loaded)
  const withBack = ui.check('Include the background picture', !!backdrop, () => {});
  const withPlate = ui.check('Include the plate picture', !!platePic, () => {});
  if (!backdrop) { withBack.querySelector('input').disabled = true; ui.tip(withBack, 'No background picture is loaded'); }
  if (!platePic) { withPlate.querySelector('input').disabled = true; ui.tip(withPlate, 'No plate picture is loaded'); }
  const dataUrl = file => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
  const PLATE_KEYS = ['w', 'd', 'x', 'y', 'rot', 'opacity', 'mirrorX', 'mirrorY'];
  const save = button('Save theme...', async () => {
    const out = { app: 'Workingtitle3D', kind: 'theme', version: 1, colors: { ...colors } };
    if (withBack.querySelector('input').checked && backdrop?.file) {
      out.background = { ...Object.fromEntries(Object.keys(BACKDROP0).map(k => [k, backdrop[k]])), name: backdrop.name, data: await dataUrl(backdrop.file) };
    }
    if (withPlate.querySelector('input').checked && platePic?.file) {
      out.plate = { ...Object.fromEntries(PLATE_KEYS.map(k => [k, platePic[k]])), name: platePic.name, data: await dataUrl(platePic.file) };
    }
    const bytes = new TextEncoder().encode(JSON.stringify(out, null, 1));
    await saveBytes(bytes, 'my theme.wt3dtheme', 'Workingtitle3D theme', 'application/json', '.wt3dtheme');
  });
  const load = button('Load theme...', async () => {
    const f = await pickFile('.wt3dtheme,.json');
    if (!f) return;
    try {
      const t = JSON.parse(await f.text());
      if (t?.kind !== 'theme' || typeof t.colors !== 'object') throw new Error('not a Workingtitle3D theme');
      clearTheme();
      customTheme = { colors: { ...themeNow(), ...t.colors } };
      applyTheme(customTheme.colors);
      folders.remember('theme', customTheme.colors).catch(() => {});
      if (t.background?.data) {
        const file = new File([await (await fetch(t.background.data)).blob()], t.background.name || 'background');
        await setBackdropFile(file);
        Object.assign(backdrop, Object.fromEntries(Object.keys(BACKDROP0).filter(k => ['number', 'boolean'].includes(typeof t.background[k])).map(k => [k, t.background[k]])));
        showBackdrop();
      } else if (backdrop) { URL.revokeObjectURL(backdrop.url); backdrop = null; showBackdrop(); }
      if (t.plate?.data) {
        const file = new File([await (await fetch(t.plate.data)).blob()], t.plate.name || 'plate');
        await loadPlatePic(file, t.plate.w || 200);
        Object.assign(platePic, Object.fromEntries(PLATE_KEYS.filter(k => ['number', 'boolean'].includes(typeof t.plate[k])).map(k => [k, t.plate[k]])));
        showPlatePic();
      }
      const pics = [t.background?.data && 'background', t.plate?.data && 'plate'].filter(Boolean);
      status(`Theme ${f.name} loaded${pics.length ? ` with its ${pics.join(' and ')} picture${pics.length > 1 ? 's' : ''}` : ''}.`);
      showThemeBuilder();
    } catch (err) { status(`${f.name}: ${err.message}`, true); }
  });
  const reset = button('Back to built-in', () => { clearTheme(); folders.remember('theme', null).catch(() => {}); status(`Theme builder colors cleared: the ${SCHEMES.find(s => s[0] === scheme)[1]} scheme again.`); showThemeBuilder(); });
  floatPanel('Theme builder', [h('div', { class: 'themecols' }, list, h('div', {}, editor, prevBox, used)),
    withBack, withPlate, h('div', { class: 'row wrap' }, save, load, reset)], 'themepanel');
  pickRole(role);
}
/** Write bytes to a file the user picks, or to downloads. */
async function saveBytes(bytes, name, desc, mime, ext) {
  if (window.showSaveFilePicker) {
    try {
      const fh = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: desc, accept: { [mime]: [ext] } }] });
      const w = await fh.createWritable(); await w.write(bytes); await w.close();
      status(`Saved ${fh.name}.`);
      return;
    } catch (err) { if (err.name === 'AbortError') { status('Not saved.'); return; } }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  status(`Saved ${name} to downloads.`);
}
folders.recall('theme').then(c => { if (c && typeof c === 'object') { customTheme = { colors: c }; applyTheme(c); } });

// ---- keys -------------------------------------------------------------------------------------
importInput.addEventListener('change', () => { importFiles([...importInput.files]); importInput.value = ''; });
view.addEventListener('dragover', e => { e.preventDefault(); view.classList.add('dragging'); });
view.addEventListener('dragleave', () => view.classList.remove('dragging'));
view.addEventListener('drop', e => { e.preventDefault(); view.classList.remove('dragging'); importFiles([...e.dataTransfer.files]); });

function zoom(f) {
  const c = viewer.camera, t = viewer.controls.target;
  c.position.sub(t).multiplyScalar(f).add(t);
  viewer.request();
}

window.addEventListener('keyup', e => {
  // letting go of R hides the rings again, unless a turn is under way (that ends on release)
  if (e.key.toLowerCase() === 'r' && ringsHeld) { ringsHeld = false; if (!hdrag) viewer.setRings(rotateOn); }
});
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (document.querySelector('dialog[open]')) return;   // a dialog has the keys (Esc closes it); shortcuts wait
  const k = e.key.toLowerCase(), c = e.ctrlKey || e.metaKey, s = e.shiftKey;
  const act = fn => { e.preventDefault(); fn(); };
  if (c && k === 'z' && s) return act(redo);
  if (c && k === 'z') return act(undo);
  if (c && k === 'y') return act(redo);
  if (c && k === 'a') return act(() => setSel(doc.parts.filter(p => !p.hidden).map(p => p.id)));
  if (c && k === 'g' && s) return act(ungroupSel);
  if (c && k === 'g') return act(() => groupSel());
  if (c && k === 'i') return act(() => groupSel('intersect'));
  if (c && k === 'b') return act(() => status('Bundle (group without joining) is not built yet.'));
  if (c && k === 'h' && s) return act(showAll);
  if (c && k === 'h') return act(hideSel);
  if (c && k === 'l') return act(toggleLock);
  if (c && k === 'd') return act(duplicateSel);
  if (c && k === 'c') return act(copySel);
  if (c && k === 'x') return act(() => { copySel(); deleteSel(); });
  if (c && k === 'v') return act(paste);
  if (c && k === 'e') return act(() => exportModel(s));
  if (c && k === 'o') return act(openProject);
  if (placing && k === 'enter') return act(() => commitPlace(true));
  if (placing && k === 'escape') return act(cancelPlace);
  if (viewer.pickingFace && k === 'escape') return act(() => { viewer.pickingFace = false; status('Slide cancelled.'); });
  if (facePlane && sel.length === 1 && sel[0] === facePlane.id && k.startsWith('arrow')) return act(() => {
    // slide along the face it was placed on (Ctrl: straight off or into it)
    const d = moveStep * (s ? 10 : 1);
    const { u, v, n } = { ...viewer.planeAxes(facePlane.n), n: facePlane.n };
    const dir = c ? (k === 'arrowup' ? n : k === 'arrowdown' ? n.clone().negate() : null)
      : { arrowright: u, arrowleft: u.clone().negate(), arrowup: v, arrowdown: v.clone().negate() }[k];
    if (!dir) return;
    doc.update([facePlane.id], `Slide ${doc.top(facePlane.id).name}`, p => { p.xform.pos = p.xform.pos.map((x, i) => +(x + dir.getComponent(i) * d).toFixed(6)); });
  });
  if (c && (k === 'arrowup' || k === 'arrowdown')) return act(() => nudge(0, 0, (k === 'arrowup' ? 1 : -1) * moveStep * (s ? 10 : 1)));
  if (c) return;
  if (k.startsWith('arrow')) return act(() => {
    // follow the view: the part moves the way the arrow points on screen
    const b = viewer.bounds(sel);
    const ax = viewer.screenAxes(b ? b.getCenter(b.min.clone()) : null);
    const dir = { arrowright: ax.right, arrowleft: ax.right.map(v => -v), arrowup: ax.up, arrowdown: ax.up.map(v => -v) }[k];
    const d = moveStep * (s ? 10 : 1);
    nudge(dir[0] * d, dir[1] * d, 0);
  });
  if (k === 'delete' || k === 'backspace') return act(deleteSel);
  if (k === 'escape') return act(() => { if (openMenu) closeMenus(); else if (colorFor) closeColors(true); else if (floatEl) closeFloat(); else if (gridPop.style.display !== 'none') showGridPop(false); else if (step) cancelStep(); else if (past) endPast(); else setSel([]); });
  if (k === 'f' && s) return act(startSlidePick);
  if (k === 'f') return act(() => viewer.view(null, sel));
  if (k === 'h') return act(() => setHole(true));
  if (k === 's') return act(() => setHole(false));
  if (k === 'd') return act(dropToPlate);
  if (k === 'm') return act(() => mirrorSel(s ? 1 : e.altKey ? 2 : 0));
  if (k === '+' || k === '=') return act(() => zoom(0.8));
  if (k === '-' || k === '_') return act(() => zoom(1.25));
  if (k === 'r' && !c) return act(() => { if (!e.repeat) { ringsHeld = true; viewer.setRings(true); } });
  if (k === 'n' || k === 'c') {
    const what = { n: 'Notes', c: 'Cruise' }[k];
    return act(() => status(`${what} is not built yet.`));
  }
});

window.addEventListener('beforeunload', e => { if (project?.pending) { e.preventDefault(); } });

refresh();
viewer.view('iso');

// The app always starts empty (a reload is nearly always after a crash or a hang,
// and loading the same thing again would crash it again). File > Reopen brings the last
// project back, optionally with its last step undone first.
async function reopenLast() {
  const saved = await savedHome(), last = await folders.recall('last');
  if (!saved.home || !last) return;
  const undoBox = ui.check('Undo last action before loading', false, () => {});
  const go = await ask(h('div', {}, h('p', {}, `Reopen ${last}?${!project && doc.history.length ? ' The parts here are not saved and will go.' : ''}`), undoBox),
    [['Cancel', false], ['Reopen', true, true]]);
  if (!go) return;
  const undoFirst = undoBox.querySelector('input').checked;
  if (saved.state !== 'granted' && !(await folders.allow(saved.home).catch(() => false))) { status('The browser did not allow the projects folder.', true); return; }
  home = saved.home;
  let dir;
  try { dir = await folders.projectFolder(home, last); } catch { status(`The last project, ${last}, is gone from projects/.`, true); return; }
  await openFolder(dir, { undoFirst });
}
(async () => {
  const saved = await savedHome().catch(() => ({})), last = await folders.recall('last');
  if (!saved?.home || !last) return;
  lastProject = last;
  status(`File > Reopen ${last} brings back the last project.`);
})();
