// Automatic sprinkler head layout (no DOM, testable in Node).
// Plan coordinates: metres, y up. Boundaries are normalised to anticlockwise, so the lawn is always
// to the LEFT of each edge direction. A head is { x, y, radius, start, sweep, nozzleId, role, auto, warn }:
// the spray covers the sector from `start` (degrees anticlockwise from +x) sweeping anticlockwise by `sweep`.
import { dist, signedArea, nearestOnPolygon, normAngle, pointInPolygon } from './geometry.js';
import { baseModels } from './catalog.js';
import { covers, insideHoles, sampleLawn, adaptStep, computeCoverage } from './coverage.js';

const DEG = 180 / Math.PI;
const ang = (dx, dy) => normAngle(Math.atan2(dy, dx) * DEG);
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
const MAX_APPLIED_RATIO = 4; // see autoLayout()

// Drop repeated points and make the outline anticlockwise.
export function cleanBoundary(pts) {
  const out = [];
  for (const p of pts) {
    if (!out.length || dist(out[out.length - 1], p) > 1e-6) out.push({ x: p.x, y: p.y });
  }
  if (out.length > 1 && dist(out[0], out[out.length - 1]) <= 1e-6) out.pop();
  if (signedArea(out) < 0) out.reverse();
  return out;
}

// Turn angle at vertex i (positive = left turn = convex corner) and the spray arc that fills the
// lawn corner there: start along the outgoing edge, sweep to the incoming edge.
export function vertexInfo(b, i) {
  const n = b.length;
  const prev = b[(i + n - 1) % n];
  const cur = b[i];
  const next = b[(i + 1) % n];
  const inx = cur.x - prev.x;
  const iny = cur.y - prev.y;
  const outx = next.x - cur.x;
  const outy = next.y - cur.y;
  const turn = Math.atan2(inx * outy - iny * outx, inx * outx + iny * outy) * DEG;
  const start = ang(outx, outy);
  const sweep = normAngle(ang(-inx, -iny) - start);
  return { turn, start, sweep };
}

export function snapSweep(s) {
  if (s >= 354) return 360;
  if (Math.abs(s - 180) <= 8) return 180;
  return Math.round(s);
}

// Vertices that count as real corners. Corners closer than minGap are merged (sharper one wins).
export function findCorners(b, minGap, cornerAngle = 30) {
  const turnAt = (i) => Math.abs(vertexInfo(b, i).turn);
  const kept = [];
  for (let i = 0; i < b.length; i++) {
    if (turnAt(i) <= cornerAngle) continue;
    const last = kept[kept.length - 1];
    if (last !== undefined && dist(b[last], b[i]) < minGap) {
      if (turnAt(i) > turnAt(last)) kept[kept.length - 1] = i;
    } else {
      kept.push(i);
    }
  }
  if (kept.length > 1 && dist(b[kept[0]], b[kept[kept.length - 1]]) < minGap) {
    if (turnAt(kept[0]) >= turnAt(kept[kept.length - 1])) kept.pop();
    else kept.shift();
  }
  return kept;
}

// Points from vertex a forward (cyclically) to vertex c. If a === c this is the whole loop.
function stretchPath(b, a, c) {
  const pts = [b[a]];
  let i = a;
  do {
    i = (i + 1) % b.length;
    pts.push(b[i]);
  } while (i !== c);
  return pts;
}

function makePath(pts, closed = false) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const L = cum[cum.length - 1];
  const at = (s0) => {
    const s = closed && L > 0 ? ((s0 % L) + L) % L : Math.max(0, Math.min(L, s0));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const seg = cum[i] - cum[i - 1];
    const t = seg > 0 ? (s - cum[i - 1]) / seg : 0;
    return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
  };
  return { L, at };
}

// ---------- nozzle matching ----------
// Fixed-arc nozzles (e.g. 90 degree matched-precipitation) get a few degrees of tolerance.
export function arcFits(n, sweep) {
  const tol = n.minArc === n.maxArc && n.maxArc < 360 ? 6 : 0.5;
  return sweep >= n.minArc - tol && sweep <= n.maxArc + tol;
}

