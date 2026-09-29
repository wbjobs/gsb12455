/**
 * ModuleLoader — 按需加载 JS 模块，支持依赖声明、超时中断、
 * 重试上限、降级链、级联处理与循环依赖检测。
 *
 * 加载策略：fetch(AbortController 可中断) -> Blob URL -> dynamic import。
 */
export const State = Object.freeze({
  PENDING: 'pending',       // 等待加载
  LOADING: 'loading',       // 加载中
  LOADED: 'loaded',         // 正常加载成功
  FALLBACK: 'fallback',     // 通过降级模块加载成功
  DEGRADED: 'degraded',     // 自身成功，但依赖被降级/跳过/兜底
  FAILED: 'failed',         // 彻底失败（含兜底前的状态）
  SKIPPED: 'skipped',       // 手动跳过
  BLOCKED: 'blocked',       // 因循环依赖被阻断
});

const ULTIMATE_STUB_ID = '__ultimate_stub__';

export class ModuleLoader extends EventTarget {
  /**
   * @param {{history?: import('./history.js').HistoryStore}} opts
   */
  constructor(opts = {}) {
    super();
    /** @type {Map<string, object>} */
    this.modules = new Map();
    this.history = opts.history || null;
    this._controllers = new Map(); // id -> AbortController（当前进行中的请求）
    this._loadPromises = new Map();
    this._destroyed = false;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _notify(module) {
    this._emit('statechange', { module: this.getInfo(module.id) });
  }

  /**
   * 注册模块。
   * @param {{id:string, url:string, deps?:string[], timeout?:number,
   *          retries?:number, retryDelay?:number, fallbacks?:string[]}} config
   */
  register(config) {
    if (this._destroyed) throw new Error('loader destroyed');
    if (!config.id || !config.url) throw new Error('id 与 url 必填');
    if (this.modules.has(config.id)) throw new Error(`模块重复注册: ${config.id}`);
    const module = {
      id: config.id,
      url: config.url,
      deps: [...(config.deps || [])],
      timeout: config.timeout ?? 5000,
      retries: config.retries ?? 2,
      retryDelay: config.retryDelay ?? 400,
      simulateLatency: config.simulateLatency ?? 0, // 演示用：模拟网络延迟(ms)，可被 AbortController 中断
      fallbacks: [...(config.fallbacks || [])],
      state: State.PENDING,
      attempts: 0,          // 已用重试次数（不含首次）
      duration: 0,          // 最近一次加载耗时 ms
      error: null,
      fallbackReason: null, // 降级原因
      activeUrl: null,      // 实际加载成功的 url
      exports: null,
      startedAt: 0,
    };
    this.modules.set(module.id, module);
    // 注册时即检测循环依赖
    const cycle = this._findCycle();
    if (cycle) {
      this.modules.delete(module.id);
      throw new Error(`检测到循环依赖: ${cycle.join(' -> ')}`);
    }
    this._notify(module);
    return module;
  }

  /** DFS 检测循环依赖，返回环路径或 null */
  _findCycle() {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map([...this.modules.keys()].map((k) => [k, WHITE]));
    const stack = [];
    const visit = (id) => {
      color.set(id, GRAY);
      stack.push(id);
      const mod = this.modules.get(id);
      for (const dep of mod ? mod.deps : []) {
        if (!this.modules.has(dep)) continue; // 未注册依赖在加载期处理
        if (color.get(dep) === GRAY) {
          return [...stack.slice(stack.indexOf(dep)), dep];
        }
        if (color.get(dep) === WHITE) {
          const found = visit(dep);
          if (found) return found;
        }
      }
      stack.pop();
      color.set(id, BLACK);
      return null;
    };
    for (const id of this.modules.keys()) {
      if (color.get(id) === WHITE) {
        const found = visit(id);
        if (found) return found;
      }
    }
    return null;
  }

  /** 拓扑排序（Kahn），供依赖图布局使用 */
  topoOrder() {
    const indeg = new Map([...this.modules.keys()].map((k) => [k, 0]));
    for (const mod of this.modules.values()) {
      for (const dep of mod.deps) if (indeg.has(dep)) indeg.set(dep, indeg.get(dep) + 1);
    }
    // 注意：边方向 dep -> mod，这里统计的是“被依赖次数”用于分层
    const depth = new Map([...this.modules.keys()].map((k) => [k, 0]));
    const queue = [...this.modules.keys()].filter((k) => {
      const mod = this.modules.get(k);
      return mod.deps.every((d) => !this.modules.has(d));
    });
    const visited = new Set(queue);
    for (const id of queue) depth.set(id, 0);
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 100) {
      changed = false;
      for (const mod of this.modules.values()) {
        const depDepths = mod.deps.filter((d) => depth.has(d)).map((d) => depth.get(d));
        if (depDepths.length) {
          const d = Math.max(...depDepths) + 1;
          if (d > depth.get(mod.id)) { depth.set(mod.id, d); changed = true; }
        }
      }
    }
    return { depth, indeg };
  }

