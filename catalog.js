// Sprinkler catalog: converts the two Hunter JSON files in /catalog into one flat nozzle list.
// No DOM access except in loadCatalog(), so buildNozzles() can be tested in Node.
//
// Nozzle: { id, base, label, family, series, minR, maxR, minArc, maxArc, rate, pressureBar,
//           color, placeable, auto, note }
//  - base: the model the user picks (e.g. "MP-2000", "Black Short-Radius"). A base has several
//    nozzles, e.g. one per arc range.
//  - rate: nominal precipitation rate in mm/hr (null when the catalog gives none).
//  - placeable: false for strip nozzles, which spray a rectangle and not an arc.
//  - auto: false means Auto layout never picks it, but you can still use it by hand.

export const FAMILIES = [
  { id: 'mp-standard', label: 'Hunter MP Rotator (Standard)' },
  { id: 'mp800', label: 'Hunter MP Rotator MP800' },
  { id: 'pgp', label: 'Hunter PGP Ultra' },
];

// "90-210" -> [90, 210]; "360" -> [360, 360]; anything else -> null.
export function parseArc(text) {
  const s = String(text).trim();
  const range = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(s);
  if (range) return [parseFloat(range[1]), parseFloat(range[2])];
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const v = parseFloat(s);
    return [v, v];
  }
  return null;
}

function mpFamily(seriesName) {
  return /MP800/i.test(seriesName) ? 'mp800' : 'mp-standard';
}

function pgpColour(rackName) {
  const m = /^(Dark Green|Blue|Grey|Black)\b/.exec(rackName);
  return m ? m[1] : null;
}

export function buildNozzles(mp, pgp) {
  const out = [];
  const mpBar = mp.recommended_operating_pressure ? mp.recommended_operating_pressure.bar : null;

  for (const series of mp.series) {
    for (const model of series.models) {
      for (const v of model.variants) {
        const arc = parseArc(v.arc);
        const hasRadius = Array.isArray(model.radius_range_m);
        const placeable = hasRadius && arc !== null;
        out.push({
          id: v.model_number,
          base: model.base_model,
          label: v.model_number,
          family: mpFamily(series.series_name),
          series: series.series_name,
          minR: hasRadius ? model.radius_range_m[0] : null,
          maxR: hasRadius ? model.radius_range_m[1] : null,
          minArc: arc ? arc[0] : null,
          maxArc: arc ? arc[1] : null,
          rate: series.precipitation_rate_mm_hr == null ? null : series.precipitation_rate_mm_hr,
          pressureBar: mpBar == null ? null : [mpBar, mpBar],
          color: v.color || null,
          placeable,
          auto: placeable && model.base_model !== 'MP Corner',
          note: placeable ? '' : 'Strip nozzle: sprays a rectangle, not placed automatically',
        });
      }
    }
  }

  const general = pgp.general_specifications || {};
  const std = pgp.series && pgp.series[0];
  const pgpBar = std && std.pressure_specifications ? std.pressure_specifications.recommended_range_bar : null;
  const pgpRate = general.precipitation_rate_mm_hr == null ? null : general.precipitation_rate_mm_hr;

  for (const rack of pgp.nozzle_racks) {
    const common = {
      base: rack.rack_name,
      family: 'pgp',
      series: 'PGP Ultra',
      minR: rack.radius_range_m[0],
      maxR: rack.radius_range_m[1],
      rate: pgpRate,
      pressureBar: pgpBar,
      placeable: true,
      auto: true,
    };
    if (/Matched Precipitation/i.test(rack.description || '')) {
      const colour = /\(([^)]+)\)\s*$/.exec(rack.description);
      for (const nozzle of rack.nozzles) {
        const m = /^(\w+)\s*\((\d+)\)$/.exec(nozzle);
        if (!m) continue;
        const arc = parseFloat(m[2]);
        out.push({
          ...common,
          id: `PGP-${rack.rack_name}-${m[1]}`,
          label: `PGP ${rack.rack_name} ${nozzle}`,
          minArc: arc,
          maxArc: arc,
          color: colour ? colour[1] : null,
          note: 'Matched precipitation nozzle (fixed arc)',
        });
      }
    } else {
      out.push({
        ...common,
        id: `PGP-${rack.rack_name}`,
        label: `PGP Ultra ${rack.rack_name}`,
        minArc: 50,
        maxArc: 360,
        color: pgpColour(rack.rack_name),
        note: `Nozzle sizes: ${rack.nozzles.join(', ')}`,
      });
    }
  }
  return out;
}

export function makeCatalog(mp, pgp) {
  const nozzles = buildNozzles(mp, pgp);
  return { nozzles, byId: new Map(nozzles.map((n) => [n.id, n])), families: FAMILIES };
}

// Models (bases) available in a family, for the model drop-down.
export function baseModels(nozzles, family) {
  const seen = new Map();
  for (const n of nozzles) {
    if (n.family !== family || !n.placeable) continue;
    if (!seen.has(n.base)) seen.set(n.base, { base: n.base, minR: n.minR, maxR: n.maxR, auto: n.auto });
    else {
      const b = seen.get(n.base);
      b.minR = Math.min(b.minR, n.minR);
      b.maxR = Math.max(b.maxR, n.maxR);
    }
  }
  return [...seen.values()];
}

export async function loadCatalog(baseUrl = 'catalog/') {
  const [mp, pgp] = await Promise.all(
    ['mp-rotator.json', 'pgp-ultra.json'].map(async (f) => {
      const r = await fetch(baseUrl + f);
      if (!r.ok) throw new Error(`Could not load ${f} (${r.status})`);
      return r.json();
    })
  );
  return makeCatalog(mp, pgp);
}
