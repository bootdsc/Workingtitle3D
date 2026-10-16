// Picture to outlines, for extruding a drawing or a logo into a part. No DOM.
//
// Each pixel is solid or empty by its lightness against a threshold (see-through pixels are
// always empty). The outlines run along the pixel edges between solid and empty, so they
// close by construction and never cross; holes come out as loops of their own, and the
// even-odd rule decides what is solid. Then each loop is straightened (Douglas-Peucker) by
// the smoothing distance, so a staircase of pixels becomes the slope it stands for.

/** img: {width, height, data: RGBA bytes}. opts: {threshold 0-255, dark: true when dark
 *  pixels are solid, smooth: px, speck: loops under this area (px2) dropped}.
 *  Returns { loops: [[x, y, x, y, ...] in pixels, y down], solid: count of solid pixels }. */
export function trace(img, { threshold = 128, dark = true, smooth = 1, speck = 4 } = {}) {
  const { width: W, height: H, data } = img;
  const S = new Uint8Array((W + 2) * (H + 2));   // a frame of empty pixels round the picture
  let solid = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const a = data[i + 3];
    const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    const on = a >= 128 && (dark ? l < threshold : l >= threshold);
    if (on) { S[(y + 1) * (W + 2) + x + 1] = 1; solid++; }
  }
  const SW = W + 2, at = (x, y) => S[(y + 1) * SW + x + 1];
  // directed edges on the corner lattice ((W+1) x (H+1) points), solid on the left going round
  // a solid region anticlockwise in picture space (y down): next[from] = to, two per corner at most
  const CW = W + 1;
  const next = new Int32Array((W + 1) * (H + 1) * 2).fill(-1);
  const add = (a, b) => { if (next[a * 2] < 0) next[a * 2] = b; else next[a * 2 + 1] = b; };
  for (let y = 0; y <= H; y++) for (let x = 0; x <= W; x++) {
    // horizontal edge from (x, y) to (x+1, y): between pixel (x, y-1) above and (x, y) below
    if (x < W) {
      const up = at(x, y - 1), dn = at(x, y);
      if (dn && !up) add(y * CW + x, y * CW + x + 1);          // solid below: run right
      else if (up && !dn) add(y * CW + x + 1, y * CW + x);     // solid above: run left
    }
    // vertical edge from (x, y) to (x, y+1): between pixel (x-1, y) left and (x, y) right
    if (y < H) {
      const lf = at(x - 1, y), rt = at(x, y);
      if (lf && !rt) add(y * CW + x, (y + 1) * CW + x);        // solid left: run down
      else if (rt && !lf) add((y + 1) * CW + x, y * CW + x);   // solid right: run up
    }
  }
  // follow edges into loops; where two loops touch at a corner (diagonal pixels) take the turn
  // that keeps each solid pixel to itself, so loops never cross
  const used = new Uint8Array(next.length);
  const loops = [];
  for (let s = 0; s < next.length; s++) {
    if (next[s] < 0 || used[s]) continue;
    const pts = [];
    let slot = s;
    let from = (s / 2) | 0;
    while (!used[slot]) {
      used[slot] = 1;
      const to = next[slot];
      pts.push(from % CW, (from / CW) | 0);
      // the next edge out of `to`: if two, pick the one turning toward the solid side
      const a = to * 2, b = a + 1;
      let pick = a;
      if (next[b] >= 0) {
        const dx = (to % CW) - (from % CW), dy = ((to / CW) | 0) - ((from / CW) | 0);
        const turn = t => { const ex = (t % CW) - (to % CW), ey = ((t / CW) | 0) - ((to / CW) | 0); return dx * ey - dy * ex; };
        // y down: a right turn on screen has a positive cross product; keep the solid (left) side tight
        pick = turn(next[a]) < turn(next[b]) ? a : b;
        if (used[pick]) pick = pick === a ? b : a;
      }
      from = to;
      slot = pick;
      if (next[slot] < 0) break;
    }
    if (pts.length >= 6) loops.push(pts);
  }
  // straighten and drop specks
  const out = [];
  for (const l of loops) {
    const p = smooth > 0 ? simplifyLoop(l, smooth) : l;
    if (p.length < 6) continue;
    if (Math.abs(area(p)) < speck) continue;
    out.push(p);
  }
  return { loops: out, solid };
}

export function area(p) {
  let s = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) { const j = (i + 1) % n; s += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
  return s / 2;
}

/** Douglas-Peucker on a closed loop: split at the two points farthest apart, then each half. */
function simplifyLoop(p, eps) {
  const n = p.length / 2;
  if (n < 4) return p;
  let far = 0, best = -1;
  for (let i = 1; i < n; i++) { const d = (p[i * 2] - p[0]) ** 2 + (p[i * 2 + 1] - p[1]) ** 2; if (d > best) { best = d; far = i; } }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const run = (a, b) => {   // indices along the loop, a to b (b may wrap past n)
    const stack = [[a, b]];
    while (stack.length) {
      const [i, j] = stack.pop();
      if (j - i < 2) continue;
      const ax = p[(i % n) * 2], ay = p[(i % n) * 2 + 1], bx = p[(j % n) * 2], by = p[(j % n) * 2 + 1];
      const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
      let worst = -1, at = -1;
      for (let k = i + 1; k < j; k++) {
        const x = p[(k % n) * 2], y = p[(k % n) * 2 + 1];
        const d = Math.abs((x - ax) * dy - (y - ay) * dx) / L;
        if (d > worst) { worst = d; at = k; }
      }
      if (worst > eps) { keep[at % n] = 1; stack.push([i, at], [at, j]); }
    }
  };
  run(0, far);
  run(far, n);
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
  return out;
}
