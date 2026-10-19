// The app's own lettering: every letter is a set of centre lines; the stroke width is
// added later (round ends, round joins), so the same letters serve any weight.
// Font units: baseline 0, x-height 7, capitals 10, ascenders 10.5, descenders -3.
// Commands: M x y (new line), L x y, A cx cy r a0 a1 (circle arc, degrees, a1 < a0 runs
// clockwise), E cx cy rx ry a0 a1 (ellipse arc), Q cx cy x y (curve), O cx cy rx ry (closed
// ellipse, a line of its own), D x y (dot). An arc or curve that starts away from the pen
// is joined to it by a straight line.

export const CAP = 10;
const SPACE = 4;

const G = {
  A: 'M0 0 L3.5 10 L7 0 M1.23 3.5 L5.77 3.5',
  B: 'M0 0 L0 10 L3.5 10 A3.5 7.5 2.5 90 -90 L0 5 M0 5 L4 5 A4 2.5 2.5 90 -90 L0 0',
  C: 'E4.7 5 4.7 5 40 320',
  D: 'M0 0 L0 10 L3 10 A3 5 5 90 -90 L0 0',
  E: 'M6 10 L0 10 L0 0 L6 0 M0 5 L5 5',
  F: 'M6 10 L0 10 L0 0 M0 5 L5 5',
  G: 'E4.7 5 4.7 5 40 360 L5.4 5',
  H: 'M0 0 L0 10 M7 0 L7 10 M0 5 L7 5',
  I: 'M0 0 L0 10',
  J: 'M5 10 L5 2.5 A2.5 2.5 2.5 0 -180',
  K: 'M0 0 L0 10 M6.5 10 L0 3.5 M2.6 6.1 L6.5 0',
  L: 'M0 10 L0 0 L5.5 0',
  M: 'M0 0 L0 10 L4.5 3 L9 10 L9 0',
  N: 'M0 0 L0 10 L7 0 L7 10',
  O: 'O5 5 5 5',
  P: 'M0 0 L0 10 L3.5 10 A3.5 7 3 90 -90 L0 4',
  Q: 'O5 5 5 5 M6.5 2.6 L9.6 -0.5',
  R: 'M0 0 L0 10 L3.5 10 A3.5 7 3 90 -90 L0 4 M3.5 4 L6.5 0',
  S: 'E3 7.5 3 2.5 20 270 E3 2.5 3 2.5 90 -160',
  T: 'M0 10 L7 10 M3.5 10 L3.5 0',
  U: 'M0 10 L0 3.5 A3.5 3.5 3.5 180 360 L7 10',
  V: 'M0 10 L3.5 0 L7 10',
  W: 'M0 10 L2.6 0 L5 7 L7.4 0 L10 10',
  X: 'M0 10 L7 0 M0 0 L7 10',
  Y: 'M0 10 L3.5 5 L7 10 M3.5 5 L3.5 0',
  Z: 'M0 10 L7 10 L0 0 L7 0',

  a: 'O3.5 3.5 3.5 3.5 M7 7 L7 0',
  b: 'M0 10.5 L0 0 O3.5 3.5 3.5 3.5',
  c: 'E3.5 3.5 3.5 3.5 45 315',
  d: 'O3.5 3.5 3.5 3.5 M7 10.5 L7 0',
  e: 'M0 3.5 L7 3.5 A3.5 3.5 3.5 0 320',
  f: 'M1.5 0 L1.5 8.5 A3.5 8.5 2 180 60 M0 7 L4.5 7',
  g: 'O3.5 3.5 3.5 3.5 M7 7 L7 -0.5 E3.5 -0.5 3.5 2.5 0 -160',
  h: 'M0 10.5 L0 0 M0 3.5 A3.5 3.5 3.5 180 0 L7 0',
  i: 'M0 0 L0 7 D0 10',
  j: 'M2.5 7 L2.5 -1 A0.5 -1 2 0 -150 D2.5 10',
  k: 'M0 10.5 L0 0 M5.5 7 L0 2.5 M2.2 4.3 L5.5 0',
  l: 'M0 10.5 L0 1.5 A1.5 1.5 1.5 180 270',
  m: 'M0 0 L0 7 M0 4.5 A2.5 4.5 2.5 180 0 L5 0 M5 4.5 A7.5 4.5 2.5 180 0 L10 0',
  n: 'M0 0 L0 7 M0 3.5 A3.5 3.5 3.5 180 0 L7 0',
  o: 'O3.5 3.5 3.5 3.5',
  p: 'O3.5 3.5 3.5 3.5 M0 7 L0 -3',
  q: 'O3.5 3.5 3.5 3.5 M7 7 L7 -3',
  r: 'M0 0 L0 7 M0 3.5 A3.5 3.5 3.5 180 70',
  s: 'E2.5 5.25 2.5 1.75 20 270 E2.5 1.75 2.5 1.75 90 -160',
  t: 'M1.5 10 L1.5 1.5 A3 1.5 1.5 180 270 L4 0 M0 7 L4 7',
  u: 'M0 7 L0 3.5 A3.5 3.5 3.5 180 360 M7 7 L7 0',
  v: 'M0 7 L3 0 L6 7',
  w: 'M0 7 L2.2 0 L4.25 5 L6.3 0 L8.5 7',
  x: 'M0 7 L6 0 M0 0 L6 7',
  y: 'M0 7 L3.23 0.4 M6 7 L1.8 -3',
  z: 'M0 7 L6 7 L0 0 L6 0',

  0: 'O3.5 5 3.5 5',
  1: 'M0.5 8 L3 10 L3 0',
  2: 'A3.25 6.75 3.25 160 -35 L0 0 L6.5 0',
  3: 'E3 7.6 3 2.4 150 -90 E3 2.6 3.3 2.6 90 -150 M1.5 5.2 L3 5.2',
  4: 'M5 0 L5 10 L0 3 L7 3',
  5: 'M6 10 L1 10 L0.87 5.63 A3.2 3.3 3.3 135 -150',
  6: 'O3.3 3.3 3.3 3.3 M0 3.3 Q0.3 9 4.5 10',
  7: 'M0 10 L6.5 10 L2.5 0',
  8: 'O3.2 7.6 2.7 2.4 O3.2 2.6 3.2 2.6',
  9: 'O3.4 6.7 3.3 3.3 M6.7 6.7 Q6.4 1 2.2 0',

  '.': 'D0 0',
  ',': 'M0.5 0.4 L-0.3 -1.8',
  ':': 'D0 0 D0 6',
  ';': 'D0.5 6 M0.5 0.4 L-0.3 -1.8',
  '!': 'M0 10 L0 3.5 D0 0',
  '?': 'A3 7.4 2.8 160 -90 L3 3.5 D3 0',
  '-': 'M0 4 L4 4',
  '_': 'M0 -1.5 L7 -1.5',
  '+': 'M0 4.5 L6 4.5 M3 1.5 L3 7.5',
  '=': 'M0 6 L6 6 M0 3 L6 3',
  '/': 'M0 -1 L5 11',
  '\\': 'M0 11 L5 -1',
  '(': 'E4.5 5 4.5 6.5 125 235',
  ')': 'E0 5 4.5 6.5 55 -55',
  '[': 'M2.5 11 L0 11 L0 -1 L2.5 -1',
  ']': 'M0 11 L2.5 11 L2.5 -1 L0 -1',
  "'": 'M0 10 L0 7',
  '"': 'M0 10 L0 7 M2.5 10 L2.5 7',
  '#': 'M2 0 L3 10 M5 0 L6 10 M0 3.3 L7.5 3.3 M0.5 6.7 L8 6.7',
  '*': 'M3 9.5 L3 4.5 M0.83 8.25 L5.17 5.75 M0.83 5.75 L5.17 8.25',
  '%': 'M0 0 L7 10 O1.4 8.4 1.4 1.4 O5.6 1.6 1.4 1.4',
  '$': 'E3 7.5 3 2.5 20 270 E3 2.5 3 2.5 90 -160 M3 -1 L3 11',
  '<': 'M6 8 L0 4 L6 0',
  '>': 'M0 8 L6 4 L0 0',
  '°': 'O1.5 8.5 1.5 1.5',
};

