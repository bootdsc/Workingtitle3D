// Stereo view, for phone goggles and headsets: the whole app twice, side by side, each half with its
// eye's camera. One app: the left half is the real one; the right half is a clone of the page kept in
// step (rebuilt at most once a frame, on any change), its view filled with the right eye's picture,
// and pointer input on it passed to whatever sits at the same place in the left half.
//
// Size: each half is a whole fraction (1, 3/4, 2/3, 1/2) of half the screen in device pixels, the
// renderer drawing at exactly its view's device size (no scaling, no blur). Eye separation (mm) sets
// both the cameras' separation (true scale: the model is in mm) and the distance between the halves'
// middles on the screen (at 96 CSS px an inch), so they sit behind the lenses; halves that would
// overlap stay against each other with a one device pixel black line between. The rest is black.
export const STEREO_SCALES = [['1', 1, 1], ['3/4', 3, 4], ['2/3', 2, 3], ['1/2', 1, 2]];

// the drawn pointer's shapes, 24 px, white with a black edge (as the system's): [svg body, hot x, hot y]
const edge = (d, w = 1.3) => `<path d="${d}" fill="#fff" stroke="#000" stroke-width="${w}" stroke-linejoin="round"/>`;
const bar = d => `<path d="${d}" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round"/><path d="${d}" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>`;
const HAND = 'M8 3a1.5 1.5 0 0 1 3 0v7h.5V8a1.5 1.5 0 0 1 3 0v2h.5V9a1.5 1.5 0 0 1 3 0v6c0 4-2.5 7-6 7h-1.5c-2.5 0-3.8-1.5-5.5-4.5L3.3 14a1.5 1.5 0 0 1 2.6-1.5L8 15z';
const PTR = {
  default: [edge('M2 1.5v17l4.3-4 3 6.8 2.8-1.2-3-6.6h6z'), 2, 1.5],
  pointer: [edge(HAND), 9.5, 2],
  grab: [edge(HAND), 12, 12],
  grabbing: [edge(HAND), 12, 12],
  text: [bar('M8 3h4M10 3v18M8 21h4'), 10, 12],
  crosshair: [bar('M12 3v18M3 12h18'), 12, 12],
  move: [bar('M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3'), 12, 12],
  'ew-resize': [bar('M3 12h18M6 9l-3 3 3 3M18 9l3 3-3 3'), 12, 12],
  'ns-resize': [bar('M12 3v18M9 6l3-3 3 3M9 18l3 3 3-3'), 12, 12],
};
const ALIAS = { 'col-resize': 'ew-resize', 'row-resize': 'ns-resize', 'all-scroll': 'move', cell: 'crosshair' };
const ptrUrl = {};
for (const [k, [svg]] of Object.entries(PTR)) ptrUrl[k] = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${svg}</svg>`)}")`;

export class Stereo {
  constructor(app, viewer) {
    this.app = app; this.viewer = viewer;
    this.on = false;
    this.set = { scale: '1', eyeSep: 63 };
    this.mirror = document.createElement('div');
    this.mirror.className = 'stereo-mirror';
    this.blinds = document.createElement('div');
    this.blinds.className = 'stereo-blinds';
    this.right = document.createElement('canvas');   // the right eye's last picture, kept for rebuilds
    this.dirty = false; this.held = null;
    this.mo = new MutationObserver(list => { if (list.some(m => !this.mirror.contains(m.target) && m.target !== this.mirror && m.target !== this.blinds && !this.ptrs.includes(m.target))) this.soon(); });
    this.onResize = () => { if (this.on) this.layout(); };
    this.onChange = e => { if (!this.mirror.contains(e.target)) this.soon(); };
    const fwd = e => this.forward(e);
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel']) this.mirror.addEventListener(t, fwd, { passive: false });
    // the pointer, drawn in both halves: the real one shows in one eye only. The real one is hidden
    // (a sheet in the head, so the clone never carries it); each drawn one takes the shape the page
    // asks for where the pointer is. Over the 3D view the right one moves as the model does, so it
    // sits on the surface under it (the plate where there is no part); over panels both match.
    this.ptrs = [0, 1].map(() => { const d = document.createElement('div'); d.className = 'stereo-ptr'; return d; });
    this.hide = document.createElement('style');
    this.hide.textContent = 'body.stereo, body.stereo * { cursor: none !important; }';
    this.ptr = null;   // { x, y } in the left (real) half, or null when outside both
    this.shapeOf = { el: null, shape: 'default' };
    this.onPtr = e => { this.track(e); };
    this.onLeave = () => { this.ptr = null; this.drawPtrs(); };
  }

