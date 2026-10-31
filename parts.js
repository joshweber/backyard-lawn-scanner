// Parts list and watering summary for the sprinkler heads (no DOM, testable in Node).

const num1 = (v) => (Math.round(v * 10) / 10).toString();

// Hours per week needed to put down depthMm at a precipitation rate (mm/hr). null if unknown.
export function runTimeHours(depthMm, rate) {
  return rate > 0 && depthMm > 0 ? depthMm / rate : null;
}

export function formatHours(h) {
  if (h == null) return 'n/a';
  const mins = Math.round(h * 60);
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  return hh ? `${hh} h ${mm} min` : `${mm} min`;
}

/**
 * heads: [{ nozzleId, radius, sweep, warn }]; byId: Map of nozzle id -> nozzle (from the catalog).
 * Returns { rows, total, unmatched, warnings }.
 */
export function buildParts(heads, byId, depthMm = 25) {
  const rows = new Map();
  let unmatched = 0;
  for (const h of heads) {
    const n = h.nozzleId ? byId.get(h.nozzleId) : null;
    if (!n) { unmatched++; continue; }
    let r = rows.get(n.id);
    if (!r) {
      r = {
        id: n.id, label: n.label, color: n.color, family: n.family, count: 0, rate: n.rate,
        pressureBar: n.pressureBar, note: n.note, minRadius: Infinity, maxRadius: 0, hours: runTimeHours(depthMm, n.rate),
      };
      rows.set(n.id, r);
    }
    r.count++;
    r.minRadius = Math.min(r.minRadius, h.radius);
    r.maxRadius = Math.max(r.maxRadius, h.radius);
  }
  const list = [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));

  const warnings = [];
  if (unmatched) warnings.push(`${unmatched} head${unmatched > 1 ? 's have' : ' has'} no matching nozzle. Change its arc or radius, or pick a model by hand.`);
  const families = new Set(list.map((r) => r.family));
  if ([...families].some((f) => f.startsWith('mp'))) {
    warnings.push('MP Rotator nozzles screw onto a pop-up spray body, which is not in the catalog data. Order spray bodies separately.');
  }
  if (families.size > 1) warnings.push('Heads from different ranges are on this plan. Put each range on its own zone.');
  const rates = new Set(list.map((r) => r.rate).filter((v) => v != null));
  if (rates.size > 1) warnings.push('The nozzles have different precipitation rates. Put each rate on its own zone so the lawn is watered evenly.');
  const pgpArcs = new Set();
  for (const h of heads) {
    const n = h.nozzleId ? byId.get(h.nozzleId) : null;
    if (n && n.family === 'pgp' && n.minArc !== n.maxArc) pgpArcs.add(Math.round(h.sweep));
  }
  if (pgpArcs.size > 1) {
    warnings.push('PGP rotors with different arcs (e.g. 90, 180, 360) apply water at different rates unless you use the matched-precipitation (MPR) nozzles. Expect uneven watering.');
  }
  return { rows: list, total: heads.length, unmatched, warnings };
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export function partsCsv(parts, depthMm) {
  const lines = [['Model', 'Colour', 'Quantity', 'Radius used (m)', 'Precipitation rate (mm/hr)', `Run time for ${depthMm} mm/week`, 'Notes'].map(csvCell).join(',')];
  for (const r of parts.rows) {
    const radius = r.minRadius === r.maxRadius ? num1(r.minRadius) : `${num1(r.minRadius)}-${num1(r.maxRadius)}`;
    lines.push([r.label, r.color, r.count, radius, r.rate, formatHours(r.hours), r.note].map(csvCell).join(','));
  }
  if (parts.unmatched) lines.push(['No matching nozzle', '', parts.unmatched, '', '', '', ''].map(csvCell).join(','));
  for (const w of parts.warnings) lines.push(['NOTE', w].map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}
