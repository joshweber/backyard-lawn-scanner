// Minimal ASCII DXF (AutoCAD R2000 / AC1015) writer. No DOM, so it can be tested in Node.
import { LAYERS, EDGE_LABEL_LAYER, HEAD_LAYERS } from './layers.js';
import { dist } from './geometry.js';

const UNITS = {
  m: { insunits: 6, factor: 1, decimals: 4 },
  mm: { insunits: 4, factor: 1000, decimals: 1 },
};

export function buildDxf(project, opts = {}) {
  const unit = UNITS[opts.units] ? opts.units : 'm';
  const { insunits, factor, decimals } = UNITS[unit];
  const labels = !!opts.edgeLabels;
  const num = (v) => (Math.abs(v) < 1e-12 ? 0 : v).toFixed(decimals + 2).replace(/\.?0+$/, '') || '0';
  const sc = (v) => num(v * factor);

  let handle = 0x100;
  const nextHandle = () => (handle++).toString(16).toUpperCase();

  const out = [];
  const add = (code, value) => out.push(String(code), String(value));

  // Which layers are used?
  const used = new Set();
  for (const s of project.shapes) if (LAYERS[s.layer] && s.points.length) used.add(s.layer);
  const layerNames = Object.keys(LAYERS).filter((n) => used.has(n));
  if (labels) layerNames.push(EDGE_LABEL_LAYER.name);
  const heads = Array.isArray(project.heads) ? project.heads : [];
  const headLabel = (h) => {
    const n = opts.nozzles && h.nozzleId ? opts.nozzles.get(h.nozzleId) : null;
    return `${n ? n.label : h.nozzleId || 'NO NOZZLE'} ${(+h.radius).toFixed(1)}m ${Math.round(h.sweep)}deg`;
  };
  if (heads.length) layerNames.push('SPRINKLER_HEADS', 'COVERAGE', 'HEAD_LABELS');
  const aciOf = (n) => {
    if (n === EDGE_LABEL_LAYER.name) return EDGE_LABEL_LAYER.aci;
    return HEAD_LAYERS[n] ? HEAD_LAYERS[n].aci : LAYERS[n].aci;
  };

  // HEADER
  add(0, 'SECTION');
  add(2, 'HEADER');
  add(9, '$ACADVER');
  add(1, 'AC1015');
  add(9, '$INSUNITS');
  add(70, insunits);
  add(9, '$MEASUREMENT');
  add(70, 1);
  add(9, '$HANDSEED');
  add(5, 'FFFFF');
  add(0, 'ENDSEC');

  // TABLES
  add(0, 'SECTION');
  add(2, 'TABLES');

  add(0, 'TABLE');
  add(2, 'LTYPE');
  add(5, nextHandle());
  add(100, 'AcDbSymbolTable');
  add(70, 1);
  add(0, 'LTYPE');
  add(5, nextHandle());
  add(100, 'AcDbSymbolTableRecord');
  add(100, 'AcDbLinetypeTableRecord');
  add(2, 'CONTINUOUS');
  add(70, 0);
  add(3, 'Solid line');
  add(72, 65);
  add(73, 0);
  add(40, 0);
  add(0, 'ENDTAB');

  add(0, 'TABLE');
  add(2, 'LAYER');
  add(5, nextHandle());
  add(100, 'AcDbSymbolTable');
  add(70, layerNames.length + 1);
  for (const name of ['0', ...layerNames]) {
    add(0, 'LAYER');
    add(5, nextHandle());
    add(100, 'AcDbSymbolTableRecord');
    add(100, 'AcDbLayerTableRecord');
    add(2, name);
    add(70, 0);
    add(62, name === '0' ? 7 : aciOf(name));
    add(6, 'CONTINUOUS');
  }
  add(0, 'ENDTAB');

  add(0, 'TABLE');
  add(2, 'STYLE');
  add(5, nextHandle());
  add(100, 'AcDbSymbolTable');
  add(70, 1);
  add(0, 'STYLE');
  add(5, nextHandle());
  add(100, 'AcDbSymbolTableRecord');
  add(100, 'AcDbTextStyleTableRecord');
  add(2, 'STANDARD');
  add(70, 0);
  add(40, 0);
  add(41, 1);
  add(50, 0);
  add(71, 0);
  add(42, 0.2);
  add(3, 'txt');
  add(4, '');
  add(0, 'ENDTAB');

  add(0, 'ENDSEC');

  // ENTITIES
  add(0, 'SECTION');
  add(2, 'ENTITIES');

  const header = (type, layer, sub) => {
    add(0, type);
    add(5, nextHandle());
    add(100, 'AcDbEntity');
    add(8, layer);
    add(100, sub);
  };

  const textAt = (layer, x, y, height, rot, str) => {
    header('TEXT', layer, 'AcDbText');
    add(10, sc(x));
    add(20, sc(y));
    add(30, 0);
    add(40, num(height * factor));
    add(1, str);
    add(50, num(rot));
    add(7, 'STANDARD');
    add(100, 'AcDbText');
  };

  for (const s of project.shapes) {
    const def = LAYERS[s.layer];
    if (!def || !s.points.length) continue;

    if (def.kind === 'polyline') {
      const pts = s.points;
      if (pts.length < 2) continue;
      const closed = !!s.closed && pts.length > 2;
      header('LWPOLYLINE', s.layer, 'AcDbPolyline');
      add(90, pts.length);
      add(70, closed ? 1 : 0);
      for (const p of pts) {
        add(10, sc(p.x));
        add(20, sc(p.y));
      }
      if (labels) {
        const n = closed ? pts.length : pts.length - 1;
        for (let i = 0; i < n; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          const len = dist(a, b);
          if (len < 0.3) continue; // skip tiny curve segments
          let rot = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
          if (rot > 90 || rot < -90) rot += 180;
          textAt(EDGE_LABEL_LAYER.name, (a.x + b.x) / 2, (a.y + b.y) / 2, 0.12, rot, (len * factor).toFixed(unit === 'mm' ? 0 : 2));
        }
      }
    } else if (def.kind === 'circle') {
      const c = s.points[0];
      if (!(s.r > 0)) continue;
      header('CIRCLE', s.layer, 'AcDbCircle');
      add(10, sc(c.x));
      add(20, sc(c.y));
      add(30, 0);
      add(40, sc(s.r));
    } else if (def.kind === 'point') {
      const c = s.points[0];
      header('POINT', s.layer, 'AcDbPoint');
      add(10, sc(c.x));
      add(20, sc(c.y));
      add(30, 0);
      // A visible ring around the point so it shows up clearly in CAD.
      header('CIRCLE', s.layer, 'AcDbCircle');
      add(10, sc(c.x));
      add(20, sc(c.y));
      add(30, 0);
      add(40, sc(0.1));
    }
  }

  for (const h of heads) {
    // head symbol: a point and a small ring
    header('POINT', 'SPRINKLER_HEADS', 'AcDbPoint');
    add(10, sc(h.x));
    add(20, sc(h.y));
    add(30, 0);
    header('CIRCLE', 'SPRINKLER_HEADS', 'AcDbCircle');
    add(10, sc(h.x));
    add(20, sc(h.y));
    add(30, 0);
    add(40, sc(0.08));

    // spray area: DXF arcs run anticlockwise from the start angle, the same as the plan view
    if (h.sweep >= 359.5) {
      header('CIRCLE', 'COVERAGE', 'AcDbCircle');
      add(10, sc(h.x));
      add(20, sc(h.y));
      add(30, 0);
      add(40, sc(h.radius));
    } else {
      const a0 = ((h.start % 360) + 360) % 360;
      const a1 = (a0 + h.sweep) % 360;
      header('ARC', 'COVERAGE', 'AcDbCircle');
      add(10, sc(h.x));
      add(20, sc(h.y));
      add(30, 0);
      add(40, sc(h.radius));
      add(100, 'AcDbArc');
      add(50, num(a0));
      add(51, num(a1));
      // close the sector with its two radii
      for (const a of [a0, a1]) {
        const r = (a * Math.PI) / 180;
        header('LINE', 'COVERAGE', 'AcDbLine');
        add(10, sc(h.x));
        add(20, sc(h.y));
        add(30, 0);
        add(11, sc(h.x + h.radius * Math.cos(r)));
        add(21, sc(h.y + h.radius * Math.sin(r)));
        add(31, 0);
      }
    }
    textAt('HEAD_LABELS', h.x + 0.15, h.y + 0.15, 0.12, 0, headLabel(h));
  }

  add(0, 'ENDSEC');
  add(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}
