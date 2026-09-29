import { ModuleLoader, State } from './loader.js';
import { HistoryStore } from './history.js';
import { PerfMonitor } from './perf.js';
import { GraphView } from './graph.js';

const STATE_LABEL = {
  pending: '等待', loading: '加载中', loaded: '成功', fallback: '已降级',
  degraded: '部分降级', failed: '失败', skipped: '已跳过', blocked: '循环阻断',
};

const history = new HistoryStore();
await history.open().catch(() => null);

const loader = new ModuleLoader({ history });

// ---------- 演示模块注册 ----------
// core -> utils -> api；charts 依赖 utils；broken 演示降级链；slow 演示超时中断
loader.register({ id: 'core', url: './modules/core.js' });
loader.register({ id: 'utils', url: './modules/utils.js', deps: ['core'] });
loader.register({
  id: 'api', url: './modules/api.js', deps: ['core', 'utils'],
  retries: 2, retryDelay: 300,
  fallbacks: ['./modules/fallbacks/api-fallback.js'],
});
loader.register({
  id: 'charts', url: './modules/charts.js', deps: ['utils'],
  fallbacks: ['./modules/fallbacks/charts-fallback.js'],
});
loader.register({
  id: 'broken', url: './modules/broken.js', deps: ['core'],
  retries: 1, fallbacks: ['./modules/fallbacks/broken-fallback.js'], // 降级也会失败 -> 终极兜底
});
loader.register({
  id: 'report', url: './modules/report.js', deps: ['api', 'charts', 'broken'],
});
loader.register({
  id: 'slow', url: './modules/slow.js', timeout: 1500, retries: 1,
  simulateLatency: 4000, // 模拟慢网络，触发超时中断
});

// ---------- UI ----------
const $ = (sel) => document.querySelector(sel);
const moduleListEl = $('#module-list');
const logEl = $('#log');
const historyEl = $('#history-list');

function log(msg, level = 'info') {
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.prepend(line);
  while (logEl.children.length > 200) logEl.lastChild.remove();
}

function renderModules() {
  moduleListEl.innerHTML = '';
  for (const m of loader.list()) {
    const row = document.createElement('div');
    row.className = 'module-row';
    row.innerHTML = `
      <span class="m-id" title="${m.url}">${m.id}</span>
      <span class="m-deps">${m.deps.join(', ') || '-'}</span>
      <span class="m-state state-${m.state}">${STATE_LABEL[m.state] || m.state}</span>
      <span class="m-duration">${m.duration}ms</span>
      <span class="m-attempts">${m.attempts}/${m.retries}</span>
      <span class="m-reason" title="${m.fallbackReason || m.error || ''}">${m.fallbackReason || m.error || ''}</span>
      <span class="m-actions"></span>`;
    const actions = row.querySelector('.m-actions');
    const mkBtn = (text, fn, title) => {
      const b = document.createElement('button');
      b.textContent = text;
      if (title) b.title = title;
      b.onclick = fn;
      actions.appendChild(b);
    };
    mkBtn('加载', () => loader.load(m.id).catch(() => {}));
    mkBtn('重试', () => loader.retry(m.id).catch(() => {}));
    mkBtn('跳过', () => loader.skip(m.id));
    mkBtn('换源', () => {
      const url = prompt(`为 ${m.id} 指定新的降级模块 URL:`, './modules/fallbacks/');
      if (url) loader.replaceFallback(m.id, url).catch(() => {});
    });
    moduleListEl.appendChild(row);
  }
}

async function renderHistory() {
  if (!history.db) return;
  const items = await history.recent(50).catch(() => []);
  historyEl.innerHTML = items.map((it) => `
    <div class="history-row">
      <span>${new Date(it.timestamp).toLocaleTimeString()}</span>
      <span>${it.moduleId}</span>
      <span class="state-${it.state}">${STATE_LABEL[it.state] || it.state}</span>
      <span>${it.duration}ms</span>
      <span>重试${it.attempts}</span>
      <span title="${it.fallbackReason || it.error || ''}">${it.fallbackReason || it.error || ''}</span>
    </div>`).join('');
}

// ---------- 事件接线 ----------
loader.addEventListener('statechange', () => { renderModules(); });
loader.addEventListener('statechange', (e) => {
  const m = e.detail.module;
  if ([State.LOADED, State.FALLBACK, State.DEGRADED, State.FAILED, State.SKIPPED, State.BLOCKED].includes(m.state)) {
    renderHistory();
  }
});
loader.addEventListener('attempt', (e) => {
  log(`${e.detail.id} 第 ${e.detail.attempt} 次尝试失败: ${e.detail.error}`, 'warn');
});
loader.addEventListener('cascade', (e) => {
  log(`级联: ${e.detail.from} 失败 -> ${e.detail.to} 降级继续`, 'warn');
});

const perf = new PerfMonitor((entry) => {
  if (entry.type === 'measure') {
    log(`性能: ${entry.name} 耗时 ${entry.duration}ms`);
  }
});
perf.start();

const graph = new GraphView($('#graph'), loader);
graph.refresh();
renderModules();
renderHistory();

// ---------- 顶部操作 ----------
$('#btn-load-all').onclick = async () => {
  log('开始按需加载全部模块…');
  await loader.loadAll();
  log('全部模块加载流程结束');
};
$('#btn-load-report').onclick = () => {
  log('按需加载 report（将自动解析依赖链 api/charts/broken）…');
  loader.load('report').catch(() => {});
};
$('#btn-register-cycle').onclick = () => {
  try {
    loader.register({ id: 'cycleA', url: './modules/core.js', deps: ['cycleB'] });
    loader.register({ id: 'cycleB', url: './modules/core.js', deps: ['cycleA'] });
  } catch (err) {
    log(`循环依赖检测: ${err.message}`, 'error');
  }
  renderModules();
  graph.refresh();
};
$('#btn-clear-history').onclick = async () => {
  await history.clear().catch(() => {});
  renderHistory();
  log('历史已清空');
};

// ---------- 页面卸载清理 ----------
window.addEventListener('pagehide', cleanup);
window.addEventListener('beforeunload', cleanup);
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  loader.destroy();   // 中断所有进行中的 fetch
  graph.destroy();    // 终止 worker、取消 rAF
  perf.stop();        // 断开 PerformanceObserver
  history.close();    // 关闭 IndexedDB
}
