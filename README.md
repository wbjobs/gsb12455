# 动态模块加载器

纯原生 JS（无框架）实现的按需模块加载器：依赖声明、超时中断、重试上限、
降级链、级联处理、循环检测、加载历史与依赖图可视化。

## 运行

需通过静态服务器打开（ES Module + fetch 不支持 file://）：

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080
```

## 技术要点

- **动态 import + Fetch + AbortController**：fetch 拉取源码（可中断）→ Blob URL → `import()`
- **超时中断**：`AbortController` + 超时定时器，中断进行中的请求
- **重试上限**：仅作用于主源，线性退避；降级源各试一次
- **降级链**：主源 → 降级模块列表 → 终极兜底 stub（Proxy 空对象，保证依赖链不崩）
- **级联处理**：依赖彻底失败时注入 stub，下游模块标记 `degraded` 继续
- **循环检测**：注册时 DFS 检测，拒绝成环注册；加载期二次防御
- **依赖图**：Canvas 绘制，分层布局在 Web Worker 中计算
- **历史**：IndexedDB 持久化每次加载结果（状态/耗时/重试/降级原因）
- **性能**：PerformanceObserver 观察 `measure` 与 `resource` 条目
- **卸载清理**：`pagehide`/`beforeunload` 中断请求、终止 Worker、断开 Observer、关闭 DB

## 演示场景

| 模块 | 场景 |
| --- | --- |
| `api` | 前 2 次加载失败，第 3 次成功（重试） |
| `broken` | 主源与降级源均失败 → 终极兜底 stub |
| `slow` | 模拟 4s 慢网络，1.5s 超时中断 |
| `report` | 依赖 `api/charts/broken`，演示级联降级 |
| 循环按钮 | 注册 `cycleA ↔ cycleB`，演示循环检测 |

## 文件结构

```
index.html          页面
css/style.css       样式
js/loader.js        核心加载器
js/history.js       IndexedDB 历史
js/perf.js          PerformanceObserver
js/graph.js         Canvas 依赖图
js/layout-worker.js Web Worker 布局计算
js/app.js           UI 接线与卸载清理
modules/            演示模块与降级模块
```
