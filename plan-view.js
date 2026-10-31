// Top-down 2D plan view on a canvas: pan, pinch/wheel zoom, drag points, pick points for tape references.
import { LAYERS } from './layers.js';
import { dist } from './geometry.js';

const HANDLE_PX = 16;

export class PlanView {
  /**
   * hooks: { getProject(), onChange(), onPick(a, b), onSelect(sel) }
   * A point reference is { id: shapeId, i: pointIndex }.
   */
  constructor(canvas, hooks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hooks = hooks;
    this.mode = 'edit'; // 'edit' | 'pick' | 'addhead'
    this.tab = 'outline'; // 'outline' | 'sprinklers'
    this.selectedHead = null; // head id
    this.coverage = null; // result of computeCoverage(), drawn under the heads
    this.selected = null;
    this.pickBuffer = [];
    this.scale = 30; // px per metre
    this.ox = 20;
    this.oy = 300;
    this.pointers = new Map();
    this.gesture = null;
    this._bind();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.dpr = dpr;
    this.cssW = r.width;
    this.cssH = r.height;
    this.draw();
  }

  toScreen(p) {
    return { x: this.ox + p.x * this.scale, y: this.oy - p.y * this.scale };
  }

  toWorld(sx, sy) {
    return { x: (sx - this.ox) / this.scale, y: (this.oy - sy) / this.scale };
  }

  fit() {
    const shapes = this.hooks.getProject().shapes;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of shapes) {
      for (const p of s.points) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    if (!isFinite(minX) || !this.cssW) {
      this.scale = 30; this.ox = 20; this.oy = (this.cssH || 300) - 20;
      this.draw();
      return;
    }
    const w = Math.max(maxX - minX, 1);
    const h = Math.max(maxY - minY, 1);
    const pad = 40;
    this.scale = Math.min((this.cssW - 2 * pad) / w, (this.cssH - 2 * pad) / h);
    this.ox = pad + (this.cssW - 2 * pad - w * this.scale) / 2 - minX * this.scale;
    this.oy = this.cssH - pad - (this.cssH - 2 * pad - h * this.scale) / 2 + minY * this.scale;
    this.draw();
  }

  findShape(id) {
    return this.hooks.getProject().shapes.find((s) => s.id === id);
  }

  findHandle(sx, sy) {
    let best = null;
    let bestD = HANDLE_PX;
    for (const s of this.hooks.getProject().shapes) {
      s.points.forEach((p, i) => {
        const q = this.toScreen(p);
        const d = Math.hypot(q.x - sx, q.y - sy);
        if (d <= bestD) { bestD = d; best = { id: s.id, i }; }
      });
    }
    return best;
  }

  findHead(sx, sy) {
    let best = null;
    let bestD = HANDLE_PX + 4;
    for (const h of this.hooks.getProject().heads || []) {
      const q = this.toScreen(h);
      const d = Math.hypot(q.x - sx, q.y - sy);
      if (d <= bestD) { bestD = d; best = { head: h.id }; }
    }
    return best;
  }

  setTab(tab) {
    this.tab = tab;
    this.mode = 'edit';
    this.pickBuffer = [];
    this.selected = null;
    this.selectedHead = null;
    this.draw();
  }

  setSelectedHead(id) {
    this.selectedHead = id;
    this.hooks.onSelectHead && this.hooks.onSelectHead(id);
    this.draw();
  }

  setSelected(sel) {
    this.selected = sel;
    this.hooks.onSelect && this.hooks.onSelect(sel);
    this.draw();
  }

  startPick() {
    this.mode = 'pick';
    this.pickBuffer = [];
    this.draw();
  }

  cancelPick() {
    this.mode = 'edit';
    this.pickBuffer = [];
    this.draw();
  }

