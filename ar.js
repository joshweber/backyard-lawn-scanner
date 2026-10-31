// WebXR AR capture (Android Chrome + ARCore). Three.js is loaded lazily so the plan view
// still works on desktop / unsupported browsers.
import { dist, polylineLength, simplifyAutoRuns, closeLoop } from './geometry.js';
import { LAYERS, LAYER_ORDER } from './layers.js';

const TRACE_STEP = 0.3; // metres between automatically traced points
const SIMPLIFY_TOL = 0.02; // metres
const CLOSE_RADIUS = 2; // aim must be within this of the start to apply loop closure

export async function arSupported() {
  if (!window.isSecureContext || !navigator.xr || !navigator.xr.isSessionSupported) return false;
  try {
    return await navigator.xr.isSessionSupported('immersive-ar');
  } catch {
    return false;
  }
}

/**
 * overlay: DOM overlay root containing the AR controls (see index.html)
 * onShape(shape): called with each finished shape {layer, closed, points, r?, closureError?}
 * onExit(): called when the session ends
 */
export async function startAR({ overlay, onShape, onExit }) {
  const THREE = await import('three');
  const $ = (id) => overlay.querySelector('#' + id);
  const ac = new AbortController();
  const on = (el, ev, fn) => el.addEventListener(ev, fn, { signal: ac.signal });

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
  document.getElementById('xr-canvas-host').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();

  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.09, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x00ff66 })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  const liveGroup = new THREE.Group();
  const doneGroup = new THREE.Group();
  scene.add(liveGroup, doneGroup);

  const layerSelect = $('ar-layer');
  layerSelect.innerHTML = '';
  for (const name of LAYER_ORDER) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = LAYERS[name].label;
    layerSelect.appendChild(o);
  }

  // ---- capture state (plan coords: x = world x, y = -world z, metres) ----
  let pts = [];
  let traceOn = false;
  let groundY = 0;
  let cur = null;
  let curY = 0;
  let savedCount = 0;
  let toastTimer = 0;

  const toPlan = (m) => ({ x: m.elements[12], y: -m.elements[14] });
  const layerDef = () => LAYERS[layerSelect.value];

  function toast(msg) {
    const t = $('ar-toast');
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.style.opacity = '0'), 2600);
  }

  function resetDrawing() {
    pts = [];
    traceOn = false;
    $('ar-trace').classList.remove('active');
    $('ar-trace').textContent = 'Trace: off';
  }

  function vec(p, y) {
    return new THREE.Vector3(p.x, y + 0.01, -p.y);
  }

  function makeLine(plan, layer, closed, extra) {
    const colour = new THREE.Color(LAYERS[layer].css);
    const v = plan.map((p) => vec(p, groundY));
    if (extra) v.push(vec(extra, curY));
    if (closed && v.length > 2) v.push(v[0].clone());
    const g = new THREE.Group();
    if (v.length > 1) {
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(v), new THREE.LineBasicMaterial({ color: colour })));
    }
    g.add(new THREE.Points(
      new THREE.BufferGeometry().setFromPoints(plan.map((p) => vec(p, groundY))),
      new THREE.PointsMaterial({ color: colour, size: 0.06 })
    ));
    return g;
  }

  function clearGroup(group) {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
  }

  function commit(shape, display) {
    onShape(shape);
    savedCount++;
    doneGroup.add(makeLine(display, shape.layer, shape.closed, null));
    resetDrawing();
  }

  function addPoint() {
    if (!cur) return toast('Aim at the ground until the green ring appears');
    const def = layerDef();
    const layer = layerSelect.value;
    if (pts.length === 0) groundY = curY;
    if (def.kind === 'point') {
      commit({ layer, closed: false, points: [{ x: cur.x, y: cur.y }] }, [cur]);
      return toast('Saved ' + def.label);
    }
    if (def.kind === 'circle') {
      if (pts.length === 0) {
        pts.push({ x: cur.x, y: cur.y });
        return toast('Centre set. Aim at the edge and tap Add Point');
      }
      const r = dist(pts[0], cur);
      if (r < 0.02) return toast('Edge is too close to the centre');
      commit({ layer, closed: false, points: [{ x: pts[0].x, y: pts[0].y }], r }, [pts[0], cur]);
      return toast('Saved, radius ' + r.toFixed(2) + ' m');
    }
    pts.push({ x: cur.x, y: cur.y, auto: false });
  }

  function finish() {
    const def = layerDef();
    if (def.kind !== 'polyline') return toast('This layer saves itself after Add Point');
    const min = def.closed ? 3 : 2;
    if (pts.length < min) return toast(`Need at least ${min} points`);
    const raw = pts.map((p) => ({ x: p.x, y: p.y }));
    let points = simplifyAutoRuns(pts, SIMPLIFY_TOL);
    let closureError = null;
    // Aim at the start point, then tap Finish: the gap is spread round the loop.
    if (def.closed && cur && dist(cur, pts[0]) < CLOSE_RADIUS) {
      const r = closeLoop(points, cur);
      points = r.points;
      closureError = r.error;
    }
    commit({ layer: layerSelect.value, closed: def.closed, points, closureError }, raw);
    toast(def.closed && closureError == null
      ? 'Saved without loop closure (aim at the start point before Finish next time)'
      : closureError != null ? `Saved. Loop gap was ${(closureError * 100).toFixed(1)} cm` : 'Saved');
  }

  on($('ar-add'), 'click', addPoint);
  on($('ar-finish'), 'click', finish);
  on($('ar-undo'), 'click', () => {
    if (pts.length) pts.pop();
    else toast('Nothing to undo');
  });
  on($('ar-trace'), 'click', () => {
    if (layerDef().kind !== 'polyline') return toast('Trace only works on line layers');
    traceOn = !traceOn;
    $('ar-trace').classList.toggle('active', traceOn);
    $('ar-trace').textContent = traceOn ? 'Trace: ON' : 'Trace: off';
    if (traceOn) toast('Walk slowly along the curve. Tap Add Point at corners');
  });
  on(layerSelect, 'change', resetDrawing);

  // ---- session ----
  overlay.style.display = 'block'; // the DOM overlay root must be visible when the session starts
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: overlay },
    });
  } catch (e) {
    ac.abort();
    renderer.dispose();
    renderer.domElement.remove();
    overlay.style.display = 'none';
    throw e;
  }

  let hitSource = null;

  session.addEventListener('end', () => {
    ac.abort();
    renderer.setAnimationLoop(null);
    clearGroup(liveGroup);
    clearGroup(doneGroup);
    renderer.dispose();
    renderer.domElement.remove();
    overlay.style.display = 'none';
    if (hitSource) hitSource.cancel();
    onExit();
  });
  on($('ar-exit'), 'click', () => session.end());

  await renderer.xr.setSession(session);
  overlay.style.display = 'block';
  const viewerSpace = await session.requestReferenceSpace('viewer');
  hitSource = await session.requestHitTestSource({ space: viewerSpace });

  renderer.setAnimationLoop((time, frame) => {
    if (frame && hitSource) {
      const results = frame.getHitTestResults(hitSource);
      const pose = results.length ? results[0].getPose(renderer.xr.getReferenceSpace()) : null;
      if (pose) {
        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
        cur = toPlan(reticle.matrix);
        curY = reticle.matrix.elements[13];
      } else {
        reticle.visible = false;
        cur = null;
      }
    }

    const def = layerDef();
    if (traceOn && cur && def.kind === 'polyline') {
      if (pts.length === 0) {
        groundY = curY;
        pts.push({ x: cur.x, y: cur.y, auto: false });
      } else if (dist(pts[pts.length - 1], cur) >= TRACE_STEP) {
        pts.push({ x: cur.x, y: cur.y, auto: true });
      }
    }

    clearGroup(liveGroup);
    if (pts.length) liveGroup.add(makeLine(pts, layerSelect.value, false, cur));

    let info;
    if (def.kind === 'polyline') {
      const edge = pts.length && cur ? dist(pts[pts.length - 1], cur) : 0;
      info = `${pts.length} pts | path ${polylineLength(pts, false).toFixed(2)} m | edge ${edge.toFixed(2)} m`;
      if (def.closed && pts.length > 2 && cur) info += ` | to start ${dist(pts[0], cur).toFixed(2)} m`;
    } else if (def.kind === 'circle') {
      info = pts.length ? `radius ${cur ? dist(pts[0], cur).toFixed(2) : '-'} m` : 'Aim at centre, tap Add Point';
    } else {
      info = 'Aim at the point, tap Add Point';
    }
    $('ar-info').textContent = `${cur ? '' : 'Searching for ground... | '}${info} | saved: ${savedCount}`;

    renderer.render(scene, camera);
  });
}