  enable(on, set) {
    if (set) this.set = { ...this.set, ...set };
    if (on === this.on) { if (on) this.layout(); return; }
    this.on = on;
    const v = this.viewer;
    if (on) {
      document.body.classList.add('stereo');
      document.body.append(this.blinds, this.mirror, ...this.ptrs);
      document.head.append(this.hide);
      this.mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      addEventListener('resize', this.onResize);
      document.addEventListener('pointermove', this.onPtr, true);
      document.addEventListener('pointerdown', this.onPtr, true);
      document.documentElement.addEventListener('pointerleave', this.onLeave);
      document.addEventListener('input', this.onChange, true);
      document.addEventListener('scroll', this.onChange, true);
      v.stereo = { eyeSep: this.set.eyeSep, copy: c => this.copy(c) };
      this.layout();
    } else {
      this.mo.disconnect();
      removeEventListener('resize', this.onResize);
      document.removeEventListener('input', this.onChange, true);
      document.removeEventListener('scroll', this.onChange, true);
      document.removeEventListener('pointermove', this.onPtr, true);
      document.removeEventListener('pointerdown', this.onPtr, true);
      document.documentElement.removeEventListener('pointerleave', this.onLeave);
      document.body.classList.remove('stereo');
      this.mirror.remove(); this.blinds.remove(); this.mirror.replaceChildren();
      for (const p of this.ptrs) p.remove();
      this.hide.remove(); this.ptr = null;
      for (const k of ['left', 'top', 'width', 'height', 'transform']) this.app.style[k] = '';
      v.stereo = null;
    }
    v.resize();
  }

  /** Where the halves go. Sizes: the browser lays out in 1/64 CSS px, so a half is a whole number of
   *  steps that are whole both in layout units and in device pixels (8 CSS px at 2.625, 1 at 1);
   *  otherwise its picture would be resampled by a hair. Places: by transform, which is not rounded to
   *  layout units, at whole device pixels, so the line is one device pixel and the spacing fine. */
  layout() {
    const dpr = devicePixelRatio || 1, vw = innerWidth, vh = innerHeight;
    let unit = 1;
    for (let n = 1; n <= 4096; n++) { const d = (n * dpr) / 64; if (Math.abs(d - Math.round(d)) < 1e-6) { unit = n / 64; break; } }
    const snap = x => Math.floor(x / unit + 1e-9) * unit, dev = x => Math.round(x * dpr) / dpr;
    const [, a, b] = STEREO_SCALES.find(s => s[0] === this.set.scale) || STEREO_SCALES[0];
    const W = snap((((vw - 1 / dpr) / 2) * a) / b), H = snap((vh * a) / b);   // two halves and a one pixel line
    // the halves' middles the eye separation apart (96 CSS px an inch), never closer than touching
    const sep = W + 1 / dpr;   // the halves side by side, a one pixel line between
    const L = Math.max(0, dev(vw / 2 - sep / 2 - W / 2)), T = dev((vh - H) / 2), dx = dev(sep);
    Object.assign(this.app.style, { left: '0px', top: '0px', transform: `translate(${L}px, ${T}px)`, width: W + 'px', height: H + 'px' });
    const root = document.documentElement.style;
    root.setProperty('--st-l', L + 'px'); root.setProperty('--st-t', T + 'px'); root.setProperty('--st-w', W + 'px'); root.setProperty('--st-h', H + 'px');
    this.dx = dx; this.box = { L, T, W, H };
    this.mirror.style.transform = `translateX(${dx}px)`;
    this.mirror.style.clipPath = `inset(${T}px ${vw - L - W}px ${vh - T - H}px ${L}px)`;
    // black everywhere but the left half (the right half is the mirror, above this)
    this.blinds.style.clipPath = `polygon(evenodd, 0 0, ${vw}px 0, ${vw}px ${vh}px, 0 ${vh}px, 0 0, ${L}px ${T}px, ${L}px ${T + H}px, ${L + W}px ${T + H}px, ${L + W}px ${T}px, ${L}px ${T}px)`;
    if (this.viewer.stereo) this.viewer.stereo.eyeSep = this.set.eyeSep;
    this.viewer.resize();
    this.soon();
  }