  _bind() {
    const c = this.canvas;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, pos(e));
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.gesture = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y) };
        return;
      }
      const p = pos(e);
      const hit = this.tab === 'sprinklers' ? this.findHead(p.x, p.y) : this.findHandle(p.x, p.y);
      this.gesture = { type: hit ? 'handle' : 'pan', hit, start: p, last: p, moved: false };
    });

    c.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const p = pos(e);
      this.pointers.set(e.pointerId, p);
      const g = this.gesture;
      if (!g) return;
      if (g.type === 'pinch' && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (g.d > 0) this._zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / g.d);
        g.d = d;
        return;
      }
      if (this.pointers.size > 1) return;
      if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) > 6) g.moved = true;
      if (!g.moved) return;
      if (g.type === 'handle' && g.hit.head !== undefined) {
        const h = (this.hooks.getProject().heads || []).find((x) => x.id === g.hit.head);
        if (h && this.mode === 'edit') {
          const w = this.toWorld(p.x, p.y);
          h.x = w.x;
          h.y = w.y;
          this.draw();
        } else if (this.mode !== 'edit') {
          this.ox += p.x - g.last.x;
          this.oy += p.y - g.last.y;
          this.draw();
        }
      } else if (g.type === 'handle' && this.mode === 'edit') {
        const s = this.findShape(g.hit.id);
        if (s) {
          const w = this.toWorld(p.x, p.y);
          s.points[g.hit.i].x = w.x;
          s.points[g.hit.i].y = w.y;
          this.draw();
        }
      } else {
        this.ox += p.x - g.last.x;
        this.oy += p.y - g.last.y;
        this.draw();
      }
      g.last = p;
    });

    const end = (e) => {
      const g = this.gesture;
      this.pointers.delete(e.pointerId);
      if (!g) return;
      if (g.type === 'pinch') {
        if (this.pointers.size < 2) this.gesture = null;
        return;
      }
      this.gesture = null;
      if (e.type === 'pointercancel') return;
      if (g.type === 'handle' && g.hit.head !== undefined) {
        if (g.moved && this.mode === 'edit') {
          this.selectedHead = g.hit.head;
          this.hooks.onHeadMoved(g.hit.head);
        } else if (!g.moved) {
          if (this.mode === 'addhead') this.hooks.onAddHead(this.toWorld(g.start.x, g.start.y));
          else this.setSelectedHead(g.hit.head);
        }
      } else if (g.type === 'handle') {
        if (g.moved && this.mode === 'edit') {
          this.hooks.onChange();
        } else if (!g.moved) {
          if (this.mode === 'pick') this._pick(g.hit);
          else this.setSelected(g.hit);
        }
      } else if (!g.moved && this.tab === 'sprinklers') {
        if (this.mode === 'addhead') this.hooks.onAddHead(this.toWorld(g.start.x, g.start.y));
        else this.setSelectedHead(null);
      } else if (!g.moved && this.mode === 'edit') {
        this.setSelected(null);
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = pos(e);
      this._zoomAt(p.x, p.y, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });
  }

  _zoomAt(sx, sy, factor) {
    const w = this.toWorld(sx, sy);
    this.scale = Math.max(2, Math.min(2000, this.scale * factor));
    this.ox = sx - w.x * this.scale;
    this.oy = sy + w.y * this.scale;
    this.draw();
  }

  _pick(hit) {
    if (this.pickBuffer.some((h) => h.id === hit.id && h.i === hit.i)) return;
    this.pickBuffer.push(hit);
    if (this.pickBuffer.length === 2) {
      const [a, b] = this.pickBuffer;
      this.pickBuffer = [];
      this.mode = 'edit';
      this.draw();
      this.hooks.onPick(a, b);
    } else {
      this.draw();
    }
  }

  draw() {
    const ctx = this.ctx;
    if (!this.cssW) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.fillStyle = '#10151b';
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    this._grid();

    const project = this.hooks.getProject();
    ctx.lineJoin = 'round';

    for (const s of project.shapes) {
      const def = LAYERS[s.layer];
      if (!def || !s.points.length) continue;
      ctx.strokeStyle = def.css;
      ctx.fillStyle = def.css;
      ctx.lineWidth = 2;

      if (def.kind === 'polyline') {
        ctx.beginPath();
        s.points.forEach((p, i) => {
          const q = this.toScreen(p);
          if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
        });
        if (s.closed && s.points.length > 2) ctx.closePath();
        if (s.closed && s.layer === 'LAWN_BOUNDARY') {
          ctx.save();
          ctx.globalAlpha = 0.12;
          ctx.fill();
          ctx.restore();
        }
        ctx.stroke();
        this._edgeLabels(s, def.css);
      } else if (def.kind === 'circle') {
        const q = this.toScreen(s.points[0]);
        ctx.beginPath();
        ctx.arc(q.x, q.y, (s.r || 0) * this.scale, 0, Math.PI * 2);
        ctx.stroke();
      } else if (def.kind === 'point') {
        const q = this.toScreen(s.points[0]);
        ctx.beginPath();
        ctx.arc(q.x, q.y, 9, 0, Math.PI * 2);
        ctx.stroke();
      }

      const showAll = s.points.length <= 60 && this.tab === 'outline';
      s.points.forEach((p, i) => {
        const isSel = this.selected && this.selected.id === s.id && this.selected.i === i;
        const isPick = this.pickBuffer.some((h) => h.id === s.id && h.i === i);
        if (!showAll && !isSel && !isPick) return;
        const q = this.toScreen(p);
        ctx.beginPath();
        ctx.arc(q.x, q.y, isSel || isPick ? 7 : 4, 0, Math.PI * 2);
        ctx.fillStyle = isPick ? '#ff9800' : isSel ? '#ffffff' : def.css;
        ctx.fill();
      });
    }

    this._drawHeads(project);

    for (const r of project.refs) {
      const a = this._ptOf(r.a);
      const b = this._ptOf(r.b);
      if (!a || !b) continue;
      const qa = this.toScreen(a);
      const qb = this.toScreen(b);
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = '#ff9800';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(qa.x, qa.y);
      ctx.lineTo(qb.x, qb.y);
      ctx.stroke();
      ctx.restore();
      this._label(`${dist(a, b).toFixed(2)} / tape ${r.m.toFixed(2)}`, (qa.x + qb.x) / 2, (qa.y + qb.y) / 2, '#ff9800');
    }

    if (this.mode === 'pick') {
      this._label(`Tap point ${this.pickBuffer.length + 1} of 2 for tape reference`, this.cssW / 2, 18, '#ff9800');
    }
    if (this.mode === 'addhead') {
      this._label('Tap the plan to place a head. Near the lawn edge it snaps on and sets its arc.', this.cssW / 2, 18, '#4fc3f7');
    }
  }

  _drawHeads(project) {
    if (this.tab !== 'sprinklers') return;
    const ctx = this.ctx;

    // coverage overlay: red = dry, yellow = one head, green = overlap
    const cov = this.coverage;
    if (cov && cov.samples.length) {
      const px = Math.max(2, cov.step * this.scale);
      ctx.save();
      ctx.globalAlpha = 0.45;
      for (let i = 0; i < cov.samples.length; i++) {
        const c = cov.counts[i];
        ctx.fillStyle = c === 0 ? '#e53935' : c === 1 ? '#fdd835' : '#43a047';
        const q = this.toScreen(cov.samples[i]);
        ctx.fillRect(q.x - px / 2, q.y - px / 2, px + 0.5, px + 0.5);
      }
      ctx.restore();
    }

    const heads = project.heads || [];
    const sector = (h, fill) => {
      const q = this.toScreen(h);
      const r = h.radius * this.scale;
      ctx.beginPath();
      if (h.sweep >= 359.5) {
        ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      } else {
        // canvas y points down, so plan angles are negated
        const a0 = (-h.start * Math.PI) / 180;
        const a1 = (-(h.start + h.sweep) * Math.PI) / 180;
        ctx.moveTo(q.x, q.y);
        ctx.arc(q.x, q.y, r, a0, a1, true);
        ctx.closePath();
      }
      if (fill) ctx.fill();
      ctx.stroke();
    };

    for (const h of heads) {
      const sel = h.id === this.selectedHead;
      ctx.lineWidth = sel ? 2.5 : 1.2;
      ctx.strokeStyle = sel ? '#ffffff' : h.nozzleId ? '#4fc3f7' : '#ff5252';
      ctx.fillStyle = sel ? 'rgba(255,255,255,0.12)' : 'rgba(79,195,247,0.07)';
      sector(h, true);
    }
    for (const h of heads) {
      const q = this.toScreen(h);
      const sel = h.id === this.selectedHead;
      ctx.beginPath();
      ctx.arc(q.x, q.y, sel ? 8 : 6, 0, Math.PI * 2);
      ctx.fillStyle = h.nozzleId ? (h.warn ? '#ff9800' : '#00b0ff') : '#ff5252';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = sel ? '#ffffff' : '#10151b';
      ctx.stroke();
    }
  }

  _ptOf(ref) {
    const s = this.findShape(ref.id);
    return s ? s.points[ref.i] : null;
  }

  _grid() {
    if (this.scale < 8) return;
    const ctx = this.ctx;
    const tl = this.toWorld(0, 0);
    const br = this.toWorld(this.cssW, this.cssH);
    ctx.strokeStyle = '#1d2630';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(tl.x); x <= br.x; x++) {
      const sx = this.ox + x * this.scale;
      ctx.moveTo(sx, 0); ctx.lineTo(sx, this.cssH);
    }
    for (let y = Math.floor(br.y); y <= tl.y; y++) {
      const sy = this.oy - y * this.scale;
      ctx.moveTo(0, sy); ctx.lineTo(this.cssW, sy);
    }
    ctx.stroke();
  }

  _edgeLabels(s, colour) {
    const n = s.closed && s.points.length > 2 ? s.points.length : s.points.length - 1;
    for (let i = 0; i < n; i++) {
      const a = s.points[i];
      const b = s.points[(i + 1) % s.points.length];
      const qa = this.toScreen(a);
      const qb = this.toScreen(b);
      if (Math.hypot(qa.x - qb.x, qa.y - qb.y) < 70) continue;
      this._label(dist(a, b).toFixed(2) + ' m', (qa.x + qb.x) / 2, (qa.y + qb.y) / 2, colour);
    }
  }

  _label(text, x, y, colour) {
    const ctx = this.ctx;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 8;
    ctx.fillStyle = 'rgba(16,21,27,0.85)';
    ctx.fillRect(x - w / 2, y - 9, w, 18);
    ctx.fillStyle = colour;
    ctx.fillText(text, x, y);
  }
}
