// Sprinkler coverage maths (no DOM, testable in Node).
// A head is { x, y, radius, start, sweep } in metres / degrees. The spray covers the sector that
// starts at direction `start` (degrees anticlockwise from +x) and sweeps anticlockwise by `sweep`.
// A hole is { type: 'poly', points } or { type: 'circle', x, y, r }: areas that need no water.
import { pointInPolygon, normAngle } from './geometry.js';

const DEG = 180 / Math.PI;
const ARC_EPS = 0.5; // degrees of tolerance on the sector edges

export function holeContains(h, x, y) {
  if (h.type === 'circle') return Math.hypot(x - h.x, y - h.y) < h.r;
  return pointInPolygon({ x, y }, h.points);
}

export function insideHoles(holes, x, y) {
  for (const h of holes) if (holeContains(h, x, y)) return true;
  return false;
}

export function covers(h, x, y) {
  const dx = x - h.x;
  const dy = y - h.y;
  const d2 = dx * dx + dy * dy;
  if (d2 > h.radius * h.radius + 1e-9) return false;
  if (h.sweep >= 359.5 || d2 < 1e-12) return true;
  const a = normAngle(Math.atan2(dy, dx) * DEG - h.start);
  return a <= h.sweep + ARC_EPS || a >= 360 - ARC_EPS;
}

// The most recent closed lawn boundary in the project, as a point list, or null.
export function lawnBoundary(project) {
  for (let i = project.shapes.length - 1; i >= 0; i--) {
    const s = project.shapes[i];
    if (s.layer === 'LAWN_BOUNDARY' && s.closed && s.points.length >= 3) return s.points;
  }
  return null;
}

// Obstacles (beds) and trees become holes.
export function holesFromProject(project) {
  const holes = [];
  for (const s of project.shapes) {
    if (s.layer === 'OBSTACLES' && s.closed && s.points.length >= 3) {
      holes.push({ type: 'poly', points: s.points });
    } else if (s.layer === 'TREES' && s.r > 0 && s.points.length) {
      holes.push({ type: 'circle', x: s.points[0].x, y: s.points[0].y, r: s.r });
    }
  }
  return holes;
}

function bounds(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

// Keep the sample count reasonable on big lawns.
export function adaptStep(boundary, step = 0.25) {
  const b = bounds(boundary);
  const area = (b.maxX - b.minX) * (b.maxY - b.minY);
  return Math.max(step, Math.sqrt(area / 20000));
}

// Cell centres inside the lawn and outside every hole.
export function sampleLawn(boundary, holes, step) {
  const b = bounds(boundary);
  const out = [];
  for (let y = b.minY + step / 2; y < b.maxY; y += step) {
    for (let x = b.minX + step / 2; x < b.maxX; x += step) {
      if (pointInPolygon({ x, y }, boundary) && !insideHoles(holes, x, y)) out.push({ x, y });
    }
  }
  return out;
}

// counts[i] = number of heads reaching samples[i].
export function computeCoverage(heads, boundary, holes, step = 0.25) {
  const st = adaptStep(boundary, step);
  const samples = sampleLawn(boundary, holes, st);
  const counts = new Uint8Array(samples.length);
  for (const h of heads) {
    for (let i = 0; i < samples.length; i++) {
      if (counts[i] < 255 && covers(h, samples[i].x, samples[i].y)) counts[i]++;
    }
  }
  let c1 = 0;
  let c2 = 0;
  for (const c of counts) {
    if (c >= 1) c1++;
    if (c >= 2) c2++;
  }
  const total = samples.length;
  return {
    step: st,
    samples,
    counts,
    total,
    pct1: total ? (100 * c1) / total : 0,
    pct2: total ? (100 * c2) / total : 0,
  };
}