const parsed = new Map();

/** A letter's centre lines in font units: [{pts: [[x, y], ...], closed}], or null if there is none. */
export function glyph(ch, tol = 0.02) {
  const key = ch + '|' + tol;
  if (parsed.has(key)) return parsed.get(key);
  const src = G[ch];
  const out = src == null ? null : parse(src, tol);
  parsed.set(key, out);
  return out;
}

export const hasGlyph = ch => ch === ' ' || ch in G;

function parse(src, tol) {
  const tok = src.match(/[A-Z]|-?\d*\.?\d+/g);
  const lines = [];
  let cur = null, i = 0;
  const num = () => parseFloat(tok[i++]);
  const to = p => {
    if (!cur) { cur = { pts: [p], closed: false }; lines.push(cur); return; }
    const q = cur.pts[cur.pts.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) cur.pts.push(p);
  };
  const arc = (cx, cy, rx, ry, a0, a1) => {
    const r = Math.max(rx, ry), span = Math.abs(a1 - a0) * Math.PI / 180;
    const step = 2 * Math.acos(Math.max(-1, 1 - tol / r));
    const n = Math.max(2, Math.ceil(span / step));
    for (let k = 0; k <= n; k++) {
      const a = (a0 + (a1 - a0) * k / n) * Math.PI / 180;
      to([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
    }
  };
  while (i < tok.length) {
    const c = tok[i++];
    if (c === 'M') { cur = null; to([num(), num()]); }
    else if (c === 'L') to([num(), num()]);
    else if (c === 'A') { const cx = num(), cy = num(), r = num(); arc(cx, cy, r, r, num(), num()); }
    else if (c === 'E') { const cx = num(), cy = num(), rx = num(), ry = num(); arc(cx, cy, rx, ry, num(), num()); }
    else if (c === 'Q') {
      const p0 = cur ? cur.pts[cur.pts.length - 1] : [0, 0];
      const c1 = [num(), num()], p1 = [num(), num()];
      const len = Math.hypot(c1[0] - p0[0], c1[1] - p0[1]) + Math.hypot(p1[0] - c1[0], p1[1] - c1[1]);
      const n = Math.max(4, Math.ceil(len / Math.sqrt(8 * tol)));
      for (let k = 1; k <= n; k++) {
        const t = k / n, u = 1 - t;
        to([u * u * p0[0] + 2 * u * t * c1[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c1[1] + t * t * p1[1]]);
      }
    } else if (c === 'O') {
      const cx = num(), cy = num(), rx = num(), ry = num();
      cur = null; arc(cx, cy, rx, ry, 0, 360);
      cur.pts.pop(); cur.closed = true; cur = null;
    } else if (c === 'D') {
      const x = num(), y = num();
      lines.push({ pts: [[x, y - 0.005], [x, y + 0.005]], closed: false });
      cur = null;
    } else throw new Error(`font: bad command ${c} in ${src}`);
  }
  return lines;
}

// Each letter's reach in horizontal bands, for spacing by shape rather than by box.
const BAND = 0.5, Y0 = -4, NB = 32;
function profile(lines) {
  const left = new Float64Array(NB).fill(Infinity), right = new Float64Array(NB).fill(-Infinity);
  const mark = (x, y) => {
    const b = Math.floor((y - Y0) / BAND);
    if (b < 0 || b >= NB) return;
    if (x < left[b]) left[b] = x;
    if (x > right[b]) right[b] = x;
  };
  for (const { pts, closed } of lines) {
    const n = closed ? pts.length : pts.length - 1;
    if (pts.length === 1) mark(pts[0][0], pts[0][1]);
    for (let k = 0; k < n; k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length];
      const steps = Math.max(1, Math.ceil(Math.abs(b[1] - a[1]) / (BAND / 2)));
      for (let s = 0; s <= steps; s++) mark(a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps);
    }
  }
  return { left, right };
}

function box(lines) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const { pts } of lines) for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, x1, y0, y1 };
}

