import { ModuleLoader } from './loader/ModuleLoader.js';
import { GraphView } from './loader/GraphView.js';
import { HistoryStore } from './loader/HistoryStore.js';
import { PerfMonitor } from './loader/PerfMonitor.js';

const loader = new ModuleLoader({ defaultTimeout: 8000, defaultMaxRetries: 2 });
const history = new HistoryStore();
const graphView = new GraphView(document.getElementById('graph'), loader.graph);
graphView.onSelect = (name) => highlightRow(name);

const STATUS_TEXT = {
  pending: '待加载', loading: '加载中', retrying: '重试中',
  loaded: '成功', fallback: '已降级', degraded: '兜底stub',
  failed: '失败', skipped: '已跳过',
};

// ---------- 模块注册 ----------

function registerBaseModules() {
  loader.register({ name: 'alpha', url: './modules/alpha.js' });
  loader.register({ name: 'beta', url: './modules/beta.js', deps: ['alpha'] });
  loader.register({ name: 'gamma', url: './modules/gamma.js', deps: ['alpha', 'beta'] });
  loader.register({
    name: 'delta', url: './modules/delta.js', deps: ['gamma'],
    fallbackUrl: './modules/delta.fallback.js',
  });
}

// ---------- 表格渲染 ----------

const tbody = document.getElementById('module-rows');

function renderTable() {
  tbody.innerHTML = '';
  for (const rec of loader.getRecords()) {
    const def = loader.defs.get(rec.name);
    const tr = document.createElement('tr');
    tr.dataset.name = rec.name;
    tr.innerHTML = `
      <td>${rec.name}</td>
      <td>${(def?.deps || []).join(', ') || '-'}</td>
      <td><span class="badge st-${rec.status}">${STATUS_TEXT[rec.status] || rec.status}</span></td>
      <td>${rec.duration ? rec.duration + ' ms' : '-'}</td>
      <td>${rec.retries}</td>
      <td class="reason" title="${rec.fallbackReason || rec.error || ''}">${rec.fallbackReason || rec.error || '-'}</td>
      <td class="actions">
        <button data-act="retry">重试</button>
        <button data-act="skip">跳过</button>
        <button data-act="replace">替换降级</button>
      </td>`;
    tbody.appendChild(tr);
  }
}

function highlightRow(name) {
  for (const tr of tbody.children) {
    tr.classList.toggle('selected', tr.dataset.name === name);
  }
}

tbody.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const name = btn.closest('tr').dataset.name;
  const act = btn.dataset.act;
  if (act === 'retry') await loader.retry(name);
  if (act === 'skip') loader.skip(name);
  if (act === 'replace') {
    const url = prompt(`为 ${name} 指定新的降级模块 URL:`, './modules/delta.fallback.js');
    if (url) await loader.replaceFallback(name, url);
  }
});

// ---------- 事件联动 ----------

loader.addEventListener('module-state', (e) => {
  const { name, record } = e.detail;
  graphView.setState(name, record.status);
  renderTable();
});
loader.addEventListener('graph-state', () => graphView.draw());

// 加载告一段落后（防抖）保存历史快照
let saveTimer = null;
loader.addEventListener('settled', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await history.saveSession(loader.getRecords());
      await renderHistory();
    } catch (err) {
      console.warn('历史保存失败', err);
    }
  }, 500);
});

// ---------- 性能面板 ----------

const perfLog = document.getElementById('perf-log');
const perfMonitor = new PerfMonitor((entry) => {
  const li = document.createElement('li');
  li.textContent = entry.kind === 'measure'
    ? `[measure] ${entry.name}: ${entry.duration.toFixed(1)}ms`
    : `[resource] ${entry.name.split('/').pop()}: ${entry.duration.toFixed(1)}ms`;
  perfLog.prepend(li);
  while (perfLog.children.length > 30) perfLog.lastChild.remove();
});

// ---------- 历史面板 ----------

async function renderHistory() {
  const box = document.getElementById('history-list');
  box.innerHTML = '';
  let sessions = [];
  try { sessions = await history.listSessions(10); } catch { return; }
  for (const s of sessions) {
    const div = document.createElement('div');
    div.className = 'session';
    const time = new Date(s.ts).toLocaleString();
    const ok = s.modules.filter((m) => ['loaded'].includes(m.status)).length;
    const deg = s.modules.filter((m) => ['fallback', 'degraded'].includes(m.status)).length;
    const bad = s.modules.filter((m) => ['failed', 'skipped'].includes(m.status)).length;
    div.innerHTML = `<details>
      <summary>${time} — 成功 ${ok} / 降级 ${deg} / 失败 ${bad}</summary>
      <pre>${s.modules.map((m) =>
        `${m.name}: ${STATUS_TEXT[m.status]} ${m.duration}ms 重试${m.retries}次${m.fallbackReason ? ' | ' + m.fallbackReason : ''}${m.error ? ' | ' + m.error : ''}`
      ).join('\n')}</pre>
    </details>`;
    box.appendChild(div);
  }
  if (!sessions.length) box.textContent = '暂无历史记录';
}

// ---------- 场景按钮 ----------

const scenarios = {
  async normal() {
    scenarios.reset();
    await loader.loadAll();
  },
  async notfound() {
    scenarios.reset();
    loader.register({
      name: 'news', url: './modules/__missing__.js', deps: ['alpha'],
      fallbackUrl: './modules/delta.fallback.js', maxRetries: 1,
    });
    await loader.load('news');
  },
  async timeout() {
    scenarios.reset();
    loader.register({
      name: 'slow', url: 'http://10.255.255.1:81/slow.js',
      timeout: 1500, maxRetries: 1,
      fallbackUrl: './modules/delta.fallback.js',
    });
    await loader.load('slow');
  },
  async fallbackFail() {
    scenarios.reset();
    loader.register({
      name: 'ads', url: './modules/__missing1__.js',
      fallbackUrl: './modules/__missing2__.js', maxRetries: 1,
    });
    loader.register({ name: 'ads-ui', url: './modules/alpha.js', deps: ['ads'] });
    await loader.load('ads-ui');
  },
  async cycle() {
    scenarios.reset();
    loader.register({ name: 'cycA', url: './modules/alpha.js', deps: ['cycB'] });
    loader.register({ name: 'cycB', url: './modules/beta.js', deps: ['cycA'] });
    loader.register({ name: 'cycC', url: './modules/gamma.js', deps: ['cycA'] });
    await loader.load('cycC');
  },
  async cascade() {
    scenarios.reset();
    loader.register({ name: 'core', url: './modules/__missing__.js', maxRetries: 1 });
    loader.register({ name: 'feature', url: './modules/alpha.js', deps: ['core'] });
    loader.register({ name: 'page', url: './modules/beta.js', deps: ['feature'] });
    await loader.load('page');
  },
  reset() {
    for (const n of [...loader.defs.keys()]) loader.unregister(n);
    registerBaseModules();
    loader.reset();
    graphView.draw();
  },
};

document.getElementById('controls').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const fn = scenarios[btn.dataset.scenario];
  if (fn) {
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; }
  }
});

document.getElementById('clear-history').addEventListener('click', async () => {
  await history.clear();
  await renderHistory();
});

// ---------- 页面卸载清理 ----------

window.addEventListener('pagehide', () => {
  loader.dispose();       // 中断进行中的请求、终止 Worker
  perfMonitor.disconnect();
  history.close();
});

// ---------- 启动 ----------

registerBaseModules();
renderTable();
graphView.draw();
renderHistory();
