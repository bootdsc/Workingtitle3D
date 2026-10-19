// The 3D view: a scene of parts. Z is up (printer convention). Renders only when
// something changed; frames run only while the camera settles.
//
// Mouse: right drag orbits, middle drag pans, wheel zooms, Ctrl + left drag orbits,
// Shift + right drag pans. Left click picks, left drag on a part moves it on the plate,
// left drag on empty space draws a selection box.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshBVH } from 'three-mesh-bvh';
import { faultEdges } from './meshcheck.js';

const C = { bg: 0x0a0a0a, body: 0x9c9c9c, bodySel: 0xc8c8c8, inside: 0x2d5a2d, edge: 0x000000, edgeSel: 0x7dcf7d,
  hole: 0x8a8a8a, grid: 0x333333, gridMajor: 0x555555, plate: 0x111411, pick: 0x7dcf7d, box: 0x7dcf7d };

export class Viewer {
  constructor(el) {
    this.el = el;
    // alpha: a background picture can sit behind the view; the clear stays opaque until one does
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.bgColor = C.bg;
    this.renderer.setClearColor(C.bg, 1);
    this.renderer.localClippingEnabled = true;
    el.appendChild(this.renderer.domElement);
    const dom = this.renderer.domElement;
    dom.tabIndex = 0;
    // A driver reset (often on resume from sleep) loses the GL context. three.js keeps it
    // restorable and rebuilds its GPU state on restore; nothing redraws unless asked.
    this.lost = false;
    dom.addEventListener('webglcontextlost', () => { this.lost = true; this.onContext?.(false); });
    dom.addEventListener('webglcontextrestored', () => { this.lost = false; this.onContext?.(true); this.request(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.request(); });
    window.addEventListener('pageshow', () => this.request());

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 20000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(160, -220, 170);
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = true;
    // the wheel is ours: towards the point under the pointer, a share of the way per notch but
    // never under a few mm, so close up keeps a steady pace instead of crawling towards it for ever; at a
    // surface it carries on through, so the inside of a part can be seen
    this.controls.enableZoom = false;
    // zoomSpeed 1 to 10 (View > Accessibility), 5 the usual: per notch it zooms 3% x speed of
    // the way, never under 0.6 mm x speed
    this.zoomSpeed = 5;
    dom.addEventListener('wheel', e => {
      e.preventDefault();
      // one notch is 100 in pixels; some browsers count lines (3 a notch) or pages, so the same
      // wheel zoomed a different amount in each: all of them to pixels first
      const px = e.deltaY * (e.deltaMode === 1 ? 100 / 3 : e.deltaMode === 2 ? 800 : 1);
      const notches = Math.max(-5, Math.min(5, px / 100));
      if (!notches) return;
      const ray = this.ray(e).ray, h = this.hit(e);
      let p = h ? h.point.clone() : null;
      if (!p) { p = new THREE.Vector3(); if (!ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), p) || p.distanceTo(this.camera.position) > 1e5) p = ray.at(this.camera.position.distanceTo(this.controls.target), new THREE.Vector3()); }
      const d = this.camera.position.distanceTo(p);
      const zs = Math.min(10, Math.max(1, this.zoomSpeed || 5));
      const step = Math.max(d * 0.03 * zs, 0.6 * zs) * Math.abs(notches);   // speed 5: 15% / 3 mm, as before
      // floor (set while drawing a path): zooming in stops 1 mm above the build plate, never through it
      const FLOOR = 1, cz = this.camera.position.z;
      if (this.floor && notches < 0 && cz > FLOOR && p.z < cz) {
        const most = d * (cz - FLOOR) / (cz - p.z) - 1e-6;   // how far along the way to p before the floor
        if (most <= 0) return;
        const t = Math.min(step, most, d - 0.5) / d;
        if (t <= 0) return;
        this.camera.position.lerp(p, t);
        this.controls.target.lerp(p, t);
        this.controls.update();
        this.request();
        return;
      }
      if (notches < 0 && step > d - 0.5) {
        // at the surface: go on through it, along the pointer's ray, camera and orbit point
        // together; inside a part it turns see-through (updateInside)
        const v = ray.direction.clone().multiplyScalar(step);
        this.camera.position.add(v);
        this.controls.target.add(v);
        this.controls.update();
        this.request();
        return;
      }
      // camera and orbit point both scale towards (or away from) the point: the view direction
      // never changes, so nothing turns
      const k = notches < 0 ? 1 - step / d : 1 + step / d;
      this.camera.position.sub(p).multiplyScalar(k).add(p);
      this.controls.target.sub(p).multiplyScalar(k).add(p);
      this.controls.update();
      this.request();
    }, { passive: false });
    this.controls.dampingFactor = 0.18;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.addEventListener('change', () => this.request());

    // sky light from straight above (this view is Z up; the light's default up is Y, which lit
    // faces by which way they pointed across the plate, so a curve read from some sides only).
    // A slope is darker than a top from every side, so fillets and coves show their shape.
    const sky = new THREE.HemisphereLight(0xffffff, 0x202020, 1.1);
    sky.position.set(0, 0, 1);
    this.scene.add(sky);
    // the key light: mostly from above, leaning towards the viewer and to their left, turning with
    // the view (aimLight). Riding on the camera instead lit any slope facing the viewer as bright
    // as a top, and a fillet seen from that side vanished into the face above it.
    this.key = new THREE.DirectionalLight(0xffffff, 2);
    this.scene.add(this.key, this.key.target);
    this.scene.add(this.camera);

    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
    this.clipOn = false;
    this.mats = {
      body: new THREE.MeshLambertMaterial({ color: C.body, flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      bodySel: new THREE.MeshLambertMaterial({ color: C.bodySel, flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      inside: new THREE.MeshBasicMaterial({ color: C.inside, side: THREE.BackSide, transparent: true, opacity: 0.18, depthWrite: false }),
      hole: new THREE.MeshLambertMaterial({ color: C.hole, flatShading: true, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }),
      edge: new THREE.LineBasicMaterial({ color: C.edge, transparent: true, opacity: 0.5 }),
      edgeSel: new THREE.LineBasicMaterial({ color: C.edgeSel }),
      holeEdge: new THREE.LineDashedMaterial({ color: 0xb0b0b0, dashSize: 2, gapSize: 1.5 }),
      pick: new THREE.MeshBasicMaterial({ color: C.pick, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
    };

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.objs = new Map();     // part id -> {group, mesh, edges, key, tris, part}
    this.selected = new Set();
    this.setPlate({ w: 600, d: 600, every: 1 });

    // events the app listens to
    this.onPick = null;        // (id|null, faceIndex, event)
    this.onBox = null;         // (ids[], event) after a selection box
    this.onDragStart = null;   // (id, event) -> bool (start a move)
    this.onDrag = null;        // (dx, dy, event) plate millimetres since the start
    this.onDragEnd = null;
    this.onHandle = null;      // (phase 'start'|'move'|'end', info, event) -> start returns bool
    this.initHandles();
    this.initOutline();

    this.boxEl = document.createElement('div');
    this.boxEl.className = 'selbox';
    el.appendChild(this.boxEl);
    this.pointer(dom);
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
  }

  // ---- input -------------------------------------------------------------------------------
  pointer(dom) {
    let down = null;
    const plateAt = (e, z) => {
      const ray = this.ray(e);
      const p = new THREE.Vector3();
      return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), p) ? p : null;
    };
    dom.addEventListener('contextmenu', e => e.preventDefault());
    // a turn about to start (right button, or Ctrl + left): turn about what is in the middle of the
    // screen (after panning and zooming the turning point drifted off into space)
    dom.addEventListener('pointerdown', e => { if (e.button === 2 || (e.button === 0 && e.ctrlKey)) this.recentrePivot(); }, { capture: true });
    dom.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      if (this.ghost) { e.stopPropagation(); this.onPlace?.('click', this.placeHit(e)); return; }
      // a drawing tool (the path) takes left clicks; the view still turns and pans
      // a tool that can grab (a frame point under the pointer) takes the press and its drag; a
      // drawing tool takes clicks; otherwise the press goes on as usual (Pointer)
      if (this.drawTool && !e.ctrlKey && this.drawTool.grab?.(e)) {
        e.stopPropagation();
        this.toolDrag = true;
        try { dom.setPointerCapture(e.pointerId); } catch { /* the pointer is already up */ }
        return;
      }
      if (this.drawTool?.click && !e.ctrlKey) { e.stopPropagation(); this.drawTool.click(e); return; }
      if (this.pickingFace) { e.stopPropagation(); this.pickingFace = false; this.onPickFace?.(this.placeHit(e)); return; }
      if (e.ctrlKey) {   // Ctrl + left: orbit
        this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
        return;
      }
      this.controls.mouseButtons.LEFT = null;
      const hh = this.hitHandle(e);
      if (hh) {
        const g = this.grab(hh, e);
        if (g && this.onHandle?.('start', g.info, e) !== false) { down = { handle: g }; try { dom.setPointerCapture(e.pointerId); } catch { /* the pointer is already up */ } }
        return;
      }
      const hit = this.hit(e);
      down = { x: e.clientX, y: e.clientY, hit, moving: false, boxing: false };
      if (hit) down.plane = plateAt(e, hit.point.z);
      try { dom.setPointerCapture(e.pointerId); } catch { /* the pointer is already up */ }
    });
    this.plateAt = plateAt;
    dom.addEventListener('pointerleave', () => { if (this.pointerAt) this.pointerAt.inView = false; });
    dom.addEventListener('pointermove', e => {
      this.pointerAt = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, inView: true };
      if (this.ghost) { this.onPlace?.('move', this.placeHit(e)); return; }
      if (this.toolDrag) { this.drawTool?.drag?.(e); return; }
      if (!down) this.drawTool?.hover?.(e);   // e.g. a grab cursor over a frame point
      if (this.drawTool?.move && !down) { this.drawTool.move(e); return; }
      if (!down) { this.hover(e); return; }
      if (down.handle) { this.onHandle?.('move', this.follow(down.handle, e), e); return; }
      const dist = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (!down.moving && !down.boxing && dist > 4) {
        if (down.hit && this.onDragStart?.(down.hit.id, e)) down.moving = true;
        else if (!down.hit) down.boxing = true;
      }
      if (down.moving && down.plane) {
        const p = plateAt(e, down.plane.z);
        if (p) this.onDrag?.(p.x - down.plane.x, p.y - down.plane.y, e);
      }
      if (down.boxing) {
        const r = dom.getBoundingClientRect();
        const x0 = Math.min(down.x, e.clientX) - r.left, y0 = Math.min(down.y, e.clientY) - r.top;
        Object.assign(this.boxEl.style, { display: 'block', left: x0 + 'px', top: y0 + 'px',
          width: Math.abs(e.clientX - down.x) + 'px', height: Math.abs(e.clientY - down.y) + 'px' });
      }
    });
    // the release can be missed (the page busy when it came, or it landed outside the view): a
    // move with the left button already up, or the pointer leaving the window, ends it just the same,
    // so a part never stays stuck to the mouse
    const lost = e => { if (down && !(e.buttons & 1)) finish(e); };
    dom.addEventListener('pointermove', lost, { capture: true });
    // the end of a tool's grab, wherever the pointer is let go
    window.addEventListener('pointerup', e => { if (e.button === 0 && this.toolDrag) { this.toolDrag = false; this.drawTool?.drop?.(e); } }, true);
    window.addEventListener('pointerup', e => { if (e.button === 0 && down && e.target !== dom) finish(e); });
    window.addEventListener('blur', () => { if (down) finish({ clientX: down.x || 0, clientY: down.y || 0, button: 0, shiftKey: false }); });
    dom.addEventListener('pointerup', e => {
      if (e.button !== 0 || !down) return;
      finish(e);
    });
    const finish = e => {
      const d = down;
      down = null;
      if (d.handle) { this.onHandle?.('end', this.follow(d.handle, e), e); return; }
      if (d.moving) { this.onDragEnd?.(e); return; }
      if (d.boxing) {
        this.boxEl.style.display = 'none';
        this.onBox?.(this.inBox(d.x, d.y, e.clientX, e.clientY), e);
        return;
      }
      this.onPick?.(d.hit ? d.hit.id : null, d.hit ? d.hit.face : -1, e);
    };
  }