// Best nozzle in `list` for a head that needs radius r and arc sweep.
// Prefers the smallest model whose range contains r, else the one needing the smallest radius increase.
export function chooseNozzle(list, r, sweep) {
  const fits = list.filter((n) => arcFits(n, sweep));
  const inRange = fits.filter((n) => r >= n.minR - 1e-9 && r <= n.maxR + 1e-9);
  if (inRange.length) {
    inRange.sort((a, b) => a.maxR - b.maxR || a.maxArc - a.minArc - (b.maxArc - b.minArc));
    return { nozzle: inRange[0], radius: r, raised: false };
  }
  const below = fits.filter((n) => r < n.minR);
  if (below.length) {
    below.sort((a, b) => a.minR - b.minR);
    return { nozzle: below[0], radius: below[0].minR, raised: true };
  }
  return null;
}

function assign(head, own, familyAll) {
  const res = chooseNozzle(own, head.radius, head.sweep) || chooseNozzle(familyAll, head.radius, head.sweep);
  if (res) {
    head.nozzleId = res.nozzle.id;
    head.radius = round2(res.radius);
    head.warn = res.raised ? 'Radius raised to the nozzle minimum' : '';
  } else {
    head.nozzleId = null;
    head.warn = 'No matching nozzle';
  }
  return head;
}

// Heads that would sit inside a bed or tree are pushed just outside it.
// The closest spot that is on the lawn (or on its edge) and clear of every hole is found by searching
// outwards in rings, so a head on the lawn edge slides along the edge instead of off the lawn.
function nudgeOutOfHoles(head, holes, boundary) {
  if (!insideHoles(holes, head.x, head.y)) return;
  const onLawn = (x, y) => pointInPolygon({ x, y }, boundary) || nearestOnPolygon({ x, y }, boundary, true).dist < 0.03;
  const ok = (x, y) => onLawn(x, y) && !insideHoles(holes, x, y);
  const wasOnEdge = nearestOnPolygon(head, boundary, true).dist < 0.03;
  for (let r = 0.1; r <= 3; r += 0.1) {
    let best = null;
    for (let k = 0; k < 48; k++) {
      const a = (k * Math.PI * 2) / 48;
      let x = head.x + r * Math.cos(a);
      let y = head.y + r * Math.sin(a);
      if (wasOnEdge) {
        // stay on the lawn edge if that spot is still clear
        const q = nearestOnPolygon({ x, y }, boundary, true);
        if (ok(q.x, q.y)) { x = q.x; y = q.y; }
      }
      if (ok(x, y)) {
        const d = Math.hypot(x - head.x, y - head.y);
        if (!best || d < best.d) best = { x, y, d };
      }
    }
    if (best) {
      head.x = round2(best.x);
      head.y = round2(best.y);
      return;
    }
  }
  head.warn = 'Inside an obstacle';
}

// Spray arc at position s along a path: look delta either side of it.
function edgeArcAt(path, s, delta) {
  const d = Math.max(0.05, Math.min(delta, s > 0 ? s : delta, path.L - s > 0 ? path.L - s : delta));
  const p = path.at(s);
  const p0 = path.at(s - d);
  const p1 = path.at(s + d);
  if (dist(p, p1) < 1e-9 || dist(p, p0) < 1e-9) return { start: 0, sweep: 180 };
  const start = ang(p1.x - p.x, p1.y - p.y);
  const back = ang(p0.x - p.x, p0.y - p.y);
  return { start: Math.round(start * 10) / 10, sweep: snapSweep(normAngle(back - start)) };
}

