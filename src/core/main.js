// The shell: shapes, parts, inspector, view, project folder, keys.
// Parts are recipes in the Doc; meshes come from the worker; tools are steps in a recipe.
import workerSrc from 'virtual:worker-src';
import cadSrc from 'virtual:cad-src';
import tools from 'virtual:tools-ui';
import { stlBytes, sizeText } from './decimate.js';
import { Viewer } from './viewer.js';
import * as ui from './ui.js';
import { Vector3, Box3, Quaternion, Euler, Matrix4, Matrix3, Plane } from 'three';
import { Doc, shapeKey, formKey, IDENT, matrix } from './doc.js';
import { Project, packProject, unpackProject, PROJECT_EXT } from './project.js';
import * as folders from './folders.js';
import { browserHome } from './idbfs.js';
import { describe, weld, volume as meshVolume, repair, report } from './meshcheck.js';
import { triangulate } from './tri2d.js';
import { trace } from './trace.js';
import { Stereo, STEREO_SCALES } from './stereo.js';
import { hasGlyph } from './font.js';
import { Surface, chart, deform, subdivide, gridSolid } from './wrap.js';
import { textRings } from './text.js';

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
  text: { text: 'Text', size: 10, width: 1.7, spacing: 0.8, lineGap: 2.5, h: 2, sx: 100, sy: 100, vertical: false },
};
const LABELS = { x: 'Width', y: 'Depth', z: 'Height', h: 'Height', d: 'Diameter', d1: 'Bottom diameter', d2: 'Top diameter',
  tube: 'Tube', wall: 'Wall', sides: 'Facets', tubeSides: 'Tube facets', r: 'Radius', length: 'Length', width: 'Line width' };
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
  // side by side from the panel leftward: the parts list, the Path list, the color list; never one under another
  const order = [partFly, pathFly, colorFly].filter(f => f === el || f.style.display !== 'none');
  const prev = order[order.indexOf(el) - 1];
  const edge = prev ? prev.getBoundingClientRect().left : side.left;
  el.style.right = Math.max(4, innerWidth - edge + 6) + 'px';
  // every list starts at the same height: under the floating header, so its buttons stay
  // reachable (lining up with what opened it put each at a different height)
  const want = Math.max(side.top + 4, header.getBoundingClientRect().bottom + 6);
  const floor = want;
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

// no browser right-click menu over the app (a right drag to orbit that starts over a button or a
// list opened it); text and number boxes keep it, for copy and paste
document.addEventListener('contextmenu', e => { if (!e.target.closest?.('input, textarea, [contenteditable=true]')) e.preventDefault(); });

// a hex box selects all on focus, so typing replaces the old value (as the number boxes do)
document.addEventListener('focusin', e => { if (e.target.matches?.('.hex-in')) setTimeout(() => e.target.select(), 0); });

/** One button, "Color" with a chip of the current color, that opens the list. */
function colorPicker(current, onpick) {
  const chip = (current || '').toLowerCase() === OLD_GRAY ? DEFAULT_COLOR : (current || DEFAULT_COLOR);
  const b = h('button', { type: 'button', class: 'btn colorbtn', 'aria-haspopup': 'listbox', title: `Color: ${colorName(current)}. Click to pick another` },
    h('span', { class: 'chip', style: `background:${chip}` }), 'Color');
  b.addEventListener('click', () => { if (colorFor?.anchor === b) closeColors(); else openColors(b, current, onpick); });
  // the panel redraws after a pick: an open list moves to the new button
  if (colorFor) requestAnimationFrame(() => { if (colorFor && b.isConnected) { colorFor.anchor = b; placeFlyout(colorFly, b); } });
  return b;
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
// View > Accessibility...: settings for how the app is worked, remembered on this computer. It
// shares the Grid panel's place under the menus (one of them shows at a time).
let zoomSpeed = 5;
folders.recall('zoomspeed').then(v => { if (v >= 1 && v <= 10) zoomSpeed = viewer.zoomSpeed = v; }).catch(() => {});
function showAccessPop() {
  gridPop.style.display = '';
  gridPop.replaceChildren(h('h3', {}, 'Accessibility'),
    ui.tip(ui.slider('Scroll to zoom speed', zoomSpeed, '', { min: 1, max: 10, step: 1 },
      v => { zoomSpeed = viewer.zoomSpeed = v; },
      v => { folders.remember('zoomspeed', v).catch(() => {}); status(`Scroll to zoom speed ${v} (5 is the usual).`); }),
    'How far one notch of the wheel zooms: 1 is a fine creep, 10 twice the usual'),
    h('div', { class: 'note' }, '5 is the usual speed.'),
    h('div', { class: 'row' }, button('Done', () => showGridPop(false), { small: true })));
}
// ---- tooltips and color schemes (remembered on this computer, with the home folder) ------------
// Tooltips: any control's title becomes its tip, shown only when switched on; a greyed control's
// tip says why it is off. Schemes: one accent family each, so nothing rests on telling hues apart.
let tipsOn = false, scheme = 'mono';
const SCHEMES = [
  ['green', 'Green', 'Greens and grays'],
  ['blue', 'Blue', 'Blues and grays, for red-green color blindness'],
  ['mono', 'High contrast', 'The default: white and grays only, the most contrast'],
];
document.documentElement.dataset.scheme = scheme;   // the page's colors at once; the view's follow below
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
// the remembered scheme, else the default (High contrast); the view gets it either way
folders.recall('scheme').then(v => setScheme(SCHEMES.some(s => s[0] === v) ? v : scheme, true), () => setScheme(scheme, true));

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
    ['Redo', () => redo(), { key: 'Ctrl+Shift+Z', off: () => !sel.length && doc.at >= doc.history.length && 'Nothing to redo' }],
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
    ['Snap faces...', () => startFaceSnap(), { tip: 'Click a face to snap to, then a face on another part: that part turns and moves onto the first face' }],
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
    ['Measure', () => setMeasure(!measureOn), { on: () => measureOn, key: 'T', tip: 'Click two points, on parts or the plate, for the distance between them' }],
    ['3D path (work in progress)', () => setPath3d(!path3dOn), { on: () => path3dOn, tip: 'Off by default, still being built: the 3D frame tool in Path, for drawing in space' }],
    ['Grid...', () => showGridPop(true), { tip: 'Grid size and line spacing' }],
    '-',
    ['Background picture...', () => showBackdropPanel(), { tip: 'A picture behind the model, tilted and scaled to line up with it' }],
    ['Plate picture...', () => showPlatePicPanel(), { tip: 'A picture lying on the plate under the grid, to model over' }],
    '-',
    ['Key bindings', () => setKeysTab(!keysTab), { on: () => keysTab, tip: 'A Keys tab beside Parts listing every mouse move and key' }],
    ['Key strip', () => setKeyStrip(!keyStripOn), { on: () => keyStripOn, tip: 'The everyday keys, faint along the bottom of the view' }],
    ['Tooltips', () => setTips(!tipsOn), { on: () => tipsOn, tip: 'Show what a control does when the pointer rests on it' }],
    ['Accessibility...', () => showAccessPop(), { tip: 'Scroll to zoom speed' }],
    ['Stereo', () => setStereo(!stereo.on), { on: () => stereo.on, tip: 'Side by side for phone goggles and headsets: the app twice, an eye each' }],
    ['Stereo settings...', () => showStereoPop(), { tip: 'Size of each half, and eye separation' }],
    '-',
    ...SCHEMES.map(([id, label, tip]) => [label, () => setScheme(id), { on: () => scheme === id && !customTheme, tip }]),
    ['Theme builder...', () => showThemeBuilder(), { on: () => !!customTheme, tip: 'Make your own colors for the app and the view, see them live, save and load them as files' }],
  ]),
);
const header = h('header', {},
  menubar,
  h('span', { class: 'popwrap' }, gridPop),
  h('span', { class: 'spacer' }), projBtn, importInput, projInput);

// Path: lit while it is in use (a second press closes it)
const pathBtn = button('Path', () => { if (drawing) { stopPath(); status('Path closed.'); } else startPath(); }, { title: 'Draw lines, arcs, circles and rectangles by clicking, on the plate or a face (P)' });
const shapeGrid = h('div', { class: 'shapes' }, ...Object.keys(SHAPES).map(k => {
  const b = button(k[0].toUpperCase() + k.slice(1), () => addShape(k), { title: `Add a ${k} on the plate` });
  return b;
}), pathBtn);
const stepCard = h('div');
const inspector = h('div', { class: 'inspector', style: 'display:none' });
/** Every mouse move and key the app answers to: [key, what it does, the word on the key strip (none: not on it)].
 *  The Keys tab and the key strip are both made from this one list. */
const KEYS = [
  ['Mouse', [['Right drag', 'turn the view'], ['Ctrl + left drag', 'turn the view'], ['Middle drag', 'pan'], ['Wheel', 'zoom to the pointer'],
    ['Left drag on a part', 'move it'], ['Alt + drag', 'move a copy'], ['Left drag on empty space', 'select by box'], ['Shift + click', 'add to the selection']]],
  ['View', [['F', 'fit the selection, or all', 'fit'], ['+  /  -', 'zoom', 'zoom'], ['Shift + F', 'slide along a face you click'], ['R (hold)', 'show the turn rings', 'rings'], ['T', 'measure between two points (Esc ends it)', 'measure']]],
  ['Path (while it is open)', [['P', 'open or close Path', 'path'], ['V', 'pointer: select and move parts, Path stays open'], ['L / A / C / R', 'line, arc, circle, rectangle'], ['K', 'delete: click a stretch of a line to remove it; U takes it back'],['3', '3D frame on / off: a line under way joins the frame; off, flat again from its last point'],['E', 'edit the selected frame part\'s frame (3D frame or Pointer)'],['F', 'finish the line, open'],
    ['U', 'undo the last point'], ['X', 'cancel the line']]],
  ['3D frame (in Path)', [['Shift (hold)', 'move the mouse up or down: lift or lower the point'], ['D  /  F', 'draw / fill faces'], ['B', 'make solid'], ['N', 'end the strand, or fill the loop'], ['U', 'undo the last step'],
    ['G', 'draw on the plate (again: let go)'], ['Space', 'lock points to the upright grid as it stands (again: unlock)']]],
  ['Parts', [['Arrows', 'move one step (Shift: ten)', 'move'], ['Ctrl + Up / Down', 'raise / lower', 'raise'], ['D', 'drop to the plate', 'drop'], ['H  /  S', 'hole / solid', 'hole / solid'],
    ['M', 'mirror X (Shift: Y, Alt: Z)', 'mirror'], ['Delete', 'delete', 'delete'], ['Esc', 'deselect, or close', 'deselect'], ['F2', 'rename (in the parts list)']]],
  ['Edit', [['Ctrl + Z', 'undo (with parts selected: only them)', 'undo'], ['Ctrl + Shift + Z', 'redo (with parts selected: only them)', 'redo'], ['Ctrl + A', 'select all'], ['L', 'several parts selected: light up Align in the panel'], ['Ctrl + C / X / V', 'copy / cut / paste', 'copy / cut / paste'], ['Ctrl + D', 'duplicate', 'duplicate'],
    ['Ctrl + G', 'group', 'group'], ['Ctrl + Shift + G', 'ungroup'], ['Ctrl + I', 'intersect'], ['Ctrl + L', 'lock', 'lock'], ['Ctrl + H', 'hide', 'hide'], ['Ctrl + Shift + H', 'show all']]],
  ['File', [['Ctrl + O', 'open'], ['Ctrl + E', 'export', 'export'], ['Ctrl + Shift + E', 'export again, to a place you pick']]],
];
/** The Keys tab. */
// 3D path keys: listed only while View > 3D path is on (off, they do nothing, so they are not shown)
const is3dKey = (head, k) => head === '3D frame (in Path)' || (head === 'Path (while it is open)' && (k === '3' || k === 'E'));
function keysCard() {
  const keys = KEYS.filter(([head]) => path3dOn || head !== '3D frame (in Path)').map(([head, list]) => [head, list.filter(([k]) => path3dOn || !is3dKey(head, k))]);
  return card('Keys', ...keys.map(([head, list]) => h('div', {}, h('div', { class: 'sub' }, head),
    h('div', { class: 'kv keys' }, list.flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)])))));
}
/** The key strip: the everyday keys, faint along the foot of the view, never in the way of the mouse. */
const keyStrip = h('div', { class: 'keystrip', style: 'display:none', 'aria-hidden': 'true' },
  ...KEYS.flatMap(([, list]) => list.filter(r => r[2]).map(([k, , s]) => h('span', {}, h('b', {}, k.replace(/\s+/g, ' ')), ' ', s))));
// 3D path: the 3D frame tool, a work in progress, off unless switched on in View
let path3dOn = false;
function setPath3d(on) {
  path3dOn = on;
  folders.remember('path3d', on).catch(() => {});
  if (!on && drawing?.tool === 'frame') setPathTool('frame');   // (3 again: back to flat)
  if (drawing) renderPathFly();
  renderInspector(); panes.keys.replaceChildren(keysCard());
  status(on ? '3D path on (a work in progress): 3D frame (3) is in the Path list.' : '3D path off: Path draws flat only.');
}
let keyStripOn = false;
function setKeyStrip(on) {
  keyStripOn = on;
  keyStrip.style.display = on ? '' : 'none';
  folders.remember('keystrip', on).catch(() => {});
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
// the Shapes card heads Shape tools only: Parts gives the part's panel the whole height
const shapesCard = card('Shapes', shapeGrid);
const panes = { shapes: h('div', { class: 'pane' }, shapesCard, shapeOpts),
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
folders.recall('path3d').then(v => { if (v) { path3dOn = true; if (drawing) renderPathFly(); renderInspector(); panes.keys.replaceChildren(keysCard()); } }).catch(() => {});
folders.recall('keystrip').then(v => { if (v) { keyStripOn = true; keyStrip.style.display = ''; } }).catch(() => {});
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
  placePathFly();   // the Path and color lists move beside the parts list, and back when it shuts
}
partFly.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !e.target.closest('input')) { e.stopPropagation(); openPartList(false); tabs.querySelector('[data-v="parts"]')?.focus(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = [...partList.querySelectorAll('.prow')], i = rows.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault(); e.stopPropagation();
  rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
});
window.addEventListener('resize', () => { if (partFlyOpen) placeFlyout(partFly, null); placePathFly(); });
// the arrow rolls the panel up to its tab row, and the view takes the width
const fold = h('button', { class: 'fold', title: 'Roll the panel up' }, '▴');
fold.onclick = () => {
  const up = app.classList.toggle('folded');
  fold.textContent = up ? '▾' : '▴';
  fold.title = up ? 'Roll the panel down' : 'Roll the panel up';
};
const aside = h('aside', {}, h('div', { class: 'tabrow' }, tabs, fold), panes.parts, panes.shapes, panes.keys);

const view = h('div', { id: 'view' });
// how many parts are selected, faint at the top right of the view (only when more than one)
const selCount = h('div', { class: 'selcount', style: 'display:none', 'aria-live': 'polite' });
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

// ---- measure (T, View > Measure): there from the start, nothing to place first ----------------
// Clicks pick points on a part (a corner of the face when one is within 8 px) or on the plate;
// two points give the distance, in a readout under the menus and the status line, never by the
// part. A third click starts again. Esc clears the points, then ends it.
let measureOn = false, mPts = [];
const measureBox = h('div', { class: 'measurebox', style: 'display:none', role: 'status' });
const snapBar = h('div', { class: 'snapbar', style: 'display:none' });   // snap faces: where on the face
function setMeasure(on) {
  measureOn = on; mPts = [];
  viewer.setMeasure([]);
  measureBox.style.display = on ? '' : 'none';
  if (on) { measureText(); status('Measure: click two points, on a part or the plate. Esc or T ends it.'); }
  else status('Measure off.');
}
function measureText() {
  if (mPts.length < 2) { measureBox.replaceChildren(mPts.length ? 'Click the second point' : 'Click the first point'); return; }
  const d = mPts[1].clone().sub(mPts[0]), f = v => Math.abs(v).toFixed(2);
  measureBox.replaceChildren(h('b', {}, `${d.length().toFixed(2)} mm`), h('span', {}, `X ${f(d.x)}`), h('span', {}, `Y ${f(d.y)}`), h('span', {}, `Z ${f(d.z)}`));
  status(`Distance ${d.length().toFixed(2)} mm (X ${f(d.x)}, Y ${f(d.y)}, Z ${f(d.z)}).`);
}
// ---- path (P, or Path under Shape tools): lines, arcs, circles and rectangles, by clicking -----
// Path lights its button and opens a list beside the panel (as the color list does). While it is
// open its keys are its own: L line, A arc, C circle, R rectangle, Enter finish, Backspace a point
// back, Esc cancel the piece (Esc again closes Path). The first click of each piece sets its
// height: the plate, or the spot clicked on a part. The piece is drawn level there, X and Y only.
// Points land in move steps (Shift: a line's stretch turns in 15 degree steps).
//   Line: click points; the first point again closes the loop; Finish (or the last point again) ends it open.
//   Arc: from the last point (or a first click), a click it passes through, then where it ends.
//   Circle: the middle, then a point on it. Rectangle: one corner, then the opposite one.
// Each finished piece is a part: a line of the width and height set in the list, round at bends
// and ends; a closed one's inside (hollow, filled, or cut through) is set in the panel after.
let drawing = null;   // { tool, plane: { o, n, u, v, rot }, pts: [[a, b]] in the plane from o, mark }
const pathSet = { width: 1, h: 1 };
const pathFly = flyout('pathfly');
const PATH_TOOLS = [['pointer', 'Pointer', 'V'], ['line', 'Line', 'L'], ['arc', 'Arc', 'A'], ['circle', 'Circle', 'C'], ['rect', 'Rectangle', 'R'], ['erase', 'Delete', 'K'], ['frame', '3D frame', '3']];
const PATH_HINT = {
  get pointer() { return path3dOn ? 'Clicks select and move parts again, and a 3D frame\'s points can be dragged (Shift: up and down). Pick a tool to draw.' : 'Clicks select and move parts again. Pick a tool to draw.'; },
  line: 'Click points. F finishes the line; clicking the first point again closes it into a loop.',
  arc: 'From the last point: click where it passes, then where it ends.',
  circle: 'Click the middle, then a point on the circle.',
  rect: 'Click one corner, then the opposite one.',
  get erase() { return path3dOn ? 'Click a stretch of a line, or a frame point or edge, to remove it. U takes it back.' : 'Click a stretch of a line to remove it: an open line splits in two, a loop opens. U takes it back.'; },
};

