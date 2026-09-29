// 依赖图：存储模块依赖关系，提供拓扑排序与循环依赖检测
export class DependencyGraph {
  constructor() {
    this.nodes = new Map(); // name -> Set<depName>
  }

  add(name, deps = []) {
    if (!this.nodes.has(name)) this.nodes.set(name, new Set());
    const set = this.nodes.get(name);
    for (const d of deps) {
      set.add(d);
      if (!this.nodes.has(d)) this.nodes.set(d, new Set());
    }
  }

  remove(name) {
    this.nodes.delete(name);
    for (const deps of this.nodes.values()) deps.delete(name);
  }

  depsOf(name) {
    return [...(this.nodes.get(name) || [])];
  }

  has(name) {
    return this.nodes.has(name);
  }

  // name 及其全部传递依赖
  closure(name) {
    const out = new Set();
    const walk = (n) => {
      if (out.has(n)) return;
      out.add(n);
      for (const d of this.depsOf(n)) walk(d);
    };
    walk(name);
    return [...out];
  }

  // 所有直接或间接依赖 name 的节点
  dependentsOf(name) {
    const out = new Set([name]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [n, deps] of this.nodes) {
        if (out.has(n)) continue;
        for (const d of deps) {
          if (out.has(d)) { out.add(n); changed = true; break; }
        }
      }
    }
    out.delete(name);
    return [...out];
  }

  // 检测循环依赖，返回环路径（如 ['a','b','a']），无环返回 null
  detectCycle(only = null) {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    const scope = only ? new Set(only) : null;
    const names = scope ? [...scope] : [...this.nodes.keys()];
    for (const n of names) color.set(n, WHITE);
    const stack = [];

    const dfs = (u) => {
      color.set(u, GRAY);
      stack.push(u);
      for (const v of this.depsOf(u)) {
        if (scope && !scope.has(v)) continue;
        if (!this.nodes.has(v)) continue;
        if (color.get(v) === GRAY) {
          return stack.slice(stack.indexOf(v)).concat(v);
        }
        if (color.get(v) === WHITE) {
          const r = dfs(v);
          if (r) return r;
        }
      }
      stack.pop();
      color.set(u, BLACK);
      return null;
    };

    for (const n of names) {
      if (color.get(n) === WHITE) {
        const r = dfs(n);
        if (r) return r;
      }
    }
    return null;
  }

  // 拓扑排序（依赖在前）。有环时抛出带环信息的错误。
  topoOrder(names = null) {
    const scope = names ? new Set(names) : null;
    const list = scope ? [...scope] : [...this.nodes.keys()];
    const visited = new Set();
    const order = [];
    const visit = (u, path) => {
      if (visited.has(u)) return;
      if (path.includes(u)) {
        throw new Error('循环依赖: ' + path.slice(path.indexOf(u)).concat(u).join(' -> '));
      }
      for (const d of this.depsOf(u)) {
        if (!this.nodes.has(d)) continue;
        if (scope && !scope.has(d)) continue;
        visit(d, path.concat(u));
      }
      visited.add(u);
      order.push(u);
    };
    for (const n of list) visit(n, []);
    return order;
  }
}
