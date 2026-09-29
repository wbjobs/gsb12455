/** layout-worker — 在 Web Worker 中计算依赖图分层布局，避免阻塞主线程。 */
self.onmessage = (e) => {
  const { nodes, edges, width, height } = e.data;
  // 按拓扑深度分层
  const depth = new Map(nodes.map((n) => [n.id, 0]));
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    for (const [from, to] of edges) {
      if (depth.has(from) && depth.has(to)) {
        const d = depth.get(from) + 1;
        if (d > depth.get(to)) { depth.set(to, d); changed = true; }
      }
    }
  }
  const layers = new Map();
  for (const n of nodes) {
    const d = depth.get(n.id) || 0;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(n.id);
  }
  const maxLayer = Math.max(0, ...layers.keys());
  const padX = 90, padY = 50;
  const positions = {};
  for (const [layer, ids] of layers) {
    const x = maxLayer === 0
      ? width / 2
      : padX + (layer / maxLayer) * (width - padX * 2);
    ids.forEach((id, i) => {
      const y = ids.length === 1
        ? height / 2
        : padY + (i / (ids.length - 1)) * (height - padY * 2);
      positions[id] = { x: Math.round(x), y: Math.round(y), layer };
    });
  }
  self.postMessage({ positions });
};