  getInfo(id) {
    const m = this.modules.get(id);
    if (!m) return null;
    return {
      id: m.id, url: m.url, deps: [...m.deps], state: m.state,
      attempts: m.attempts, retries: m.retries, duration: Math.round(m.duration),
      error: m.error ? String(m.error.message || m.error) : null,
      fallbackReason: m.fallbackReason, activeUrl: m.activeUrl,
      timeout: m.timeout, fallbacks: [...m.fallbacks],
    };
  }

  list() {
    return [...this.modules.values()].map((m) => this.getInfo(m.id));
  }

  /** 加载单个模块（含其依赖链）。幂等：进行中/已完成直接复用。 */
  load(id) {
    if (this._destroyed) return Promise.reject(new Error('loader destroyed'));
    if (this._loadPromises.has(id)) return this._loadPromises.get(id);
    const p = this._load(id).finally(() => this._loadPromises.delete(id));
    this._loadPromises.set(id, p);
    return p;
  }

  /** 加载全部已注册模块 */
  async loadAll() {
    const results = await Promise.allSettled([...this.modules.keys()].map((id) => this.load(id)));
    return results;
  }

  async _load(id, _chain = []) {
    const mod = this.modules.get(id);
    if (!mod) throw new Error(`模块未注册: ${id}`);
    if ([State.LOADED, State.FALLBACK, State.SKIPPED].includes(mod.state)) return mod.exports;

    // 加载期循环检测（防御动态变更）
    if (_chain.includes(id)) {
      const cyclePath = [..._chain, id].join(' -> ');
      this._blockChain(id, `循环依赖: ${cyclePath}`);
      throw new Error(cyclePath);
    }

    // 先解析依赖
    let degraded = false;
    for (const depId of mod.deps) {
      const dep = this.modules.get(depId);
      if (!dep) {
        degraded = true;
        mod.fallbackReason = `依赖未注册: ${depId}`;
        continue;
      }
      try {
        await this._load(depId, [..._chain, id]);
        if (dep.state !== State.LOADED) degraded = true;
      } catch (err) {
        // 级联处理：依赖彻底失败时注入兜底 stub，让当前模块降级继续
        degraded = true;
        mod.fallbackReason = `依赖失败(已兜底): ${depId}`;
        this._emit('cascade', { from: depId, to: id, error: String(err && err.message || err) });
      }
    }

    if (mod.state === State.SKIPPED) return mod.exports;

    await this._loadWithRetryAndFallback(mod);
    if (mod.state === State.SKIPPED) return mod.exports;
    if (mod.state === State.LOADED && degraded) {
      mod.state = State.DEGRADED;
      this._notify(mod);
    }
    return mod.exports;
  }

  _blockChain(id, reason) {
    const mod = this.modules.get(id);
    if (mod) {
      mod.state = State.BLOCKED;
      mod.error = reason;
      this._notify(mod);
    }
  }

  /** 核心：主 url -> 重试 -> 降级链 -> 终极兜底 stub */
  async _loadWithRetryAndFallback(mod) {
    const t0 = performance.now();
    mod.state = State.LOADING;
    mod.error = null;
    mod.startedAt = t0;
    this._notify(mod);
    performance.mark(`mod:${mod.id}:start`);

    const sources = [mod.url, ...mod.fallbacks];
    let lastError = null;

    for (let i = 0; i < sources.length; i++) {
      const url = sources[i];
      const isFallback = i > 0;
      const maxAttempts = isFallback ? 1 : mod.retries + 1; // 降级源只试一次，重试上限作用于主源
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (this._destroyed || mod.state === State.SKIPPED) return;
        try {
          const exports = await this._fetchAndImport(mod, url);
          mod.exports = exports;
          mod.activeUrl = url;
          mod.duration = performance.now() - t0;
          if (isFallback) {
            mod.state = State.FALLBACK;
            mod.fallbackReason = `主源失败(${lastError && lastError.message || 'unknown'})，降级到 ${url}`;
          } else {
            mod.state = State.LOADED;
          }
          this._finishMeasure(mod);
          this._notify(mod);
          this._record(mod, null);
          return;
        } catch (err) {
          lastError = err;
          mod.attempts += 1;
          mod.duration = performance.now() - t0;
          this._emit('attempt', { id: mod.id, url, attempt, error: String(err && err.message || err) });
          this._notify(mod);
          if (attempt < maxAttempts) {
            await this._sleep(mod.retryDelay * attempt); // 简单线性退避
          }
        }
      }
      if (isFallback) {
        mod.fallbackReason = `降级源也失败: ${url} (${lastError && lastError.message})`;
      }
    }