  /** Put the turning point on what the middle of the screen shows: the nearest part, else the
   *  plate (z = 0). It lies on the line of sight, so the picture does not move; only the point
   *  turns are made about. Nothing in the middle and the plate behind the camera: unchanged. */
  recentrePivot() {
    const r = this.renderer.domElement.getBoundingClientRect();
    const mid = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const hit = this.hit(mid);
    let p = hit?.point || null;
    if (!p) {
      const ray = this.ray(mid).ray, q = new THREE.Vector3();
      if (ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), q) && q.distanceTo(this.camera.position) < this.camera.far) p = q;
    }
    if (!p || p.distanceTo(this.camera.position) < 1e-3) return;
    this.controls.target.copy(p);
    this.controls.update();
  }

  ray(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    return ray;
  }

  /** Nearest part under the pointer: {id, face (local triangle), point}. */
  hit(e) {
    const ray = this.ray(e);
    const vis = [...this.objs.values()].filter(o => o.group.visible);
    // the cut away side of a part being cut cannot be picked; parts not being cut are whole
    const keep = (id, p) => !(this.cutHere(id) && this.clipPlane.distanceToPoint(p) < 0);
    const h = ray.intersectObjects(vis.filter(o => !o.pickBvh).map(o => o.mesh), false).find(x => keep(x.object.userData.id, x.point));
    let best = h ? { id: h.object.userData.id, face: h.faceIndex, point: h.point, d: h.distance } : null;
    // big parts: their search tree (built in the worker), so a press on them answers at once
    for (const o of vis) {
      if (!o.pickBvh) continue;
      o.mesh.updateMatrixWorld();
      const lr = ray.ray.clone().applyMatrix4(o.mesh.matrixWorld.clone().invert());
      for (const x of o.pickBvh.raycast(lr, THREE.DoubleSide)) {
        const p = x.point.clone().applyMatrix4(o.mesh.matrixWorld), d = p.distanceTo(ray.ray.origin);
        if ((best && d >= best.d) || !keep(o.part.id, p)) continue;
        best = { id: o.part.id, face: (o.pickIndex[x.faceIndex * 3] / 3) | 0, point: p, d };   // the tree's triangle back to the part's own
      }
    }
    return best ? { id: best.id, face: best.face, point: best.point } : null;
  }

  /** Parts the selection box touches: any of the part's points (sampled), any of its
   *  triangle middles, or the box's own centre lying on it. */
  inBox(x0, y0, x1, y1) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const lo = [Math.min(x0, x1) - r.left, Math.min(y0, y1) - r.top], hi = [Math.max(x0, x1) - r.left, Math.max(y0, y1) - r.top];
    const out = [];
    const v = new THREE.Vector3();
    const inside = () => {
      if (v.z > 1) return false;   // behind the camera
      const sx = ((v.x + 1) / 2) * r.width, sy = ((1 - v.y) / 2) * r.height;
      return sx >= lo[0] && sx <= hi[0] && sy >= lo[1] && sy <= hi[1];
    };
    for (const [id, o] of this.objs) {
      if (!o.group.visible) continue;
      o.group.updateMatrixWorld();
      const m = o.group.matrixWorld, t = o.tris;
      const n = t.length / 9;
      const stride = Math.max(1, Math.floor(n / 4000));
      let hit = false;
      for (let f = 0; f < n && !hit; f += stride) {
        const i = f * 9;
        for (let k = 0; k < 9 && !hit; k += 3) { v.set(t[i + k], t[i + k + 1], t[i + k + 2]).applyMatrix4(m).project(this.camera); hit = inside(); }
        if (!hit) { v.set((t[i] + t[i + 3] + t[i + 6]) / 3, (t[i + 1] + t[i + 4] + t[i + 7]) / 3, (t[i + 2] + t[i + 5] + t[i + 8]) / 3).applyMatrix4(m).project(this.camera); hit = inside(); }
      }
      if (hit) out.push(id);
    }
    // a box drawn wholly inside one big part touches no point of it: take what is under its centre
    if (!out.length) {
      const e = { clientX: (x0 + x1) / 2, clientY: (y0 + y1) / 2 };
      const h = this.hit(e);
      if (h) out.push(h.id);
    }
    return out;
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    if (this.stereo) {
      // stereo: the backing store exactly the view's size in device pixels, shown at that size
      const dpr = window.devicePixelRatio || 1, r = this.el.getBoundingClientRect();
      const dw = Math.round(r.width * dpr), dh = Math.round(r.height * dpr);
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(dw, dh, false);
      Object.assign(this.renderer.domElement.style, { width: dw / dpr + 'px', height: dh / dpr + 'px' });
      this.camera.aspect = dw / dh;
      this.camera.updateProjectionMatrix();
      this.request();
      return;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    Object.assign(this.renderer.domElement.style, { width: '', height: '' });
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.request();
  }

  request() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      if (this.lost) return;
      this.controls.update();
      if (this.clipOn) this.updateClip();
      this.updateHandles();
      // from under the plate only the 10 mm lines show; the fine patch only when 1 mm spans 40 px or more
      const below = this.camera.position.z < 0;
      // 1 mm lines only when 1 mm spans about 2.7 px or more: further out they shimmer, and the 10 mm grid is enough
      // and faded in from there to full at 8 px, so lines too close to land evenly on pixels never band
      if (this.minorLines) {
        const px = 1 / this.pxAt(this.controls.target);
        this.minorLines.visible = !below && px >= 8 / 3;
        this.minorLines.material.opacity = Math.min(1, Math.max(0.15, (px - 8 / 3) / (8 - 8 / 3)));
      }
      if (this.fine) this.fine.visible = !below && this.pxAt(this.controls.target) <= 1 / 40;
      // panning moves at the orbit point's depth; close up that would crawl, so never slower than at 20 mm
      this.controls.panSpeed = Math.max(1, 20 / Math.max(0.01, this.camera.position.distanceTo(this.controls.target)));
      this.updateGuides();
      this.updateDepthRange();
      this.updateInside();
      this.aimLight();
      this.drawFrame();
    });
  }
  /** One frame: the view and the selection outline; in stereo, the right eye first (copied out to the
   *  right half straight after it is drawn), then the left eye, which stays in this canvas.
   *  Goggles: each half sits under its own lens, the halves already the eyes' width apart, so the
   *  eyes look straight ahead, side by side, each picture centred on its own half. The left eye is
   *  the view's own camera (clicks on the left half land exactly); the right eye is the same camera
   *  moved to its right, same lens, no frustum shift (a shift toward a meeting point is for one shared
   *  screen, and under lenses it pitched both pictures in like a mirror). The move puts the turning
   *  point 2 % of the half's width apart in the two pictures (nearer things more, farther less), from
   *  the distance to it and the view's width and lens, so it holds at any zoom and window size. Not
   *  the eyes' 63 mm: the view is often a few cm from a part, and 63 mm there saw it from 30 degrees
   *  either side, too far apart to fuse. */
  drawFrame() {
    if (!this.stereo) { this.renderer.render(this.scene, this.camera); this.drawOutline(); return; }
    const main = this.camera, R = (this.eyeR ||= new THREE.PerspectiveCamera());
    R.copy(main, false);   // (place and lens only, never children)
    const tanH = (Math.tan(THREE.MathUtils.degToRad(main.fov / 2)) * main.aspect) / (main.zoom || 1);   // half the view's width at 1 mm off
    R.translateX(0.02 * 2 * main.position.distanceTo(this.controls.target) * tanH);
    R.updateMatrixWorld();
    R.projectionMatrix.copy(main.projectionMatrix); R.projectionMatrixInverse.copy(main.projectionMatrixInverse);
    try {
      for (const [eye, out] of [[R, true], [main, false]]) {
        this.camera = eye;
        this.renderer.render(this.scene, eye);
        this.drawOutline();
        if (out) this.stereo.copy(this.renderer.domElement);
      }
    } finally { this.camera = main; }
  }

  /** Near and far follow the camera, so zooming out never cuts the model off at the back and
   *  coming close never cuts a surface open in front. Set before each frame. */
  updateDepthRange() {
    const cam = this.camera, d = cam.position.distanceTo(this.controls.target);
    if (!this.sceneBox || this.sceneBoxDirty) {
      const b = new THREE.Box3();
      for (const o of this.objs.values()) if (o.group.visible) b.union(new THREE.Box3().setFromObject(o.mesh));
      const [hw, hd] = this.plateHalf || [300, 300];
      b.expandByPoint(new THREE.Vector3(-hw, -hd, 0)).expandByPoint(new THREE.Vector3(hw, hd, 0));
      this.sceneBox = b; this.sceneBoxDirty = false;
      this.sceneSphere = b.getBoundingSphere(new THREE.Sphere());
    }
    const s = this.sceneSphere;
    const far = Math.max(cam.position.distanceTo(s.center) + s.radius, d * 4) * 1.5;
    const near = Math.min(Math.max(0.01, d / 1000), far / 1000);
    if (Math.abs(near - cam.near) > cam.near * 0.05 || Math.abs(far - cam.far) > cam.far * 0.05) {
      cam.near = near; cam.far = far; cam.updateProjectionMatrix();
    }
  }

  // ---- selection outline --------------------------------------------------------------------
  // The selected parts are drawn white into a mask, then a ring of pixels just outside the mask
  // is painted in the selection color. It follows the true silhouette of any shape (a cone's
  // sloped sides as well as a box's edges); the feature lines still light up as before.
  // Costs one extra draw of the selected parts only, and nothing when none is selected.
  initOutline() {
    this.maskRT = new THREE.WebGLRenderTarget(1, 1);
    this.maskMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    this.outlineMat = new THREE.ShaderMaterial({
      uniforms: { mask: { value: this.maskRT.texture }, texel: { value: new THREE.Vector2(1, 1) }, color: { value: new THREE.Color(C.edgeSel) }, width: { value: 2 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform sampler2D mask; uniform vec2 texel; uniform vec3 color; uniform float width; varying vec2 vUv;
        void main() {
          if (texture2D(mask, vUv).r > 0.5) discard;
          float m = 0.0;
          for (int i = 0; i < 16; i++) {
            float a = float(i) * 0.3926991;
            vec2 d = vec2(cos(a), sin(a)) * texel;
            m = max(m, texture2D(mask, vUv + d * width).r);
            m = max(m, texture2D(mask, vUv + d * width * 0.5).r);
          }
          if (m < 0.5) discard;
          gl_FragColor = vec4(color, 1.0);
          #include <colorspace_fragment>
        }`,
      depthTest: false, depthWrite: false, transparent: true,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.outlineMat);
    quad.frustumCulled = false;
    this.outlineScene = new THREE.Scene();
    this.outlineScene.add(quad);
    this.outlineCam = new THREE.Camera();
  }
  drawOutline() {
    const any = [...this.selected].some(id => { const o = this.objs.get(id); return o && o.group.visible && o.mesh.visible && this.root.visible; });
    if (!any) return;
    const r = this.renderer, size = r.getDrawingBufferSize(new THREE.Vector2());
    if (this.maskRT.width !== size.x || this.maskRT.height !== size.y) this.maskRT.setSize(size.x, size.y);
    this.outlineMat.uniforms.texel.value.set(1 / size.x, 1 / size.y);
    this.outlineMat.uniforms.width.value = 2 * r.getPixelRatio();
    this.maskMat.clippingPlanes = this.clipOn ? [this.clipPlane] : null;
    const clear = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha(), layers = this.camera.layers.mask;
    r.setRenderTarget(this.maskRT);
    r.setClearColor(0x000000, 1);
    r.clear();
    this.camera.layers.set(2);
    this.scene.overrideMaterial = this.maskMat;
    r.render(this.scene, this.camera);
    this.scene.overrideMaterial = null;
    this.camera.layers.mask = layers;
    r.setRenderTarget(null);
    r.setClearColor(clear, alpha);
    const auto = r.autoClear;
    r.autoClear = false;
    r.render(this.outlineScene, this.outlineCam);
    r.autoClear = auto;
  }

  // ---- parts -------------------------------------------------------------------------------
  /** Show these parts. meshes: Map(id -> {key, tris}) in each part's own frame. */
  sync(parts, meshes, keep = false) {
    const seen = new Set();
    for (const p of parts) {
      seen.add(p.id);
      const m = meshes.get(p.id);
      let o = this.objs.get(p.id);
      if (!m) continue;
      if (!o || o.key !== m.key || o.hole !== !!p.hole) {
        if (o) this.drop(o);
        o = this.build(p, m);
        this.objs.set(p.id, o);
      }
      o.part = p;
      if (o.body) o.body.color.set(p.color || C.body);   // color never needs a rebuild
      this.place(o.group, p.xform);
      o.group.visible = !p.hidden && (!this.soloId || this.soloId.has(p.id)) && !this.peekOff.has(p.id);
    }
    // keep: parts just gone (joined into a group still being built) stay on screen until it is
    // ready, so nothing blinks out; the app marks them busy meanwhile
    this.kept = new Set();
    for (const [id, o] of this.objs) if (!seen.has(id)) {
      if (keep) { this.kept.add(id); continue; }
      this.drop(o); this.objs.delete(id);
    }
    this.sceneBoxDirty = true;
    this.paintSelection();
    this.request();
  }

  build(p, m) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.tris, 3));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const group = new THREE.Group();
    const hole = !!p.hole;
    // each solid gets its own material so it can carry its own color
    const cut = this.cutHere(p.id) ? [this.clipPlane] : null;
    const body = hole ? null : new THREE.MeshLambertMaterial({ color: p.color || C.body, flatShading: true, polygonOffset: true,
      polygonOffsetFactor: 1, polygonOffsetUnits: 1, clippingPlanes: cut });
    const mesh = new THREE.Mesh(g, hole ? this.mats.hole : body);
    mesh.userData = { id: p.id, hole };
    group.add(mesh);
    // the inside of the walls, seen through a cut: the theme's inside color, barely there, so the
    // part reads as hollow and what is inside it shows (its own, so only parts being cut are cut)
    const insideMat = hole ? null : this.mats.inside.clone();
    if (insideMat) { insideMat.clippingPlanes = cut; group.add(new THREE.Mesh(g, insideMat)); }
    // feature lines: small parts here and now; big ones from the worker, filled in when ready
    // (building them on the page took 4 s for 1.2 million triangles and froze the view)
    const small = m.tris.length / 9 <= 30000;
    const edges = new THREE.LineSegments(small ? new THREE.EdgesGeometry(g, 40) : new THREE.BufferGeometry(), hole ? this.mats.holeEdge : this.mats.edge);
    if (hole && small) edges.computeLineDistances();
    group.add(edges);
    if (!small) queueMicrotask(() => this.onNeedEdges?.(p.id, m.key, m.tris));
    // a search tree (built in the worker) for picking and for the inside test, which otherwise
    // scans every triangle each frame while the camera is in the part's box (15 fps at 237k)
    if (m.tris.length / 9 > 20000) queueMicrotask(() => this.onNeedBvh?.(p.id, m.key, m.tris));
    this.root.add(group);
    const o = { group, mesh, edges, body, insideMat, key: m.key, tris: m.tris, hole, part: p };
    if (this.faultsOn) this.addFaults(o);
    return o;
  }

  /** Fault highlight: where each part is not closed, as yellow lines with a dot at each end,
   *  drawn through the model so a fault on the far side is still found. Off by default. */
  setFaults(on) {
    this.faultsOn = on;
    for (const o of this.objs.values()) {
      if (on && !o.faults) this.addFaults(o);
      if (o.faults) o.faults.visible = on;
    }
    this.request();
  }
  addFaults(o) {
    const f = faultEdges(o.tris);
    o.faultCount = f;
    if (!f.segs.length) { o.faults = new THREE.Group(); o.group.add(o.faults); return; }
    if (!this.mats.fault) {
      this.mats.fault = new THREE.LineBasicMaterial({ color: 0xffe066, depthTest: false, transparent: true });
      this.mats.faultDot = new THREE.PointsMaterial({ color: 0xffe066, size: 6, sizeAttenuation: false, depthTest: false, transparent: true });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(f.segs, 3));
    const grp = new THREE.Group();
    const lines = new THREE.LineSegments(g, this.mats.fault), dots = new THREE.Points(g, this.mats.faultDot);
    lines.renderOrder = dots.renderOrder = 10;
    grp.add(lines, dots);
    o.faults = grp;
    o.group.add(grp);
  }

  drop(o) {
    o.group.traverse(c => { if (c.geometry) c.geometry.dispose(); });
    o.body?.dispose(); o.insideMat?.dispose();
    o.seeThrough?.dispose();
    for (const [id, x] of this.objs) if (x === o) this.insideIds?.delete(id);
    this.root.remove(o.group);
  }

  place(obj, x) {
    obj.position.set(...(x?.pos || [0, 0, 0]));
    const r = (x?.rot || [0, 0, 0]).map(d => (d * Math.PI) / 180);
    obj.rotation.set(r[0], r[1], r[2], 'XYZ');
    obj.scale.set(...(x?.scale || [1, 1, 1]));
  }

  /** History view: show these parts in place of the part ids given (the rest stay as they are,
   *  unless others is false: then only these show), or null to go back.
   *  items: [{tris, xform, color, hole}] in each part's own frame. */
  showPast(items, replace = [], others = true) {
    if (this.past) { this.past.traverse(c => { c.geometry?.dispose(); if (c.material && c.material !== this.mats.hole && c.material !== this.mats.inside) c.material.dispose(); }); this.scene.remove(this.past); this.past = null; }
    for (const id of this.pastHidden || []) { const o = this.objs.get(id); if (o) o.group.visible = !o.part?.hidden; }
    this.pastHidden = null;
    this.root.visible = !items || others;
    if (items) {
      this.pastHidden = [...replace];
      for (const id of replace) { const o = this.objs.get(id); if (o) o.group.visible = false; }
      this.past = new THREE.Group();
      for (const it of items) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(it.tris, 3));
        g.computeVertexNormals();
        const grp = new THREE.Group();
        grp.add(new THREE.Mesh(g, it.hole ? this.mats.hole : new THREE.MeshLambertMaterial({ color: it.color || C.body, flatShading: true })));
        if (!it.hole) grp.add(new THREE.Mesh(g, this.mats.inside));
        this.place(grp, it.xform);
        this.past.add(grp);
      }
      this.scene.add(this.past);
    }
    this.request();
  }

  /** A picking search tree made in the worker for the part's mesh with this key. It sits on its
   *  own geometry (sharing the points) so the part's drawn geometry is untouched. */
  setBvh(id, key, data) {
    const o = this.objs.get(id);
    if (!o || o.key !== key) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', o.mesh.geometry.attributes.position);
    o.pickBvh = MeshBVH.deserialize(data, g, { setIndex: true });
    o.pickIndex = data.index;
  }

  /** Feature lines worked out elsewhere, for the part's mesh with this key (a newer mesh wins). */
  setEdges(id, key, segs) {
    const o = this.objs.get(id);
    if (!o || o.key !== key) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(segs, 3));
    o.edges.geometry.dispose();
    o.edges.geometry = g;
    if (o.hole) o.edges.computeLineDistances();
    this.request();
  }

  /** Show only this part (the others hidden in the view only), or null for all. */
  solo(id) {
    // one part, or several (an array): only they show
    this.soloId = id?.length && typeof id !== 'string' ? new Set(id) : id ? new Set([id]) : null;
    for (const [oid, o] of this.objs) o.group.visible = !o.part?.hidden && (!this.soloId || this.soloId.has(oid)) && !this.peekOff.has(oid);
    this.sceneBoxDirty = true;
    this.request();
  }

  /** Move a part's display without a rebuild (live drag). */
  setXform(id, x) { const o = this.objs.get(id); if (o) { this.place(o.group, x); this.sceneBoxDirty = true; this.request(); } }

  /** Placing a new shape: a see-through copy follows the pointer until a click.
   *  onPlace('move' | 'click', hit) with hit = {point, normal} on a part, or {point} on the plate. */
  startPlace(tris) {
    this.endPlace();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tris, 3));
    g.computeVertexNormals();
    this.ghost = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: C.body, transparent: true, opacity: 0.55, flatShading: true, depthWrite: false }));
    this.ghost.visible = false;
    this.scene.add(this.ghost);
    this.request();
  }
  /** A mesh shown as it is, in world coordinates, not a part (text being wrapped). null takes it away. */
  setPreview(tris, cut = false) {
    // a cut (deboss) shows as dark letters seen through the surface, the color of cut walls
    if (tris && this.wrapMesh && this.wrapMesh.userData.cut !== cut) this.setPreview(null);
    const o = this.wrapMesh;
    if (!tris) {
      if (o) { this.scene.remove(o); o.geometry.dispose(); o.material.dispose(); this.wrapMesh = null; this.request(); }
      return;
    }
    if (!o) {
      // a cut: only its inside faces (floor and walls as seen into a hole), drawn last over a
      // cleared depth so the part's surface does not hide them: it reads as letters cut in
      this.wrapMesh = new THREE.Mesh(new THREE.BufferGeometry(), cut
        ? new THREE.MeshLambertMaterial({ color: C.inside, flatShading: true, transparent: true, opacity: 1, side: THREE.BackSide })
        : new THREE.MeshLambertMaterial({ color: C.bodySel, flatShading: true }));
      this.wrapMesh.userData.cut = cut;
      if (cut) { this.wrapMesh.renderOrder = 10; this.wrapMesh.onBeforeRender = r => r.clearDepth(); }
      this.scene.add(this.wrapMesh);
    }
    const g = this.wrapMesh.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(tris, 3));
    g.computeBoundingSphere();
    this.request();
  }
  /** Show or hide one part's mesh for a while, without changing the part (kept through redraws). */
  peekOff = new Set();
  peek(id, on) {
    if (on) this.peekOff.delete(id); else this.peekOff.add(id);
    const o = this.objs.get(id);
    if (o) { o.group.visible = on && !o.part?.hidden && (!this.soloId || this.soloId.has(id)); this.request(); }
  }
  setGhost(x) { if (!this.ghost) return; this.place(this.ghost, x); this.ghost.visible = true; this.request(); }
  endPlace() {
    if (!this.ghost) return;
    this.scene.remove(this.ghost); this.ghost.geometry.dispose(); this.ghost.material.dispose(); this.ghost = null;
    this.request();
  }
  placeHit(e) {
    const h = this.hit(e);
    if (h) {
      const o = this.objs.get(h.id), pos = o.mesh.geometry.attributes.position, f = h.face;
      const a = new THREE.Vector3().fromBufferAttribute(pos, f * 3), b = new THREE.Vector3().fromBufferAttribute(pos, f * 3 + 1), c = new THREE.Vector3().fromBufferAttribute(pos, f * 3 + 2);
      o.mesh.updateMatrixWorld();
      [a, b, c].forEach(v => v.applyMatrix4(o.mesh.matrixWorld));
      const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
      return { point: h.point, normal: n, id: h.id };
    }
    const ray = this.ray(e), p = new THREE.Vector3();
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), p) ? { point: p } : null;
  }
  /** Unit vectors in a plane that run most nearly right and up on screen. */
  planeAxes(n) {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const flat = v => v.clone().sub(n.clone().multiplyScalar(v.dot(n))).normalize();
    let u = flat(right);
    if (!(u.lengthSq() > 0.5)) u = flat(up).cross(n).normalize();
    let w = n.clone().cross(u).normalize();
    if (w.dot(up) < 0) w.negate();
    return { u, v: w };
  }

  /** Preview a different mesh for one part (tool steps), or null to go back. */
  preview(id, tris) {
    const o = this.objs.get(id);
    if (!o) return;
    if (o.previewMesh) { o.group.remove(o.previewMesh); o.previewMesh.geometry.dispose(); o.previewMesh = null; }
    o.group.children.forEach(c => { if (c !== o.previewMesh) c.visible = !tris; });
    if (tris) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(tris, 3));
      g.computeVertexNormals();
      o.previewMesh = new THREE.Mesh(g, this.mats.bodySel);
      o.group.add(o.previewMesh);
    }
    this.request();
  }

  select(ids) {
    this.selected = new Set(ids);
    this.paintSelection();
    this.request();
  }
  paintSelection() {
    for (const [id, o] of this.objs) {
      const on = this.selected.has(id);
      // selected: lit up (lightness, works on any color) and green outline (shape cue)
      if (o.body) o.body.emissive.setHex(on ? 0x3a3a3a : 0x000000);
      if (o.edges && !o.hole) o.edges.material = on ? this.mats.edgeSel : this.mats.edge;
      if (on) o.mesh.layers.enable(2); else o.mesh.layers.disable(2);   // layer 2: drawn into the outline mask
    }
    if (this.clipOn) this.applyClip();   // the cut follows the selection
  }

  /** Highlight picked triangles on one part (tool face picks). */
  setFacePick(id, list) {
    if (this.pickMesh) { this.pickMesh.parent?.remove(this.pickMesh); this.pickMesh.geometry.dispose(); this.pickMesh = null; }
    const o = id && this.objs.get(id);
    if (o && list?.length) {
      const a = new Float32Array(list.length * 9);
      list.forEach((f, i) => a.set(o.tris.subarray(f * 9, f * 9 + 9), i * 9));
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(a, 3));
      this.pickMesh = new THREE.Mesh(g, this.mats.pick);
      o.group.add(this.pickMesh);
    }
    this.request();
  }

  /** Which plate axes the arrow keys mean from this view: the one of +X, -X, +Y, -Y that
   *  moves on screen most nearly right, and the one most nearly up. Works from any angle,
   *  below the plate included. Returns {right: [x, y], up: [x, y]}. */
  screenAxes(at) {
    const c = at || this.controls.target;
    const r = this.renderer.domElement.getBoundingClientRect();
    const p0 = new THREE.Vector3(c.x, c.y, c.z).project(this.camera);
    const L = Math.max(1, this.camera.position.distanceTo(this.controls.target) / 20);
    const cands = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(a => {
      const p = new THREE.Vector3(c.x + a[0] * L, c.y + a[1] * L, c.z).project(this.camera);
      const sx = (p.x - p0.x) * r.width, sy = -(p.y - p0.y) * r.height;   // screen y grows down
      const l = Math.hypot(sx, sy) || 1;
      return { a, sx: sx / l, sy: sy / l };
    });
    const right = cands.reduce((b, k) => (k.sx > b.sx ? k : b));
    const up = cands.filter(k => k.a[0] !== right.a[0] || k.a[1] !== right.a[1]).filter(k => !(k.a[0] === -right.a[0] && k.a[1] === -right.a[1]))
      .reduce((b, k) => (-k.sy > -b.sy ? k : b));
    return { right: right.a, up: up.a };
  }

  /** World bounding box of some parts (all when ids is empty). */
  bounds(ids) {
    const b = new THREE.Box3();
    for (const [id, o] of this.objs) if ((!ids?.length || ids.includes(id)) && o.group.visible) b.expandByObject(o.group);
    return b.isEmpty() ? null : b;
  }

  // ---- handles ------------------------------------------------------------------------------
  // On the one selected part: a cube on each side and on top (size), a cone above (lift) and
  // a ring per axis (turn). Shapes only, no numbers: sizes are read in the side panel. They
  // keep the same size on screen and draw over the part. Hover lights one up.
  initHandles() {
    const mk = () => new THREE.MeshBasicMaterial({ color: 0xb0b0b0, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
    this.hot = new THREE.MeshBasicMaterial({ color: C.pick, depthTest: false, depthWrite: false, transparent: true });
    this.handles = new THREE.Group();
    this.handles.visible = false;
    this.handleFor = null;
    this.hparts = [];
    const add = (geo, info, mat = mk()) => {
      const m = new THREE.Mesh(geo, mat);
      m.renderOrder = 20;
      m.userData = { info, mat };
      this.handles.add(m);
      this.hparts.push(m);
      return m;
    };
    const cube = new THREE.BoxGeometry(1, 1, 1);
    const outline = new THREE.EdgesGeometry(cube);
    for (const [axis, side] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1]]) {
      const m = add(cube, { kind: 'size', axis, side });
      const l = new THREE.LineSegments(outline, new THREE.LineBasicMaterial({ color: 0x000000, depthTest: false }));
      l.renderOrder = 21;
      m.add(l);
    }
    const cone = new THREE.ConeGeometry(0.45, 1.1, 20).rotateX(Math.PI / 2);
    add(cone, { kind: 'lift' });
    // a second Z cube and lift cone under the part, shown as well (not instead) when seen from below
    {
      const m = add(cube, { kind: 'size', axis: 2, side: -1 });
      const l = new THREE.LineSegments(outline, new THREE.LineBasicMaterial({ color: 0x000000, depthTest: false }));
      l.renderOrder = 21;
      m.add(l);
      add(cone, { kind: 'lift' }).rotation.x = Math.PI;
    }
    // rings: a thin visible band, picked through a thicker invisible one
    for (const axis of [0, 1, 2]) {
      const ring = new THREE.Group();
      const band = new THREE.Mesh(new THREE.TorusGeometry(1, 0.008, 6, 128), mk());
      band.material.opacity = 0.45;
      band.renderOrder = 19;
      const pick = add(new THREE.TorusGeometry(1, 0.05, 6, 64), { kind: 'rot', axis },
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
      pick.userData.show = band;
      this.handles.remove(pick);
      ring.add(band, pick);
      if (axis === 0) ring.rotation.y = Math.PI / 2;
      if (axis === 1) ring.rotation.x = Math.PI / 2;
      ring.userData.axis = axis;
      this.handles.add(ring);
    }
    this.scene.add(this.handles);
  }

  /** Show handles on this part (or none). */
  setHandles(id) { this.handleFor = id; this.handleBox = null; this.request(); }
  /** Handles on the box around several parts (all selected): square to the axes, and following
   *  them while a drag shows them changing. */
  setHandleBox(ids) { this.handleFor = null; this.handleBox = ids?.length ? ids : null; this.request(); }
  setRings(on) { this.ringsOn = on; this.request(); }
  setGrid(on) { this.gridOn = on; if (this.plate) this.plate.visible = on; this.request(); }
  /** Selection guides: the selected parts' outline on the plate, and its four sides run out
   *  to the plate's edges, so lining parts up can be judged from afar. */
  updateGuides() {
    const ids = [...(this.selected || [])].filter(id => this.objs.get(id)?.group.visible);
    if (!this.guides) {
      this.mats.guide = new THREE.LineBasicMaterial({ color: this.guideColor || 0x3d7a3d });
      this.guides = new THREE.LineSegments(new THREE.BufferGeometry(), this.mats.guide);
      this.guides.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(48), 3));
      this.guides.position.z = 0.02;
      this.scene.add(this.guides);
    }
    if (!ids.length || this.ghost) { this.guides.visible = false; return; }
    const b = new THREE.Box3();
    for (const id of ids) b.union(new THREE.Box3().setFromObject(this.objs.get(id).group));
    const [hw, hd] = this.plateHalf || [300, 300], x0 = b.min.x, x1 = b.max.x, y0 = b.min.y, y1 = b.max.y;
    const a = this.guides.geometry.attributes.position.array;
    a.set([x0, y0, 0, x1, y0, 0, x1, y0, 0, x1, y1, 0, x1, y1, 0, x0, y1, 0, x0, y1, 0, x0, y0, 0,
      x0, -hd, 0, x0, hd, 0, x1, -hd, 0, x1, hd, 0, -hw, y0, 0, hw, y0, 0, -hw, y1, 0, hw, y1, 0]);
    this.guides.geometry.attributes.position.needsUpdate = true;
    this.guides.geometry.computeBoundingSphere();
    this.guides.visible = true;
  }
  /** Measure marks: a small dot at each point and a thin line between two, in the selection
   *  color, drawn over everything (no numbers in the view: they go in the readout). pts: Vector3s. */
  setMeasure(pts) { this.marks('measure', pts); }
  /** A path being drawn: its points, a line through them, and a last stretch to the pointer. */
  setDraft(pts) { this.marks('draft', pts); }
  /** The 3D frame: its edges (segments, 6 numbers each) and points in the selection color, drawn
   *  over everything; its chosen faces filled faintly (triangles, 9 numbers each); edges left open
   *  by a failed Make solid in the error yellow. Any of them empty hides it. */
  setFrame({ segs = [], pts = [], faces = [], open = [], stems = [] } = {}) {
    if (!this.frameMarks) {
      const lineMat = new THREE.LineBasicMaterial({ depthTest: false, transparent: true });
      const openMat = new THREE.LineBasicMaterial({ color: 0xffe066, depthTest: false, transparent: true });
      const g = new THREE.Group();
      const edges = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat);
      const dots = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, depthTest: false, transparent: true }));
      const fill = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }));
      const bad = new THREE.LineSegments(new THREE.BufferGeometry(), openMat);
      // each raised point's stem to the plate and its foot: half see-through, so they read as height, not frame
      const stem = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ depthTest: false, transparent: true, opacity: 0.5 }));
      for (const x of [edges, dots, fill, bad, stem]) { x.frustumCulled = false; x.renderOrder = 10; g.add(x); }
      this.frameMarks = g;
      this.scene.add(g);
    }
    const [edges, dots, fill, bad, stem] = this.frameMarks.children;
    const set = (o, a) => { o.geometry.dispose(); o.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(Float32Array.from(a), 3)); o.visible = a.length > 0; };
    const sl = [];
    for (const [x, y, z] of stems) sl.push(x, y, z, x, y, 0, x - 1.5, y, 0, x + 1.5, y, 0, x, y - 1.5, 0, x, y + 1.5, 0);
    set(edges, segs); set(dots, pts); set(fill, faces); set(bad, open); set(stem, sl);
    for (const o of [edges, dots, fill, stem]) o.material.color.copy(this.mats.edgeSel.color);
    this.frameMarks.visible = segs.length + pts.length + faces.length + open.length + sl.length > 0;
    this.request();
  }
  /** A reference grid on a plane, for drawing in space: lines every `step` mm along u and v from o,
   *  u from -half to +half, v from v0 to v1; every fifth line and the v = vPlate line stronger.
   *  Drawn behind parts (depth tested), see-through. null hides it. */
  setRefGrid(g) {
    if (!this.refGrid) {
      const minor = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x8a8a8a, transparent: true, opacity: 0.22, depthWrite: false }));
      const major = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xb0b0b0, transparent: true, opacity: 0.45, depthWrite: false }));
      // the ring gauge: stronger than the grid, drawn over the plate's own lines
      const dial = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xb0b0b0, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false }));
      dial.renderOrder = 9;
      this.refGrid = new THREE.Group();
      this.refGrid.add(minor, major, dial);
      for (const x of [minor, major, dial]) x.frustumCulled = false;
      this.scene.add(this.refGrid);
    }
    this.refGrid.visible = !!g;
    if (!g) { this.request(); return; }
    const { o, u, v, half, v0, v1, step, vPlate, gauge } = g, mi = [], ma = [], di = [];
    const at = (a, b) => o.clone().addScaledVector(u, a).addScaledVector(v, b);
    const push = (list, p, q) => list.push(p.x, p.y, p.z, q.x, q.y, q.z);
    if (gauge) {
      // a ring gauge on the plate round the grid's foot: a tick every degree, longer every 5 and 10,
      // longest at 0 / 90 / 180 / 270 (0 along X); the needle along the grid's own direction
      const R = gauge.r, P = (r, d) => new THREE.Vector3(o.x + r * Math.cos((d * Math.PI) / 180), o.y + r * Math.sin((d * Math.PI) / 180), 0);
      for (let d = 0; d < 360; d++) {
        push(di, P(R, d), P(R, d + 1));
        const len = d % 90 === 0 ? 8 : d % 10 === 0 ? 5 : d % 5 === 0 ? 3 : 1.5;
        push(di, P(R, d), P(R - len, d));
      }
      push(di, P(0, gauge.deg), P(R + 6, gauge.deg));
      push(di, P(R + 6, gauge.deg), P(R + 2, gauge.deg + 2)); push(di, P(R + 6, gauge.deg), P(R + 2, gauge.deg - 2));
    }
    for (let k = -Math.floor(half / step); k <= Math.floor(half / step); k++) push(k % 5 ? mi : ma, at(k * step, v0), at(k * step, v1));
    for (let b = Math.ceil(v0 / step) * step; b <= v1 + 1e-9; b += step) {
      const strong = Math.abs(b - (vPlate ?? Infinity)) < 1e-6 || Math.round(b / step) % 5 === 0;
      push(strong ? ma : mi, at(-half, b), at(half, b));
    }
    const [minor, major, dial] = this.refGrid.children;
    for (const [o2, a] of [[minor, mi], [major, ma], [dial, di]]) { o2.geometry.dispose(); o2.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(a), 3)); }
    this.request();
  }
  /** Marks drawn over everything in the selection color: dots at pts, a line through them. */
  marks(key, pts) {
    this.markSets ||= {};
    let g = this.markSets[key];
    if (!g) {
      const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ depthTest: false, transparent: true }));
      const dots = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, depthTest: false, transparent: true }));
      line.renderOrder = dots.renderOrder = 10;
      line.frustumCulled = dots.frustumCulled = false;
      g = this.markSets[key] = new THREE.Group();
      g.add(line, dots);
      this.scene.add(g);
    }
    const [line, dots] = g.children;
    const a = new Float32Array(pts.flatMap(p => [p.x, p.y, p.z]));
    line.geometry.dispose(); dots.geometry.dispose();
    line.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(a, 3));
    dots.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(a.slice(), 3));
    line.visible = pts.length > 1;
    line.material.color.copy(this.mats.edgeSel.color); dots.material.color.copy(this.mats.edgeSel.color);
    g.visible = pts.length > 0;
    this.request();
  }
  /** The point under the pointer for measuring: on a part (a corner of the face under it when one
   *  is within px pixels) or on the plate. { point, corner } or null. */
  snapPoint(e, px = 8) {
    const h = this.hit(e);
    if (!h) { const p = this.placeHit(e); return p ? { point: p.point.clone(), corner: false } : null; }
    const o = this.objs.get(h.id), pos = o.mesh.geometry.attributes.position, r = this.renderer.domElement.getBoundingClientRect();
    o.mesh.updateMatrixWorld();
    let best = null, bd = px * px;
    for (let k = 0; k < 3; k++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, h.face * 3 + k).applyMatrix4(o.mesh.matrixWorld);
      const s = v.clone().project(this.camera);
      const dx = (s.x + 1) / 2 * r.width + r.left - e.clientX, dy = (1 - s.y) / 2 * r.height + r.top - e.clientY;
      if (dx * dx + dy * dy <= bd) { bd = dx * dx + dy * dy; best = v; }
    }
    return { point: best || h.point.clone(), corner: !!best };
  }
  /** Key light direction: up, plus a little towards the camera (flat on the plate, so its height
   *  does not matter) and to its left. From below the plate, the same from underneath. */
  aimLight() {
    const toCam = this.camera.position.clone().sub(this.controls.target);
    toCam.z = 0;
    if (toCam.lengthSq() < 1e-9) toCam.set(0, -1, 0);
    toCam.normalize();
    const left = new THREE.Vector3(-toCam.y, toCam.x, 0).negate();
    const up = this.camera.position.z < 0 ? -1 : 1;
    const dir = new THREE.Vector3(0, 0, up).multiplyScalar(1).addScaledVector(toCam, 0.2).addScaledVector(left, 0.35);
    this.key.target.position.copy(this.controls.target);
    this.key.position.copy(this.controls.target).addScaledVector(dir.normalize(), 100);
    this.key.target.updateMatrixWorld();
  }
  /** Inside a part, that part turns see-through until the camera leaves it; the rest stay solid.
   *  Inside means: the camera is within the part's box and the first surface straight ahead is
   *  the back of one of its faces. That holds for open imported meshes too, and it is exactly
   *  when the view would otherwise fill with the part's dark inside color. Its walls then show
   *  in its own color, see-through, so the other parts and where they cross can be seen.
   *  Heavy parts are tested at most every 120 ms while the camera moves, and once it stops. */
  updateInside(force = false) {
    const cam = this.camera.position;
    const now = performance.now();
    if (!force && this.insideAt && now - this.insideAt < 120 && this.insideHeavy) {
      clearTimeout(this.insideTimer);
      this.insideTimer = setTimeout(() => { this.updateInside(true); this.request(); }, 130);
      return;
    }
    this.insideAt = now;
    const near = [];
    let heavy = false;
    for (const [id, o] of this.objs) {
      if (o.hole || !o.group.visible || !o.body || !o.group.children[1]) continue;
      const b = new THREE.Box3().setFromObject(o.mesh);
      if (!b.expandByScalar(Math.max(0.01, this.camera.near)).containsPoint(cam)) continue;
      near.push([id, o]);
      if (o.tris.length > 9 * 200000) heavy = true;
    }
    this.insideHeavy = heavy;
    // each part on its own: the camera may be inside several that overlap, and each turns see-through
    const inside = new Set();
    if (near.length) {
      const dir = this.controls.target.clone().sub(cam);
      if (dir.lengthSq() < 1e-12) this.camera.getWorldDirection(dir);
      const rc = new THREE.Raycaster(cam.clone(), dir.normalize());
      const cut = p => this.clipOn && this.clipPlane.distanceToPoint(p) < 0;
      for (const [id, o] of near) {
        if (o.pickBvh) {
          // the part's search tree: the first surface ahead, either side; its back facing us is inside
          o.mesh.updateMatrixWorld();
          const mw = o.mesh.matrixWorld, lr = rc.ray.clone().applyMatrix4(mw.clone().invert());
          let first = null, fd = Infinity;
          for (const x of o.pickBvh.raycast(lr, THREE.DoubleSide)) {
            const p = x.point.clone().applyMatrix4(mw), d = p.distanceToSquared(cam);
            if (d < fd && !cut(p)) { fd = d; first = x; }
          }
          // (a mirrored part's faces wind the other way round)
          if (first && (first.face.normal.dot(lr.direction) > 0) !== (mw.determinant() < 0)) inside.add(id);
          continue;
        }
        const hits = rc.intersectObjects([o.mesh, o.group.children[1]], false).filter(x => !cut(x.point));
        if (hits.length && hits[0].object === o.group.children[1]) inside.add(id);
      }
    }
    const was = this.insideIds || new Set();
    if (inside.size === was.size && [...inside].every(id => was.has(id))) return;
    const set = (id, on) => {
      const o = this.objs.get(id);
      if (!o?.body) return;
      const back = o.group.children[1];
      if (on) {
        o.seeThrough ||= new THREE.MeshLambertMaterial({ side: THREE.BackSide, transparent: true, opacity: 0.35, depthWrite: false, flatShading: true });
        o.seeThrough.color.copy(o.body.color);
        o.seeThrough.clippingPlanes = this.cutHere(id) ? [this.clipPlane] : null;
        back.material = o.seeThrough;
      } else back.material = o.insideMat;
    };
    for (const id of was) if (!inside.has(id)) set(id, false);
    for (const id of inside) if (!was.has(id)) set(id, true);
    this.insideIds = inside;
  }

  // ---- cut view: only the selected parts (all of them when none is selected) ------------------
  cutHere(id) { return this.clipOn && (!this.selected.size || this.selected.has(id)); }
  /** Clipping on exactly the parts being cut; a material changing over needs its shader rebuilt. */
  applyClip() {
    const plane = [this.clipPlane];
    const set = (m, on) => { if (!m) return; if (!!m.clippingPlanes !== on) { m.clippingPlanes = on ? plane : null; m.needsUpdate = true; } };
    const all = this.clipOn && !this.selected.size;
    for (const [id, o] of this.objs) { const c = this.cutHere(id); set(o.body, c); set(o.insideMat, c); set(o.seeThrough, c); }
    set(this.mats.edgeSel, this.clipOn);
    set(this.mats.edge, all);
    set(this.mats.hole, all);
    set(this.mats.holeEdge, all);
    set(this.mats.pick, this.clipOn);
    set(this.mats.bodySel, this.clipOn);
  }

  // ---- busy: parts being rebuilt are striped and cannot be picked ------------------------------
  setBusy(ids) {
    this.busy = new Set(ids);
    if (!this.busyMat) {
      this.busyMat = new THREE.ShaderMaterial({
        uniforms: { color: { value: new THREE.Color(0xb0b0b0) } },
        vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform vec3 color; void main() { if (mod(gl_FragCoord.x + gl_FragCoord.y, 12.0) > 4.0) discard; gl_FragColor = vec4(color, 1.0);\n#include <colorspace_fragment>\n}',
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
      });
    }
    for (const [id, o] of this.objs) {
      const on = this.busy.has(id);
      if (on && !o.busyMesh) { o.busyMesh = new THREE.Mesh(o.mesh.geometry, this.busyMat); o.group.add(o.busyMesh); }
      else if (!on && o.busyMesh) { o.group.remove(o.busyMesh); o.busyMesh = null; }
    }
    this.request();
  }

  /** Accent colors for a scheme: selection edges, picks and the inside of a cut. */
  setScheme(id) {
    const s = { green: [0x7dcf7d, 0x2d5a2d, 0x3d7a3d], blue: [0x8cc4ff, 0x1f3d66, 0x2f5f99], mono: [0xffffff, 0x3a3a3a, 0x6a6a6a] }[id] || [0x7dcf7d, 0x2d5a2d, 0x3d7a3d];
    this.guideColor = s[2];
    for (const [k, m] of Object.entries(this.mats)) {
      if (!m?.color) continue;
      if (k === 'guide') m.color.setHex(s[2]);
      else if (k === 'inside') { m.color.setHex(s[1]); for (const o of this.objs.values()) o.insideMat?.color.setHex(s[1]); }
      else if (/sel|pick|box|handle/i.test(k)) m.color.setHex(s[0]);
    }
    this.outlineMat.uniforms.color.value.setHex(s[0]);
    this.request();
  }

  /** Theme colors for the view (hex strings), from the theme builder. Any left out keep theirs. */
  setViewColors(c) {
    if (c.bg) { this.bgColor = new THREE.Color(c.bg).getHex(); if (!this.bgImage) this.renderer.setClearColor(this.bgColor, 1); }
    if (c.select) { this.mats.edgeSel.color.set(c.select); this.mats.pick.color.set(c.select); this.outlineMat.uniforms.color.value.set(c.select); this.hot.color.set(c.select); }
    if (c.inside) { this.mats.inside.color.set(c.inside); for (const o of this.objs.values()) o.insideMat?.color.set(c.inside); }
    if (c.guide) { this.guideColor = new THREE.Color(c.guide).getHex(); this.mats.guide?.color.set(c.guide); }
    if (c.plate || c.grid || c.gridMajor) {
      this.plateColors = { ...this.plateColors, ...Object.fromEntries(['plate', 'grid', 'gridMajor'].filter(k => c[k]).map(k => [k, c[k]])) };
      if (this.plateSpec) this.setPlate(this.plateSpec);
    }
    this.request();
  }

  /** A picture behind the view (the page shows it; the view clears to see-through), or off. */
  setBackdrop(on) {
    this.bgImage = !!on;
    this.renderer.setClearColor(this.bgColor, on ? 0 : 1);
    // the plate's dark fill would hide the picture: only its lines stay
    if (this.plate) this.plate.children[0].visible = !on;
    this.request();
  }

  /** A picture lying on the plate under the grid, to model over: {image (a canvas: an
   *  ImageBitmap would ignore flipY and land upside down), w, d, x, y, rot, opacity, mirrorX, mirrorY}, or null. */
  setPlateImage(img) {
    if (this.plateImg) { this.scene.remove(this.plateImg); this.plateImg.geometry.dispose(); this.plateImg.material.dispose(); this.plateImg = null; }
    if (this.plateTex && this.plateTex.image !== img?.image) { this.plateTex.dispose(); this.plateTex = null; }
    if (img) {
      if (!this.plateTex) {
        this.plateTex = new THREE.Texture(img.image);
        this.plateTex.colorSpace = THREE.SRGBColorSpace;
        this.plateTex.flipY = true;
        this.plateTex.needsUpdate = true;
      }
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: this.plateTex, transparent: true, opacity: img.opacity ?? 1, depthWrite: false, side: THREE.DoubleSide }));
      // the picture reads as it does on screen when seen from above; the mirror switches flip it
      m.scale.set(img.w * (img.mirrorX ? -1 : 1), img.d * (img.mirrorY ? -1 : 1), 1);
      m.position.set(img.x || 0, img.y || 0, -0.005);
      m.rotation.z = ((img.rot || 0) * Math.PI) / 180;
      m.renderOrder = -1;
      this.plateImg = m;
      this.scene.add(m);
    }
    this.request();
  }

  /** World millimetres per screen pixel at a point. */
  pxAt(p) {
    const h = this.renderer.domElement.clientHeight || 1;
    return (2 * this.camera.position.distanceTo(p) * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
  }

  updateHandles() {
    const o = this.handleFor && this.objs.get(this.handleFor), B = this.handleBox && this.bounds(this.handleBox);
    const on = !!(((o && o.group.visible) || B) && this.root.visible);
    this.handles.visible = on;
    if (!on) return;
    let M, lo, hi;
    const q = new THREE.Quaternion();
    if (B) { M = new THREE.Matrix4(); lo = B.min; hi = B.max; }
    else {
      o.group.updateMatrixWorld();
      M = o.group.matrixWorld;
      o.group.getWorldQuaternion(q);
      ({ min: lo, max: hi } = o.mesh.geometry.boundingBox);
    }
    const cx = (lo.x + hi.x) / 2, cy = (lo.y + hi.y) / 2, cz = (lo.z + hi.z) / 2;
    const w = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(M);
    // seen from under the part's bottom (below the plate too), a second Z handle and lift cone show
    // under it as well: that handle pulls the bottom down (the top stays), that cone points down
    const below = this.camera.position.z < w(cx, cy, lo.z).z;
    const spots = [w(hi.x, cy, lo.z), w(lo.x, cy, lo.z), w(cx, hi.y, lo.z), w(cx, lo.y, lo.z), w(cx, cy, hi.z)];
    const [size, lift, under, liftUnder] = [this.hparts.slice(0, 5), this.hparts[5], this.hparts[6], this.hparts[7]];
    size.forEach((m, i) => { m.position.copy(spots[i]); m.quaternion.copy(q); m.scale.setScalar(this.pxAt(spots[i]) * 10); });
    const top = spots[4], px = this.pxAt(top);
    lift.position.copy(top).add(new THREE.Vector3(0, 0, px * 34));
    lift.scale.setScalar(px * 16);
    const bot = w(cx, cy, lo.z), pb = this.pxAt(bot);
    under.position.copy(bot); under.quaternion.copy(q); under.scale.setScalar(pb * 10);
    liftUnder.position.copy(bot).add(new THREE.Vector3(0, 0, -pb * 34)); liftUnder.scale.setScalar(pb * 16);
    under.visible = liftUnder.visible = below;
    under.userData.off = liftUnder.userData.off = !below;
    // rings around the middle (the point turns keep still), sized to clear the part
    const mid = w(cx, cy, cz);
    const wb = new THREE.Box3();
    for (const x of [lo.x, hi.x]) for (const y of [lo.y, hi.y]) for (const z of [lo.z, hi.z]) wb.expandByPoint(w(x, y, z));
    const half = wb.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const rpx = this.pxAt(mid);
    const look = this.camera.position.clone().sub(mid).normalize();
    for (const ring of this.handles.children.filter(c => c.userData.axis !== undefined)) {
      const a = ring.userData.axis;
      // shown only when asked for (the Rotate box, or R held); a ring seen edge-on is a line, so hidden
      ring.visible = !!this.ringsOn && Math.abs(look.getComponent(a)) > 0.25;
      const r = (a === 0 ? Math.hypot(half.y, half.z) : a === 1 ? Math.hypot(half.x, half.z) : Math.hypot(half.x, half.y)) + rpx * 22;
      ring.position.copy(mid);
      ring.scale.setScalar(r);
      ring.userData.radius = r;
    }
    this.handleState = { mid, q };
  }

  hitHandle(e) {
    if (!this.handles.visible) return null;
    this.updateHandles();
    this.handles.updateMatrixWorld(true);
    // cubes and the cone win over a ring passing behind them
    const hits = this.ray(e).intersectObjects(this.hparts.filter(m => m.parent.visible && !m.userData.off), false);
    const h = hits.find(x => x.object.userData.info.kind !== 'rot') || hits[0];
    return h ? h.object : null;
  }

  hover(e) {
    const h = this.handles.visible ? this.hitHandle(e) : null;
    if (h === this.hovered) return;
    const paint = (m, on) => { const t = m.userData.show || m; t.material = on ? this.hot : (t.userData.mat || t.userData.base || t.material); };
    if (this.hovered) paint(this.hovered, false);
    if (h) { const t = h.userData.show || h; if (!t.userData.base && !t.userData.mat) t.userData.base = t.material; paint(h, true); }
    this.hovered = h;
    this.renderer.domElement.style.cursor = h ? (h.userData.info.kind === 'rot' ? 'grab' : 'pointer') : '';
    this.request();
  }

  /** Start dragging a handle: remember the line or plane its value is read along. */
  grab(m, e) {
    const info = m.userData.info;
    const at = m.getWorldPosition(new THREE.Vector3());
    if (info.kind === 'size') {
      const u = new THREE.Vector3().setComponent(info.axis, info.side).applyQuaternion(this.handleState.q).normalize();
      return { info, line: { p: at, u }, t0: this.alongLine(e, at, u) };
    }
    if (info.kind === 'lift') {
      const u = new THREE.Vector3(0, 0, 1);
      return { info, line: { p: at, u }, t0: this.alongLine(e, at, u) };
    }
    const n = new THREE.Vector3().setComponent(info.axis, 1);
    const c = this.handleState.mid.clone();
    const v0 = this.onPlane(e, c, n);
    return v0 ? { info, plane: { c, n }, v0 } : null;
  }

  /** The handle's value now: mm along its line (size, lift) or degrees about its axis (rot). */
  follow(g, e) {
    if (g.line) return { ...g.info, delta: this.alongLine(e, g.line.p, g.line.u) - g.t0 };
    const v = this.onPlane(e, g.plane.c, g.plane.n);
    if (!v) return { ...g.info, deg: 0 };
    const deg = (Math.atan2(new THREE.Vector3().crossVectors(g.v0, v).dot(g.plane.n), g.v0.dot(v)) * 180) / Math.PI;
    return { ...g.info, deg };
  }

  /** Distance along a line (p, unit u) to the point nearest the pointer's ray. */
  alongLine(e, p, u) {
    const r = this.ray(e).ray, d = r.direction, w = r.origin.clone().sub(p);
    const b = d.dot(u), dd = d.dot(w), uw = u.dot(w), den = 1 - b * b;
    return den < 1e-9 ? 0 : (uw - b * dd) / den;
  }

  /** Where the pointer's ray meets a plane, as a direction from its centre. */
  onPlane(e, c, n) {
    const p = new THREE.Vector3();
    if (!this.ray(e).ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, c), p)) return null;
    const v = p.sub(c);
    return v.lengthSq() > 1e-12 ? v.normalize() : null;
  }

  // ---- plate, cut, camera -------------------------------------------------------------------
  /** Plate w x d mm centred on 0, a line every `every` mm from the centre, a darker line
   *  every 5 or 10 of them, and the edges. */
  setPlate({ w, d, every }) {
    if (this.plate) {
      this.scene.remove(this.plate);
      this.plate.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    }
    const hw = w / 2, hd = d / 2, p = [], c = [], pM = [], cM = [];
    this.plateHalf = [hw, hd];
    this.plateSpec = { w, d, every };
    this.sceneBoxDirty = true;
    const pc = { plate: C.plate, grid: C.grid, gridMajor: C.gridMajor, ...this.plateColors };
    const minor = new THREE.Color(pc.grid), major = new THREE.Color(pc.gridMajor);
    const big = every < 10 ? 10 : every * 5;   // heavy lines every 10 mm whenever the spacing allows
    const onBig = v => Math.abs(v / big - Math.round(v / big)) < 1e-6;
    const line = (k, ...xyz) => { const [pp, cc] = k === major ? [pM, cM] : [p, c]; pp.push(...xyz); cc.push(k.r, k.g, k.b, k.r, k.g, k.b); };
    for (let i = -Math.floor(hw / every + 1e-9); i * every <= hw + 1e-9; i++) { const v = i * every; line(onBig(v) ? major : minor, v, -hd, 0, v, hd, 0); }
    for (let i = -Math.floor(hd / every + 1e-9); i * every <= hd + 1e-9; i++) { const v = i * every; line(onBig(v) ? major : minor, -hw, v, 0, hw, v, 0); }
    line(major, -hw, -hd, 0, hw, -hd, 0); line(major, -hw, hd, 0, hw, hd, 0);
    line(major, -hw, -hd, 0, -hw, hd, 0); line(major, hw, -hd, 0, hw, hd, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true }));
    const gM = new THREE.BufferGeometry();
    gM.setAttribute('position', new THREE.Float32BufferAttribute(pM, 3));
    gM.setAttribute('color', new THREE.Float32BufferAttribute(cM, 3));
    const majorLines = new THREE.LineSegments(gM, new THREE.LineBasicMaterial({ vertexColors: true }));
    this.minorLines = lines;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color: pc.plate, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }));
    plate.position.z = -0.01;
    // fine lines: 0.1 mm over a 200 x 200 mm patch in the middle, whatever the plate size, shown
    // only when zoomed in close (fixed size, so a wide screen costs no more)
    const fw = Math.min(100, hw), fd = Math.min(100, hd), fp = [];
    for (let i = Math.round(-fw * 10); i <= fw * 10; i++) if (i % 10) fp.push(i / 10, -fd, 0, i / 10, fd, 0);
    for (let i = Math.round(-fd * 10); i <= fd * 10; i++) if (i % 10) fp.push(-fw, i / 10, 0, fw, i / 10, 0);
    fp.push(-fw, -fd, 0, fw, -fd, 0, -fw, fd, 0, fw, fd, 0, -fw, -fd, 0, -fw, fd, 0, fw, -fd, 0, fw, fd, 0);
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
    this.fine = new THREE.LineSegments(fg, new THREE.LineBasicMaterial({ color: 0x2a2a2a }));
    this.fine.position.z = 0.001;
    this.plate = new THREE.Group();
    this.plate.add(plate, this.fine, lines, majorLines);
    this.plate.visible = this.gridOn !== false;
    plate.visible = !this.bgImage;
    this.scene.add(this.plate);
    this.request();
  }

  /** Cut along an axis at a position in mm (world), or axis null for no cut. */
  setClip(axis, at) { this.clipAxis = axis; this.clipAt = at; this.updateClip(); this.request(); }
  /** The extent of what the cut works on, along an axis: [lo, hi] mm, or null. */
  cutRange(axis) {
    const b = this.bounds(this.selected.size ? [...this.selected] : null);
    if (!b) return null;
    const i = { x: 0, y: 1, z: 2 }[axis];
    return [b.min.getComponent(i), b.max.getComponent(i)];
  }
  updateClip() {
    const on = !!this.clipAxis && this.objs.size > 0;
    if (on !== this.clipOn) {
      this.clipOn = on;
      this.applyClip();
    }
    if (!on) return;
    const i = { x: 0, y: 1, z: 2 }[this.clipAxis];
    // the half nearer the camera goes, so the cut face looks at you
    const s = this.camera.position.getComponent(i) >= this.controls.target.getComponent(i) ? 1 : -1;
    const n = new THREE.Vector3(); n.setComponent(i, -s);
    this.clipPlane.set(n, s * this.clipAt);
  }

  /** The plate in the middle of the view, all of it in sight, looking the way the view looks now. */
  viewPlate() {
    const [hw, hd] = this.plateHalf || [300, 300];
    const v = this.camera.position.clone().sub(this.controls.target).normalize();
    const r = Math.hypot(hw, hd);
    const d = (r / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.05;
    this.controls.target.set(0, 0, 0);
    this.camera.position.copy(v.multiplyScalar(d));
    this.controls.update();
    this.request();
  }

  /** kind: iso | top | front | right; ids: fit these (default all, or the plate). */
  view(kind, ids) {
    const b = this.bounds(ids) || new THREE.Box3(new THREE.Vector3(-60, -60, 0), new THREE.Vector3(60, 60, 20));
    const c = b.getCenter(new THREE.Vector3());
    const r = Math.max(5, b.getSize(new THREE.Vector3()).length() / 2);
    const d = (r / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.1;
    const dir = { iso: [0.55, -0.75, 0.55], top: [0, -0.0001, 1], bottom: [0, -0.0001, -1], front: [0, -1, 0.0001], left: [-1, 0, 0.0001], right: [1, 0, 0.0001] }[kind] || null;
    const v = dir ? new THREE.Vector3(...dir).normalize() : this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(v, d);
    this.controls.update();
    this.request();
  }
}