  soon() {
    if (this.dirty || !this.on) return;
    this.dirty = true;
    requestAnimationFrame(() => { this.dirty = false; if (this.on) this.rebuild(); });
  }

  /** The right half: a fresh clone of the page, its fields, ticks, scroll and pictures as they are. */
  rebuild() {
    const real = [...document.body.children].filter(el => el !== this.mirror && el !== this.blinds && !this.ptrs.includes(el) && el.tagName !== 'SCRIPT');
    const clones = real.map(el => el.cloneNode(true));
    const glc = this.viewer.renderer.domElement;
    this.eye = null;
    real.forEach((r, i) => {
      const c = clones[i];
      const rf = r.querySelectorAll('input, textarea, select'), cf = c.querySelectorAll('input, textarea, select');
      rf.forEach((x, k) => { const y = cf[k]; if (!y) return; if ('checked' in x) y.checked = x.checked; if ('value' in x && x.type !== 'file') y.value = x.value; });
      const rc = r.querySelectorAll('canvas'), cc = c.querySelectorAll('canvas');
      rc.forEach((x, k) => {
        const y = cc[k];
        if (!y) return;
        y.width = x.width; y.height = x.height;
        if (x === glc) { this.eye = y; if (this.right.width) y.getContext('2d').drawImage(this.right, 0, 0); }
        else { try { y.getContext('2d').drawImage(x, 0, 0); } catch { /* an empty canvas */ } }
      });
      const scr = [r, ...r.querySelectorAll('*')], scc = [c, ...c.querySelectorAll('*')];
      const pairs = [];
      scr.forEach((x, k) => { if (x.scrollTop || x.scrollLeft) pairs.push([scc[k], x.scrollTop, x.scrollLeft]); });
      // (the clones keep their ids: the layout is written against #app and #view; the real page comes
      // first in the document, so a look-up by id still finds the real one)
      c.dataset.mirror = '1';
      requestAnimationFrame(() => { for (const [y, t, l] of pairs) { y.scrollTop = t; y.scrollLeft = l; } });
    });
    this.mirror.replaceChildren(...clones);
  }

  /** The right eye's picture, from the view's canvas just after it is drawn. */
  copy(gl) {
    if (this.right.width !== gl.width || this.right.height !== gl.height) { this.right.width = gl.width; this.right.height = gl.height; }
    this.right.getContext('2d').drawImage(gl, 0, 0);
    if (this.eye) {
      if (this.eye.width !== gl.width || this.eye.height !== gl.height) { this.eye.width = gl.width; this.eye.height = gl.height; }
      this.eye.getContext('2d').drawImage(this.right, 0, 0);
    }
    // the view moved: the pointer's depth may have too (after the frame, with the view's camera back)
    if (this.ptr) queueMicrotask(() => this.drawPtrs());
  }

  /** Where the pointer is, in the left (real) half; over the right half it stands for the same place. */
  track(e) {
    if (!e.isTrusted || !this.box) return;
    const { L, T, W, H } = this.box;
    let x = e.clientX;
    const y = e.clientY;
    if (x >= L + this.dx && x < L + this.dx + W) x -= this.dx;
    this.ptr = x >= L && x < L + W && y >= T && y < T + H ? { x, y } : null;
    this.drawPtrs();
  }

