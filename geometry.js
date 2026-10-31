// Pure geometry helpers (no DOM) so they can be unit tested in Node.
// Points are {x, y} in metres, plan view (x right, y up).

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function polylineLength(pts, closed = false) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 2) len += dist(pts[pts.length - 1], pts[0]);
  return len;
}

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

// Douglas-Peucker. First and last points are always kept.
export function douglasPeucker(pts, tol) {
  if (pts.length < 3) return pts.slice();
  let maxD = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSegment(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= tol) return [pts[0], pts[pts.length - 1]];
  const left = douglasPeucker(pts.slice(0, idx + 1), tol);
  const right = douglasPeucker(pts.slice(idx), tol);
  return left.slice(0, -1).concat(right);
}

// Simplify only runs of automatically traced points (auto:true).
// Manually tapped points (corners) are always kept. Returns plain {x, y} points.
export function simplifyAutoRuns(points, tol) {
  const out = [];
  let i = 0;
  while (i < points.length) {
    if (!points[i].auto) {
      out.push({ x: points[i].x, y: points[i].y });
      i++;
      continue;
    }
    let j = i;
    while (j < points.length && points[j].auto) j++;
    const chain = [];
    if (i > 0) chain.push(points[i - 1]);
    for (let k = i; k < j; k++) chain.push(points[k]);
    if (j < points.length) chain.push(points[j]);
    const simp = douglasPeucker(chain, tol);
    const start = i > 0 ? 1 : 0;
    const end = j < points.length ? simp.length - 1 : simp.length;
    for (let k = start; k < end; k++) out.push({ x: simp[k].x, y: simp[k].y });
    i = j;
  }
  return out;
}

// The user walks round the outline and finally aims at the start point (endPoint).
// Because of AR drift endPoint will not equal points[0]. Spread that gap over all points
// in proportion to distance walked, so the loop closes exactly.
// Returns { points, error } where error is the gap in metres.
export function closeLoop(points, endPoint) {
  const first = points[0];
  const gx = first.x - endPoint.x;
  const gy = first.y - endPoint.y;
  const error = Math.hypot(gx, gy);
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + dist(points[i - 1], points[i]));
  const total = cum[cum.length - 1] + dist(points[points.length - 1], endPoint);
  if (total === 0) return { points: points.map((p) => ({ ...p })), error };
  const out = points.map((p, i) => ({
    ...p,
    x: p.x + (gx * cum[i]) / total,
    y: p.y + (gy * cum[i]) / total,
  }));
  return { points: out, error };
}

// Least squares scale s minimising sum (m - s*d)^2 for pairs {d: current, m: measured}.
export function bestFitScale(pairs) {
  let num = 0;
  let den = 0;
  for (const { d, m } of pairs) {
    if (!(d > 0) || !(m > 0)) continue;
    num += d * m;
    den += d * d;
  }
  return den === 0 ? 1 : num / den;
}

export function centroidOf(shapes) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const s of shapes) {
    for (const p of s.points) {
      sx += p.x;
      sy += p.y;
      n++;
    }
  }
  return n ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
}

// Scale every shape about a centre point, in place.
export function scaleShapes(shapes, factor, centre) {
  for (const s of shapes) {
    for (const p of s.points) {
      p.x = centre.x + (p.x - centre.x) * factor;
      p.y = centre.y + (p.y - centre.y) * factor;
    }
    if (typeof s.r === 'number') s.r *= factor;
    if (typeof s.closureError === 'number') s.closureError *= factor;
  }
}

// Tilt of the phone camera away from pointing straight down, in degrees.
// m is a column-major 4x4 pose matrix (WebXR / Three.js). The camera looks along its local -Z,
// so world forward = -(m[8], m[9], m[10]) and its dot product with world down (0,-1,0) is m[9].
// 0 = phone flat over the ground (screen up, camera down), 90 = camera pointing at the horizon.
export function tiltFromStraightDown(m) {
  const c = Math.max(-1, Math.min(1, m[9]));
  return (Math.acos(c) * 180) / Math.PI;
}

export const TILT_GOOD = 15; // degrees: fully green at or below this
export const TILT_WARN = 35; // degrees: orange
export const TILT_BAD = 55; // degrees: fully red at or above this

const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const hex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

// Green -> orange -> red as the tilt increases. Returns a '#rrggbb' string.
export function tiltColour(deg) {
  const green = [0x22, 0xc5, 0x5e];
  const orange = [0xff, 0x98, 0x00];
  const red = [0xe5, 0x39, 0x35];
  let a;
  let b;
  let t;
  if (deg <= TILT_GOOD) return hex(...green);
  if (deg >= TILT_BAD) return hex(...red);
  if (deg <= TILT_WARN) {
    a = green; b = orange; t = (deg - TILT_GOOD) / (TILT_WARN - TILT_GOOD);
  } else {
    a = orange; b = red; t = (deg - TILT_WARN) / (TILT_BAD - TILT_WARN);
  }
  return hex(lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t));
}

// Signed polygon area: positive when the points run anticlockwise (y up).
export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Nearest point on a polygon outline. Returns {x, y, dist, i, t}: segment i (pts[i] -> pts[i+1]) at fraction t.
export function nearestOnPolygon(p, pts, closed = true) {
  let best = null;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = dist(p, q);
    if (!best || d < best.dist) best = { x: q.x, y: q.y, dist: d, i, t };
  }
  return best;
}

// Angle in degrees wrapped to [0, 360).
export const normAngle = (deg) => ((deg % 360) + 360) % 360;

// Parse "11.02", "11,02 m", "1102 cm", "36 ft", "432 in", "11020mm" into metres. Returns null if invalid.
export function parseLength(text) {
  const m = /^\s*([0-9]*[.,]?[0-9]+)\s*(mm|cm|m|ft|in)?\s*$/i.exec(text || '');
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  const f = { mm: 0.001, cm: 0.01, m: 1, ft: 0.3048, in: 0.0254 }[(m[2] || 'm').toLowerCase()];
  return v * f;
}
