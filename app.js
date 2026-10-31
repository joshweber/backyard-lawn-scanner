import { PlanView } from './plan-view.js';
import { arSupported, startAR } from './ar.js';
import { buildDxf } from './dxf-writer.js';
import { LAYERS } from './layers.js';
import { loadProject, saveProject, newProject, parseProject } from './storage.js';
import {
  dist, polylineLength, polygonArea, bestFitScale, scaleShapes, centroidOf, parseLength,
} from './geometry.js';

const $ = (id) => document.getElementById(id);
let project = loadProject() || newProject();

const view = new PlanView($('plan'), {
  getProject: () => project,
  onChange: () => changed(),
  onPick: (a, b) => addReference(a, b),
  onSelect: () => updateButtons(),
});

function changed() {
  saveProject(project);
  renderRefs();
  updateStats();
  updateButtons();
  view.draw();
}

function notice(msg) {
  const n = $('notice');
  n.textContent = msg;
  n.style.display = msg ? 'block' : 'none';
}

function updateStats() {
  const lawn = project.shapes.filter((s) => s.layer === 'LAWN_BOUNDARY' && s.closed);
  if (!lawn.length) {
    $('stats').textContent = project.shapes.length ? `${project.shapes.length} shapes` : 'No scan yet';
    return;
  }
  const l = lawn[lawn.length - 1];
  let t = `Lawn: perimeter ${polylineLength(l.points, true).toFixed(2)} m, area ${polygonArea(l.points).toFixed(1)} m²`;
  if (typeof l.closureError === 'number') t += `, closure gap ${(l.closureError * 100).toFixed(1)} cm`;
  $('stats').textContent = t;
}

function updateButtons() {
  const sel = view.selected;
  $('btn-delete').disabled = !sel;
  $('btn-del-shape').disabled = !sel;
}

// ---------- tape references ----------
function refPts(r) {
  const sa = project.shapes.find((s) => s.id === r.a.id);
  const sb = project.shapes.find((s) => s.id === r.b.id);
  return sa && sb && sa.points[r.a.i] && sb.points[r.b.i] ? [sa.points[r.a.i], sb.points[r.b.i]] : null;
}

function pruneRefs() {
  project.refs = project.refs.filter((r) => refPts(r));
}

function addReference(a, b) {
  const pa = refPts({ a, b });
  if (!pa) return;
  const current = dist(pa[0], pa[1]);
  const text = prompt(`Those points are ${current.toFixed(3)} m apart in the scan.\nEnter the tape-measured distance (e.g. 11.02, 1102 cm, 36 ft):`);
  if (text === null) return;
  const m = parseLength(text);
  if (!m || m <= 0) return alert('Could not read that length.');
  project.refs.push({ a, b, m });
  applyBestFitScale();
  changed();
}

function applyBestFitScale() {
  pruneRefs();
  const pairs = project.refs.map((r) => {
    const [p, q] = refPts(r);
    return { d: dist(p, q), m: r.m };
  });
  const k = bestFitScale(pairs);
  scaleShapes(project.shapes, k, centroidOf(project.shapes));
}

function renderRefs() {
  pruneRefs();
  const box = $('refs');
  box.innerHTML = '';
  if (!project.refs.length) {
    box.innerHTML = '<div class="summary">Tape references: none. Use "Tape reference", tap two points, enter the measured distance.</div>';
    return;
  }
  project.refs.forEach((r, idx) => {
    const [p, q] = refPts(r);
    const d = dist(p, q);
    const err = (d - r.m) * 1000;
    const row = document.createElement('div');
    row.className = 'ref';
    row.innerHTML = `<span>#${idx + 1}: tape ${r.m.toFixed(3)} m | scan ${d.toFixed(3)} m | off ${err >= 0 ? '+' : ''}${err.toFixed(0)} mm</span>`;
    const del = document.createElement('button');
    del.textContent = 'Remove';
    del.onclick = () => { project.refs.splice(idx, 1); changed(); };
    row.appendChild(del);
    box.appendChild(row);
  });
  if (project.refs.length > 1) {
    const s = document.createElement('div');
    s.className = 'summary';
    s.textContent = 'With several references the scale is a best fit. A large "off" value on one suggests a bad measurement or a skewed scan.';
    box.appendChild(s);
  }
}

