// Run with: node tests/sprinkler-tests.mjs  (also run by `npm test`)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArc, makeCatalog, baseModels } from '../catalog.js';
import {
  autoLayout, cleanBoundary, vertexInfo, findCorners, chooseNozzle, arcFits, suggestArc, assignNozzle,
} from '../sprinkler-layout.js';
import { covers, computeCoverage, lawnBoundary, holesFromProject } from '../coverage.js';
import { buildParts, partsCsv, runTimeHours, formatHours } from '../parts.js';
import { buildDxf } from '../dxf-writer.js';
import { signedArea } from '../geometry.js';
import { parseProject, newProject } from '../storage.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok -', name); };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} !~ ${b}`);

const rd = (f) => JSON.parse(readFileSync(new URL('../catalog/' + f, import.meta.url), 'utf8'));
const cat = makeCatalog(rd('mp-rotator.json'), rd('pgp-ultra.json'));
const get = (id) => cat.byId.get(id);

const rect = [{ x: 0, y: 0 }, { x: 11, y: 0 }, { x: 11, y: 6 }, { x: 0, y: 6 }];
const lShape = [{ x: 0, y: 0 }, { x: 11, y: 0 }, { x: 11, y: 3 }, { x: 5, y: 3 }, { x: 5, y: 8 }, { x: 0, y: 8 }];

// ---------- catalog ----------
test('parseArc', () => {
  assert.deepEqual(parseArc('90-210'), [90, 210]);
  assert.deepEqual(parseArc('360'), [360, 360]);
  assert.deepEqual(parseArc('45-105'), [45, 105]);
  assert.equal(parseArc('Left Corner Strip'), null);
});

test('catalog: MP Rotator models', () => {
  const n = get('MP-2000-90');
  assert.equal(n.family, 'mp-standard');
  assert.deepEqual([n.minR, n.maxR, n.minArc, n.maxArc, n.rate, n.color], [4.0, 6.4, 90, 210, 10, 'Black']);
  const full = get('MP-2000-360');
  assert.deepEqual([full.minArc, full.maxArc], [360, 360]);
  assert.equal(get('MP-815-90').family, 'mp800');
  assert.equal(get('MP-815-90').rate, 20);
  const corner = get('MP-CORNER');
  assert.deepEqual([corner.minArc, corner.maxArc, corner.auto], [45, 105, false]);
});

test('catalog: strip nozzles are not placeable', () => {
  for (const id of ['MP-LCS-515', 'MP-RCS-515', 'MP-SS-530']) {
    assert.equal(get(id).placeable, false, id);
    assert.equal(get(id).minR, null);
  }
});

test('catalog: PGP racks', () => {
  const blue = get('PGP-Blue Standard');
  assert.deepEqual([blue.family, blue.minR, blue.maxR, blue.minArc, blue.maxArc], ['pgp', 8.8, 14.0, 50, 360]);
  const q = get('PGP-MPR-25-Q');
  assert.deepEqual([q.minArc, q.maxArc, q.minR, q.maxR], [90, 90, 7.0, 7.6]);
  assert.equal(get('PGP-MPR-25-F').minArc, 360);
  assert.equal(get('PGP-MPR-25-T').minArc, 120);
  assert.equal(get('PGP-Black Short-Radius').maxR, 7.6);
});

test('catalog: ids are unique and baseModels groups variants', () => {
  assert.equal(new Set(cat.nozzles.map((n) => n.id)).size, cat.nozzles.length);
  const mp = baseModels(cat.nozzles, 'mp-standard').map((m) => m.base);
  assert.deepEqual(mp.sort(), ['MP Corner', 'MP-1000', 'MP-2000', 'MP-3000', 'MP-3500']);
});

// ---------- geometry used by the layout ----------
test('cleanBoundary makes anticlockwise and drops duplicate closing point', () => {
  const cw = [...rect].reverse().concat([rect[3]]);
  const b = cleanBoundary(cw);
  assert.equal(b.length, 4);
  assert.ok(signedArea(b) > 0);
});

test('vertexInfo: convex and concave corners', () => {
  const b = cleanBoundary(lShape);
  const i0 = b.findIndex((p) => p.x === 0 && p.y === 0);
  const v0 = vertexInfo(b, i0);
  near(v0.sweep, 90);
  near(v0.start, 0);
  const i3 = b.findIndex((p) => p.x === 5 && p.y === 3);
  const v3 = vertexInfo(b, i3);
  near(v3.sweep, 270);
  assert.ok(v3.turn < 0);
});

test('findCorners ignores gentle curves', () => {
  const pts = [];
  for (let i = 0; i <= 20; i++) pts.push({ x: 5 * Math.cos((Math.PI * i) / 20), y: 5 * Math.sin((Math.PI * i) / 20) });
  const closed = cleanBoundary(pts);
  const corners = findCorners(closed, 1);
  assert.equal(corners.length, 2); // only the two sharp ends of the half disc
});

// ---------- nozzle choice ----------
test('arcFits tolerance', () => {
  assert.ok(arcFits(get('MP-2000-90'), 90));
  assert.ok(arcFits(get('MP-2000-90'), 180));
  assert.ok(!arcFits(get('MP-2000-90'), 270));
  assert.ok(arcFits(get('MP-2000-210'), 270));
  assert.ok(arcFits(get('PGP-MPR-25-H'), 178));
  assert.ok(!arcFits(get('PGP-MPR-25-Q'), 120));
});

test('chooseNozzle: 90 deg at 6 m -> MP-2000-90; 270 deg -> a 210-270 variant; none for odd arcs', () => {
  const list = cat.nozzles.filter((n) => n.family === 'mp-standard' && n.auto);
  assert.equal(chooseNozzle(list, 6, 90).nozzle.id, 'MP-2000-90');
  assert.equal(chooseNozzle(list, 6, 180).nozzle.id, 'MP-2000-90');
  assert.match(chooseNozzle(list, 6, 270).nozzle.id, /-210$/);
  const r = chooseNozzle(list, 2, 90);
  assert.equal(r.raised, true);
  assert.equal(r.nozzle.id, 'MP-1000-90');
  assert.equal(r.radius, 2.5);
  assert.equal(chooseNozzle(list, 6, 30), null);
});

// ---------- layout ----------
test('layout 11x6 with MP Rotator Standard: 6 heads, MP-2000, 4 corners at 90 and 2 sides at 180', () => {
  const res = autoLayout(rect, [], cat, { family: 'mp-standard' });
  assert.equal(res.error, undefined);
  assert.equal(res.base, 'MP-2000');
  assert.equal(res.heads.length, 6);
  assert.equal(res.heads.filter((h) => h.sweep === 90).length, 4);
  assert.equal(res.heads.filter((h) => h.sweep === 180).length, 2);
  for (const h of res.heads) {
    assert.equal(h.nozzleId, 'MP-2000-90');
    assert.ok(h.radius >= 4 && h.radius <= 6.4, `radius ${h.radius}`);
    assert.equal(h.warn, '');
  }
  assert.ok(res.pct1 >= 99, 'coverage ' + res.pct1);
  assert.ok(res.pct2 > 30, 'overlap ' + res.pct2);
});

test('layout is the same for a clockwise outline', () => {
  const a = autoLayout(rect, [], cat, { family: 'mp-standard' });
  const b = autoLayout([...rect].reverse(), [], cat, { family: 'mp-standard' });
  assert.equal(a.heads.length, b.heads.length);
  assert.equal(a.base, b.base);
});

test('layout of an L-shaped lawn has a 270 degree head at the inside corner and full coverage', () => {
  const res = autoLayout(lShape, [], cat, { family: 'mp-standard' });
  assert.equal(res.error, undefined);
  const inner = res.heads.find((h) => Math.abs(h.x - 5) < 0.05 && Math.abs(h.y - 3) < 0.05);
  assert.ok(inner, 'head at the inside corner');
  assert.equal(inner.sweep, 270);
  assert.match(inner.nozzleId, /-210$/);
  assert.ok(res.pct1 >= 98, 'coverage ' + res.pct1);
  assert.equal(res.heads.filter((h) => !h.nozzleId).length, 0);
});

test('layout works for the other ranges and fully covers the lawn', () => {
  for (const family of ['mp800', 'pgp']) {
    const res = autoLayout(rect, [], cat, { family });
    assert.equal(res.error, undefined, family);
    assert.ok(res.pct1 >= 98, `${family} coverage ${res.pct1}`);
    assert.ok(res.heads.every((h) => h.nozzleId), family + ' all matched');
    for (const h of res.heads) assert.equal(cat.byId.get(h.nozzleId).family, family);
  }
});

test('a fixed model is respected', () => {
  const res = autoLayout(rect, [], cat, { family: 'mp-standard', base: 'MP-1000' });
  assert.equal(res.base, 'MP-1000');
  assert.ok(res.heads.length > 6);
  assert.ok(res.pct1 >= 98);
});

test('an interior head is added when the lawn is wider than the edge heads reach', () => {
  const big = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
  const res = autoLayout(big, [], cat, { family: 'mp-standard', base: 'MP-3000' });
  assert.ok(res.heads.some((h) => h.role === 'interior'), 'has an interior head');
  assert.ok(res.pct1 >= 97, 'coverage ' + res.pct1);
});

test('heads are nudged out of a tree', () => {
  const tree = { type: 'circle', x: 5.5, y: 0.2, r: 0.6 };
  const res = autoLayout(rect, [tree], cat, { family: 'mp-standard' });
  for (const h of res.heads) assert.ok(Math.hypot(h.x - tree.x, h.y - tree.y) >= tree.r - 1e-6, `head at ${h.x},${h.y}`);
});

test('too few points gives an error', () => {
  assert.ok(autoLayout([{ x: 0, y: 0 }, { x: 1, y: 1 }], [], cat, { family: 'pgp' }).error);
});

// ---------- hand placement ----------
test('suggestArc: corner, edge, interior', () => {
  const corner = suggestArc(rect, { x: 0.2, y: 0.15 });
  assert.deepEqual([corner.x, corner.y, corner.sweep, corner.start], [0, 0, 90, 0]);
  const edge = suggestArc(rect, { x: 5, y: 0.3 });
  assert.equal(edge.sweep, 180);
  near(edge.y, 0);
  assert.equal(edge.start, 0);
  const mid = suggestArc(rect, { x: 5, y: 3 });
  assert.deepEqual([mid.sweep, mid.snapped], [360, false]);
});

test('assignNozzle for a hand-placed head', () => {
  const h = { x: 0, y: 0, radius: 5, start: 0, sweep: 90 };
  assignNozzle(h, cat, 'mp-standard', 'auto');
  assert.equal(h.nozzleId, 'MP-2000-90');
  const odd = { x: 0, y: 0, radius: 5, start: 0, sweep: 20 };
  assignNozzle(odd, cat, 'mp-standard', 'auto');
  assert.equal(odd.nozzleId, null);
  assert.equal(odd.warn, 'No matching nozzle');
});

// ---------- coverage ----------
test('covers: sector edges and wrap-around', () => {
  const h = { x: 0, y: 0, radius: 5, start: 350, sweep: 90 };
  // sector runs from 350 deg through 0 to 80 deg
  assert.ok(covers(h, 3, 0));
  assert.ok(covers(h, 1, 3)); // about 72 deg
  assert.ok(covers(h, 3, -0.4)); // about 352 deg: past the wrap-around
  assert.ok(!covers(h, 0, 3)); // 90 deg: just outside
  assert.ok(!covers(h, 3, -1)); // about 341 deg: just outside
  assert.ok(!covers(h, -3, 0));
  assert.ok(!covers(h, 6, 0));
  assert.ok(covers({ x: 0, y: 0, radius: 2, start: 0, sweep: 360 }, -1, -1));
});

test('computeCoverage: full / none, and holes are excluded', () => {
  const c = computeCoverage([{ x: 0, y: 0, radius: 20, start: 0, sweep: 90 }], rect, [], 0.25);
  near(c.pct1, 100, 1e-6);
  const withTree = computeCoverage([], rect, [{ type: 'circle', x: 5.5, y: 3, r: 1 }], 0.25);
  const without = computeCoverage([], rect, [], 0.25);
  assert.ok(withTree.total < without.total);
  assert.equal(without.pct1, 0);
});

test('project helpers: lawn boundary and holes', () => {
  const p = newProject();
  p.shapes.push({ id: 1, layer: 'LAWN_BOUNDARY', closed: true, points: rect });
  p.shapes.push({ id: 2, layer: 'TREES', points: [{ x: 3, y: 3 }], r: 0.5 });
  p.shapes.push({ id: 3, layer: 'OBSTACLES', closed: true, points: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }] });
  assert.equal(lawnBoundary(p).length, 4);
  assert.equal(holesFromProject(p).length, 2);
  assert.equal(lawnBoundary(newProject()), null);
});

// ---------- parts ----------
test('parts list counts, run times and warnings', () => {
  const res = autoLayout(rect, [], cat, { family: 'mp-standard' });
  const parts = buildParts(res.heads, cat.byId, 25);
  assert.equal(parts.rows.length, 1);
  assert.equal(parts.rows[0].id, 'MP-2000-90');
  assert.equal(parts.rows[0].count, 6);
  near(parts.rows[0].hours, 2.5);
  assert.equal(formatHours(2.5), '2 h 30 min');
  assert.equal(runTimeHours(25, null), null);
  assert.ok(parts.warnings.some((w) => /spray body/.test(w)));
  const csv = partsCsv(parts, 25);
  assert.ok(csv.includes('MP-2000-90,Black,6'));
  assert.ok(csv.startsWith('Model,Colour,Quantity'));
});

test('parts warnings: mixed PGP arcs, unmatched heads', () => {
  const heads = [
    { nozzleId: 'PGP-Blue Standard', radius: 10, sweep: 90 },
    { nozzleId: 'PGP-Blue Standard', radius: 10, sweep: 180 },
    { nozzleId: null, radius: 5, sweep: 20 },
  ];
  const parts = buildParts(heads, cat.byId, 25);
  assert.equal(parts.unmatched, 1);
  assert.ok(parts.warnings.some((w) => /no matching nozzle/.test(w)));
  assert.ok(parts.warnings.some((w) => /different arcs/.test(w)));
});

// ---------- DXF ----------
test('DXF includes sprinkler layers, arcs, circles and labels', () => {
  const res = autoLayout(rect, [], cat, { family: 'mp-standard' });
  const project = {
    shapes: [{ id: 1, layer: 'LAWN_BOUNDARY', closed: true, points: rect }],
    heads: res.heads.map((h, i) => ({ ...h, id: i + 1 })),
  };
  project.heads.push({ id: 99, x: 5, y: 3, radius: 4, start: 0, sweep: 360, nozzleId: 'MP-2000-360' });
  const dxf = buildDxf(project, { units: 'm', nozzles: cat.byId });
  const lines = dxf.split('\r\n');
  const count = (v) => lines.filter((l, k) => k % 2 === 1 && lines[k - 1] === '0' && l === v).length;
  for (const n of ['SPRINKLER_HEADS', 'COVERAGE', 'HEAD_LABELS']) assert.ok(dxf.includes('\r\n' + n + '\r\n'), n);
  assert.equal(count('ARC'), 6);
  assert.equal(count('LINE'), 12);
  assert.equal(count('CIRCLE'), 7 + 1); // 7 head rings + one full-circle coverage
  assert.equal(count('POINT'), 7);
  assert.equal(count('TEXT'), 7);
  assert.ok(dxf.includes('MP-2000-90 6.0m 90deg'));
  assert.ok(!dxf.includes('NaN'));
  assert.equal(count('SECTION'), 3);
  assert.equal(count('ENDSEC'), 3);
  assert.equal(lines[lines.length - 2], 'EOF');
  // arc angles: the corner head at (0,0) runs 0 -> 90
  const i = lines.findIndex((l, k) => l === 'AcDbArc' && lines[k - 1] === '100');
  assert.equal(lines[i + 2], '0');
  assert.equal(lines[i + 4], '90');
});

test('DXF without heads has no sprinkler layers', () => {
  const dxf = buildDxf({ shapes: [{ id: 1, layer: 'LAWN_BOUNDARY', closed: true, points: rect }], heads: [] }, { units: 'm' });
  assert.ok(!dxf.includes('SPRINKLER_HEADS'));
});

test('older projects without heads still load', () => {
  const p = parseProject(JSON.stringify({ shapes: [{ id: 1, layer: 'LAWN_BOUNDARY', closed: true, points: rect }] }));
  assert.deepEqual(p.heads, []);
  assert.equal(p.nextHeadId, 1);
  const q = parseProject(JSON.stringify({ shapes: [], heads: [{ id: 4 }] }));
  assert.equal(q.nextHeadId, 5);
});

console.log(`\n${passed} sprinkler tests passed`);
