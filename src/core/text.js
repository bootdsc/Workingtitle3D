// Text as flat outlines in mm: the app's own centre-line letters (font.js), stretched, then
// given their line width with round ends and round joins. Centred on the origin.
import ClipperLib from 'clipper-lib';
import { layout, CAP } from './font.js';

const S = 1e4;   // clipper units per mm

/** mm per font unit: size is the capital height at the usual line width (a sixth of the size). */
export const unitOf = size => size / (CAP + 2);

/** {rings: [[[x, y], ...]], missing: [chars]} for a text part's params. */
export function textRings(p) {
  const s = unitOf(p.size), sx = (p.sx ?? 100) / 100, sy = (p.sy ?? 100) / 100;
  const L = layout(p.text, { width: p.width / s, spacing: p.spacing / s, lineGap: p.lineGap / s, vertical: !!p.vertical, tol: 0.005 / s });
  if (!L.box) return { rings: [], missing: L.missing };
  const cx = (L.box.x0 + L.box.x1) / 2, cy = (L.box.y0 + L.box.y1) / 2;
  const co = new ClipperLib.ClipperOffset(2, 0.01 * S);   // round ends and joins within 0.01 mm
  for (const l of L.lines) {
    const path = l.pts.map(([x, y]) => ({ X: Math.round((x - cx) * s * sx * S), Y: Math.round((y - cy) * s * sy * S) }));
    co.AddPath(path, ClipperLib.JoinType.jtRound, l.closed ? ClipperLib.EndType.etClosedLine : ClipperLib.EndType.etOpenRound);
  }
  const out = new ClipperLib.Paths();
  co.Execute(out, (p.width / 2) * S);
  return { rings: out.map(r => r.map(q => [q.X / S, q.Y / S])), missing: L.missing };
}