// ---------- editing ----------
$('btn-fit').onclick = () => view.fit();

$('btn-tape').onclick = () => {
  if (view.mode === 'pick') {
    view.cancelPick();
    $('btn-tape').classList.remove('active');
    return;
  }
  if (project.shapes.reduce((n, s) => n + s.points.length, 0) < 2) return alert('Scan something first.');
  view.startPick();
  $('btn-tape').classList.add('active');
};

// pick finishes by itself, so un-highlight the button when the mode returns to edit
const origPick = view.hooks.onPick;
view.hooks.onPick = (a, b) => {
  $('btn-tape').classList.remove('active');
  origPick(a, b);
};

$('btn-delete').onclick = () => {
  const sel = view.selected;
  if (!sel) return;
  const s = project.shapes.find((x) => x.id === sel.id);
  if (!s) return;
  const def = LAYERS[s.layer];
  const min = def.kind === 'polyline' ? (s.closed ? 3 : 2) : 1;
  if (def.kind !== 'polyline' || s.points.length <= min) {
    if (!confirm('That would leave too few points. Delete the whole shape?')) return;
    project.shapes = project.shapes.filter((x) => x.id !== s.id);
  } else {
    s.points.splice(sel.i, 1);
    // keep tape references pointing at the right points
    project.refs = project.refs.filter((r) => !((r.a.id === s.id && r.a.i === sel.i) || (r.b.id === s.id && r.b.i === sel.i)));
    for (const r of project.refs) {
      for (const end of [r.a, r.b]) if (end.id === s.id && end.i > sel.i) end.i--;
    }
  }
  view.setSelected(null);
  changed();
};

$('btn-del-shape').onclick = () => {
  const sel = view.selected;
  if (!sel) return;
  if (!confirm('Delete the whole selected shape?')) return;
  project.shapes = project.shapes.filter((x) => x.id !== sel.id);
  view.setSelected(null);
  changed();
};

// ---------- AR ----------
$('btn-scan').onclick = async () => {
  try {
    await startAR({
      overlay: $('ar-overlay'),
      onShape: (shape) => {
        shape.id = project.nextId++;
        project.shapes.push(shape);
        saveProject(project);
      },
      onExit: () => {
        changed();
        requestAnimationFrame(() => { view.resize(); view.fit(); });
      },
    });
  } catch (e) {
    console.error(e);
    notice('Could not start AR: ' + (e && e.message ? e.message : e));
  }
};

async function checkAR() {
  if (await arSupported()) return;
  $('btn-scan').disabled = true;
  if (!window.isSecureContext) {
    notice('AR needs HTTPS. Open this page from its https:// address (e.g. GitHub Pages).');
  } else {
    notice('AR scanning is not available here. Use Chrome on an ARCore-capable Android phone. You can still edit saved projects and export DXF.');
  }
}

// ---------- export / import ----------
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

$('btn-dxf').onclick = () => {
  if (!project.shapes.length) return alert('Nothing to export yet.');
  const dxf = buildDxf(project, { units: $('units').value, edgeLabels: $('edge-labels').checked });
  download(`lawn-${stamp()}.dxf`, dxf, 'application/dxf');
};

$('btn-save-json').onclick = () => {
  download(`lawn-project-${stamp()}.json`, JSON.stringify(project, null, 1), 'application/json');
};

$('btn-load-json').onclick = () => $('file-json').click();
$('file-json').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    project = parseProject(await f.text());
    view.setSelected(null);
    changed();
    view.fit();
  } catch (err) {
    alert('Could not load project: ' + err.message);
  }
};

$('btn-clear').onclick = () => {
  if (!confirm('Delete the whole project? This cannot be undone.')) return;
  project = newProject();
  view.setSelected(null);
  changed();
  view.fit();
};

// ---------- start ----------
renderRefs();
updateStats();
updateButtons();
view.fit();
checkAR();
