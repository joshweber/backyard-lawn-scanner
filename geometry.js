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

function distToSegment(p, a, b) {
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

// Parse "11.02", "11,02 m", "1102 cm", "36 ft", "432 in", "11020mm" into metres. Returns null if invalid.
export function parseLength(text) {
  const m = /^\s*([0-9]*[.,]?[0-9]+)\s*(mm|cm|m|ft|in)?\s*$/i.exec(text || '');
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  const f = { mm: 0.001, cm: 0.01, m: 1, ft: 0.3048, in: 0.0254 }[(m[2] || 'm').toLowerCase()];
  return v * f;
}
