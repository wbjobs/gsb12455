import { DependencyGraph } from './DependencyGraph.js';

// 兜底 stub：降级模块也失败时的最后保障，保证依赖方拿到可用导出
const stubCode = (name, reason) => `
const reason = ${JSON.stringify(reason)};
console.warn('[ModuleLoader] 兜底 stub 模块 "${name}":', reason);
export const __stub = true;
export const __reason = reason;
export default { __stub: true, name: ${JSON.stringify(name)}, reason };
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ModuleLoader extends EventTarget {
  constructor({ defaultTimeout = 8000, defaultMaxRetries = 2 } = {}) {
    super();
    this.graph = new DependencyGraph();
    this.defs = new Map();      // name -> { name, url, deps, fallbackUrl, timeout, maxRetries }
    this.records = new Map();   // name -> 运行状态记录
    this.exports = new Map();   // name -> 模块导出
    this.defaultTimeout = defaultTimeout;
    this.defaultMaxRetries = defaultMaxRetries;
    this._reqId = 0;
    this._pending = new Map();  // id -> { resolve, reject, timer }
    this._disposed = false;
    this._loading = null;       // 当前批量加载 Promise

    try {
      this.worker = new Worker(new URL('../workers/fetchWorker.js', import.meta.url));
      this.worker.onmessage = (e) => this._onWorkerMessage(e);
      this.worker.onerror = () => { this.worker = null; };
    } catch {
      this.worker = null; // Worker 不可用时回退主线程 fetch
    }

    if (!globalThis.__APP_MODULES__) globalThis.__APP_MODULES__ = {};
  }

  register(def) {
    const full = {
      deps: [],
      fallbackUrl: null,
      timeout: this.defaultTimeout,
      maxRetries: this.defaultMaxRetries,
      ...def,
    };
    this.defs.set(full.name, full);
    this.graph.add(full.name, full.deps);
    if (!this.records.has(full.name)) {
      this.records.set(full.name, this._freshRecord(full.name));
    }
    this._emit(full.name);
    return full;
  }

  unregister(name) {
    this.defs.delete(name);
    this.records.delete(name);
    this.exports.delete(name);
    delete globalThis.__APP_MODULES__[name];
    this.graph.remove(name);
    this._emitAll();
  }

  reset() {
    for (const name of this.defs.keys()) {
      this.records.set(name, this._freshRecord(name));
      this.exports.delete(name);
      delete globalThis.__APP_MODULES__[name];
    }
    this._emitAll();
  }

  _freshRecord(name) {
    return {
      name,
      status: 'pending',   // pending|loading|retrying|loaded|fallback|degraded|failed|skipped
      attempts: 0,
      retries: 0,
      duration: 0,
      error: null,
      fallbackReason: null,
      source: null,        // main | fallback | stub
    };
  }

  getRecord(name) { return this.records.get(name); }
  getRecords() { return [...this.records.values()]; }

  _emit(name) {
    this.dispatchEvent(new CustomEvent('module-state', {
      detail: { name, record: this.records.get(name) },
    }));
  }

  _emitAll() {
    this.dispatchEvent(new CustomEvent('graph-state'));
    for (const n of this.records.keys()) this._emit(n);
  }

  // ---------- 网络层 ----------

  _fetchCode(url, timeout) {
    if (this.worker) return this._fetchViaWorker(url, timeout);
    return this._fetchMainThread(url, timeout);
  }

  _fetchViaWorker(url, timeout) {
    return new Promise((resolve, reject) => {
      const id = ++this._reqId;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        this.worker.postMessage({ type: 'abort', id }); // 超时中断
        reject(new Error(`加载超时 (${timeout}ms)，已中断`));
      }, timeout);
      this._pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ type: 'fetch', id, url });
    });
  }

  _fetchMainThread(url, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    return fetch(url, { signal: controller.signal, cache: 'no-cache' })
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .catch((err) => {
        if (err && err.name === 'AbortError') throw new Error(`加载超时 (${timeout}ms)，已中断`);
        throw err;
      })
      .finally(() => clearTimeout(timer));
  }

  _onWorkerMessage(e) {
    const { type, id, ok, code, error, aborted } = e.data || {};
    if (type !== 'result') return;
    const p = this._pending.get(id);
    if (!p) return; // 已超时，结果被丢弃
    clearTimeout(p.timer);
    this._pending.delete(id);
    if (ok) p.resolve(code);
    else p.reject(new Error(aborted ? '请求被中断' : (error || '网络错误')));
  }

  async _importCode(code) {
    const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try {
      return await import(/* webpackIgnore: true */ blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  // ---------- 加载流程 ----------

  async _tryLoad(url, rec, timeout, maxRetries) {
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this._disposed) throw new Error('加载器已销毁');
      rec.attempts++;
      if (attempt > 0) {
        rec.retries++;
        rec.status = 'retrying';
        this._emit(rec.name);
        await sleep(300 * 2 ** (attempt - 1)); // 指数退避
      } else {
        rec.status = 'loading';
        this._emit(rec.name);
      }
      try {
        const code = await this._fetchCode(url, timeout);
        return await this._importCode(code);
      } catch (err) {
        lastError = err;
        rec.error = String(err && err.message || err);
        this._emit(rec.name);
      }
    }
    throw lastError;
  }

  async _loadOne(name) {
    const def = this.defs.get(name);
    const rec = this.records.get(name);
    const t0 = performance.now();
    performance.mark(`mod:${name}:start`);

    const finish = (status) => {
      rec.duration = Math.round((performance.now() - t0) * 10) / 10;
      rec.status = status;
      performance.mark(`mod:${name}:end`);
      try { performance.measure(`module:${name}`, `mod:${name}:start`, `mod:${name}:end`); } catch {}
      this._emit(name);
    };

    // 1) 主 URL，带重试
    try {
      const mod = await this._tryLoad(def.url, rec, def.timeout, def.maxRetries);
      rec.source = 'main';
      finish('loaded');
      return mod;
    } catch (mainErr) {
      rec.fallbackReason = `主模块失败(已重试${def.maxRetries}次): ${mainErr.message}`;
    }

    // 2) 降级 URL
    if (def.fallbackUrl) {
      this._emit(name);
      try {
        const mod = await this._tryLoad(def.fallbackUrl, rec, def.timeout, def.maxRetries);
        rec.source = 'fallback';
        finish('fallback');
        return mod;
      } catch (fbErr) {
        rec.fallbackReason += `；降级模块也失败: ${fbErr.message}，启用兜底 stub`;
      }
    } else {
      finish('failed');
      throw new Error(rec.fallbackReason);
    }

    // 3) 兜底 stub，保证依赖方不崩
    try {
      const mod = await this._importCode(stubCode(name, rec.fallbackReason));
      rec.source = 'stub';
      finish('degraded');
      return mod;
    } catch (stubErr) {
      finish('failed');
      throw stubErr;
    }
  }

  // 依赖级联：依赖失败/被跳过 -> 当前模块直接标记失败，不再请求
  _checkDeps(name) {
    for (const dep of this.graph.depsOf(name)) {
      const r = this.records.get(dep);
      if (!r) return `依赖 ${dep} 未注册`;
      if (r.status === 'failed') return `依赖 ${dep} 加载失败`;
      if (r.status === 'skipped') return `依赖 ${dep} 被跳过`;
    }
    return null;
  }

  async load(name) {
    if (!this.defs.has(name)) throw new Error(`模块 ${name} 未注册`);
    const closure = this.graph.closure(name).filter((n) => this.defs.has(n));

    // 循环依赖检测：环上成员 + 依赖环的模块全部标记失败
    const cycle = this.graph.detectCycle(closure);
    let cycleMembers = new Set();
    if (cycle) {
      cycleMembers = new Set(cycle.slice(0, -1));
      const msg = '循环依赖: ' + cycle.join(' -> ');
      for (const n of closure) {
        const rec = this.records.get(n);
        if (cycleMembers.has(n)) {
          Object.assign(rec, { status: 'failed', error: msg });
        } else {
          const deps = this.graph.depsOf(n);
          const tainted = deps.some((d) => cycleMembers.has(d)) ||
            deps.some((d) => this.records.get(d)?.status === 'failed');
          if (tainted || this.graph.dependentsOf(n).some((x) => cycleMembers.has(x))) {
            Object.assign(rec, { status: 'failed', error: `依赖链涉及${msg}` });
          }
        }
        this._emit(n);
      }
    }

    const loadable = closure.filter((n) => !cycleMembers.has(n) &&
      this.records.get(n).status !== 'failed');
    let order;
    try {
      order = this.graph.topoOrder(loadable);
    } catch {
      order = loadable; // 兜底：按注册顺序
    }

    for (const n of order) {
      const rec = this.records.get(n);
      if (['loaded', 'fallback', 'degraded'].includes(rec.status)) continue;
      if (['failed', 'skipped'].includes(rec.status)) continue;

      const depErr = this._checkDeps(n);
      if (depErr) {
        rec.status = 'failed';
        rec.error = `级联失败: ${depErr}`;
        this._emit(n);
        continue;
      }

      try {
        const mod = await this._loadOne(n);
        this.exports.set(n, mod);
        globalThis.__APP_MODULES__[n] = mod;
      } catch {
        // 状态已在 _loadOne 内记录，继续处理后续模块（级联由 _checkDeps 完成）
      }
    }

    this.dispatchEvent(new CustomEvent('settled', { detail: { name } }));
    return this.records.get(name);
  }

  async loadAll() {
    if (this._loading) return this._loading;
    const names = [...this.defs.keys()];
    this._loading = (async () => {
      for (const n of names) await this.load(n);
      this._loading = null;
      this.dispatchEvent(new CustomEvent('all-settled'));
    })();
    return this._loading;
  }

  // ---------- 手动干预 ----------

  async retry(name) {
    const rec = this.records.get(name);
    if (!rec) return;
    this.records.set(name, { ...this._freshRecord(name) });
    this._emit(name);
    return this.load(name);
  }

  skip(name) {
    const rec = this.records.get(name);
    if (!rec) return;
    rec.status = 'skipped';
    rec.error = '手动跳过';
    this._emit(name);
    // 级联：标记尚未加载的依赖方为失败
    for (const dep of this.graph.dependentsOf(name)) {
      const r = this.records.get(dep);
      if (r && ['pending', 'loading', 'retrying'].includes(r.status)) {
        r.status = 'failed';
        r.error = `级联失败: 依赖 ${name} 被跳过`;
        this._emit(dep);
      }
    }
  }

  async replaceFallback(name, newFallbackUrl) {
    const def = this.defs.get(name);
    if (!def) return;
    def.fallbackUrl = newFallbackUrl;
    return this.retry(name);
  }

  // ---------- 清理 ----------

  dispose() {
    this._disposed = true;
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      if (this.worker) this.worker.postMessage({ type: 'abort', id });
      p.reject(new Error('页面卸载，加载已取消'));
    }
    this._pending.clear();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
