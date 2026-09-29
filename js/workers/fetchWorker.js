// 拉取模块源码的 Worker：网络请求移出主线程，支持主线程发消息中断
const controllers = new Map(); // id -> AbortController

self.onmessage = async (e) => {
  const { type, id, url } = e.data || {};

  if (type === 'abort') {
    const c = controllers.get(id);
    if (c) {
      c.abort();
      controllers.delete(id);
    }
    return;
  }

  if (type === 'fetch') {
    const controller = new AbortController();
    controllers.set(id, controller);
    try {
      const res = await fetch(url, { signal: controller.signal, cache: 'no-cache' });
      controllers.delete(id);
      if (!res.ok) {
        self.postMessage({ type: 'result', id, ok: false, status: res.status, error: 'HTTP ' + res.status });
        return;
      }
      const code = await res.text();
      self.postMessage({ type: 'result', id, ok: true, status: res.status, code });
    } catch (err) {
      controllers.delete(id);
      const aborted = err && err.name === 'AbortError';
      self.postMessage({ type: 'result', id, ok: false, aborted, error: aborted ? 'aborted' : String(err && err.message || err) });
    }
  }
};