/**
 * Lay text out in font units. width = stroke width (font units); spacing = clear gap between
 * letters' edges; lineGap = clear gap between lines; vertical stacks letters top to bottom.
 * Returns {lines: [{pts, closed}], missing: [chars], box}.
 */
export function layout(text, { width = 2, spacing = 1, lineGap = 3, vertical = false, tol = 0.02 } = {}) {
  const out = [], missing = new Set();
  const gap = width + spacing;
  const reach = Math.ceil((width / 2) / BAND);   // round ends reach into the bands beside them
  const rows = String(text).split('\n');
  let row = 0;
  for (const line of rows) {
    if (vertical) {
      let y = 0;
      const cx = row * (10 + gap + lineGap);
      for (const ch of line) {
        if (ch === ' ') { y -= SPACE + gap; continue; }
        const g = glyph(ch, tol);
        if (!g) { missing.add(ch); continue; }
        const b = box(g);
        const dx = cx - (b.x0 + b.x1) / 2, dy = y - b.y1;
        for (const l of g) out.push({ pts: l.pts.map(([x, yy]) => [x + dx, yy + dy]), closed: l.closed });
        y += -(b.y1 - b.y0) - gap;
      }
    } else {
      let prev = null, x = 0;
      const base = -row * (CAP + 3 + gap + lineGap);
      for (const ch of line) {
        if (ch === ' ') { x = (prev ? prev.end : x) + SPACE + gap; prev = { end: x - gap, prof: null }; continue; }
        const g = glyph(ch, tol);
        if (!g) { missing.add(ch); continue; }
        const b = box(g), pr = profile(g);
        let dx = prev ? prev.end + gap - b.x0 : -b.x0;
        if (prev && prev.prof) {
          // slide the letter as close as its shape allows, never more than 2 units past its box
          let need = -Infinity;
          for (let k = 0; k < NB; k++) {
            if (pr.left[k] === Infinity) continue;
            for (let j = Math.max(0, k - reach); j <= Math.min(NB - 1, k + reach); j++) {
              if (prev.prof.right[j] === -Infinity) continue;
              need = Math.max(need, prev.prof.right[j] + prev.shift + gap - pr.left[k]);
            }
          }
          if (need > -Infinity) dx = Math.max(need, dx - 2);
        }
        for (const l of g) out.push({ pts: l.pts.map(([px, py]) => [px + dx, py + base]), closed: l.closed });
        prev = { end: b.x1 + dx, prof: pr, shift: dx };
        x = prev.end;
      }
    }
    row++;
  }
  return { lines: out, missing: [...missing], box: out.length ? box(out) : null };
}
