// Sprinklers tab: connects the panel in index.html to the catalog, layout engine and plan view.
import { loadCatalog, baseModels, FAMILIES } from './catalog.js';
import { autoLayout, suggestArc, assignNozzle, arcFits } from './sprinkler-layout.js';
import { computeCoverage, lawnBoundary, holesFromProject } from './coverage.js';
import { buildParts, partsCsv, formatHours } from './parts.js';
import { normAngle } from './geometry.js';

const $ = (id) => document.getElementById(id);
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * ctx: { view, getProject(), changed(), download(name, text, type), stamp() }
 * Returns { setTab(name), refresh(), catalog() }.
 */
export function initSprinklers(ctx) {
  const { view } = ctx;
  let catalog = null;
  let dirtyLawn = false;
  const project = () => ctx.getProject();

  const msg = (text, warn = true) => {
    const el = $('sp-msg');
    el.textContent = text || '';
    el.style.display = text ? 'block' : 'none';
    el.style.background = warn ? '#3a2f12' : '#12303a';
    el.style.color = warn ? '#ffd98a' : '#9fe3ff';
  };

  const headById = (id) => (project().heads || []).find((h) => h.id === id);
  const family = () => $('sp-family').value;
  const base = () => $('sp-base').value;

  // ---------- selects ----------
  function fillFamilies() {
    const sel = $('sp-family');
    sel.innerHTML = '';
    for (const f of FAMILIES) sel.add(new Option(f.label, f.id));
    sel.value = (project().sprinkler && project().sprinkler.family) || 'mp-standard';
  }

  function fillBases() {
    const sel = $('sp-base');
    sel.innerHTML = '';
    sel.add(new Option('Auto (best fit)', 'auto'));
    for (const m of baseModels(catalog.nozzles, family())) {
      sel.add(new Option(`${m.base} (${m.minR}-${m.maxR} m)${m.auto ? '' : ' - hand only'}`, m.base));
    }
    const saved = project().sprinkler && project().sprinkler.base;
    sel.value = [...sel.options].some((o) => o.value === saved) ? saved : 'auto';
  }

  function saveSettings() {
    project().sprinkler = { family: family(), base: base(), spacing: +$('sp-spacing').value };
    ctx.changed(false);
  }

  // ---------- coverage, stats, parts ----------
  function recompute() {
    const p = project();
    const b = lawnBoundary(p);
    if (!catalog) return;
    let cov = null;
    if (b && (p.heads || []).length) cov = computeCoverage(p.heads, b, holesFromProject(p), 0.25);
    view.coverage = $('sp-cov').checked ? cov : null;
    const n = (p.heads || []).length;
    $('sp-stats').textContent = !b
      ? 'Scan a closed lawn outline first (Outline tab).'
      : n
        ? `${n} head${n > 1 ? 's' : ''} | covered ${cov.pct1.toFixed(0)}% | double-covered ${cov.pct2.toFixed(0)}%`
        : 'No heads yet. Press Auto layout or Add head.';
    renderParts();
    view.draw();
  }

  function renderParts() {
    const box = $('sp-parts');
    box.innerHTML = '';
    const heads = project().heads || [];
    if (!heads.length) return;
    const depth = Math.max(1, +$('sp-depth').value || 25);
    const parts = buildParts(heads, catalog.byId, depth);
    for (const r of parts.rows) {
      const d = document.createElement('div');
      d.className = 'part';
      const radius = r.minRadius === r.maxRadius ? `${round1(r.minRadius)} m` : `${round1(r.minRadius)}-${round1(r.maxRadius)} m`;
      d.textContent = `${r.count} x ${r.label}${r.color ? ` (${r.color})` : ''} | radius ${radius}` +
        (r.rate ? ` | ${r.rate} mm/hr | ${depth} mm/week = ${formatHours(r.hours)}` : '');
      box.appendChild(d);
    }
    if (parts.unmatched) {
      const d = document.createElement('div');
      d.className = 'part warn';
      d.textContent = `${parts.unmatched} x no matching nozzle (shown red on the plan)`;
      box.appendChild(d);
    }
    for (const w of parts.warnings) {
      const d = document.createElement('div');
      d.className = 'warn';
      d.textContent = w;
      box.appendChild(d);
    }
    box.appendChild(Object.assign(document.createElement('div'), {
      className: 'summary',
      textContent: 'Starting layout only. Check spacing and pressure against the Hunter spray charts.',
    }));
  }

  // ---------- selected head editor ----------
  function fillNozzleSelect(h) {
    const sel = $('sp-nozzle');
    sel.innerHTML = '';
    const all = catalog.nozzles.filter((n) => n.family === family() && n.placeable);
    const fits = all.filter((n) => arcFits(n, h.sweep));
    for (const n of fits) sel.add(new Option(`${n.label} (${n.minR}-${n.maxR} m)${n.color ? ' ' + n.color : ''}`, n.id));
    if (h.nozzleId && !fits.some((n) => n.id === h.nozzleId)) {
      const cur = catalog.byId.get(h.nozzleId);
      if (cur) sel.add(new Option(`${cur.label} (arc does not fit)`, cur.id));
    }
    if (!fits.length && !h.nozzleId) sel.add(new Option('No nozzle fits this arc', ''));
    sel.value = h.nozzleId || '';
  }

  function showEditor() {
    const h = headById(view.selectedHead);
    $('sp-edit').style.display = h ? 'flex' : 'none';
    if (!h) return;
    const idx = project().heads.indexOf(h) + 1;
    $('sp-edit-title').textContent = `Head ${idx}`;
    fillNozzleSelect(h);
    $('sp-radius').value = h.radius;
    $('sp-sweep').value = Math.round(h.sweep);
    $('sp-start').value = Math.round(normAngle(h.start));
    const n = h.nozzleId ? catalog.byId.get(h.nozzleId) : null;
    $('sp-edit-note').textContent = !n
      ? h.warn || 'No nozzle selected'
      : `${n.minR}-${n.maxR} m, ${n.minArc === n.maxArc ? n.minArc + ' deg' : n.minArc + '-' + n.maxArc + ' deg'}${h.warn ? ' | ' + h.warn : ''}`;
  }

  // Re-match a head after its radius or arc changed. Keeps the chosen nozzle if it still fits.
  function rematch(h) {
    const n = h.nozzleId ? catalog.byId.get(h.nozzleId) : null;
    if (n && arcFits(n, h.sweep)) {
      h.warn = h.radius < n.minR - 1e-9 ? `Radius is below this nozzle's minimum (${n.minR} m)`
        : h.radius > n.maxR + 1e-9 ? `Radius is above this nozzle's maximum (${n.maxR} m)` : '';
      return;
    }
    assignNozzle(h, catalog, family(), base());
  }

  function edited(h, redraw = true) {
    rematch(h);
    h.auto = false;
    ctx.changed(false);
    showEditor();
    recompute();
    if (redraw) view.draw();
  }

  function bindEditor() {
    const num = (id, fn) =>
      $(id).addEventListener('change', () => {
        const h = headById(view.selectedHead);
        const v = parseFloat($(id).value);
        if (!h || !isFinite(v)) return showEditor();
        fn(h, v);
        edited(h);
      });
    num('sp-radius', (h, v) => { h.radius = round2(Math.max(0.5, Math.min(30, v))); });
    num('sp-sweep', (h, v) => { h.sweep = Math.max(5, Math.min(360, v)); });
    num('sp-start', (h, v) => { h.start = normAngle(v); });

    $('sp-nozzle').addEventListener('change', () => {
      const h = headById(view.selectedHead);
      const n = catalog.byId.get($('sp-nozzle').value);
      if (!h || !n) return;
      h.nozzleId = n.id;
      h.radius = round2(Math.max(n.minR, Math.min(n.maxR, h.radius)));
      if (n.minArc === n.maxArc && n.maxArc < 360) h.sweep = n.maxArc;
      edited(h);
    });
    $('sp-rot-l').onclick = () => rotate(15);
    $('sp-rot-r').onclick = () => rotate(-15);
    function rotate(d) {
      const h = headById(view.selectedHead);
      if (!h) return;
      h.start = normAngle(h.start + d);
      edited(h);
    }
    $('sp-snap').onclick = () => {
      const h = headById(view.selectedHead);
      const b = lawnBoundary(project());
      if (!h || !b) return msg('Scan a closed lawn outline first.');
      const s = suggestArc(b, h, 1.5);
      if (!s.snapped) return msg('That head is more than 1.5 m from the lawn edge.');
      h.x = s.x; h.y = s.y; h.start = s.start; h.sweep = s.sweep;
      edited(h);
    };
    $('sp-del').onclick = () => {
      const p = project();
      p.heads = p.heads.filter((x) => x.id !== view.selectedHead);
      view.setSelectedHead(null);
      ctx.changed(false);
      recompute();
    };
  }

  // ---------- auto layout / add head ----------
  function newHead(fields) {
    const p = project();
    const h = { id: p.nextHeadId++, nozzleId: null, warn: '', auto: false, ...fields };
    p.heads.push(h);
    return h;
  }

  function runAuto() {
    const p = project();
    const b = lawnBoundary(p);
    if (!b) return msg('Scan a closed lawn outline first (Outline tab).');
    const manual = (p.heads || []).filter((h) => !h.auto);
    if (manual.length && !confirm(`Replace the automatic heads? Your ${manual.length} hand-placed or edited head${manual.length > 1 ? 's' : ''} will be kept.`)) return;
    const res = autoLayout(b, holesFromProject(p), catalog, {
      family: family(),
      base: base(),
      spacingFactor: +$('sp-spacing').value / 100,
    });
    if (res.error) return msg(res.error);
    p.heads = (p.heads || []).filter((h) => !h.auto);
    for (const h of res.heads) newHead(h);
    view.setSelectedHead(null);
    saveSettings();
    const picked = res.base;
    const warn = res.heads.filter((h) => h.warn).length;
    msg(
      `Used ${picked} at ${Math.round(res.spacing * 10) / 10} m spacing: ${res.heads.length} heads, ${res.pct1.toFixed(0)}% covered.` +
        (warn ? ` ${warn} head${warn > 1 ? 's need' : ' needs'} a look (orange or red dots).` : '') +
        (res.applied > 4 ? ' Much of the spray lands outside the lawn: try another range.' : ''),
      warn > 0 || res.applied > 4
    );
    recompute();
  }

  function onAddHead(w) {
    const p = project();
    const b = lawnBoundary(p);
    const s = b ? suggestArc(b, w) : { x: w.x, y: w.y, start: 0, sweep: 360, snapped: false };
    // default radius: the middle of the chosen model's range, or the best guess for Auto
    const list = catalog.nozzles.filter((n) => n.family === family() && n.placeable && (base() === 'auto' ? n.auto : n.base === base()));
    const fit = list.filter((n) => arcFits(n, s.sweep));
    const pick = (fit.length ? fit : list).slice().sort((a, c) => (a.maxR - a.minR) - (c.maxR - c.minR) || a.minR - c.minR)[0];
    const radius = pick ? round2((pick.minR + pick.maxR) / 2) : 4;
    const h = newHead({ x: round2(s.x), y: round2(s.y), radius, start: s.start, sweep: s.sweep, role: 'manual' });
    assignNozzle(h, catalog, family(), base());
    view.mode = 'edit';
    $('sp-add').classList.remove('active');
    ctx.changed(false);
    view.setSelectedHead(h.id);
    recompute();
    msg(s.snapped ? 'Head snapped to the lawn edge. Adjust its radius or arc below.' : 'Head placed. Use Snap to lawn edge to set its arc from the nearest edge.', false);
  }

  // ---------- tab handling ----------
  function setTab(name) {
    const on = name === 'sprinklers';
    view.setTab(name);
    $('sprinkler-panel').style.display = on ? 'flex' : 'none';
    $('panel').style.display = on ? 'none' : 'flex';
    $('tab-outline').classList.toggle('active', !on);
    $('tab-sprinklers').classList.toggle('active', on);
    $('toolbar').style.display = on ? 'none' : 'flex';
    $('sp-add').classList.remove('active');
    if (on && catalog) recompute();
    view.resize();
  }

  function refresh() {
    if (catalog && view.tab === 'sprinklers') recompute();
  }

  // ---------- wiring ----------
  $('sp-family').addEventListener('change', () => { fillBases(); saveSettings(); });
  $('sp-base').addEventListener('change', saveSettings);
  $('sp-spacing').addEventListener('input', () => { $('sp-spacing-val').textContent = $('sp-spacing').value + '%'; });
  $('sp-spacing').addEventListener('change', saveSettings);
  $('sp-auto').onclick = runAuto;
  $('sp-add').onclick = () => {
    if (view.mode === 'addhead') {
      view.mode = 'edit';
      $('sp-add').classList.remove('active');
    } else {
      view.mode = 'addhead';
      $('sp-add').classList.add('active');
    }
    view.draw();
  };
  $('sp-cov').addEventListener('change', recompute);
  $('sp-depth').addEventListener('input', renderParts);
  $('sp-csv').onclick = () => {
    const heads = project().heads || [];
    if (!heads.length) return msg('No heads yet.');
    const depth = Math.max(1, +$('sp-depth').value || 25);
    ctx.download(`sprinkler-parts-${ctx.stamp()}.csv`, partsCsv(buildParts(heads, catalog.byId, depth), depth), 'text/csv');
  };
  bindEditor();

  view.hooks.onSelectHead = () => showEditor();
  view.hooks.onHeadMoved = (id) => {
    const h = headById(id);
    if (h) { h.auto = false; }
    ctx.changed(false);
    showEditor();
    recompute();
  };
  view.hooks.onAddHead = onAddHead;

  $('tab-outline').onclick = () => setTab('outline');
  $('tab-sprinklers').onclick = () => setTab('sprinklers');
  $('sp-add').disabled = true;
  $('sp-auto').disabled = true;
  $('sp-spacing-val').textContent = $('sp-spacing').value + '%';

  loadCatalog().then((c) => {
    catalog = c;
    fillFamilies();
    fillBases();
    const sp = project().sprinkler;
    if (sp && sp.spacing) { $('sp-spacing').value = sp.spacing; $('sp-spacing-val').textContent = sp.spacing + '%'; }
    $('sp-add').disabled = false;
    $('sp-auto').disabled = false;
    if (view.tab === 'sprinklers') recompute();
  }).catch((e) => {
    console.error(e);
    msg('Could not load the sprinkler catalog: ' + e.message);
  });


  return { setTab, refresh, catalog: () => catalog };
}
