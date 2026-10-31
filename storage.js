// Project persistence (browser localStorage + JSON import/export).
const KEY = 'lawnScanner.project.v1';

export function newProject() {
  return { version: 1, nextId: 1, nextHeadId: 1, shapes: [], refs: [], heads: [] };
}

export function parseProject(text) {
  const p = JSON.parse(text);
  if (!p || !Array.isArray(p.shapes)) throw new Error('Not a Lawn Scanner project file');
  for (const s of p.shapes) {
    if (!s.layer || !Array.isArray(s.points)) throw new Error('Invalid shape in project file');
  }
  p.refs = Array.isArray(p.refs) ? p.refs : [];
  p.heads = Array.isArray(p.heads) ? p.heads : [];
  p.nextHeadId = p.nextHeadId || p.heads.reduce((m, h) => Math.max(m, h.id || 0), 0) + 1;
  p.nextId = p.nextId || p.shapes.reduce((m, s) => Math.max(m, s.id || 0), 0) + 1;
  p.version = 1;
  return p;
}

export function loadProject() {
  try {
    const text = localStorage.getItem(KEY);
    return text ? parseProject(text) : null;
  } catch (e) {
    console.warn('Could not load saved project', e);
    return null;
  }
}

export function saveProject(project) {
  try {
    localStorage.setItem(KEY, JSON.stringify(project));
  } catch (e) {
    console.warn('Could not save project', e);
  }
}