// ---- 3D frame (Path, key 3): a wireframe drawn in space, its faces chosen after, made solid ------
// Draw (D): click points. A point moves on the level of the last one; with Shift it moves on the
// upright plane through the last one, facing you, so the line climbs or drops. Points land in move
// steps, and a click within 8 px of a frame point joins to it and carries on from there; Enter ends
// a strand (the next click starts a new one). The status line gives the point's X Y Z.
// Faces (F): click the corners of a loop in order; the first corner again fills it.
// Make solid (B): every edge of the faces must be shared by exactly two faces, or it says how many
// are open and marks them; closed, the faces become a part. The frame is kept while Path is closed,
// and Backspace takes back the last step of any kind.
// Locks (they stay until switched off): Draw on the plate (G) puts every point on the build plate,
// for a flat outline; Lock plane (Space) freezes the upright grid as it is drawn,
// so turn the view until the grid faces the way wanted, press Space, and points stay on that grid.
const frame = { verts: [], edges: [], cur: null, mode: 'draw', faces: [], faceCur: [], hist: [], open: [], plate: false, lock: null };
const FRAME_HINT = {
  draw: 'Click points. Click a point again to join it, or drag it to move it; N ends a strand.',
  faces: 'Click the corners of a loop in order; the first corner again fills it.',
};
function frameSave() {
  frame.hist.push(JSON.stringify({ verts: frame.verts, edges: frame.edges, cur: frame.cur, faces: frame.faces, faceCur: frame.faceCur, partId: frame.partId ?? null }));
  if (frame.hist.length > 500) frame.hist.shift();
}
function frameBack() {
  const s = frame.hist.pop();
  if (!s) return;
  Object.assign(frame, JSON.parse(s), { open: [] });
  showFrame(null); renderPathFly();
}
/** The frame point within px pixels of the pointer, or -1. */
function frameNear(e, px = 8, skip = -1) {
  let best = -1, bd = px;
  frame.verts.forEach((v, i) => { if (i === skip) return; const [x, y] = onScreen(new Vector3(...v)); const d = Math.hypot(x - e.clientX, y - e.clientY); if (d <= bd) { bd = d; best = i; } });
  return best;
}
/** Where a click would put a new point: on the plate or a part to start; then on the level of the
 *  last point, in move steps from it; with Shift held, lifted or lowered by the mouse. */
function framePoint(e) {
  // every point inside the plate's area and never under the plate (a ray grazing the level met it
  // far off and drew lines out of sight)
  const q = framePointRaw(e);
  return q && [Math.max(-plate.w / 2, Math.min(plate.w / 2, q[0])), Math.max(-plate.d / 2, Math.min(plate.d / 2, q[1])), Math.max(0, q[2])].map(v => +v.toFixed(6));
}
/** A step (x, y) from the last point: as a line (length in move steps, direction in whole degrees)
 *  or on the move-step grid, whichever is nearer the mouse. The line gives fine angles; the grid
 *  keeps exact corners (a 20 x 20 diagonal is 28.28 mm, which no whole-step length reaches). */
function polar(x, y) {
  const st = v => Math.round(v / moveStep) * moveStep;
  const len = st(Math.hypot(x, y));
  const a = (Math.round((Math.atan2(y, x) * 180) / Math.PI) * Math.PI) / 180;
  const p = [len * Math.cos(a), len * Math.sin(a)], g = [st(x), st(y)];
  return Math.hypot(p[0] - x, p[1] - y) < Math.hypot(g[0] - x, g[1] - y) ? p : g;
}
function framePointRaw(e) {
  const st = v => Math.round(v / moveStep) * moveStep;
  if (frame.plate) {
    // on the plate: X and Y on the move-step lattice, Z 0
    const p = new Vector3();
    if (!viewer.ray(e).ray.intersectPlane(new Plane(new Vector3(0, 0, 1), 0), p)) return null;
    return [onLattice(p.x), onLattice(p.y), 0].map(v => +v.toFixed(6));
  }
  if (frame.lock) {
    // on the locked plane: from the last point, the length in move steps and the direction in whole
    // degrees (snapping across and up separately gave blocky angles on short lines)
    const L = frame.lock, p = new Vector3();
    if (!viewer.ray(e).ray.intersectPlane(new Plane().setFromNormalAndCoplanarPoint(L.n, L.o), p)) return null;
    const b = frame.cur != null ? new Vector3(...frame.verts[frame.cur]) : L.o;
    const d = p.sub(b), [du, dv] = polar(d.dot(L.u), d.dot(L.v));
    const q = b.clone().addScaledVector(L.u, du).addScaledVector(L.v, dv);
    return [q.x, q.y, q.z].map(v => +v.toFixed(6));
  }
  // where the point would be on the level (the plate or a part for the first one)
  let flat;
  if (frame.lift) flat = frame.lift.base;
  else if (frame.cur == null) {
    const hit = viewer.placeHit(e);
    if (!hit) return null;
    flat = [onLattice(hit.point.x), onLattice(hit.point.y), hit.normal ? hit.point.z : 0].map(v => +v.toFixed(6));
  } else {
    const b = new Vector3(...frame.verts[frame.cur]), p = new Vector3();
    if (!viewer.ray(e).ray.intersectPlane(new Plane().setFromNormalAndCoplanarPoint(new Vector3(0, 0, 1), b), p)) return null;
    const [dx, dy] = polar(p.x - b.x, p.y - b.y);
    flat = [b.x + dx, b.y + dy, b.z].map(v => +v.toFixed(6));
  }
  if (!e.shiftKey) { frame.lift = null; return flat; }
  // Shift: the point stays where it is across the plate, and the mouse going up or down lifts or
  // lowers it, at the view's scale there, in move steps; from any angle, straight down included.
  // (An upright plane facing the viewer read heights only from the side, and ran away seen from above.)
  // Shift going down over a frame point (12 px) lifts from that point itself: a line straight up from it
  if (!frame.lift) {
    const i = frameNear(e, 12), base = i >= 0 ? [...frame.verts[i]] : flat;
    frame.lift = { base, y0: e.clientY, mmPx: viewer.pxAt(new Vector3(...base)) };
  }
  const L = frame.lift;
  return [L.base[0], L.base[1], +(L.base[2] + st((L.y0 - e.clientY) * L.mmPx)).toFixed(6)];
}
function frameClick(e) {
  // lifting: no joins (let go of Shift to join); drawing: the last point never catches the mouse,
  // so a 1 mm step is a 1 mm step at any zoom
  const i = e.shiftKey && frame.mode === 'draw' ? -1 : frameNear(e, 8, frame.mode === 'draw' ? frame.cur ?? -1 : -1);
  if (frame.mode === 'faces') {
    if (i < 0) return;
    frameSave();
    if (frame.faceCur.length >= 3 && i === frame.faceCur[0]) {
      frame.faces.push(frame.faceCur); frame.faceCur = [];
      status(`${frame.faces.length} face${frame.faces.length > 1 ? 's' : ''}. Fill more loops, or Make solid (B).`);
    } else if (!frame.faceCur.includes(i)) frame.faceCur.push(i);
  } else {
    let j = i;
    const q = j < 0 ? framePoint(e) : null;
    if (j < 0 && !q) return;
    frameSave();
    if (j < 0) { frame.verts.push(q); j = frame.verts.length - 1; }
    frame.lift = null;   // a held Shift lifts again from the new point
    const c = frame.cur;
    if (c != null && j !== c && !frame.edges.some(([a, b]) => (a === c && b === j) || (a === j && b === c))) frame.edges.push([c, j]);
    frame.cur = j;
  }
  frame.open = [];
  showFrame(null); renderPathFly();
}
// Moving frame points: a press on one (Pointer, or Draw) and a drag moves it on its own level in move
// steps; Shift during the drag lifts or lowers it (from where it is when Shift goes down, so it never
// jumps). Never off the plate's area or under it. One undo step a move. A press that does not move
// is a click: in Draw it joins the point, as before.
let fgrab = null;   // { i, x0, y0, from, shift, ly, moved, ev }
function frameGrab(e) {
  const t = drawing?.tool;
  if (!path3dOn || !(t === 'pointer' || (t === 'frame' && frame.mode === 'draw')) || !frame.verts.length) return false;
  const i = frameNear(e);
  if (i < 0) return false;
  fgrab = { i, x0: e.clientX, y0: e.clientY, from: [...frame.verts[i]], shift: e.shiftKey, ly: e.clientY, moved: false,
    ev: { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey } };
  viewer.renderer.domElement.style.cursor = 'grabbing';
  return true;
}
function frameDrag(e) {
  const g = fgrab;
  if (!g) return;
  if (!g.moved && Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < 4) return;
  if (!g.moved) { g.moved = true; frameSave(); }
  if (e.shiftKey !== g.shift) { g.shift = e.shiftKey; g.from = [...frame.verts[g.i]]; g.ly = e.clientY; }
  const st = v => Math.round(v / moveStep) * moveStep, b = new Vector3(...g.from);
  let q;
  if (e.shiftKey) q = [b.x, b.y, b.z + st((g.ly - e.clientY) * viewer.pxAt(b))];
  else {
    const p = new Vector3();
    if (!viewer.ray(e).ray.intersectPlane(new Plane(new Vector3(0, 0, 1), -b.z), p)) return;
    q = [b.x + st(p.x - b.x), b.y + st(p.y - b.y), b.z];
  }
  q = [Math.max(-plate.w / 2, Math.min(plate.w / 2, q[0])), Math.max(-plate.d / 2, Math.min(plate.d / 2, q[1])), Math.max(0, q[2])].map(v => +v.toFixed(6));
  frame.verts[g.i] = q; frame.open = [];
  showFrame(null);
  status(`X ${q[0].toFixed(2)}   Y ${q[1].toFixed(2)}   Z ${q[2].toFixed(2)}   (moving a point; Shift: up and down)`);
}
function frameDrop() {
  const g = fgrab;
  fgrab = null;
  viewer.renderer.domElement.style.cursor = '';
  if (!g) return;
  if (!g.moved) { if (drawing?.tool === 'frame') frameClick(g.ev); return; }
  renderPathFly();
  const part = frame.partId && doc.top(frame.partId);
  status(`Point moved.${part ? ` Make solid (B) updates ${part.name}.` : ''} U takes it back.`);
}
function setFramePlate(on) {
  frame.plate = on;
  if (on) frame.lock = null;
  renderPathFly(); showFrame(null);
  status(on ? 'Drawing on the plate: every point at Z 0. G again lets go.' : 'Drawing in space again.');
}
/** Lock the plane through the last point (or the middle of the view), square to the view; again: unlock. */
function toggleFrameLock() {
  if (frame.lock) { frame.lock = null; status('Plane unlocked: points follow the last point\'s level again (Shift: up and down).'); }
  else {
    // the upright grid as it stands: vertical, through the last point, at the gauge's whole-degree
    // heading. (Square to the view, camera tilt and all, it leaned back into the depth: points meant
    // to go up went up and away.)
    // Nothing recomputed: the lock is a copy of the grid last drawn, so locking cannot move it.
    frame.plate = false;   // (on the plate no grid is drawn: let go first, so the copy is the current one)
    frameGrid(null);
    const { o, u, deg } = shownGrid;
    frame.lock = { o: o.clone(), u: u.clone(), v: new Vector3(0, 0, 1), n: new Vector3(-u.y, u.x, 0), deg };
    status(`Plane locked: the upright grid at ${deg}° from X, through the last point. Points move on it, up and across. Space unlocks.`);
  }
  renderPathFly(); showFrame(null);
}
function frameEnter() {
  if (frame.mode === 'draw') { frame.cur = null; status('Strand ended. ' + FRAME_HINT.draw); }
  else if (frame.faceCur.length >= 3) { frameSave(); frame.faces.push(frame.faceCur); frame.faceCur = []; }
  showFrame(null); renderPathFly();
}
/** Triangles (9 numbers each) filling the faces: each loop flattened on its own best plane. */
function frameTris(faces) {
  const out = [];
  for (const f of faces) {
    const P = f.map(i => new Vector3(...frame.verts[i]));
    const n = new Vector3();   // Newell's normal: right for bent loops too
    for (let k = 0; k < P.length; k++) { const a = P[k], b = P[(k + 1) % P.length]; n.x += (a.y - b.y) * (a.z + b.z); n.y += (a.z - b.z) * (a.x + b.x); n.z += (a.x - b.x) * (a.y + b.y); }
    if (n.lengthSq() < 1e-18) continue;
    n.normalize();
    const u = (Math.abs(n.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0)).cross(n).normalize(), v = n.clone().cross(u);
    const { tris, extra } = triangulate([P.map(p => [p.dot(u), p.dot(v)])]);
    const pts = [...P];
    const o = n.clone().multiplyScalar(P[0].dot(n));
    for (const [x, y] of extra) pts.push(o.clone().addScaledVector(u, x).addScaledVector(v, y));
    for (const k of tris) out.push(pts[k].x, pts[k].y, pts[k].z);
  }
  return out;
}
/** The reference grid while drawing a frame in space: upright through the current point (or the
 *  middle of the view), square to the view, from 100 mm under the plate to 150 mm over it, lines
 *  every 10 mm (stronger every 50 and at the plate); on the locked plane when it is locked; with a
 *  line from the pointer's point straight to the plate. None when drawing on the plate. */
let gridAngle = null;   // the Path list's readout of the upright grid's turn
let shownGrid = null;   // the upright grid last drawn {o, u, deg}: what Lock plane copies
/** The upright grid's heading through b: square to the view across the plate, in whole degrees, 0 along X. */
function gridHeading(b) {
  const n = viewer.camera.position.clone().sub(b);
  n.z = 0;
  if (n.lengthSq() < 1e-9) n.set(0, -1, 0);
  return ((Math.round((Math.atan2(n.x, -n.y) * 180) / Math.PI) % 360) + 360) % 360;
}
function frameGrid(q) {
  if (!drawing || drawing.tool !== 'frame' || frame.plate) { viewer.setRefGrid(null); return; }
  const drop = q && Math.abs(q[2]) > 1e-6 ? new Vector3(...q) : null;
  // every raised point's stem to the plate, with a foot, so up reads as up and across as across
  const stems = frame.verts.filter(v => v[2] > 1e-6);
  // locked: the grid stays where the lock put it, so the plane points land on is the one on screen.
  // Free: it turns with the view in whole degrees, 0 square to the plate (running along X).
  const L = frame.lock;
  const b = L ? L.o : frame.cur != null ? new Vector3(...frame.verts[frame.cur]) : viewer.controls.target.clone();
  const deg = L ? L.deg : gridHeading(b);
  const a = (deg * Math.PI) / 180, u = new Vector3(Math.cos(a), Math.sin(a), 0);
  const o = new Vector3(b.x, b.y, 0);
  shownGrid = { o, u, deg };
  viewer.setRefGrid({ o, u, v: new Vector3(0, 0, 1), half: 100, v0: 0, v1: 150, step: 10, vPlate: 0, gauge: { r: 30, deg }, drop, stems });
  if (gridAngle) gridAngle.textContent = `${deg}°`;
}
/** The frame on screen, with the stretch a click would add, or the loop being picked. With gone
 *  (from frameGone), what a Delete click would take is left out, so it vanishes under the pointer. */
