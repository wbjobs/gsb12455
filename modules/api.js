// 模拟不稳定模块：前两次加载抛错，第三次成功（通过会话内计数）
const key = '__api_fail_count__';
const g = globalThis;
g[key] = g[key] || 0;
g[key]++;
if (g[key] <= 2) {
  throw new Error('api 模块模拟网络/初始化失败（第 ' + g[key] + ' 次）');
}
export const name = 'api';
export function fetchData() { return Promise.resolve({ ok: true }); }