    // 终极兜底：内置空 stub，保证依赖链不整体崩溃
    mod.state = State.FAILED;
    mod.error = lastError;
    mod.duration = performance.now() - t0;
    mod.exports = this._ultimateStub(mod);
    mod.activeUrl = ULTIMATE_STUB_ID;
    mod.fallbackReason = (mod.fallbackReason ? mod.fallbackReason + '；' : '') +
      '所有源均失败，已注入终极兜底 stub';
    this._finishMeasure(mod);
    this._notify(mod);
    this._record(mod, lastError);
    // 不 throw：由 _load 的级联逻辑把失败信息传给依赖方
  }

  _ultimateStub(mod) {
    return new Proxy({}, {
      get: (_t, prop) => {
        if (prop === '__isStub') return true;
        if (prop === 'then') return undefined; // 避免被当作 thenable
        return () => undefined;
      },
    });
  }

  /** fetch(可中断) -> Blob -> dynamic import */
  async _fetchAndImport(mod, url) {
    const controller = new AbortController();
    this._controllers.set(mod.id, controller);
    const timer = setTimeout(() => controller.abort(new DOMException('加载超时', 'TimeoutError')), mod.timeout);
    try {
      if (mod.simulateLatency > 0) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, mod.simulateLatency);
          controller.signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(controller.signal.reason || new DOMException('加载超时', 'TimeoutError'));
          }, { once: true });
        });
      }
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const source = await res.text();
      const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      try {
        return await import(/* @vite-ignore */ blobUrl);
      } finally {
        // 延迟回收，避免某些浏览器 import 尚未完成解析
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      }
    } finally {
      clearTimeout(timer);
      this._controllers.delete(mod.id);
    }
  }

  _finishMeasure(mod) {
    try {
      performance.mark(`mod:${mod.id}:end`);
      performance.measure(`mod:${mod.id}`, `mod:${mod.id}:start`, `mod:${mod.id}:end`);
    } catch { /* mark 可能因重入缺失，忽略 */ }
  }

  _record(mod, error) {
    if (!this.history) return;
    this.history.add({
      moduleId: mod.id,
      url: mod.activeUrl || mod.url,
      state: mod.state,
      duration: Math.round(mod.duration),
      attempts: mod.attempts,
      fallbackReason: mod.fallbackReason,
      error: error ? String(error.message || error) : null,
      timestamp: Date.now(),
    }).catch(() => {});
  }

  /** 手动重试：重置状态后重新加载 */
  async retry(id) {
    const mod = this.modules.get(id);
    if (!mod) return;
    mod.state = State.PENDING;
    mod.attempts = 0;
    mod.error = null;
    mod.fallbackReason = null;
    mod.exports = null;
    mod.activeUrl = null;
    this._notify(mod);
    return this.load(id);
  }

  /** 手动跳过：注入 stub，标记 skipped，并级联唤醒依赖方 */
  async skip(id) {
    const mod = this.modules.get(id);
    if (!mod) return;
    const c = this._controllers.get(id);
    if (c) c.abort(new DOMException('手动跳过', 'AbortError'));
    mod.state = State.SKIPPED;
    mod.exports = this._ultimateStub(mod);
    mod.fallbackReason = '手动跳过';
    this._notify(mod);
    this._record(mod, null);
    // 级联：重新触发依赖此模块且仍处于 pending 的模块
    for (const m of this.modules.values()) {
      if (m.deps.includes(id) && m.state === State.PENDING) {
        this.load(m.id).catch(() => {});
      }
    }
  }

  /** 手动替换降级模块 url 并重试 */
  async replaceFallback(id, newUrl) {
    const mod = this.modules.get(id);
    if (!mod) return;
    if (!mod.fallbacks.includes(newUrl)) mod.fallbacks.push(newUrl);
    return this.retry(id);
  }

  /** 页面卸载/销毁：中断所有请求 */
  destroy() {
    this._destroyed = true;
    for (const c of this._controllers.values()) {
      c.abort(new DOMException('页面卸载', 'AbortError'));
    }
    this._controllers.clear();
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