function showFrame(e, gone = null) {
  if (!path3dOn) { viewer.setFrame({}); viewer.setRefGrid(null); return; }   // 3D path off: the frame out of sight
  const V = frame.verts;
  const segs = frame.edges.filter((_, k) => !gone?.edges.has(k)).flatMap(([a, b]) => [...V[a], ...V[b]]);
  let q = null;
  if (e && frame.mode === 'draw') {
    const i = e.shiftKey ? -1 : frameNear(e, 8, frame.cur ?? -1);
    q = i >= 0 ? V[i] : framePoint(e);
    if (q && frame.cur != null) segs.push(...V[frame.cur], ...q);
    if (q) status(`X ${q[0].toFixed(2)}   Y ${q[1].toFixed(2)}   Z ${q[2].toFixed(2)}${i >= 0 ? '   (joins this point)' : ''}`);
  }
  frameGrid(q);
  for (let k = 1; k < frame.faceCur.length; k++) segs.push(...V[frame.faceCur[k - 1]], ...V[frame.faceCur[k]]);
  // stems: every raised point, and the one a click would make, down to the plate
  const keep = V.filter((_, i) => !gone?.verts.has(i));
  const stems = [...keep, ...(q ? [q] : [])].filter(v => v[2] > 1e-6);
  viewer.setFrame({ segs, pts: keep.flat(), faces: frameTris(frame.faces.filter((_, k) => !gone?.faces.has(k))), open: frame.open.flatMap(([a, b]) => [...V[a], ...V[b]]), stems });
}
function buildFrame() {
  if (!frame.faces.length) { status('Make solid: fill some faces first (Faces, F: click a loop\'s corners).'); return; }
  // a closed body: every edge of the faces shared by exactly two of them
  const use = new Map();
  for (const f of frame.faces) for (let k = 0; k < f.length; k++) {
    const a = f[k], b = f[(k + 1) % f.length], key = a < b ? `${a},${b}` : `${b},${a}`;
    use.set(key, (use.get(key) || 0) + 1);
  }
  const open = [...use].filter(([, c]) => c !== 2).map(([key]) => key.split(',').map(Number));
  if (open.length) {
    frame.open = open; showFrame(null);
    status(`Not closed: ${open.length} edge${open.length > 1 ? 's are' : ' is'} on ${open.length > 1 ? 'one face each' : 'one face'} (marked in yellow). Fill the faces that close ${open.length > 1 ? 'them' : 'it'}.`, true);
    return;
  }
  const r = repair(Float32Array.from(frameTris(frame.faces)));
  const rep = report(r.tris);
  if (!rep.watertight) { status(`The faces do not make a closed solid: ${describe(rep)}.`, true); return; }
  // the part's middle in X and Y, its floor at its lowest point
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity;
  const t = r.tris;
  for (let i = 0; i < t.length; i += 3) { x0 = Math.min(x0, t[i]); x1 = Math.max(x1, t[i]); y0 = Math.min(y0, t[i + 1]); y1 = Math.max(y1, t[i + 1]); z0 = Math.min(z0, t[i + 2]); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, local = new Float32Array(t.length);
  for (let i = 0; i < t.length; i += 3) { local[i] = t[i] - cx; local[i + 1] = t[i + 1] - cy; local[i + 2] = t[i + 2] - z0; }
  // the part keeps its frame (in its own frame, from its placement), so it can be edited and grown
  // later; the frame stays here too, and Make solid again updates the same part
  const xform = { pos: [cx, cy, z0].map(v => +v.toFixed(6)), rot: [0, 0, 0], scale: [1, 1, 1] };
  const kept = { verts: frame.verts.map(([x, y, z]) => [+(x - xform.pos[0]).toFixed(6), +(y - xform.pos[1]).toFixed(6), +(z - xform.pos[2]).toFixed(6)]), edges: frame.edges, faces: frame.faces };
  const blob = doc.addBlob(local), nf = frame.faces.length, again = frame.partId && doc.top(frame.partId);
  let id = frame.partId;
  if (again) doc.update([id], `Make solid again: ${again.name}`, q => { q.blob = blob; q.xform = xform; q.frame = kept; });   // its steps run on the new shape
  else id = doc.add({ kind: 'mesh', blob, name: doc.nameFor('frame'), xform, frame: kept }, 'Make solid from the 3D frame');
  frame.partId = id; frame.open = [];
  showFrame(null); renderPathFly();
  setSel([id]);
  status(`${again ? 'Updated' : 'Made'} ${doc.top(id).name} from ${nf} faces: ${(rep.volume / 1000).toFixed(2)} cm3. Keep adding; Make solid again updates it, Clear frame starts a new one.`);
}
/** The one selected part, if it was made from a 3D frame and is not the frame being edited now. */
function frameToEdit() {
  const p = path3dOn && sel.length === 1 ? doc.top(sel[0]) : null;
  return p?.frame && frame.partId !== p.id ? p : null;
}
/** A part made from a 3D frame: its frame back in Path, where the part is now, to carry on. */
function editFrame(p) {
  if (!p?.frame || !path3dOn) return;
  const M = matrix(p.xform);
  if (!drawing) startPath();
  frameSave();   // U brings back the frame that was in hand
  Object.assign(frame, {
    verts: p.frame.verts.map(v => { const w = new Vector3(...v).applyMatrix4(M); return [w.x, w.y, w.z].map(t => +t.toFixed(6)); }),
    edges: p.frame.edges.map(e => [...e]), faces: p.frame.faces.map(f => [...f]),
    cur: null, faceCur: [], open: [], mode: 'draw', partId: p.id,
  });
  if (drawing.tool !== 'frame') setPathTool('frame');   // (3 again would switch it off)
  else { showFrame(null); renderPathFly(); }
  status(`Editing ${p.name}'s frame: add to it, then Make solid (B) updates ${p.name}.`);
}
// the view hands left clicks and moves to this while a drawing tool is picked; with Pointer it only
// offers frame points to grab (a press anywhere else selects and moves parts as usual)
const grabbing = { grab: e => frameGrab(e), drag: e => frameDrag(e), drop: e => frameDrop(e),
  hover: e => { viewer.renderer.domElement.style.cursor = path3dOn && drawing &&(drawing.tool === 'pointer' || drawing.tool === 'frame') && frameNear(e) >= 0 ? 'grab' : ''; } };
const drawTool = { ...grabbing, click: e => pathClick(e), move: e => { if (!drawing) return; if (drawing.tool === 'frame') showFrame(e); else if (drawing.tool === 'erase') eraseMove(e); else showDraft(pathPoint(e)); } };
const pointerTool = { ...grabbing };
function startPath() {
  cancelPlace(); cancelStep();
  if (measureOn) setMeasure(false);
  if (fsnap) endFaceSnap();
  drawing = { tool: 'line', plane: null, pts: [], mark: null };
  viewer.drawTool = drawTool;
  viewer.floor = true;   // zooming in stops above the build plate while drawing
  dropHint.style.display = 'none';
  pathBtn.classList.add('go');
  renderPathFly();
  status('Path, line: ' + PATH_HINT.line);
}
function stopPath() {
  drawing = null; viewer.drawTool = null; viewer.setDraft([]);
  viewer.floor = false;
  frame.cur = null; frame.faceCur = [];
  viewer.setFrame({});   // the frame is kept; it shows again with the 3D frame tool
  viewer.setRefGrid(null);
  pathFly.style.display = 'none';
  placePathFly();   // an open color list moves back against the panel
  pathBtn.classList.remove('go');
  dropHint.style.display = doc.parts.length ? 'none' : '';
}
function setPathTool(t) {
  if (!drawing) return;
  // a line or arc carries on as an arc or a line. Any other tool sets the piece under way aside,
  // unfinished, and picking its tool again brings it back as it was (it used to be finished: 3 in
  // the middle of a line made a part of it).
  const kind = x => (x === 'line' || x === 'arc' ? 'line' : x);
  const d = drawing;
  // 3 is a switch: on, into space; again, back to the flat tool it came from. One shape: a flat line
  // under way joins the frame as a strand and the frame carries on from its last point; back to flat,
  // the line starts at the frame's last point, level, and joins the frame again on the next 3.
  let toFlat = false;
  if (t === 'frame' && d.tool === 'frame') { t = d.flat || 'line'; toFlat = true; }
  else if (t === 'frame') {
    d.flat = d.tool === 'pointer' ? 'line' : d.tool;
    if ((d.tool === 'line' || d.tool === 'arc') && d.plane && d.pts.length) {
      frameSave();
      const ids = d.pts.map(q => {
        const w = fromPlane(d.plane, q), p = [w.x, w.y, w.z].map(v => +v.toFixed(6));
        const i = frame.verts.findIndex(v => Math.hypot(v[0] - p[0], v[1] - p[1], v[2] - p[2]) < 1e-4);
        if (i >= 0) return i;
        frame.verts.push(p); return frame.verts.length - 1;
      });
      for (let k = 1; k < ids.length; k++) {
        const a = ids[k - 1], b = ids[k];
        if (a !== b && !frame.edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) frame.edges.push([a, b]);
      }
      frame.cur = ids[ids.length - 1]; frame.plate = false; frame.open = [];
      d.pts = []; d.plane = null; d.mark = null;
    }
  }
  let kept = '';
  if (kind(t) !== kind(d.tool) && (d.pts.length || d.mark)) {
    d.parked = { tool: d.tool, pts: d.pts, plane: d.plane, mark: d.mark };
    d.pts = []; d.plane = null;
    kept = ` The ${d.parked.tool === 'rect' ? 'rectangle' : d.parked.tool} under way is kept: ${PATH_TOOLS.find(x => x[0] === d.parked.tool)[2]} brings it back.`;
  }
  d.mark = null;
  if (d.parked && kind(d.parked.tool) === kind(t) && !d.pts.length) {
    Object.assign(d, { pts: d.parked.pts, plane: d.parked.plane, mark: t === d.parked.tool ? d.parked.mark : null });
    d.parked = null;
  }
  if (toFlat && (t === 'line' || t === 'arc') && !d.pts.length && frame.cur != null) {
    const c = frame.verts[frame.cur];
    d.plane = { o: new Vector3(...c), n: new Vector3(0, 0, 1), u: new Vector3(1, 0, 0), v: new Vector3(0, 1, 0), rot: [0, 0, 0] };
    d.pts = [[0, 0]];
    frame.cur = null;   // the frame's strand carries on in the flat line
  }
  // Delete: nothing selected, so the stretch under the pointer is the only thing lit
  if (t === 'erase' && d.tool !== 'erase') { eraseLog = []; if (sel.length) setSel([]); }
  d.tool = t;
  viewer.drawTool = t === 'pointer' ? pointerTool : drawTool;
  renderPathFly();
  // Pointer: the frame stays in sight, to come back to and carry on
  if (t === 'pointer') { viewer.setDraft([]); frame.cur = null; frame.faceCur = []; showFrame(null); viewer.setRefGrid(null); status('Pointer: ' + PATH_HINT.pointer + kept); return; }
  if (t === 'frame') { viewer.setDraft([]); showFrame(null); status('3D frame: ' + FRAME_HINT[frame.mode] + kept); return; }
  showFrame(null); viewer.setRefGrid(null);   // the frame stays in sight: the flat line is part of it
  showDraft(null);
  status(`Path, ${PATH_TOOLS.find(x => x[0] === t)[1].toLowerCase()}: ${PATH_HINT[t]}${kept}`);
}
/** The Path list in its place (against the panel, or beside the parts list while that is open),
 *  and an open color list beside it. */
function placePathFly() {
  if (drawing) placeFlyout(pathFly, pathBtn.getClientRects().length ? pathBtn : null);
  if (colorFor) placeFlyout(colorFly, colorFor.anchor);
}
function renderPathFly() {
  const tool = drawing.tool;
  const tb = ([t, label, key]) => {
    const b = button(label, () => setPathTool(t), { small: true, title: `${label} (${key})` });
    b.append(h('span', { class: 'mkey' }, key));
    if (t === tool) b.classList.add('go');
    return b;
  };
  const head = h('h3', {}, 'Path', h('span', { class: 'grow' }), button('Close', () => { stopPath(); status('Path closed.'); }, { small: true, title: 'Esc with nothing being drawn' }));
  // every action shows its key on the button, as the tools do
  const kb = (label, key, fn, title) => { const b = button(label, fn, { small: true, title: `${title} (${key})` }); b.append(h('span', { class: 'mkey' }, key)); return b; };
  // a made frame part selected (Pointer, then a click on it): its frame back for editing, from here
  const ef = frameToEdit();
  const editRow = ef ? [h('div', { class: 'pathtools' }, kb(`Edit frame: ${ef.name}`, 'E', () => editFrame(ef), 'Its 3D frame back to change: drag points, add to it, then Make solid updates the part'))]
    : path3dOn && doc.parts.some(p => p.frame) && !frame.partId ? [h('div', { class: 'note' }, 'To change a made frame: Pointer (V), click the part, then E.')] : [];
  if (tool === 'frame') {
    const draw = kb('Draw', 'D', () => setFrameMode('draw'), 'Lay down points and edges'), faces = kb('Faces', 'F', () => setFrameMode('faces'), 'Fill loops of the frame');
    (frame.mode === 'draw' ? draw : faces).classList.add('go');
    pathFly.replaceChildren(head,
      h('div', { class: 'pathtools' }, ...PATH_TOOLS.filter(x => path3dOn || x[0] !== 'frame').map(tb)),
      h('div', { class: 'pathtools' }, draw, faces),
      ...editRow,
      h('div', { class: 'keyhint' }, h('b', {}, 'Shift'), ' hold: mouse up or down lifts or lowers the point; over a point, straight up from it'),
      h('div', { class: 'note' }, 'Upright grid: ', gridAngle = h('span', { class: 'mono' }, '0°'), frame.lock ? ' from X, locked: points stay on it' : ' from X (turns with the view, whole degrees)'),
      ui.tip(ui.check('Draw on the plate  (G)', frame.plate, v => setFramePlate(v)), 'Every point on the build plate: a flat outline'),
      ui.tip(ui.check('Lock plane  (Space)', !!frame.lock, () => toggleFrameLock()), 'Turn the view until the upright grid faces the way you want, then lock: points stay on that grid, up and across, through the last point'),
      h('div', { class: 'note' }, FRAME_HINT[frame.mode]),
      h('div', { class: 'note' }, `${frame.verts.length} points, ${frame.edges.length} edges, ${frame.faces.length} faces`),
      h('div', { class: 'pathtools' },
        kb('Make solid', 'B', () => buildFrame(), 'The filled faces as a part, if they close up'),
        frame.mode === 'draw' ? kb('End strand', 'N', () => frameEnter(), 'The next click starts a new strand') : kb('Fill loop', 'N', () => frameEnter(), 'Fill the loop picked so far'),
        kb('Undo last step', 'U', () => frameBack(), 'Take back the last point, edge or face'),
        button('Clear frame', () => { frameSave(); Object.assign(frame, { verts: [], edges: [], cur: null, faces: [], faceCur: [], open: [], partId: null }); showFrame(null); renderPathFly(); status('Frame cleared: the next Make solid makes a new part. U brings it back.'); }, { small: true, title: 'Start a new design (U brings this one back)' })));
    placePathFly();
    return;
  }
  if (tool === 'erase') {
    pathFly.replaceChildren(head, h('div', { class: 'pathtools' }, ...PATH_TOOLS.filter(x => path3dOn || x[0] !== 'frame').map(tb)), h('div', { class: 'note' }, PATH_HINT.erase),
      h('div', { class: 'pathtools' }, kb('Undo last delete', 'U', () => eraseUndo(), 'Bring back what the last click deleted')));
    placePathFly();
    return;
  }
  if (tool === 'pointer') {
    pathFly.replaceChildren(head, h('div', { class: 'pathtools' }, ...PATH_TOOLS.filter(x => path3dOn || x[0] !== 'frame').map(tb)), ...editRow, h('div', { class: 'note' }, PATH_HINT.pointer));
    placePathFly();
    return;
  }
  pathFly.replaceChildren(head,
    h('div', { class: 'pathtools' }, ...PATH_TOOLS.filter(x => path3dOn || x[0] !== 'frame').map(tb)),
    h('div', { class: 'note' }, PATH_HINT[tool]),
    ...(tool === 'line' || tool === 'arc' ? [h('div', { class: 'keyhint' }, h('b', {}, 'Shift'), ' hold: turn in 15 degree steps')] : []),
    ui.numfield('Line width', pathSet.width, 'mm', v => { pathSet.width = v; }, { min: 0.01, step: 0.5, lazy: true, digits: 3 }),
    ui.numfield('Height', pathSet.h, 'mm', v => { pathSet.h = v; }, { min: 0.01, step: 0.5, lazy: true, digits: 3 }),
    h('div', { class: 'pathtools' },
      kb('Finish line', 'F', () => finishPiece(false), 'End the line at its last point, open'),
      kb('Undo last point', 'U', () => pointBack(), 'Take the last point clicked back off the line'),
      kb('Cancel line', 'X', () => clearPiece(true), 'Drop the line being drawn')));
  placePathFly();
}
function setFrameMode(m) {
  frame.mode = m; frame.faceCur = []; frame.cur = null;
  renderPathFly(); showFrame(null);
  status('3D frame: ' + FRAME_HINT[m]);
}
function clearPiece(say) { if (!drawing) return; drawing.pts = []; drawing.plane = null; drawing.mark = null; showDraft(null); if (say) status('Path: piece dropped. ' + PATH_HINT[drawing.tool]); }
function pointBack() {
  if (!drawing) return;
  if (drawing.mark) drawing.mark = null; else drawing.pts.pop();
  if (!drawing.pts.length && !drawing.mark) drawing.plane = null;
  showDraft(null);
}
/** Within 0.01 mm of a true arc: the most a step may turn on a circle of radius r. */
const arcStep = r => 2 * Math.acos(Math.max(-1, 1 - Math.min(0.01 / Math.max(r, 1e-9), 1)));
/** An arc from p0 through p1 to p2 (in the plane), as points from p0 to p2; a straight line if they line up. */
function arcPoints(p0, p1, p2) {
  const [ax, ay] = p0, [bx, by] = p1, [cx, cy] = p2;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return [p0, p2];
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy), T = 2 * Math.PI, norm = x => ((x % T) + T) % T;
  const t0 = Math.atan2(ay - uy, ax - ux), t1 = Math.atan2(by - uy, bx - ux), t2 = Math.atan2(cy - uy, cx - ux);
  const sweep = norm(t1 - t0) < norm(t2 - t0) ? norm(t2 - t0) : -norm(t0 - t2);   // the way round that passes p1
  const n = Math.min(720, Math.max(2, Math.ceil(Math.abs(sweep) / arcStep(r))));
  const out = [p0];
  for (let i = 1; i < n; i++) { const t = t0 + (sweep * i) / n; out.push([+(ux + r * Math.cos(t)).toFixed(6), +(uy + r * Math.sin(t)).toFixed(6)]); }
  out.push(p2);
  return out;
}
const circlePoints = ([cx, cy], r) => {
  const n = Math.min(720, Math.max(24, Math.ceil((2 * Math.PI) / arcStep(r))));
  return Array.from({ length: n }, (_, i) => [+(cx + r * Math.cos((2 * Math.PI * i) / n)).toFixed(6), +(cy + r * Math.sin((2 * Math.PI * i) / n)).toFixed(6)]);
};
const rectPoints = ([a0, b0], [a1, b1]) => [[a0, b0], [a1, b0], [a1, b1], [a0, b1]];
const onScreen = p => {
  const s = p.clone().project(viewer.camera), r = viewer.renderer.domElement.getBoundingClientRect();
  return [(s.x + 1) / 2 * r.width + r.left, (1 - s.y) / 2 * r.height + r.top];
};
const fromPlane = (P, [a, b]) => P.o.clone().addScaledVector(P.u, a).addScaledVector(P.v, b);
/** Where the pointer lands on the path's plane, in its own coordinates, on the move step. */
function pathPoint(e) {
  let P = drawing.plane;
  if (!P) {
    const hit = viewer.placeHit(e);
    if (!hit) return null;
    return [onLattice(hit.point.x), onLattice(hit.point.y)].map(v => +v.toFixed(6));   // the level plane's o is over the origin
  }
  const p = new Vector3();
  if (!viewer.ray(e).ray.intersectPlane(new Plane().setFromNormalAndCoplanarPoint(P.n, P.o), p)) return null;
  p.sub(P.o);
  let a = p.dot(P.u), b = p.dot(P.v);
  const last = drawing.pts[drawing.pts.length - 1];
  if (e.shiftKey && last) {
    // the stretch from the last point turns in 15 degree steps
    const ang = Math.round(Math.atan2(b - last[1], a - last[0]) / (Math.PI / 12)) * (Math.PI / 12), len = Math.hypot(a - last[0], b - last[1]);
    a = last[0] + Math.cos(ang) * len; b = last[1] + Math.sin(ang) * len;
  } else { a = Math.round(a / moveStep) * moveStep; b = Math.round(b / moveStep) * moveStep; }
  return [+a.toFixed(6), +b.toFixed(6)];
}
/** The piece being drawn, with the pointer's point as the next click would make it. */
function showDraft(cursor) {
  const d = drawing;
  if (!d?.plane) { viewer.setDraft([]); return; }
  let pts = d.pts.slice();
  if (cursor) {
    if (d.tool === 'line') pts.push(cursor);
    else if (d.tool === 'arc') pts = d.mark && pts.length ? [...pts, ...arcPoints(pts[pts.length - 1], d.mark, cursor).slice(1)] : [...pts, ...(d.mark ? [d.mark] : []), cursor];
    else if (d.tool === 'circle' && d.mark) { const c = circlePoints(d.mark, Math.hypot(cursor[0] - d.mark[0], cursor[1] - d.mark[1])); pts = [...c, c[0]]; }
    else if (d.tool === 'rect' && d.mark) { const c = rectPoints(d.mark, cursor); pts = [...c, c[0]]; }
    else pts.push(cursor);
  } else if (d.mark) pts.push(d.mark);
  viewer.setDraft(pts.map(q => fromPlane(d.plane, q)));
}
/** The first click of a piece: its level plane (at the plate or the spot clicked) and the point in it. */
function planeFrom(e) {
  // always level: at the plate, or at the height of the spot clicked on a part (top, side or
  // slope). A plane tilted to the face clicked stood on edge to the view on a side face, and the
  // mouse met it far off: points flew away. X and Y only from here; the height stays.
  const hit = viewer.placeHit(e);
  if (!hit) return null;
  const z = hit.normal ? +hit.point.z.toFixed(6) : 0;
  drawing.plane = { o: new Vector3(0, 0, z), n: new Vector3(0, 0, 1), u: new Vector3(1, 0, 0), v: new Vector3(0, 1, 0), rot: [0, 0, 0] };
  return pathPoint(e);
}
function pathClick(e) {
  const d = drawing;
  if (d.tool === 'frame') { frameClick(e); return; }
  if (d.tool === 'erase') { eraseClick(e); return; }
  const q = d.plane ? pathPoint(e) : planeFrom(e);
  if (!q) return;
  const near = (p, px) => { const [x, y] = onScreen(fromPlane(d.plane, p)); return Math.hypot(x - e.clientX, y - e.clientY) <= px; };
  const same = (p, r) => p && p[0] === r[0] && p[1] === r[1];
  if (d.tool === 'line') {
    if (d.pts.length >= 3 && near(d.pts[0], 8)) { finishPiece(true); return; }
    if (d.pts.length >= 2 && near(d.pts[d.pts.length - 1], 4)) { finishPiece(false); return; }
    if (!same(d.pts[d.pts.length - 1], q)) d.pts.push(q);
  } else if (d.tool === 'arc') {
    if (!d.pts.length) d.pts.push(q);
    else if (!d.mark) { if (!same(d.pts[d.pts.length - 1], q)) d.mark = q; }
    else {
      const end = d.pts.length >= 2 && near(d.pts[0], 8) ? d.pts[0] : q;   // an arc ending on the first point closes the loop
      d.pts.push(...arcPoints(d.pts[d.pts.length - 1], d.mark, end).slice(1));
      d.mark = null;
      if (end === d.pts[0] && d.pts.length >= 4) { d.pts.pop(); finishPiece(true); return; }
    }
  } else if (!d.mark) d.mark = q;
  else {
    const m = d.mark;
    d.mark = null;
    if (d.tool === 'circle') { const r = Math.hypot(q[0] - m[0], q[1] - m[1]); if (r > 0) commitPiece(circlePoints(m, r), true); }
    else if (q[0] !== m[0] && q[1] !== m[1]) commitPiece(rectPoints(m, q), true);
    return;
  }
  showDraft(null);
}
function finishPiece(closed) {
  const d = drawing;
  if (!d) return;
  if (d.pts.length < 2) { status('Path: a line needs two points or more.'); return; }
  commitPiece(d.pts, closed);
}
/** A finished piece as a part; Path stays open for the next. */
function commitPiece(pts2, closed) {
  const d = drawing;
  // the part's middle is the middle of its points; the points are kept from there
  const c = pts2.reduce((s, q) => [s[0] + q[0] / pts2.length, s[1] + q[1] / pts2.length], [0, 0]);
  const pts = pts2.map(q => [+(q[0] - c[0]).toFixed(6), +(q[1] - c[1]).toFixed(6)]);
  const at = fromPlane(d.plane, c);
  const id = doc.add({ kind: 'path', params: { pts, width: pathSet.width, h: pathSet.h, closed, fill: 'line', sides: 32 },
    xform: { pos: [at.x, at.y, at.z].map(v => +v.toFixed(6)), rot: d.plane.rot, scale: [1, 1, 1] } });
  clearPiece(false);
  setSel([id]);
  status(`Added ${doc.top(id).name}${closed ? ', closed: its inside is set in the panel' : ''}. Draw the next piece, or Esc to close Path.`);
}

