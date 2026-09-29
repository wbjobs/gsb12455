/** GraphView — Canvas 绘制依赖图，布局由 Web Worker 计算。 */
const STATE_COLORS = {
  pending: '#8a8f98',
  loading: '#e6a23c',
  loaded: '#3fb27f',
  fallback: '#b98ae0',
  degraded: '#d4b106',
  failed: '#e05555',
  skipped: '#5b8def',
  blocked: '#ff7a45',
};

export class GraphView {
  constructor(canvas, loader) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.loader = loader;
    this.positions = {};
    this.raf = 0;
    this.destroyed = false;
    this.worker = new Worker('./js/layout-worker.js');
    this.worker.onmessage = (e) => {
      this.positions = e.data.positions;
      this._scheduleDraw();
    };
    this._onState = () => this.refresh();
    loader.addEventListener('statechange', this._onState);
    this._onResize = () => this.refresh();
    window.addEventListener('resize', this._onResize);
  }

  refresh() {
    if (this.destroyed) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(300, rect.width), h = Math.max(200, rect.height);
    if (this.canvas.width !== w * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
    }
    const nodes = this.loader.list().map((m) => ({ id: m.id }));
    const edges = [];
    for (const m of this.loader.list()) {
      for (const dep of m.deps) edges.push([dep, m.id]);
    }
    this.worker.postMessage({ nodes, edges, width: w, height: h });
  }

  _scheduleDraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this._draw();
    });
  }

  _draw() {
    if (this.destroyed) return;
    const { ctx, canvas } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const infos = new Map(this.loader.list().map((m) => [m.id, m]));

    // 边（带箭头，dep -> dependent）
    ctx.lineWidth = 1.5;
    for (const m of infos.values()) {
      for (const dep of m.deps) {
        const a = this.positions[dep], b = this.positions[m.id];
        if (!a || !b) continue;
        ctx.strokeStyle = '#4a5160';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        // 箭头
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const r = 26;
        const tx = b.x - Math.cos(angle) * r, ty = b.y - Math.sin(angle) * r;
        ctx.fillStyle = '#4a5160';
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - 8 * Math.cos(angle - 0.4), ty - 8 * Math.sin(angle - 0.4));
        ctx.lineTo(tx - 8 * Math.cos(angle + 0.4), ty - 8 * Math.sin(angle + 0.4));
        ctx.closePath();
        ctx.fill();
      }
    }

    // 节点
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [id, pos] of Object.entries(this.positions)) {
      const info = infos.get(id);
      const color = STATE_COLORS[(info && info.state) || 'pending'] || '#888';
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 22, 0, Math.PI * 2);
      ctx.fillStyle = '#1c1f26';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.fillStyle = '#e6e9ef';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(id.length > 10 ? id.slice(0, 9) + '…' : id, pos.x, pos.y);
      ctx.fillStyle = color;
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText((info && info.state) || '', pos.x, pos.y + 34);
    }
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.worker.terminate();
    this.loader.removeEventListener('statechange', this._onState);
    window.removeEventListener('resize', this._onResize);
  }
}