  /** The two drawn pointers: the same shape, the right one moved by the view's depth there. */
  drawPtrs() {
    const p = this.ptr, dlg = document.querySelector('dialog[open]');
    // a dialog sits above anything drawn: over one, the real pointer shows and the drawn ones go;
    // outside both halves (the black) too, so the pointer is never lost
    this.hide.disabled = !!dlg || !p;
    if (!p || dlg || !this.on) { for (const d of this.ptrs) d.style.display = 'none'; return; }
    this.mirror.style.pointerEvents = 'none';
    const el = document.elementFromPoint(p.x, p.y);
    this.mirror.style.pointerEvents = '';
    const shape = this.shapeAt(el);
    const [, hx, hy] = PTR[shape];
    const shift = el && el === this.viewer.renderer.domElement ? this.depthShift(p) : 0;
    [[p.x, 0], [p.x + this.dx + shift, 1]].forEach(([x, k]) => {
      const d = this.ptrs[k];
      d.style.backgroundImage = ptrUrl[shape];
      d.style.transform = `translate(${x - hx}px, ${p.y - hy}px)`;
      d.style.display = '';
    });
  }

  /** The pointer shape the page asks for on el (read with the hiding sheet off for a moment). */
  shapeAt(el) {
    if (!el) return 'default';
    // the view sets its pointer on the canvas itself, and changes it often: read it there
    let c;
    if (el === this.viewer.renderer.domElement) c = el.style.cursor || 'default';
    else if (this.shapeOf.el === el) return this.shapeOf.shape;
    else { this.hide.disabled = true; c = getComputedStyle(el).cursor; this.hide.disabled = false; }
    c = ALIAS[c] || c;
    if (c === 'auto') c = el.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]), textarea, [contenteditable=true]') ? 'text' : 'default';
    const shape = PTR[c] ? c : 'default';
    if (el !== this.viewer.renderer.domElement) this.shapeOf = { el, shape };
    return shape;
  }

  /** How far right the right eye's pointer moves so it sits on the surface under it: a part, else
   *  the plate, else the turning point. In CSS px, from where the point falls in each eye's picture. */
  depthShift(p) {
    const v = this.viewer, R = v.eyeR, main = v.controls.object;
    if (!R) return 0;
    const r = v.renderer.domElement.getBoundingClientRect();
    const at = v.placeHit({ clientX: p.x, clientY: p.y })?.point || v.controls.target;
    const a = at.clone().project(main), b = at.clone().project(R);
    return ((b.x - a.x) / 2) * r.width;
  }

  /** Input on the right half goes to the same place in the left (the real) half. */
  forward(e) {
    if (!e.isTrusted) return;
    e.preventDefault(); e.stopPropagation();
    const x = e.clientX - this.dx, y = e.clientY;
    let t = (e.type.endsWith('move') || e.type.endsWith('up') || e.type === 'pointercancel') && this.held ? this.held : null;
    if (!t) { this.mirror.style.pointerEvents = 'none'; t = document.elementFromPoint(x, y); this.mirror.style.pointerEvents = ''; }
    if (!t) return;
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: e.screenX - this.dx, screenY: e.screenY,
      button: e.button, buttons: e.buttons, detail: e.detail, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, view: window };
    let ev;
    if (e.type.startsWith('pointer')) ev = new PointerEvent(e.type, { ...init, pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary, width: e.width, height: e.height, pressure: e.pressure });
    else if (e.type === 'wheel') ev = new WheelEvent('wheel', { ...init, deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode });
    else ev = new MouseEvent(e.type, init);
    if (e.type === 'pointerdown') {
      this.held = t;
      // the mirror keeps the pointer, so a capture the real side asks for cannot pull the real pointer over
      try { this.mirror.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      if (t.matches?.('input, textarea, select, button, [tabindex]')) t.focus({ preventScroll: true });
    }
    t.dispatchEvent(ev);
    if (e.type === 'pointerdown') { try { t.releasePointerCapture?.(e.pointerId); } catch { /* none taken */ } try { this.mirror.setPointerCapture(e.pointerId); } catch { /* not capturable */ } }
    if (e.type === 'pointerup' || e.type === 'pointercancel') this.held = null;
  }
}