// ---- Delete (Path, key K): click a stretch of a drawn line, or a 3D frame point or edge, to remove it --
// Hovering shows what would go: a frame point or edge vanishes under the pointer; a line's stretch
// is drawn over in the selection color. A stretch out of an open line splits it in two parts (an
// end stretch shortens it); out of a closed loop, the loop opens there. A frame point takes its
// edges and faces with it; an edge takes the faces along it; a point left with no edge goes too.
// U takes back the last delete (frame deletes on the frame's own undo, line deletes on the model's).
let eraseLog = [];   // 'frame' or 'doc' per delete, newest last, for U
/** Distance in pixels from the pointer to the screen segment A B. */
function segDist(e, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((e.clientX - ax) * dx + (e.clientY - ay) * dy) / L)) : 0;
  return Math.hypot(ax + t * dx - e.clientX, ay + t * dy - e.clientY);
}
/** What a Delete click here would take: {kind: 'vert' | 'edge', i} on the frame, {kind: 'path', id, k} a line's stretch k, or null. */
function eraseTarget(e) {
  if (path3dOn && frame.verts.length) {
    const i = frameNear(e, 8);
    if (i >= 0) return { kind: 'vert', i };
    let best = -1, bd = 8;
    frame.edges.forEach(([a, b], k) => { const d = segDist(e, onScreen(new Vector3(...frame.verts[a])), onScreen(new Vector3(...frame.verts[b]))); if (d <= bd) { bd = d; best = k; } });
    if (best >= 0) return { kind: 'edge', i: best };
  }
  // a line's stretch: within 8 px of its middle line, or anywhere on a line wider than that on screen
  let hit = null, bd = Infinity;
  for (const p of doc.parts) {
    if (p.kind !== 'path' || p.hidden || !p.params?.pts?.length) continue;
    const M = matrix(p.xform), z = (p.params.h || 0) / 2;
    const W = p.params.pts.map(([x, y]) => new Vector3(x, y, z).applyMatrix4(M));
    const tol = Math.max(8, (p.params.width || 0) / 2 / viewer.pxAt(W[0]));
    const S = W.map(onScreen), runs = p.params.closed ? S.length : S.length - 1;
    for (let k = 0; k < runs; k++) {
      const d = segDist(e, S[k], S[(k + 1) % S.length]);
      if (d <= tol && d < bd) { bd = d; hit = { kind: 'path', id: p.id, k, a: W[k], b: W[(k + 1) % W.length] }; }
    }
  }
  return hit;
}
/** The frame points, edges and faces (index sets) a frame delete takes. */
function frameGone(t) {
  const verts = new Set(), edges = new Set(), faces = new Set();
  if (t.kind === 'vert') {
    verts.add(t.i);
    frame.edges.forEach(([a, b], k) => { if (a === t.i || b === t.i) edges.add(k); });
    frame.faces.forEach((f, k) => { if (f.includes(t.i)) faces.add(k); });
  } else {
    const [a, b] = frame.edges[t.i];
    edges.add(t.i);
    frame.faces.forEach((f, k) => { for (let j = 0; j < f.length; j++) { const x = f[j], y = f[(j + 1) % f.length]; if ((x === a && y === b) || (x === b && y === a)) faces.add(k); } });
  }
  // a point left with no edge and in no face goes too
  const ends = new Set([...edges].flatMap(k => frame.edges[k]));
  for (const v of ends) if (!verts.has(v) && !frame.edges.some((ed, k) => !edges.has(k) && ed.includes(v)) && !frame.faces.some((f, k) => !faces.has(k) && f.includes(v))) verts.add(v);
  return { verts, edges, faces };
}
function eraseMove(e) {
  const t = eraseTarget(e);
  viewer.setDraft(t?.kind === 'path' ? [t.a, t.b] : []);
  showFrame(null, t && t.kind !== 'path' ? frameGone(t) : null);
  if (!t) { status('Delete: ' + PATH_HINT.erase); return; }
  status(t.kind === 'path' ? `Click deletes this stretch of ${doc.top(t.id).name}.` : `Click deletes this frame ${t.kind === 'vert' ? 'point' : 'edge'}.`);
}
function eraseClick(e) {
  const t = eraseTarget(e);
  if (!t) { status('Delete: nothing here. ' + PATH_HINT.erase); return; }
  if (t.kind === 'path') {
    const p = doc.top(t.id);
    if (p.locked) { status(`${p.name} is locked (Ctrl+L).`); return; }
    const P = p.params.pts, k = t.k;
    let msg;
    doc.commit(`Delete a stretch of ${p.name}`, parts => {
      const i = parts.findIndex(q => q.id === p.id), q = parts[i];
      if (q.params.closed) { q.params.pts = [...P.slice(k + 1), ...P.slice(0, k + 1)]; q.params.closed = false; msg = `${p.name} opened there`; return; }
      const pieces = [P.slice(0, k + 1), P.slice(k + 1)].filter(x => x.length >= 2);
      if (!pieces.length) { parts.splice(i, 1); msg = `${p.name} deleted (that was its last stretch)`; return; }
      q.params.pts = pieces[0];
      if (pieces.length === 1) { msg = `${p.name} shortened`; return; }
      const c = structuredClone(q);
      Object.assign(c, { id: doc.newId(), name: doc.nameFor('path') });
      c.params.pts = pieces[1];
      parts.splice(i + 1, 0, c);
      msg = `${p.name} split in two: ${p.name} and ${c.name}`;
    });
    eraseLog.push('doc');
    viewer.setDraft([]);
    status(`${msg}. U takes it back.`);
    return;
  }
  const g = frameGone(t);
  frameSave();
  const map = new Map();
  frame.verts.forEach((v, i) => { if (!g.verts.has(i)) map.set(i, map.size); });
  frame.verts = frame.verts.filter((_, i) => !g.verts.has(i));
  frame.edges = frame.edges.filter((_, k) => !g.edges.has(k)).map(ed => ed.map(v => map.get(v)));
  frame.faces = frame.faces.filter((_, k) => !g.faces.has(k)).map(f => f.map(v => map.get(v)));
  frame.cur = frame.cur != null && map.has(frame.cur) ? map.get(frame.cur) : null;
  frame.faceCur = []; frame.open = [];
  eraseLog.push('frame');
  showFrame(null); renderPathFly();
  const said = [[g.verts.size, 'point'], [g.edges.size, 'edge'], [g.faces.size, 'face']].filter(([n]) => n).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`);
  status(`Deleted from the frame: ${said.join(', ')}. U takes it back.`);
}
function eraseUndo() {
  const k = eraseLog.pop();
  if (!k) { status('Delete: nothing to take back.'); return; }
  if (k === 'frame') frameBack(); else docUndo();
  status('Delete taken back.');
}

function measureClick(e) {
  const s = viewer.snapPoint(e);
  if (!s) return;
  if (mPts.length >= 2) mPts = [];
  mPts.push(s.point);
  viewer.setMeasure(mPts);
  measureText();
}
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
// a line of text, not a button: quiet, at the bottom right of the view, while there is work and
// nothing keeps it; a click starts saving (the same as Save as project)
const autosaveNote = h('a', { class: 'autosave-note', href: '#', style: 'display:none', title: 'Name the project; every step is then kept as you work' }, 'Auto save is turned off, click here to enable');
autosaveNote.addEventListener('click', e => { e.preventDefault(); pickProjectFolder(); });
const footer = h('footer', {}, statusMsg, h('span', { class: 'busybar', role: 'progressbar', 'aria-label': 'Working' }, h('i')), autosaveNote);
let busyTimer = 0;
function busyCheck() {
  let on = /\.\.\.$/.test(statusMsg.textContent);
  try { on ||= [...pool.jobs.values()].some(j => !j.chore) || building.size > 0; } catch { /* still starting up */ }
  clearTimeout(busyTimer);
  if (on) busyTimer = setTimeout(() => footer.classList.add('busy'), 150);   // not for blinks of work
  else footer.classList.remove('busy');
}
const fatal = h('div', { class: 'fatal', style: 'display:none' });
view.append(header, dropHint, views, cut, moveCol, pastBanner, measureBox, snapBar, fatal, keyStrip, footer, selCount);
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

// ---- stereo (View > Stereo): for phone goggles and headsets; see stereo.js -------------------------
const stereo = new Stereo(app, viewer);
folders.recall('stereo').then(v => { if (v && typeof v === 'object') stereo.set = { ...stereo.set, ...v }; }).catch(() => {});
function setStereo(on) {
  stereo.enable(on);
  status(on ? `Stereo on: windows at ${STEREO_SCALES.find(s => s[0] === stereo.set.scale)[0]} scale. View > Stereo settings to change it.` : 'Stereo off.');
}
function showStereoPop() {
  const save = () => { folders.remember('stereo', stereo.set).catch(() => {}); if (stereo.on) stereo.layout(); };
  gridPop.style.display = '';
  gridPop.replaceChildren(h('h3', {}, 'Stereo'),
    ui.tip(h('div', { class: 'sub' }, 'Scale windows'), 'Whole fractions of half the screen, in device pixels: the picture is drawn at exactly that size'),
    seg(STEREO_SCALES.map(([k]) => [k, k]), stereo.set.scale, v => { stereo.set.scale = v; save(); }),
    h('div', { class: 'row' }, button(stereo.on ? 'Stereo off' : 'Stereo on', () => { setStereo(!stereo.on); showStereoPop(); }, { small: true }), button('Done', () => showGridPop(false), { small: true })));
}
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
let rewound = [];   // Ctrl+Z steps back with parts selected: [{ steps: [{ i: history index, ids }] }], newest last (see undo)
function bindDoc() {
  rewound = [];
  doc.on(rewoundFollows);
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
  const busyNow = () => [...building, ...(building.size ? viewer.kept : [])].filter(id => !holdView.has(id));
  for (const id of holdView.keys()) if (!need.some(p => p.id === id)) holdView.delete(id);
  viewer.sync(doc.parts, meshes, building.size > 0);
  for (const [id, x] of holdView) viewer.setXform(id, x);
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
    holdView.delete(p.id);
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
// A part resized by a handle or a typed size: until its new mesh is built, its old mesh stays
// shown the way the drag left it (stretched), not striped. Shown at its new settings, the old mesh
// sprang back to its old size for a moment and then jumped to the new one.
const holdView = new Map();   // part id -> placement of its current mesh that looks like the new form
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

let alignLit = false;   // L: the Align buttons lit (several parts selected); a new selection puts it out
function setSel(ids) {
  if (ids.length !== sel.length || ids.some((id, i) => id !== sel[i])) alignLit = false;
  endPast(false);
  if (facePlane && !(ids.length === 1 && ids[0] === facePlane.id)) facePlane = null;
  // another part picked while text is being wrapped: the wrap is let go (its text comes back flat)
  if ((wrap || wrapPick) && !(ids.length === 1 && ids[0] === (wrap?.id || wrapPick))) { cancelWrap(); status('Wrap cancelled: another part was selected.'); }
  sel = ids.filter(id => doc.top(id));
  viewer.select(sel);
  viewer.solo(pastHideOthers && sel.length ? [...sel] : null);   // Hide other parts follows the selection
  renderParts();
  renderInspector();
  if (drawing && (drawing.tool === 'frame' || drawing.tool === 'pointer')) renderPathFly();   // Edit frame follows the selection
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
  if (drawing) stopPath();   // a shape picked while drawing: Path closes (the 3D frame is kept)
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
  if (wrapPick) { const id = wrapPick; wrapPick = null; startWrap(id, hit); return; }
  if (!hit?.normal) { status('No face there: slide not set.'); return; }
  const { u, v } = viewer.planeAxes(hit.normal);
  facePlane = { id: sel[0], n: hit.normal, u, v };
  status(`${doc.top(sel[0]).name} slides along that face: arrows, Ctrl+Up/Down off and into it. Click empty space to end.`);
};
viewer.onPlace = (what, hit) => { if (what === 'move') placeAt(hit); else { placeAt(hit); commitPlace(); } };

// ---- text onto a part -------------------------------------------------------------------------
// The text is made flat (and edge shaped) first. Wrap bends that onto another part's surface
// where it is clicked; a press and drag on that part moves it and it re-forms as it goes. Done
// keeps it as a mesh part; a deboss is grouped with the part so it cuts. The flat text and the
// wrap settings stay on the part (flat, wrap), so Flat again brings the text back.
let wrapPick = null;   // the text part waiting for the click that says where it goes
let wrap = null;       // { id, target, surf, flat, ext, g, h, anchor, n, up, rot, spiral, mode, tris }
let wrapFrame = 0;
function startWrapPick(id) {
  if (drawing) stopPath();
  cancelWrap();
  wrapPick = id;
  viewer.pickingFace = true;
  status('Click the part the text goes on, where its middle goes.');
}
function startWrap(id, hit) {
  const p = doc.top(id), m = meshes.get(id);
  if (!hit?.id || hit.id === id) { status('Click another part: the text goes on its surface.'); return; }
  const tp = doc.top(hit.id), tm = meshes.get(hit.id);
  if (!p || !m || !tp || !tm) { status('Still building: try again when the stripes go.'); return; }
  // the part's surface in the world (a mirrored part's triangles turned back outward)
  const M = matrix(tp.view || tp.xform), t = tm.tris, wt = new Float32Array(t.length), v = new Vector3();
  const flip = M.determinant() < 0;
  for (let i = 0; i < t.length; i += 9) for (let k = 0; k < 3; k++) {
    const src = i + (flip && k ? (3 - k) * 3 : k * 3);
    v.set(t[src], t[src + 1], t[src + 2]).applyMatrix4(M);
    wt[i + k * 3] = v.x; wt[i + k * 3 + 1] = v.y; wt[i + k * 3 + 2] = v.z;
  }
  wrap = { id, target: hit.id, surf: new Surface(wt), slant: false, job: 0, ...flatForWrap(p, p.params, m),
    anchor: hit.point.clone(), n: hit.normal.clone(), up: null, rot: 0, spiral: 0, smooth: 0.5, mode: p.hole ? 'deboss' : 'emboss', tris: null };
  wrap.up = wrapUp(wrap.n, null);
  viewer.peek(id, false);
  viewer.drawTool = wrapTool;
  reform();
  renderInspector();
  status(`Text on ${tp.name}: press and drag on it to move the text. Done keeps it.`);
}
/** The flat text at its real size, round its middle, its foot at 0: {base, flat, ext, h, g, scale}.
 *  Plain text is made here from params (so a slider re-forms it at once) with its faces on a
 *  square grid (they shade evenly once bent); edge-shaped text is the part's mesh, split. */
function flatForWrap(p, params, m = meshes.get(p.id)) {
  const scale = (p.view || p.xform).scale.map(Math.abs), g = Math.max(0.25, Math.min(1, (params?.size || 10) / 12));   // grid, mm
  let f, s = scale, split = true;
  if (p.kind === 'text' && !p.ops?.length) {
    const { rings } = textRings(params);
    f = gridSolid(rings.map(r => r.map(([x, y]) => [x * s[0], y * s[1]])), params.h * s[2], g);
    s = [1, 1, 1]; split = false;
  } else f = m.tris;
  const lb = localBounds(f), cx = (lb.lo[0] + lb.hi[0]) / 2, cy = (lb.lo[1] + lb.hi[1]) / 2, flat = new Float32Array(f.length);
  for (let i = 0; i < f.length; i += 3) { flat[i] = (f[i] - cx) * s[0]; flat[i + 1] = (f[i + 1] - cy) * s[1]; flat[i + 2] = (f[i + 2] - lb.lo[2]) * s[2]; }
  const base = split ? subdivide(flat, g) : flat;
  return { base, flat: base, scale, g, h: (lb.hi[2] - lb.lo[2]) * s[2],
    ext: { x0: (lb.lo[0] - cx) * s[0], x1: (lb.hi[0] - cx) * s[0], y0: (lb.lo[1] - cy) * s[1], y1: (lb.hi[1] - cy) * s[1] } };
}
/** The wrapped text again from these letter settings (a slider being dragged, or a change kept). */
function rewrap(params) {
  const p = wrap && doc.top(wrap.id);
  if (!p || p.kind !== 'text') return;
  try { if (!textRings(params).rings.length) return; } catch { return; }
  Object.assign(wrap, flatForWrap(p, params));
  if (wrap.slant) refreshFlat(true);
  reformSoon();
}
/** The text's up: on a side, up the surface; on a top or bottom, as it was, else up on screen. */
function wrapUp(n, prev) {
  if (Math.abs(n.z) < 0.9) return new Vector3(0, 0, 1).addScaledVector(n, -n.z).normalize();
  const u = (prev || viewer.planeAxes(n).v).clone();
  u.addScaledVector(n, -u.dot(n));
  return u.lengthSq() > 1e-9 ? u.normalize() : viewer.planeAxes(n).v;
}
function reform() {
  if (!wrap) return;
  // tops round an inside corner at about 1.5 letter heights (they would cross themselves)
  const c = chart(wrap.surf, wrap.anchor, wrap.n, wrap.up, wrap.ext, wrap.g, wrap.rot, wrap.spiral, wrap.smooth, 1.5 * wrap.h);
  wrap.tris = deform(wrap.flat, c, wrap.h, wrap.mode);
  viewer.setPreview(wrap.tris, wrap.mode === 'deboss');
}
const reformSoon = () => { if (!wrapFrame) wrapFrame = requestAnimationFrame(() => { wrapFrame = 0; reform(); }); };
/** Which way is down across the letters at the anchor: [along the line, up the letters]. */
function wrapDown() {
  const n = wrap.n.clone().normalize(), u0 = wrap.up.clone().addScaledVector(n, -wrap.up.dot(n)).normalize();
  const a = (wrap.rot * Math.PI) / 180, up = u0.clone().multiplyScalar(Math.cos(a)).add(n.clone().cross(u0).multiplyScalar(Math.sin(a)));
  const right = up.clone().cross(n).normalize();
  return [-right.z, -up.z];
}
/** The flat letters again, with their undersides slanted for the way down here when asked
 *  (made by the reader worker; the last ask wins). */
let slantWait = 0;
function refreshFlat(soon = false) {
  if (!wrap) return;
  clearTimeout(slantWait);
  if (soon) { slantWait = setTimeout(() => refreshFlat(), 250); return; }
  const w = wrap, p = doc.top(w.id), u = wrapDown();
  if (!w.slant || !p?.params || Math.hypot(u[0], u[1]) < 0.3) {   // on a top or a bottom nothing overhangs
    if (w.flat !== w.base) { w.flat = w.base; reformSoon(); }
    if (w.slant) status('Nothing overhangs here: the letters face up or down.');
    return;
  }
  const job = ++w.job;
  status('Slanting the overhangs...');
  pool.call('io', { type: 'mesh', part: { id: 'slant', kind: p.kind, params: { ...p.params, slant: { u, deboss: w.mode === 'deboss' } }, xform: IDENT(), ops: p.ops || [], hole: false } }).then(r => {
    if (wrap !== w || w.job !== job) return;
    const t = r.tris, lb = localBounds(t), s = w.scale, cx = (lb.lo[0] + lb.hi[0]) / 2, cy = (lb.lo[1] + lb.hi[1]) / 2, f = new Float32Array(t.length);
    for (let i = 0; i < t.length; i += 3) { f[i] = (t[i] - cx) * s[0]; f[i + 1] = (t[i + 1] - cy) * s[1]; f[i + 2] = (t[i + 2] - lb.lo[2]) * s[2]; }
    w.flat = subdivide(f, w.g);
    reformSoon();
    status('Overhangs slanted to 45 deg.');
  }).catch(err => { if (wrap === w) status(shortErr(err.message), true); });
}
function moveWrap(hit) {
  wrap.anchor = hit.point.clone();
  wrap.n = hit.normal.clone();
  wrap.up = wrapUp(wrap.n, wrap.up);
  reformSoon();
}
const wrapTool = {
  // a press off the part does nothing (it would drop the selection and the panel with it)
  grab: e => { if (!wrap) return false; const hit = viewer.placeHit(e); if (hit?.id === wrap.target) moveWrap(hit); return true; },
  drag: e => { const hit = viewer.placeHit(e); if (wrap && hit?.id === wrap.target) moveWrap(hit); },
  drop: () => { if (wrap?.slant) refreshFlat(); },
};
function cancelWrap() {
  if (wrapPick) { wrapPick = null; viewer.pickingFace = false; }
  if (!wrap) return;
  cancelAnimationFrame(wrapFrame); wrapFrame = 0;
  viewer.setPreview(null);
  viewer.peek(wrap.id, true);
  if (viewer.drawTool === wrapTool) viewer.drawTool = null;
  wrap = null;
  renderInspector();
}
function finishWrap() {
  if (!wrap?.tris) return;
  const w = wrap, p = doc.top(w.id), tp = doc.top(w.target);
  if (!p || !tp) { cancelWrap(); return; }
  // its own frame: middle in X and Y, floor at its lowest point, placed back where it is
  const t = w.tris, b = localBounds(t), c = [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, b.lo[2]], local = new Float32Array(t.length);
  for (let i = 0; i < t.length; i += 3) { local[i] = t[i] - c[0]; local[i + 1] = t[i + 1] - c[1]; local[i + 2] = t[i + 2] - c[2]; }
  const rep = report(local);
  const blob = doc.addBlob(local);
  const flat = { kind: p.kind, params: p.params, ops: p.ops, xform: p.xform, hole: !!p.hole };
  const how = { target: w.target, anchor: w.anchor.toArray(), n: w.n.toArray(), up: w.up.toArray(), rot: w.rot, spiral: w.spiral, smooth: w.smooth, slant: w.slant, mode: w.mode };
  const xform = { pos: c.map(v => +v.toFixed(6)), rot: [0, 0, 0], scale: [1, 1, 1] };
  cancelWrap();
  doc.update([w.id], `Wrap ${p.name} onto ${tp.name}`, q => {
    q.kind = 'mesh'; q.blob = blob; delete q.params; q.ops = []; q.xform = xform; q.hole = w.mode === 'deboss'; q.flat = flat; q.wrap = how;
  });
  ready.set(shapeKey(doc.top(w.id)), { tris: local, volume: Math.abs(meshVolume(local)) });
  // locked to the part: the two grouped, so they move as one and a cut cuts; the lock in the
  // group's options lets the text go again
  const gid = doc.group([w.target, w.id]);
  if (gid) setSel([gid]);
  status(`${p.name} ${w.mode === 'deboss' ? 'cut into' : 'locked onto'} ${tp.name}.${rep.watertight ? '' : ` Not closed: ${describe(rep)}.`}`, !rep.watertight);
}
const LOCK_SVG = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="5.5" width="8" height="5.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 5.5V3.8a2 2 0 0 1 4 0v1.7" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
/** A group holding wrapped text: a lock row; Unlock takes the group apart, the text free to move. */
function textLockRow(p) {
  const t = p.children?.find(c => c.wrap);
  if (!t) return null;
  const other = p.children.find(c => c !== t);
  const b = button('Unlock', () => { if (p.locked) { status(`${p.name} is locked (Ctrl+L).`); return; } doc.ungroup(p.id); setSel([t.id]); status(`${t.name} unlocked: it moves on its own; Done on a new wrap locks it again.`); },
    { small: true, title: 'Take the text off the part, free to move' });
  const icon = h('span', { class: 'lockicon' });
  icon.innerHTML = LOCK_SVG;
  return h('div', { class: 'row lockrow' }, icon, h('span', { class: 'grow' }, `${t.name} locked to ${other?.name || 'the part'}`), b);
}
/** A wrapped text part back to its flat text, where it was before the wrap. */
function flatAgain(id) {
  const p = doc.top(id);
  if (!p?.flat) return;
  doc.update([id], `${p.name}: flat text again`, q => {
    const f = q.flat;
    q.kind = f.kind; q.params = f.params; q.ops = f.ops; q.xform = f.xform; q.hole = f.hole;
    delete q.blob; delete q.flat; delete q.wrap;
  });
}

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
const catchUp = () => { if (document.activeElement?.tagName !== 'INPUT' || !inspector.contains(document.activeElement)) renderInspector(); };
inspector.addEventListener('focusout', () => setTimeout(catchUp, 0));
// nor under a press in the panel or the color list: pressing a button moves focus (and a typed
// value is saved on leaving its field), and a rebuild between press and release swapped the
// button for a copy, so the browser dropped the click and every button needed two. A rebuild
// asked for meanwhile runs once the click is done.
// The same for a step's notes: a preview landing mid-press added a line above Apply, Apply
// moved down and the release fell on the card behind it.
let pressing = false, owed = false;
const held = [];
const whenFree = fn => (pressing ? held.push(fn) : fn());
addEventListener('pointerdown', e => { pressing = !!e.target.closest?.('aside, .flyout'); }, true);
const released = () => {
  pressing = false;
  if (owed || held.length) setTimeout(() => { for (const fn of held.splice(0)) fn(); if (owed) { owed = false; catchUp(); } }, 0);
};
addEventListener('pointerup', released, true);
addEventListener('pointercancel', released, true);
/** live: the part as a handle drag would leave it, shown while dragging (with `view`, the
 *  placement of its current mesh that looks the same). */
let histBlock = null;   // the History block last shown {id, nodes}: kept in place during a drag
/** Three number boxes on one row under a title (Size, Position, Rotation, Scale); extra sits at the
 *  title's right end. Each box keeps its full name (read aloud, and found by it) and shows a letter. */
const trio = (title, fields, extra) => h('div', { class: 'trio' }, h('div', { class: 'sub' }, h('span', {}, title), ...(extra ? [extra] : [])), h('div', { class: 'trio-row' }, ...fields));
const mini = (el, letter) => { el.classList.add('mini'); el.querySelector('label').dataset.s = letter; el.title ||= el.querySelector('label').textContent; return el; };
/** Handles on the one selected part, or on the box around several (none locked, no step or
 *  history view under way). */
function showHandles() {
  const free = sel.length && !step && !past && sel.every(id => doc.top(id) && !doc.top(id).locked);
  if (free && sel.length === 1) viewer.setHandles(sel[0]);
  else if (free) viewer.setHandleBox([...sel]);
  else viewer.setHandles(null);
}
/** The Rotation heading is the rings' switch: lit while they show, until pressed again. */
function ringsButton() {
  const b = button('Rotation Rings', () => { rotateOn = !rotateOn; viewer.setRings(rotateOn); b.classList.toggle('go', rotateOn); },
    { small: true, title: 'Shows the turn rings until pressed again. Holding R shows them too. The boxes below turn the part about its middle, in degrees.' });
  if (rotateOn) b.classList.add('go');
  return b;
}
function renderInspector(live = null) {
  if (pressing && !live) { owed = true; return; }
  showHandles();
  selCount.textContent = `${sel.length} parts selected`;
  selCount.style.display = sel.length > 1 ? '' : 'none';
  const hide = !sel.length;
  shapeOpts.style.display = hide || curTab !== 'shapes' ? 'none' : '';
  partOpts.style.display = hide || curTab !== 'parts' ? 'none' : '';
  if (hide) { inspector.style.display = 'none'; inspectorFor = null; return; }
  const key = sel.join();
  if (!live && inspectorFor === key && inspector.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  inspectorFor = key;
  inspector.style.display = '';
  if (sel.length > 1) {
    const first = doc.top(sel[0]);
    const ungroupBtn = button('Ungroup', () => ungroupSel(), { title: 'Ctrl+Shift+G' });
    const holes = sel.map(id => !!doc.top(id)?.hole);
    inspector.replaceChildren(
      // Solid / Hole for them all (lit on neither while they differ)
      seg([['solid', 'Solid'], ['hole', 'Hole']], holes.every(x => x) ? 'hole' : holes.every(x => !x) ? 'solid' : null, v => {
        const ids = editable();
        if (ids.length) doc.update(ids, `${ids.length} parts to ${v}`, q => { q.hole = v === 'hole'; });
      }),
      // Color and Hide other parts on one row, as for one part
      h('div', { class: 'pairrow' }, colorPicker(sel.every(id => doc.top(id)?.color === first?.color) ? first?.color : '', hex => {
        const ids = editable();
        if (ids.length) doc.update(ids, `Color ${ids.length} parts: ${colorName(hex)}`, q => { if (hex) q.color = hex; else delete q.color; q.hole = false; });
      }), ui.tip(ui.check('Hide other parts', pastHideOthers, v => { pastHideOthers = v; viewer.solo(v ? [...sel] : null); }), 'Show only these parts in the view while they are selected')),
      // the box around them all: typed sizes stretch them as the handles do; the rings turn them together
      ...(() => {
        const b = viewer.bounds(sel);
        if (!b) return [];
        const sz = b.getSize(new Vector3()).toArray();
        return [trio('Size, mm', ['Width', 'Depth', 'Height'].map((label, i) => mini(ui.numfield(label, +sz[i].toFixed(4), '', v => { if (v > 0) multiSize(i, v); },
          { min: 0.0001, step: moveStep, lazy: true, digits: 4 }), 'WDH'[i]))), h('div', { class: 'sub' }, ringsButton())];
      })(),
      h('div', { class: 'row' }, button('Group', () => groupSel(), { title: 'Ctrl+G' }), button('Intersect', () => groupSel('intersect'), { title: 'Ctrl+I' }), ungroupBtn),
      h('div', { class: 'sub' }, 'Align'),
      ...['X', 'Y', 'Z'].map((a, i) => h('div', { class: 'row align' }, h('span', { class: 'axis' }, a),
        ...ALIGN_WORDS[i].map((l, j) => { const b = button(l, () => alignSel(i, j / 2), { small: true, title: `Line the parts up on their ${l.toLowerCase()} ${l === 'Middle' ? 'in ' + a : 'sides'}` }); if (alignLit) b.classList.add('go'); return b; }))),
      button('Snap faces...', () => startFaceSnap(), { small: true, title: 'Click a face to snap to, then a face on another part: that part turns and moves onto the first face' }),
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
  // color and Hide other parts share a row (the panel scrolled on a scaled 1080p screen)
  const hideOthers = ui.tip(ui.check('Hide other parts', pastHideOthers, v => { pastHideOthers = v; viewer.solo(v ? p.id : null); if (past) scrubTo(past.k); }), 'Show only this part in the view while it is selected');
  // Color always shows; picking one on a hole makes it solid in the same step (no extra click)
  body.push(h('div', { class: 'pairrow' }, colorPicker(p.color, hex => upd(`${p.name} color: ${colorName(hex)}${p.hole ? ', solid' : ''}`, q => { if (hex) q.color = hex; else delete q.color; q.hole = false; })), hideOthers));
  // history of this part: each form it has had (shape, sizes, steps, turn, scale), not where
  // it has been. Dragging shows that form where the part is now; letting go sets it (one undo
  // step). Later forms stay in the list, so it can be stepped forward again.
  // during a drag the block is not rebuilt, but the one already shown stays in place, so nothing
  // below it jumps up and back (it used to drop out for the whole drag)
  const hist = live ? null : doc.formHistory(p.id);
  if (live && histBlock?.id === p.id) body.push(...histBlock.nodes);
  else if (hist && hist.length > 1) {
    const n = hist.length, key = formKey(p);
    let cur = n;
    for (let i = n - 1; i >= 0; i--) if (hist[i].key === key) { cur = i + 1; break; }
    const at = past?.id === p.id ? past.k : cur;
    const label = h('div', { class: 'note' });
    pastUi = { label, n, hist, cur, id: p.id };
    const nodes = [h('div', { class: 'sub' }, 'History'),
      ui.slider(`Step (of ${n})`, at, '', { min: 1, max: n, step: 1 }, k => scrubTo(k), k => setPast(k)),
      label];
    histBlock = { id: p.id, nodes };
    body.push(...nodes);
    pastLabel(at);
  } else { pastUi = null; histBlock = null; }
  // a closed path's inside, the bucket: the line alone, filled, or filled and cut through as a hole
  if (p.kind === 'path' && p.params.closed) {
    const inside = seg([['line', 'Hollow'], ['fill', 'Fill'], ['clear', 'Clear']], p.hole ? 'clear' : p.params.fill === 'fill' ? 'fill' : 'line',
      v => upd(`${p.name} inside: ${v === 'line' ? 'hollow' : v}`, q => { q.params.fill = v === 'line' ? 'line' : 'fill'; q.hole = v === 'clear'; }));
    // once the part has steps (a hollow, an edge shape), the line alone is not a choice: grayed out, saying why
    if (p.ops?.length) {
      // (grayed, not disabled: a disabled button shows no tip; a click says why in the status line)
      const b = inside.querySelector('button[data-v="line"]'), why = `Hollow is off: the part has ${p.ops.length} step${p.ops.length > 1 ? 's' : ''}; remove them under Steps to pick the line alone.`;
      b.classList.add('off'); b.setAttribute('aria-disabled', 'true');
      b.addEventListener('click', e => { e.stopImmediatePropagation(); status(why); }, true);   // capture: before the button's own pick
      ui.tip(b, why);
    }
    body.push(ui.tip(h('div', { class: 'sub' }, 'Inside'), 'Hollow: the line alone. Fill: the inside solid. Clear: the inside cuts a hole in what it sits on (in a group).'), inside);
  }
  if (p.kind === 'text') {
    // the words, then the letters' own sizes; sliders stretch and space them
    const P = p.params;
    const ta = h('textarea', { class: 'textin', rows: 2, spellcheck: 'false', 'aria-label': 'Text' });
    ta.value = P.text;
    let wait = 0;
    // while it is wrapped, every change here re-forms the wrapped text too (live while dragging)
    const wrapped = () => wrap?.id === p.id;
    const live = (k, v) => { if (wrapped()) rewrap({ ...doc.top(p.id).params, [k]: v }); };
    const kept = () => { if (wrapped()) rewrap(doc.top(p.id).params); };
    const send = () => { clearTimeout(wait); const v = ta.value; if (v !== doc.top(p.id)?.params.text) { upd(`${p.name}: text`, q => { q.params.text = v; }); kept(); } };
    ta.addEventListener('input', () => { clearTimeout(wait); live('text', ta.value); wait = setTimeout(send, 500); });
    ta.addEventListener('change', send);
    body.push(h('div', { class: 'sub' }, 'Text'), ta);
    const miss = [...new Set([...P.text].filter(c => c !== '\n' && !hasGlyph(c)))];
    if (miss.length) body.push(h('div', { class: 'note' }, `Left out: ${miss.join(' ')}`));
    const set = (k, label) => v => { upd(`${p.name}: ${label.toLowerCase()} ${v}`, q => { q.params[k] = v; }); kept(); };
    const num = (k, label, o) => ui.numfield(label, P[k], 'mm', set(k, label), { lazy: true, digits: 3, ...o });
    const sl = (k, label, unit, o) => ui.slider(label, P[k], unit, o, v => live(k, v), set(k, label));
    body.push(num('size', 'Size', { min: 0.0001, step: 1 }), num('h', 'Height', { min: 0.0001, step: 0.5 }),
      ui.tip(sl('width', 'Line width', 'mm', { min: 0.2, max: Math.max(4, +(P.size / 2).toFixed(1)), step: 0.05, digits: 2, limits: [0.0001, Infinity] }),
        'Grows or shrinks every stroke about its centre line.'),
      sl('spacing', 'Letter spacing', 'mm', { min: -2, max: 10, step: 0.1, digits: 2, limits: [-Infinity, Infinity] }),
      sl('lineGap', 'Line spacing', 'mm', { min: -2, max: 20, step: 0.1, digits: 2, limits: [-Infinity, Infinity] }),
      sl('sx', 'Stretch across', '%', { min: 20, max: 400, step: 1, limits: [0.0001, Infinity] }),
      sl('sy', 'Stretch up', '%', { min: 20, max: 400, step: 1, limits: [0.0001, Infinity] }),
      ui.check('Vertical', P.vertical, v => { upd(`${p.name}: ${v ? 'vertical' : 'across'}`, q => { q.params.vertical = v; }); kept(); }));
    if (wrap?.id === p.id) {
      body.push(h('div', { class: 'sub' }, `On ${doc.top(wrap.target)?.name || 'a part'}`),
        seg([['emboss', 'Emboss'], ['deboss', 'Deboss']], wrap.mode, v => { wrap.mode = v; if (wrap.slant) refreshFlat(); else reformSoon(); }),
        ui.slider('Turn', wrap.rot, 'deg', { min: -180, max: 180, step: 1, limits: [-Infinity, Infinity] }, v => { wrap.rot = v; reformSoon(); }, v => { wrap.rot = v; reformSoon(); if (wrap.slant) refreshFlat(true); }),
        ui.tip(ui.slider('Spiral', wrap.spiral, 'deg', { min: -60, max: 60, step: 1, limits: [-80, 80] }, v => { wrap.spiral = v; reformSoon(); }),
          'Tilts the line the letters sit on; the letters stay upright. Round a cylinder it climbs as a spiral.'),
        ui.tip(ui.slider('Smooth over', wrap.smooth, 'mm', { min: 0, max: 10, step: 0.1, digits: 1, limits: [0, Infinity] }, v => { wrap.smooth = v; reformSoon(); }),
          'Surface detail smaller than this is bridged; larger detail the letters follow. 0 follows every groove and edge.'),
        ui.tip(ui.check('Slant overhangs', wrap.slant, v => { wrap.slant = v; refreshFlat(); }),
          'Undersides of the letters (and the ceilings of cut-in letters) at 45 deg, so text on a wall prints without supports.'),
        h('div', { class: 'row' }, button('Done', () => finishWrap(), { go: true }), button('Cancel', () => cancelWrap())));
    } else {
      body.push(h('div', { class: 'row' }, button('Wrap onto a part', () => startWrapPick(p.id), { title: 'Bend the text onto another part: click where it goes, then press and drag to move it' })));
    }
  }
  if (p.flat) body.push(h('div', { class: 'row' }, button('Flat text again', () => flatAgain(p.id), { title: 'Back to the flat text, before it was wrapped' })));
  if (p.params && p.kind !== 'text') {
    const pf = (k, v, facets, unit = facets ? '' : 'mm') => ui.numfield(LABELS[k] || k, v, unit, nv => upd(`${p.name}: ${(LABELS[k] || k).toLowerCase()} ${nv}`, q => { q.params[k] = facets ? Math.round(nv) : nv; }),
      { min: facets ? 3 : k === 'd2' || k === 'd1' ? 0 : 0.0001, step: facets ? 4 : 1, lazy: true, digits: facets ? 0 : 4 });
    // a box's three sizes on one row
    const xyz = ['x', 'y', 'z'].every(k => typeof p.params[k] === 'number');
    if (xyz) body.push(trio('Size, mm', ['x', 'y', 'z'].map((k, i) => mini(pf(k, p.params[k], false, ''), 'WDH'[i]))));
    for (const [k, v] of Object.entries(p.params)) {
      if (typeof v !== 'number') continue;   // a path's points, closed and inside are not sizes
      if (p.kind === 'path' && k === 'h') continue;   // its height is under Size, with width and depth
      if (xyz && (k === 'x' || k === 'y' || k === 'z')) continue;
      body.push(pf(k, v, k === 'sides' || k === 'tubeSides'));
    }
  }
  if (p.kind === 'group') {
    const lockRow = textLockRow(p);
    body.push(lockRow || h('div', { class: 'row' }, button('Ungroup', () => ungroupSel(), { title: 'Ctrl+Shift+G' })));
  }
  if (p.frame && path3dOn) body.push(h('div', { class: 'row' }, button('Edit frame', () => editFrame(doc.top(p.id)), { title: 'Its 3D frame back in Path, where the part is now: add to it, then Make solid updates this part' })));
  // typed sizes for imports, groups and paths (shapes have their own sizes above): the same change
  // as the size handles, kept exactly as typed
  if (m && (p.kind === 'mesh' || p.kind === 'group' || p.kind === 'path' || p.kind === 'text')) {
    const lb = boundsOf(m), sc = (p.view || p.xform).scale;
    body.push(trio('Size, mm', ['Width', 'Depth', 'Height'].map((label, i) => {
      const cur = (lb.hi[i] - lb.lo[i]) * Math.abs(sc[i]);
      return mini(ui.numfield(label, +cur.toFixed(4), '', v => {
        const q0 = doc.top(p.id);
        if (!q0 || !(v > 0) || !(cur > 0)) return;
        const r = handleResult({ p: q0, lb }, { kind: 'size', axis: i, side: 0, exact: true, size: v }, {});
        if (!r.same && !lock) holdView.set(p.id, r.view);
        if (!r.same) upd(r.label, q => { q.params = r.part.params; q.xform = r.part.xform; });
      }, { min: 0.0001, step: moveStep, lazy: true, digits: 4 }), 'WDH'[i]);
    })));
  }
  body.push(trio(ringsButton(), ['X', 'Y', 'Z'].map((a, i) => mini(ui.numfield(a, p.xform.rot[i], '',
    v => upd(`Rotate ${p.name}`, q => { const r = [...q.xform.rot]; r[i] = v; q.xform = rotated(q, r); }), { step: 15, lazy: true, digits: 3 }), a))));
  if (!p.params || p.xform.scale.some(v => v !== 1)) {
    body.push(trio('Scale, %', ['X', 'Y', 'Z'].map((a, i) => mini(ui.numfield(a, p.xform.scale[i] * 100, '', v => upd(`Scale ${p.name}`, q => { q.xform.scale[i] = v / 100; q.xform = snapped(q, q.xform); }), { min: 0.0001, step: 10, lazy: true, digits: 4 }), a))));
  }
  // where the part really is: its middle in X and Y, its lowest point in Z (0 = on the plate).
  // Last of the boxes: the least used.
  const wb = worldBox(p, p.view || p.xform);
  if (wb) {
    const at = [(wb.min.x + wb.max.x) / 2, (wb.min.y + wb.max.y) / 2, wb.min.z];
    body.push(ui.tip(trio('Position, mm', [['Center X', 0], ['Center Y', 1], ['Bottom Z', 2]].map(([label, i]) => mini(ui.numfield(label, +at[i].toFixed(4), '',
      v => upd(`Move ${p.name}`, q => { q.xform.pos[i] = +(q.xform.pos[i] + v - at[i]).toFixed(6); q.xform = snapped(q, q.xform); }), { step: moveStep, lazy: true, digits: 3 }), 'XYZ'[i]))),
      'X and Y: the middle of the part. Z: its lowest point (0 is on the plate).'));
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
  body.push(h('div', { class: 'row wrap steps' }, ...usable.map(t => button(t.title, () => startStep(t, p.id), { small: true, title: t.blurb }))));
  // a tool's settings open right here, under the button that opened them
  if (step && step.partId === p.id) body.push(stepCard);
  if (lock) body.push(h('div', { class: 'note' }, 'Locked: Ctrl+L to unlock.'));
  // the numbers and Export sit at the foot of the panel, so they stay put while the rest changes
  const info = h('div', { class: 'infobox' });
  if (m) {
    const b = wb;
    info.append(dimsBox(b && b.getSize(new Vector3())), kv([['volume', `${(realVolume(p, m) / 1000).toFixed(2)} cm3`], ['triangles', count(m.tris.length / 9)], ['STL', `about ${sizeText(stlBytes(m.tris.length / 9))}`]]));
  }
  info.append(h('div', { class: 'row' }, button('Export this part...', () => { expWhat = 'sel'; exportDialog(); }, { small: true, title: 'Export only this part (Ctrl+E exports with the last choices)' })));
  body.push(info);
  inspector.replaceChildren(...body);
}

/** The outer size, large, in a frame with its caption on the line (a group box, not a button:
 *  no fill, no hover, the frame in the border gray). s: Vector3 or null while building. */
function dimsBox(s) {
  return h('div', { class: 'dims' }, h('span', { class: 'cap' }, 'Outer size, mm'),
    ...['X', 'Y', 'Z'].map(a => h('div', { class: 'd' }, h('b', {}, s ? mm(s[a.toLowerCase()]) : '-'), h('span', {}, a))));
}

/** A part's volume at its real size: its mesh is in its own frame, before scale. */
const realVolume = (p, m) => (m.volume || 0) * Math.abs(((p.view || p.xform)?.scale || [1, 1, 1]).reduce((a, b) => a * b, 1));

/** Several parts selected: their numbers added up (size is the box round them all). */
function selTotals() {
  let tris = 0, vol = 0, all = true;
  const b = new Box3();
  for (const id of sel) {
    const p = doc.top(id), m = meshes.get(id);
    if (!p || !m) { all = false; continue; }
    tris += m.tris.length / 9;
    vol += realVolume(p, m);
    const wb = worldBox(p);
    if (wb) b.union(wb);
  }
  const s = b.isEmpty() ? null : b.getSize(new Vector3());
  // the same order as one part's: the outer size, the totals, Export at the foot
  return h('div', { class: 'infobox' }, ...(all ? [] : [h('div', { class: 'sub' }, 'Some still building')]),
    dimsBox(s), kv([['volume', `${(vol / 1000).toFixed(2)} cm3`], ['triangles', count(tris)], ['STL', `about ${sizeText(stlBytes(tris))}`]]),
    h('div', { class: 'row' }, button('Export these parts...', () => { expWhat = 'sel'; exportDialog(); }, { small: true, title: 'Export only the selected parts, joined or one file each' })));
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
  showHandles();
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
  if (measureOn) { measureClick(e); return; }
  if (fsnap && !fsnap.b) { faceSnapPick(id, face); return; }
  if (id && viewer.busy?.has(id)) { status('Still building: wait until the stripes go.'); return; }
  // while a step works, its picks stay as they were sent: a click must not add or drop a face
  // under a running job (dragging the part still moves it)
  const picking = step && id === step.partId && (step.tool.needsFace || step.tool.pickWalls?.(step.params));
  if (picking && step.running) { status(`${step.tool.title} is working: the picked faces are locked until it finishes.`); return; }
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
  const snap = moveStep;
  drag.d = [+(Math.round(dx / snap) * snap).toFixed(6), +(Math.round(dy / snap) * snap).toFixed(6)];
  for (const id of drag.ids) {
    const p = doc.top(id), s = drag.start.get(id);
    viewer.setXform(id, { ...p.xform, pos: [s[0] + drag.d[0], s[1] + drag.d[1], s[2]] });
  }
  status(`Move ${mm(drag.d[0])}, ${mm(drag.d[1])} mm`);
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
// sizes every axis together. A side handle pulls that side only, round shapes too (a circle
// pulled one way goes oval, by its scale); a shape's own sizes change where they can (a box
// keeps scale 1, a cylinder pulled up keeps its height), otherwise its scale. Lift: Z in move
// steps. Turn: about the part's middle, 15 degree steps (Shift: 1). The panel follows live; one
// undo step on release.
const ROUND = { cylinder: 1, tube: 1, cone: 1, torus: 1, sphere: 1 };
let hdrag = null;
viewer.onHandle = (phase, h, e) => {
  if (sel.length > 1) { multiHandle(phase, h, e); return phase === 'start' ? !!hdrag : undefined; }
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
  holdView.set(d.p.id, r.view);
  doc.update([d.p.id], r.label, q => { q.params = r.part.params; q.xform = r.part.xform; });
};

// Several parts selected: the handles sit on the box around them all and work on them as if
// grouped, without grouping. Size: the box stretches from its far side (Shift: all ways), each
// part sized along its own axis nearest the pulled one and moved so it keeps its place in the
// box. Lift: all up together. Turn: all about the box's middle. One undo step on release.
/** The world box of a part's own box corners, as placed by xform (as the view's box is). */
function cornerBox(lb, xform) {
  const M = matrix(xform), b = new Box3();
  for (const x of [lb.lo[0], lb.hi[0]]) for (const y of [lb.lo[1], lb.hi[1]]) for (const z of [lb.lo[2], lb.hi[2]]) b.expandByPoint(new Vector3(x, y, z).applyMatrix4(M));
  return b;
}
function multiHandle(phase, h, e) {
  if (phase === 'start') {
    const ps = sel.map(id => doc.top(id));
    if (step || past || ps.some(p => !p || p.locked || !meshes.get(p.id))) { hdrag = null; return; }
    const lbs = new Map(ps.map(p => [p.id, localBounds(meshes.get(p.id).tris)]));
    const box = new Box3();
    for (const p of ps) box.union(cornerBox(lbs.get(p.id), p.xform));
    hdrag = { multi: true, ps: ps.map(p => structuredClone(p)), lbs, box, next: null };
    return;
  }
  if (!hdrag?.multi) return;
  if (phase === 'move') {
    const r = multiResult(hdrag, h, e);
    hdrag.next = r;
    for (const [id, x] of r.out) viewer.setXform(id, x.view);
    status(r.text);
    return;
  }
  const d = hdrag; hdrag = null;
  if (!ringsHeld) viewer.setRings(rotateOn);
  multiCommit(d.next);
}
function multiCommit(r) {
  if (!r || r.same) { viewer.sync(doc.parts, meshes); renderInspector(); return; }
  for (const [id, x] of r.out) holdView.set(id, x.view);
  doc.update([...r.out.keys()], r.label, q => { const x = r.out.get(q.id); q.params = x.part.params; q.xform = x.part.xform; });
}
/** A typed size for several parts: the same stretch as a handle, from the middle and the bottom. */
function multiSize(axis, size) {
  multiHandle('start');
  const d = hdrag;
  hdrag = null;
  if (d) multiCommit(multiResult(d, { kind: 'size', axis, side: 0, exact: true, size }, { shiftKey: false }));
}
function multiResult(d, h, e) {
  const { box: B, ps, lbs } = d, out = new Map(), n = ps.length;
  const lo = B.min.toArray(), hi = B.max.toArray(), mid = B.getCenter(new Vector3());
  const move = (x, dv) => { for (const xf of [x.part.xform, x.view]) xf.pos = xf.pos.map((v, j) => +(v + dv[j]).toFixed(6)); };
  if (h.kind === 'lift') {
    const dz = +(Math.round(h.delta / moveStep) * moveStep).toFixed(6);
    for (const p of ps) { const part = structuredClone(p); part.xform.pos[2] = +(part.xform.pos[2] + dz).toFixed(6); out.set(p.id, { part, view: part.xform }); }
    return { out, same: !dz, label: `Lift ${n} parts ${mm(dz)} mm`, text: `Lift ${mm(dz)} mm (${n} parts)` };
  }
  if (h.kind === 'rot') {
    const st = e.shiftKey ? 1 : 15, deg = Math.round(h.deg / st) * st;   // (as handleResult rounds it)
    for (const p of ps) {
      const r = handleResult({ p, lb: lbs.get(p.id) }, h, e), lb = lbs.get(p.id);
      // each part turns about its own middle (handleResult), then its middle swings about the box's
      const c = new Vector3((lb.lo[0] + lb.hi[0]) / 2, (lb.lo[1] + lb.hi[1]) / 2, (lb.lo[2] + lb.hi[2]) / 2).applyMatrix4(matrix(p.xform));
      const qa = new Quaternion().setFromAxisAngle(new Vector3().setComponent(h.axis, 1), (deg * Math.PI) / 180);
      const to = c.clone().sub(mid).applyQuaternion(qa).add(mid);
      const x = { part: r.part, view: r.part.xform };
      move(x, to.sub(c).toArray());
      out.set(p.id, x);
    }
    return { out, same: !deg, label: `Turn ${n} parts ${deg} deg about ${'XYZ'[h.axis]}`, text: `Turn ${deg} deg about ${'XYZ'[h.axis]} (${n} parts)${e.shiftKey ? '' : '  (Shift: 1 deg steps)'}` };
  }
  // size: the box's new size on the pulled axis, in move steps; the point that stays: the far side
  // on that axis, the middle across, the bottom in Z (as for one part)
  const i = h.axis, size0 = hi[i] - lo[i];
  // pulled back through past the side that stays: they all mirror on that axis (as one part does)
  const raw = h.exact ? h.size : size0 + h.delta, flip = !h.exact && h.side && raw < 0;
  const size = h.exact ? h.size : Math.max(moveStep, Math.round(Math.abs(raw) / moveStep) * moveStep);
  const k = size / size0, f = e.shiftKey ? [k, k, k] : [0, 1, 2].map(j => (j === i ? k : 1));
  if (flip) f[i] = -f[i];
  const a = [0, 1, 2].map(j => (j === i && h.side ? (h.side > 0 ? lo[j] : hi[j]) : j < 2 ? mid.getComponent(j) : lo[2]));
  for (const p of ps) {
    const lb = lbs.get(p.id), s = p.xform.scale;
    // the part's own axis that lies nearest the pulled one
    const R = matrix({ pos: [0, 0, 0], rot: p.xform.rot, scale: [1, 1, 1] }).elements;
    const jl = [0, 1, 2].reduce((best, j) => (Math.abs(R[j * 4 + i]) > Math.abs(R[best * 4 + i]) ? j : best), 0);
    const own = (lb.hi[jl] - lb.lo[jl]) * Math.abs(s[jl]);
    const x = handleResult({ p, lb }, { kind: 'size', axis: jl, side: 0, exact: true, size: own * k }, e);
    if (flip) for (const xf of [x.part.xform, x.view]) xf.scale = xf.scale.map((v, j) => (j === jl ? -v : v));   // mirrored, as M does
    // keep its place in the box: its middle across and its bottom in Z scaled from the point that
    // stays (mirrored in Z, its old top becomes its bottom)
    const b0 = cornerBox(lb, p.xform), b1 = cornerBox(lb, x.view);
    const at0 = [(b0.min.x + b0.max.x) / 2, (b0.min.y + b0.max.y) / 2, f[2] < 0 ? b0.max.z : b0.min.z], at1 = [(b1.min.x + b1.max.x) / 2, (b1.min.y + b1.max.y) / 2, b1.min.z];
    move(x, [0, 1, 2].map(j => a[j] + (at0[j] - a[j]) * f[j] - at1[j]));
    out.set(p.id, x);
  }
  const names = ['Width', 'Depth', 'Height'];
  return { out, same: !flip && Math.abs(k - 1) < 1e-9, label: `Size ${n} parts: ${e.shiftKey ? 'all' : names[i].toLowerCase()} ${mm(size)} mm${flip ? ', mirrored' : ''}`,
    text: `${names[i]} ${mm(size)} mm (${n} parts)${flip ? ' (mirrored)' : ''}${e.shiftKey ? ' (all sides together)' : '  (Shift: all sides together)'}` };
}

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
  // a typed size (exact) is kept as typed; a drag snaps to the move step
  const i = h.axis, size0 = (hi[i] - lo[i]) * Math.abs(s[i]);
  // a handle pulled back through the part past the side that stays: the part mirrors on that axis
  // (as M does) and keeps stretching out the other way
  const raw = h.exact ? h.size : size0 + h.delta, flip = !h.exact && h.side && raw < 0;
  const size = h.exact ? h.size : Math.max(moveStep, Math.round(Math.abs(raw) / moveStep) * moveStep);
  const k = size / size0, f = [1, 1, 1];
  if (e.shiftKey) f.fill(k);
  else {
    f[i] = k;
    if (p.kind === 'fillet' && i !== 1) f[0] = f[2] = k;   // its corner stays square
  }
  if (flip) f[i] = -f[i];
  // the point that must not move: the far side on this axis, the middle across, the bottom in Z
  // (a typed size, side 0, keeps the middle and the bottom, as the Position fields read)
  const a = [0, 1, 2].map(j => j === i && h.side ? (h.side > 0 ? lo[j] : hi[j]) : j < 2 ? (lo[j] + hi[j]) / 2 : lo[2]);
  const shift = new Vector3(...a.map((v, j) => s[j] * (f[j] - 1) * v)).applyMatrix4(R);
  const view = { ...x0, pos: [x0.pos[0] - shift.x, x0.pos[1] - shift.y, x0.pos[2] - shift.z].map(v => +v.toFixed(6)), scale: s.map((v, j) => v * f[j]) };
  part.xform = { ...view, scale: [...s] };
  // a shape's own sizes take the size; a mirror (pulled through) stays in its scale, as M does
  const P = part.params, mul = (key, j) => { if (P[key] != null) P[key] = +(P[key] * Math.abs(f[j])).toFixed(6); };
  const kind = p.kind;
  // a round shape pulled out of round (across one way, or a sphere any one way) takes it in its scale
  const af = f.map(Math.abs);
  const oval = ROUND[kind] && (af[0] !== af[1] || ((kind === 'sphere' || kind === 'torus') && af[0] !== af[2]));
  if (flip) part.xform.scale[i] = -part.xform.scale[i];
  if (oval) part.xform.scale = view.scale.map(v => +v.toFixed(6));
  else if (kind === 'box' || kind === 'wedge') { mul('x', 0); mul('y', 1); mul('z', 2); }
  else if (kind === 'path') {
    // the line keeps its width: the points spread so the outside comes to the size asked
    const w = P.width, fp = [0, 1].map(j => { const ext = (hi[j] - lo[j]) * Math.abs(s[j]); return af[j] === 1 || ext - w < 1e-9 ? af[j] : (af[j] * ext - w) / (ext - w); });
    P.pts = P.pts.map(([x, y]) => [+(x * fp[0]).toFixed(6), +(y * fp[1]).toFixed(6)]);
    mul('h', 2);
  }
  else if (kind === 'text') {
    // the letters keep their line width: the centre lines stretch so the outside comes to the size asked
    const w = P.width, fp = [0, 1].map(j => { const ext = (hi[j] - lo[j]) * Math.abs(s[j]); return af[j] === 1 || ext - w < 1e-9 ? af[j] : (af[j] * ext - w) / (ext - w); });
    P.sx = +(P.sx * fp[0]).toFixed(4); P.sy = +(P.sy * fp[1]).toFixed(4);
    mul('h', 2);
  }
  else if (kind === 'cylinder' || kind === 'tube') { mul('d', 0); mul('h', 2); if (e.shiftKey) mul('wall', 0); }
  else if (kind === 'cone') { mul('d1', 0); mul('d2', 0); mul('h', 2); }
  else if (kind === 'sphere') mul('d', 0);
  else if (kind === 'fillet') { mul('r', 0); mul('length', 1); }
  else if (kind === 'torus' && e.shiftKey) { mul('d', 0); mul('tube', 0); }
  else part.xform.scale = view.scale.map(v => +v.toFixed(6));   // meshes, groups, a torus pulled out of round
  const names = ['Width', 'Depth', 'Height'];
  return { part, view, same: !flip && Math.abs(k - 1) < 1e-9, label: `Size ${p.name}: ${e.shiftKey ? 'all' : names[i].toLowerCase()} ${mm(size)} mm${flip ? ', mirrored' : ''}`,
    text: `${names[i]} ${mm(size)} mm${flip ? ' (mirrored)' : ''}${e.shiftKey ? ' (all sides together)' : '  (Shift: all sides together)'}` };
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
// ---- snap faces: the second face clicked turns and moves onto the first --------------------------
// Click a face (its part stays put), then a face on another part: that part turns so the two
// faces lie against each other, and moves onto the first, centered. A bar under the menus then
// sets where on the first face it sits: Center, or flush with its Left, Right, Top or Bottom edge
// as seen on screen. Each placing is one undo step; Esc or Done ends it.
let fsnap = null;   // { a: face } after the first click; { a, b, moved } once snapped (snapBar is made with measureBox)
function startFaceSnap() {
  if (doc.parts.filter(p => !p.hidden).length < 2) { status('Snap faces needs two parts.'); return; }
  cancelStep(); cancelPlace();
  if (measureOn) setMeasure(false);
  if (drawing) stopPath();
  fsnap = {};
  snapBar.replaceChildren(h('span', {}, 'Click the face to snap to'));
  snapBar.style.display = '';
  status('Snap faces: click the face to snap to (that part stays), then a face on the part to move. Esc ends it.');
}
function endFaceSnap() { fsnap = null; snapBar.style.display = 'none'; viewer.setFacePick(null); }
/** A flat face of a part, in the world: its outward normal, its points and its middle (by area). */
function worldFace(id, face) {
  const p = doc.top(id), m = meshes.get(id);
  if (!p || !m || face < 0) return null;
  const r = faceRegion(m.tris, face), M = matrix(p.xform), N = new Matrix3().getNormalMatrix(M);
  const pts = [], c = new Vector3();
  let area = 0;
  for (const f of r.tris) {
    const v = [0, 1, 2].map(k => new Vector3(m.tris[f * 9 + k * 3], m.tris[f * 9 + k * 3 + 1], m.tris[f * 9 + k * 3 + 2]).applyMatrix4(M));
    const a = v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0])).length() / 2;
    c.addScaledVector(v[0].clone().add(v[1]).add(v[2]).divideScalar(3), a); area += a;
    pts.push(...v);
  }
  return { id, n: new Vector3(...r.normal).applyMatrix3(N).normalize(), pts, c: c.divideScalar(area || 1), local: r };
}
function faceSnapPick(id, face) {
  if (!id) return;
  const F = worldFace(id, face);
  if (!F) return;
  if (!fsnap.a) {
    fsnap.a = F;
    viewer.setFacePick(id, F.local.tris);
    snapBar.replaceChildren(h('span', {}, 'Now a face on the part to move'));
    status('Now click a face on the part to move onto it.');
    return;
  }
  if (id === fsnap.a.id) { status('Pick a face on another part: the first face\'s part stays put.'); return; }
  if (doc.top(id).locked) { status(`${doc.top(id).name} is locked (Ctrl+L).`); return; }
  fsnap.b = F;
  fsnap.base = structuredClone(doc.top(id).xform);
  placeSnap('center');
}
/** Turn the second part so its face lies on the first, then put it at `where` on that face. */
function placeSnap(where) {
  const { a, b } = fsnap, p = doc.top(b.id);
  if (!p) { endFaceSnap(); return; }
  // turn: the moving face's normal onto the opposite of the first face's, about the face's middle
  const R = new Quaternion().setFromUnitVectors(b.n, a.n.clone().negate());
  const turn = q => q.clone().sub(b.c).applyQuaternion(R).add(b.c);
  const pts = b.pts.map(turn), c = turn(b.c);
  // in the first face's plane, along the face itself: a world axis lying in it (the face's longest
  // edge on a slanted face), the one nearest to running across the screen; the screen only says
  // which way is right and which is up, so Left, Right, Top and Bottom are as seen
  const scr = viewer.planeAxes(a.n);
  const inPlane = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)].filter(x => Math.abs(x.dot(a.n)) < 1e-6);
  if (!inPlane.length) {
    let best = null, bl = 0;
    for (let i = 0; i < a.pts.length; i += 3) for (let k = 0; k < 3; k++) {
      const e = a.pts[i + (k + 1) % 3].clone().sub(a.pts[i + k]), l = e.length();
      if (l > bl) { bl = l; best = e; }
    }
    inPlane.push(best.normalize());
  }
  const u = inPlane.reduce((m, x) => (Math.abs(x.dot(scr.u)) > Math.abs(m.dot(scr.u)) ? x : m)).clone();
  if (u.dot(scr.u) < 0) u.negate();
  const v = a.n.clone().cross(u).normalize();
  if (v.dot(scr.v) < 0) v.negate();
  const span = (list, ax) => { let lo = Infinity, hi = -Infinity; for (const q of list) { const s = q.dot(ax); lo = Math.min(lo, s); hi = Math.max(hi, s); } return [lo, hi]; };
  const [au0, au1] = span(a.pts, u), [av0, av1] = span(a.pts, v), [bu0, bu1] = span(pts, u), [bv0, bv1] = span(pts, v);
  // across the face: centered, or one edge flush with the same edge of the first face
  let du = a.c.dot(u) - c.dot(u), dv = a.c.dot(v) - c.dot(v);
  if (where === 'left') du = au0 - bu0;
  if (where === 'right') du = au1 - bu1;
  if (where === 'bottom') dv = av0 - bv0;
  if (where === 'top') dv = av1 - bv1;
  // onto the plane: the moved face's plane meets the first face's
  const dn = a.c.dot(a.n) - c.dot(a.n);
  const T = u.clone().multiplyScalar(du).addScaledVector(v, dv).addScaledVector(a.n, dn);
  const x0 = fsnap.base;
  const q0 = new Quaternion().setFromEuler(new Euler(...x0.rot.map(r => r * Math.PI / 180), 'XYZ'));
  const e = new Euler().setFromQuaternion(R.clone().multiply(q0), 'XYZ');
  const pos = turn(new Vector3(...x0.pos)).add(T);
  doc.update([p.id], `Snap ${p.name} to ${doc.top(a.id)?.name || 'a face'}${where === 'center' ? '' : ', ' + where + ' edge'}`, q => {
    q.xform = { ...q.xform, pos: [pos.x, pos.y, pos.z].map(t => +t.toFixed(6)), rot: [e.x, e.y, e.z].map(r => { const g = +(r * 180 / Math.PI).toFixed(4); return Object.is(g, -0) ? 0 : g; }) };
  });
  fsnap.where = where;
  snapBar.replaceChildren(h('span', {}, 'On the face:'),
    seg([['center', 'Center'], ['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom']], where, w => placeSnap(w)),
    button('Done', () => { endFaceSnap(); status('Snapped.'); }, { small: true }));
  status(`${p.name} snapped onto the face${where === 'center' ? ', centered' : `, flush with its ${where} edge`}. Pick where on the face above, or Done.`);
}

// what each align button does, by axis, in words (low end, middle, high end)
const ALIGN_WORDS = [['Left', 'Middle', 'Right'], ['Front', 'Middle', 'Back'], ['Bottom', 'Middle', 'Top']];
function alignSel(axis, f) {
  const ids = editable();
  if (ids.length < 2) return;
  const boxes = new Map(ids.map(id => [id, worldBox(doc.top(id))]).filter(([, b]) => b));
  let lo = Infinity, hi = -Infinity;
  for (const b of boxes.values()) { lo = Math.min(lo, b.min.getComponent(axis)); hi = Math.max(hi, b.max.getComponent(axis)); }
  const target = lo + (hi - lo) * f;
  doc.update([...boxes.keys()], `Align ${ALIGN_WORDS[axis][f * 2].toLowerCase()}${f === 0.5 ? ' in ' + 'XYZ'[axis] : ''}`, p => {
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
// Ctrl+C / X / V: the key handler takes them and stops the browser's own copy. Where the browser
// takes the key first, its copy, cut and paste events still come here (not inside a text box).
const clipTarget = e => !e.target.closest?.('input, textarea, [contenteditable]') && !document.querySelector('dialog[open]');
document.addEventListener('copy', e => { if (clipTarget(e) && sel.length) { e.preventDefault(); copySel(); } });
document.addEventListener('cut', e => { if (clipTarget(e) && sel.length) { e.preventDefault(); copySel(); deleteSel(); } });
document.addEventListener('paste', e => { if (clipTarget(e) && clipboard) { e.preventDefault(); paste(); } });
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
  const lb = m ? stepBounds(p, m) : null;
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
  const m = meshes.get(step.partId), p = doc.top(step.partId);
  return step.tool.validate?.(step.params, { model: m && p && { bounds: stepBounds(p, m) }, selection: step.face }) || null;
}
function stepChanged() {
  if (!step) return;
  viewer.preview(step.partId, null);
  step.previewed = false;
  step.ui.hooks.update?.();
  const p = stepProblem();
  const ui0 = step.ui;
  whenFree(() => ui0.statusEl.replaceChildren(...(!p ? [] : p.wait ? [h('div', { class: 'note' }, p.wait)] : [errorLine(p)])));
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
  whenFree(() => { if (my === s.seq) s.ui.prog.style.display = ''; });
  s.running = (s.running || 0) + 1;
  try {
    await sendBlobs();
    const r = await pool.call('kern', { type: 'mesh', part }, [], (f, t) => { if (step === s && my === s.seq) { s.ui.prog.firstChild.style.width = `${Math.round(f * 100)}%`; status(`${s.tool.title}: ${t}...`); } });
    if (step !== s || my !== s.seq) return;
    meshes.set('preview', { key: shapeKey(part), tris: r.tris, volume: r.volume });
    viewer.preview(s.partId, r.tris);
    s.previewed = true;
    whenFree(() => s.ui.statusEl.replaceChildren(...(r.notes || []).map(t => h('div', { class: 'note' }, t))));
    status(`${s.tool.title}: preview ready. ${(r.notes || []).join(' ')} Apply keeps it.`);
  } catch (err) {
    if (step === s) { const m = shortErr(err.message); whenFree(() => s.ui.statusEl.replaceChildren(ui.tip(errorLine(m), err.message))); status(`${s.tool.title} did not finish.`, true); }   // the reason is in the panel, once
  } finally {
    s.running--;
    if (step === s) whenFree(() => { if (my === s.seq) s.ui.prog.style.display = 'none'; });
  }
}
async function applyStep() {
  if (!step || stepProblem()) return;
  const s = step;
  // a live preview due from the last keystroke would start after this one and make it give up,
  // leaving Apply undone: drop the timer, and try again if one already running took over
  clearTimeout(s.timer);
  for (let k = 0; k < 3 && step === s && !s.previewed; k++) await previewStep();
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
  showHandles();
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
// the panel asks for these on every redraw (live during a handle drag): one pass per mesh
const lbSeen = new WeakMap();
const boundsOf = m => { let b = lbSeen.get(m.tris); if (!b) lbSeen.set(m.tris, b = localBounds(m.tris)); return b; };
/** The part's own box at its real size, as its steps see it (kernel local scales before steps). */
function stepBounds(p, m) {
  const b = boundsOf(m), k = (p.xform?.scale || [1, 1, 1]).map(Math.abs);
  return { lo: b.lo.map((v, i) => v * k[i]), hi: b.hi.map((v, i) => v * k[i]) };
}

// ---- undo -----------------------------------------------------------------------------------
// Ctrl+Z and Ctrl+Shift+Z: with parts selected, only they go back or forward; with none, the
// whole model does (the last change, whatever it touched).
// A step back takes every selected part back by one change of its own, all at once (two parts
// moved one after the other both go back a move, not the later one all the way first): each finds
// the last change that touched it and not yet stepped back, and is put as it was before it, all as
// one new step (marked rewind, so the next Ctrl+Z looks past it). Parts such a change made or
// removed (a group, its members) go with it, so nothing goes missing. A step forward puts the parts
// of the last step back as those changes left them. A new change to a part drops its steps forward.
function docUndo() { cancelStep(); const c = doc.undo(); if (c) status(`Undone: ${c.label}.`); }
function docRedo() { cancelStep(); const c = doc.redo(); if (c) status(`Redone: ${c.label}.`); }
function rewindIds(c, want) {
  // the selected parts the change touched, and any it made or removed
  return c.touched.filter(id => want.has(id) || !c.before[id] || !c.after[id]);
}
function setStates(label, states) {
  doc.commit(label, parts => {
    for (const [id, st] of states) {
      const i = parts.findIndex(p => p.id === id);
      if (st && i >= 0) parts[i] = structuredClone(st);
      else if (st) parts.push(structuredClone(st));
      else if (i >= 0) parts.splice(i, 1);
    }
  }, { kind: 'rollback', rewind: true });
}
function undo() {
  const want = new Set(sel);
  if (!want.size) { docUndo(); return; }
  cancelStep();
  const done = new Set(rewound.flatMap(r => r.steps.flatMap(s => s.ids.map(id => `${s.i}:${id}`))));
  const steps = [], states = new Map();
  for (const id of want) {
    if (states.has(id)) continue;   // already taken back with another part's change
    for (let i = doc.at - 1; i >= 0; i--) {
      const c = doc.history[i];
      if (c.rewind || !c.touched.includes(id) || done.has(`${i}:${id}`)) continue;
      const ids = rewindIds(c, new Set([id])).filter(x => !states.has(x));
      for (const x of ids) states.set(x, c.before[x]);
      steps.push({ i, ids });
      break;
    }
  }
  if (!steps.length) { status('Nothing earlier for the selected part' + (want.size > 1 ? 's.' : '.')); return; }
  const labels = [...new Set(steps.map(s => doc.history[s.i].label))];
  setStates(`Step back ${states.size > 1 ? states.size + ' parts' : doc.find([...states.keys()][0])?.part.name || 'part'}: before "${labels.join('", "')}"`, [...states]);
  rewound.push({ steps });
  setSel(sel.filter(id => doc.top(id)));
  status(`Stepped back: before "${labels.join('", "')}" (only the selected part${want.size > 1 ? 's' : ''}).`);
}
function redo() {
  const want = new Set(sel);
  if (!want.size) { docRedo(); return; }
  cancelStep();
  for (let k = rewound.length - 1; k >= 0; k--) {
    const r = rewound[k], ids = r.steps.flatMap(s => s.ids);
    if (!ids.some(id => want.has(id))) continue;
    rewound.splice(k, 1);
    const labels = [...new Set(r.steps.map(s => doc.history[s.i].label))];
    setStates(`Step forward: "${labels.join('", "')}" again`, r.steps.flatMap(s => s.ids.map(id => [id, doc.history[s.i].after[id]])));
    setSel([...new Set([...sel.filter(id => doc.top(id)), ...ids.filter(id => doc.top(id))])]);
    status(`Stepped forward: "${labels.join('", "')}" again.`);
    return;
  }
  status('Nothing later for the selected part' + (want.size > 1 ? 's.' : '.'));
}
// a new change to a part drops its steps forward; a whole-model undo or redo drops them all
// (bound with each model, in bindDoc)
function rewoundFollows(ev) {
  if (ev.type === 'cmd' && !ev.cmd.rewind) rewound = rewound.filter(r => !r.steps.some(s => s.ids.some(id => ev.cmd.touched.includes(id))));
  else if (ev.type === 'undo' || ev.type === 'redo') rewound = [];
}

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
  // there is work and nothing keeps it: a quiet line at the foot of the view says so
  autosaveNote.style.display = !project && doc.history.length ? '' : 'none';
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
  // Ctrl+Z while drawing: first what is being drawn (a piece under way is dropped whole; in the 3D
  // frame, its last step), and only then the last finished change
  if (c && k === 'z' && drawing && (drawing.pts.length || drawing.mark)) return act(() => clearPiece(true));
  if (c && k === 'z' && drawing?.tool === 'frame' && frame.hist.length) return act(() => frameBack());
  if (c && k === 'z' && drawing?.tool === 'erase' && eraseLog.length) return act(() => eraseUndo());
  if (c && k === 'z') return act(undo);
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
  // Path open: its keys are its own (they lend L, A, C, R for as long as it is open)
  if (drawing && !c) {
    if (drawing.tool === 'frame') {
      // the frame's own keys (lending D and F while it is in use)
      if (k === 'd') return act(() => setFrameMode('draw'));
      if (k === 'f') return act(() => setFrameMode('faces'));
      if (k === 'b') return act(() => buildFrame());
      if (k === 'g') return act(() => setFramePlate(!frame.plate));
      if (k === ' ') return act(() => toggleFrameLock());
      if (k === 'n' || k === 'enter') return act(() => frameEnter());
      if (k === 'u' || k === 'backspace') return act(() => frameBack());
      if (k === 'escape' && (frame.cur != null || frame.faceCur.length)) return act(() => { frame.cur = null; frame.faceCur = []; showFrame(null); });
    }
    if (k === 'e' && (drawing.tool === 'frame' || drawing.tool === 'pointer') && frameToEdit()) return act(() => editFrame(frameToEdit()));
    const tool = { v: 'pointer', l: 'line', a: 'arc', c: 'circle', r: 'rect', k: 'erase', ...(path3dOn ? { 3: 'frame' } : {}) }[k];
    if (tool) return act(() => setPathTool(tool));
    if (k === 'p') return act(() => { stopPath(); status('Path closed.'); });
    if (drawing.tool === 'erase') {
      if (k === 'u' || k === 'backspace') return act(() => eraseUndo());
      if (k === 'escape') return act(() => { stopPath(); status('Path closed.'); });
    }
    // Pointer and Delete: Path keeps only its tool keys; every other key does what it does without Path
  }
  if (drawing && !c && drawing.tool !== 'pointer' && drawing.tool !== 'erase') {
    // letters first: Enter, Backspace and Esc mean things to the browser too (they still work)
    if (k === 'f' || k === 'enter') return act(() => finishPiece(false));
    if (k === 'u' || k === 'backspace') return act(() => pointBack());
    if (k === 'x') return act(() => clearPiece(true));
    if (k === 'escape') return act(() => { if (drawing.pts.length || drawing.mark) clearPiece(true); else { stopPath(); status('Path closed.'); } });
  }
  if (placing && k === 'enter') return act(() => commitPlace(true));
  if (placing && k === 'escape') return act(cancelPlace);
  if ((wrap || wrapPick) && k === 'escape') return act(() => { cancelWrap(); status('Wrap cancelled.'); });
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
  if (k === 'escape' && fsnap && !openMenu) return act(() => { endFaceSnap(); status('Snap faces ended.'); });
  if (k === 'escape' && measureOn && !openMenu) return act(() => { if (mPts.length) { mPts = []; viewer.setMeasure([]); measureText(); } else setMeasure(false); });
  if (k === 't') return act(() => setMeasure(!measureOn));
  if (k === 'p') return act(() => startPath());
  // L with several parts selected: the Align buttons light up, to show they are ready (again: off)
  if (k === 'l' && !s && sel.length > 1) return act(() => { alignLit = !alignLit; renderInspector(); status(alignLit ? 'Align: pick a side or the middle in the panel. L again or Esc: off.' : 'Align off.'); });
  if (k === 'escape' && alignLit) return act(() => { alignLit = false; renderInspector(); });
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
