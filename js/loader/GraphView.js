// Canvas 依赖图：按拓扑深度分列布局，节点颜色反映状态，支持点选
const STATUS_COLORS = {
  pending:  '#6b7280',
  loading:  '#3b82f6',
  retrying: '#f59e0b',
  loaded:   '#22c55e',
  fallback: '#14b8a6',
  degraded: '#a855f7',
  failed:   '#ef4444',
  skipped:  '#4b5563',
};

const NODE_W = 120;
const NODE_H = 44;
const GAP_X = 70;
const GAP_Y = 24;
const PAD = 20;

export class GraphView {
  constructor(canvas, graph) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.graph = graph;
    this.states = new Map(); // name -> status
    this.positions = new Map(); // name -> {x, y}
    this.selected = null;
    this.onSelect = null;

    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      for (const [name, p] of this.positions) {
        if (x >= p.x && x <= p.x + NODE_W && y >= p.y && y <= p.y + NODE_H) {
          this.selected = name;
          if (this.onSelect) this.onSelect(name);
          this.draw();
          return;
        }
      }
    });
  }

  setState(name, status) {
    this.states.set(name, status);
    this.draw();
  }

  // 拓扑深度：根为 0 列。带环保护。
  _depth(name, memo, visiting) {
    if (memo.has(name)) return memo.get(name);
    if (visiting.has(name)) return 0;
    visiting.add(name);
    const deps = this.graph.depsOf(name).filter((d) => this.graph.has(d));
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((x) => this._depth(x, memo, visiting)));
    visiting.delete(name);
    memo.set(name, d);
    return d;
  }

  layout() {
    const names = [...this.graph.nodes.keys()];
    const memo = new Map();
    const columns = new Map(); // depth -> [names]
    let maxDepth = 0;
    for (const n of names) {
      const d = this._depth(n, memo, new Set());
      maxDepth = Math.max(maxDepth, d);
      if (!columns.has(d)) columns.set(d, []);
      columns.get(d).push(n);
    }
    let maxRows = 0;
    for (const col of columns.values()) maxRows = Math.max(maxRows, col.length);

    this.canvas.width = PAD * 2 + (maxDepth + 1) * NODE_W + maxDepth * GAP_X;
    this.canvas.height = PAD * 2 + maxRows * NODE_H + Math.max(0, maxRows - 1) * GAP_Y;

    this.positions.clear();
    for (const [depth, col] of columns) {
      col.forEach((name, i) => {
        this.positions.set(name, {
          x: PAD + depth * (NODE_W + GAP_X),
          y: PAD + i * (NODE_H + GAP_Y),
        });
      });
    }
  }

  draw() {
    this.layout();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.font = '12px system-ui, sans-serif';

    // 边（依赖 -> 被依赖方，箭头指向依赖项）
    for (const [name, pos] of this.positions) {
      for (const dep of this.graph.depsOf(name)) {
        const dp = this.positions.get(dep);
        if (!dp) continue;
        const x1 = dp.x + NODE_W, y1 = dp.y + NODE_H / 2;
        const x2 = pos.x, y2 = pos.y + NODE_H / 2;
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.bezierCurveTo(x1 + GAP_X / 2, y1, x2 - GAP_X / 2, y2, x2, y2);
        ctx.stroke();
        // 箭头
        ctx.fillStyle = '#475569';
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - 8, y2 - 4);
        ctx.lineTo(x2 - 8, y2 + 4);
        ctx.closePath();
        ctx.fill();
      }
    }

    // 节点
    for (const [name, pos] of this.positions) {
      const status = this.states.get(name) || 'pending';
      const color = STATUS_COLORS[status] || STATUS_COLORS.pending;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(pos.x, pos.y, NODE_W, NODE_H, 8);
      ctx.fill();
      if (this.selected === name) {
        ctx.strokeStyle = '#f8fafc';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.fillText(name, pos.x + NODE_W / 2, pos.y + 19);
      ctx.fillStyle = 'rgba(248,250,252,0.75)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(status, pos.x + NODE_W / 2, pos.y + 34);
      ctx.font = '12px system-ui, sans-serif';
    }
  }
}