function placeEdgeHeads(b, S) {
  const corners = findCorners(b, S * 0.3);
  const ring = [];
  const delta = S * 0.5;
  const push = (pos, arc, role) =>
    ring.push({ x: round2(pos.x), y: round2(pos.y), radius: S, start: arc.start, sweep: arc.sweep, role, auto: true });

  if (corners.length === 0) {
    const path = makePath([...b, b[0]], true);
    const n = Math.max(3, Math.ceil(path.L / S));
    for (let j = 0; j < n; j++) {
      const s = (j * path.L) / n;
      push(path.at(s), edgeArcAt(path, s, delta), 'edge');
    }
    return ring;
  }
  for (let k = 0; k < corners.length; k++) {
    const a = corners[k];
    const c = corners[(k + 1) % corners.length];
    const info = vertexInfo(b, a);
    push(b[a], { start: Math.round(info.start * 10) / 10, sweep: snapSweep(info.sweep) }, 'corner');
    const path = makePath(stretchPath(b, a, c));
    const n = Math.max(1, Math.ceil(path.L / S));
    for (let j = 1; j < n; j++) {
      const s = (j * path.L) / n;
      push(path.at(s), edgeArcAt(path, s, delta), 'edge');
    }
  }
  return ring;
}

// Each edge head must reach its neighbours along the edge (head-to-head coverage).
function setRingRadii(ring, S) {
  const n = ring.length;
  ring.forEach((h, i) => {
    if (n < 2) { h.radius = S; return; }
    const prev = ring[(i + n - 1) % n];
    const next = ring[(i + 1) % n];
    h.radius = round2(Math.max(dist(h, prev), dist(h, next)));
  });
}

function fillInterior(b, holes, heads, S, finish) {
  const st = adaptStep(b, 0.3);
  const samples = sampleLawn(b, holes, st);
  if (!samples.length) return;
  let dry = samples.filter((s) => !heads.some((h) => covers(h, s.x, s.y)));
  const stride = (arr, max) => (arr.length <= max ? arr : arr.filter((_, i) => i % Math.ceil(arr.length / max) === 0));
  for (let iter = 0; iter < 60 && dry.length > 0.01 * samples.length; iter++) {
    const evalSet = stride(dry, 1200);
    const cands = stride(dry, 300);
    let best = null;
    let bestN = 0;
    for (const c of cands) {
      let cnt = 0;
      for (const e of evalSet) if (Math.hypot(e.x - c.x, e.y - c.y) <= S) cnt++;
      if (cnt > bestN) { bestN = cnt; best = c; }
    }
    if (!best) break;
    const head = finish({ x: round2(best.x), y: round2(best.y), radius: S, start: 0, sweep: 360, role: 'interior', auto: true });
    heads.push(head);
    dry = dry.filter((s) => !covers(head, s.x, s.y));
  }
}

function layoutWith(b, holes, own, fallback, S) {
  const finish = (h) => {
    nudgeOutOfHoles(h, holes, b);
    return assign(h, own, fallback);
  };
  const ring = placeEdgeHeads(b, S);
  setRingRadii(ring, S);
  const heads = ring.map(finish);
  fillInterior(b, holes, heads, S, finish);
  return heads;
}

/**
 * Automatic layout for one lawn.
 * opts: { family, base: 'auto' | base model name, spacingFactor (default 0.95) }
 * Returns { heads, base, spacing, pct1, pct2, trials } or { error }.
 */
