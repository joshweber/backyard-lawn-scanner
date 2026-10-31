// Run with: node tests/run-tests.mjs
import assert from 'node:assert/strict';
import {
  dist, polylineLength, polygonArea, douglasPeucker, simplifyAutoRuns,
  closeLoop, bestFitScale, scaleShapes, centroidOf, parseLength,
  tiltFromStraightDown, tiltColour,
} from '../geometry.js';
import { buildDxf } from '../dxf-writer.js';
import { parseProject } from '../storage.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok -', name); };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} !~ ${b}`);

const rect = [{ x: 0, y: 0 }, { x: 11, y: 0 }, { x: 11, y: 6 }, { x: 0, y: 6 }];

test('length and area of 11x6 rectangle', () => {
  near(polylineLength(rect, true), 34);
  near(polygonArea(rect), 66);
});

test('douglas-peucker removes collinear points, keeps corners', () => {
  const pts = [];
  for (let i = 0; i <= 10; i++) pts.push({ x: i, y: 0 });
  for (let i = 1; i <= 5; i++) pts.push({ x: 10, y: i });
  const s = douglasPeucker(pts, 0.01);
  assert.equal(s.length, 3);
});

test('simplifyAutoRuns keeps manual corners and thins auto runs', () => {
  const pts = [{ x: 0, y: 0 }, { x: 11, y: 0 }];
  for (let i = 1; i < 10; i++) pts.push({ x: 11, y: i * 0.6, auto: true });
  pts.push({ x: 11, y: 6 });
  const s = simplifyAutoRuns(pts, 0.02);
  assert.equal(s.length, 3);
  assert.deepEqual(s[2], { x: 11, y: 6 });
});

test('closeLoop closes drift and reports error', () => {
  const drift = { x: 0.1, y: -0.2 };
  const walked = rect.map((p, i) => ({ ...p }));
  const { points, error } = closeLoop(walked, drift);
  near(error, Math.hypot(0.1, 0.2));
  // first point unchanged
  near(points[0].x, 0);
  near(points[0].y, 0);
  // gap g = first - end = (-0.1, 0.2); point i moves by g * cum_i / total
  const total = 28 + dist(rect[3], drift);
  near(points[3].x, 0 + (-0.1 * 28) / total);
  near(points[3].y, 6 + (0.2 * 28) / total);
});

test('bestFitScale single and multiple references', () => {
  near(bestFitScale([{ d: 10.8, m: 11 }]), 11 / 10.8);
  const s = bestFitScale([{ d: 10, m: 11 }, { d: 20, m: 21 }]);
  assert.ok(s > 1.05 && s < 1.1);
});

test('scaleShapes scales points and radius about a centre', () => {
  const shapes = [{ points: [{ x: 0, y: 0 }, { x: 2, y: 0 }], r: 1 }];
  scaleShapes(shapes, 2, { x: 0, y: 0 });
  near(shapes[0].points[1].x, 4);
  near(shapes[0].r, 2);
  const c = centroidOf(shapes);
  near(c.x, 2);
});

test('parseLength units', () => {
  near(parseLength('11.02'), 11.02);
  near(parseLength('11,02 m'), 11.02);
  near(parseLength('1102 cm'), 11.02);
  near(parseLength('11020mm'), 11.02);
  near(parseLength('36 ft'), 10.9728);
  assert.equal(parseLength('abc'), null);
  assert.equal(parseLength(''), null);
});

// Column-major pose matrix for a camera looking along the world vector `forward`.
// Only m[8], m[9], m[10] (the camera's +Z axis = -forward) matter for the tilt calculation.
function poseLooking(forward) {
  const m = new Array(16).fill(0);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  m[8] = -forward[0]; m[9] = -forward[1]; m[10] = -forward[2];
  return m;
}

test('tiltFromStraightDown', () => {
  near(tiltFromStraightDown(poseLooking([0, -1, 0])), 0); // straight down, phone flat
  near(tiltFromStraightDown(poseLooking([0, 0, -1])), 90); // at the horizon
  const a = (30 * Math.PI) / 180;
  near(tiltFromStraightDown(poseLooking([0, -Math.cos(a), -Math.sin(a)])), 30, 1e-6);
  near(tiltFromStraightDown(poseLooking([0, 1, 0])), 180); // straight up
});

test('tiltColour green -> orange -> red', () => {
  assert.equal(tiltColour(0), '#22c55e');
  assert.equal(tiltColour(10), '#22c55e');
  assert.equal(tiltColour(35), '#ff9800');
  assert.equal(tiltColour(60), '#e53935');
  assert.equal(tiltColour(90), '#e53935');
  // halfway between green and orange is neither
  const mid = tiltColour(25);
  assert.notEqual(mid, '#22c55e');
  assert.notEqual(mid, '#ff9800');
  assert.match(mid, /^#[0-9a-f]{6}$/);
});

const project = {
  shapes: [
    { id: 1, layer: 'LAWN_BOUNDARY', closed: true, points: rect },
    { id: 2, layer: 'TREES', points: [{ x: 3, y: 2 }], r: 0.5 },
    { id: 3, layer: 'WATER_SOURCE', points: [{ x: 0, y: 3 }] },
    { id: 4, layer: 'HARDSCAPE', closed: false, points: [{ x: 0, y: 6 }, { x: 11, y: 6 }] },
  ],
};

test('DXF structure, metres', () => {
  const dxf = buildDxf(project, { units: 'm', edgeLabels: true });
  const lines = dxf.split('\r\n');
  assert.equal(lines[lines.length - 2], 'EOF');
  assert.equal(lines.length % 2, 1); // code/value pairs + trailing empty
  assert.ok(dxf.includes('AC1015'));
  const i = lines.indexOf('$INSUNITS');
  assert.equal(lines[i + 2], '6');
  for (const n of ['LAWN_BOUNDARY', 'TREES', 'WATER_SOURCE', 'HARDSCAPE', 'EDGE_LENGTHS']) {
    assert.ok(dxf.includes('\r\n' + n + '\r\n'), n);
  }
  // sections balanced
  // entity / section names are the values of group code 0 (odd line indices)
  const count = (v) => lines.filter((l, k) => k % 2 === 1 && lines[k - 1] === '0' && l === v).length;
  assert.equal(count('SECTION'), 3); // HEADER, TABLES, ENTITIES
  assert.equal(count('SECTION'), count('ENDSEC'));
  assert.equal(count('TABLE'), count('ENDTAB'));
  assert.equal(count('LWPOLYLINE'), 2);
  assert.equal(count('CIRCLE'), 2); // tree + water ring
  assert.ok(count('TEXT') >= 4);
  assert.ok(dxf.includes('\r\n11\r\n'));
  assert.ok(dxf.includes('\r\n11\r\n') && !dxf.includes('NaN'));
});

test('DXF in mm scales coordinates', () => {
  const dxf = buildDxf(project, { units: 'mm' });
  const lines = dxf.split('\r\n');
  assert.equal(lines[lines.indexOf('$INSUNITS') + 2], '4');
  assert.ok(dxf.includes('\r\n11000\r\n'));
  assert.ok(!dxf.includes('EDGE_LENGTHS'));
});

test('parseProject validates', () => {
  assert.throws(() => parseProject('{"foo":1}'));
  const p = parseProject(JSON.stringify({ shapes: project.shapes }));
  assert.equal(p.nextId, 5);
});

console.log(`\n${passed} tests passed`);