export function autoLayout(boundaryPts, holes, catalog, opts) {
  const b = cleanBoundary(boundaryPts);
  if (b.length < 3) return { error: 'The lawn outline needs at least 3 points' };
  const factor = opts.spacingFactor || 0.95;
  const family = catalog.nozzles.filter((n) => n.family === opts.family && n.placeable);
  const autoList = family.filter((n) => n.auto);
  if (!autoList.length) return { error: 'No placeable nozzles in that range' };

  const bases = opts.base && opts.base !== 'auto'
    ? [opts.base]
    : baseModels(catalog.nozzles, opts.family).filter((m) => m.auto).map((m) => m.base);

  const trials = [];
  for (const base of bases) {
    const own = family.filter((n) => n.base === base);
    if (!own.length) continue;
    const maxR = Math.max(...own.map((n) => n.maxR));
    const S = round2(maxR * factor);
    const heads = layoutWith(b, holes, own, autoList, S);
    const cov = computeCoverage(heads, b, holes, 0.25);
    const lawnArea = cov.total * cov.step * cov.step;
    const sprayed = heads.reduce((s, h) => s + 0.5 * ((h.sweep * Math.PI) / 180) * h.radius * h.radius, 0);
    trials.push({
      base,
      spacing: S,
      heads,
      pct1: cov.pct1,
      pct2: cov.pct2,
      unmatched: heads.filter((h) => !h.nozzleId).length,
      raised: heads.filter((h) => h.warn).length,
      // total spray area / lawn area: well above ~3-4 means lots of water lands outside the lawn
      applied: lawnArea > 0 ? sprayed / lawnArea : Infinity,
    });
  }
  if (!trials.length) return { error: 'No model available for that choice' };

  // Prefer a model that matches every head and covers (nearly) the whole lawn, doesn't force many
  // radii up to the nozzle minimum, and doesn't throw most of its water outside the lawn. Among
  // those, use the fewest heads. If nothing is acceptable, take the least wasteful.
  const good = (t) => t.unmatched === 0 && t.pct1 >= 98;
  const tidy = (t) => t.raised <= 0.25 * t.heads.length;
  const lean = (t) => t.applied <= MAX_APPLIED_RATIO;
  trials.sort((a, c) =>
    (good(c) ? 1 : 0) - (good(a) ? 1 : 0) ||
    a.unmatched - c.unmatched ||
    (good(a) ? 0 : c.pct1 - a.pct1) ||
    (tidy(c) ? 1 : 0) - (tidy(a) ? 1 : 0) ||
    (lean(c) ? 1 : 0) - (lean(a) ? 1 : 0) ||
    (lean(a) ? 0 : a.applied - c.applied) ||
    a.heads.length - c.heads.length ||
    a.raised - c.raised ||
    a.spacing - c.spacing
  );
  const best = trials[0];
  return {
    heads: best.heads,
    base: best.base,
    spacing: best.spacing,
    pct1: best.pct1,
    pct2: best.pct2,
    applied: best.applied,
    trials: trials.map((t) => ({
      base: t.base, heads: t.heads.length, pct1: t.pct1, unmatched: t.unmatched, raised: t.raised, applied: round1(t.applied),
    })),
  };
}

/**
 * Arc for a head the user places by hand. Within snapDist of the lawn edge the head snaps onto the
 * edge and gets the matching corner / edge arc; otherwise it is a full circle.
 * Returns { x, y, start, sweep, snapped }.
 */
export function suggestArc(boundaryPts, p, snapDist = 0.6, cornerDist = 0.5) {
  const b = cleanBoundary(boundaryPts);
  if (b.length < 3) return { x: p.x, y: p.y, start: 0, sweep: 360, snapped: false };
  const q = nearestOnPolygon(p, b, true);
  if (q.dist > snapDist) return { x: p.x, y: p.y, start: 0, sweep: 360, snapped: false };
  const n = b.length;
  for (let i = 0; i < n; i++) {
    if (dist(q, b[i]) <= cornerDist && Math.abs(vertexInfo(b, i).turn) > 30) {
      const info = vertexInfo(b, i);
      return { x: round2(b[i].x), y: round2(b[i].y), start: Math.round(info.start * 10) / 10, sweep: snapSweep(info.sweep), snapped: true };
    }
  }
  const path = makePath([...b, b[0]], true);
  let s = 0;
  for (let i = 0; i < q.i; i++) s += dist(b[i], b[(i + 1) % n]);
  s += dist(b[q.i], b[(q.i + 1) % n]) * q.t;
  const arc = edgeArcAt(path, s, 1);
  return { x: round2(q.x), y: round2(q.y), start: arc.start, sweep: arc.sweep, snapped: true };
}

/** Match a hand-placed or edited head to a nozzle. Mutates and returns the head. */
export function assignNozzle(head, catalog, family, base = 'auto') {
  const all = catalog.nozzles.filter((n) => n.family === family && n.placeable);
  const autoAll = all.filter((n) => n.auto);
  const own = base && base !== 'auto' ? all.filter((n) => n.base === base) : autoAll;
  return assign(head, own, autoAll);
}
