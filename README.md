# JS 模块按需加载器（无框架）

纯原生实现：动态 `import()` + Fetch + AbortController + PerformanceObserver +
IndexedDB + Canvas + Web Worker，无任何框架与构建步骤。

## 运行

需要通过 HTTP 服务访问（ES Module / Worker 不支持 file://）：

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080
```

## 功能

- **按需加载 + 依赖声明**：`loader.register({ name, url, deps, fallbackUrl, timeout, maxRetries })`，按拓扑序加载。
- **失败重试**：指数退避，重试上限生效后进入降级链。
- **降级链**：主 URL → `fallbackUrl` → 内置兜底 stub（保证依赖方拿到可用导出）。
- **超时中断**：主线程计时 + 通知 Worker `AbortController` 中断 fetch。
- **级联处理**：依赖失败/被跳过时，下游模块标记级联失败，不再发起请求。
- **循环依赖检测**：DFS 三色标记，给出完整环路径，环上及受影响模块标记失败。
- **手动干预**：每个模块支持重试、跳过、替换降级 URL。
- **依赖图**：Canvas 按拓扑深度分列渲染，颜色对应状态，点击节点联动表格。
- **历史记录**：每次批量加载结束写入 IndexedDB，可展开查看、可清空。
- **页面卸载清理**：`pagehide` 时中断进行中请求、终止 Worker、断开 PerformanceObserver、关闭 IndexedDB。

## 演示场景（页面按钮）

| 场景 | 验证点 |
| --- | --- |
| 加载全部 | 正常拓扑加载、耗时/状态展示 |
| 模拟 404 → 降级 | 重试上限 → fallbackUrl 生效 |
| 模拟超时中断 | 不可路由地址 + 1.5s 超时 → AbortController 中断 → 降级 |
| 模拟降级失败 → 兜底 | 主/降级均 404 → 内置 stub，依赖方正常加载 |
| 模拟循环依赖 | a↔b 环检测，依赖环的模块级联失败 |
| 模拟依赖失败级联 | 无降级的核心模块失败 → 下游全部级联失败 |

## 目录结构

```
index.html
css/style.css
js/main.js                 入口：注册、UI、场景、清理
js/loader/ModuleLoader.js  核心加载器（重试/降级/级联/中断）
js/loader/DependencyGraph.js 依赖图 + 拓扑排序 + 环检测
js/loader/GraphView.js     Canvas 依赖图
js/loader/HistoryStore.js  IndexedDB 历史
js/loader/PerfMonitor.js   PerformanceObserver
js/workers/fetchWorker.js  模块源码拉取 Worker（可中断）
modules/                   示例业务模块与降级模块
```

## 模块间如何拿到依赖的导出

加载成功后，导出挂在 `globalThis.__APP_MODULES__[name]`，业务模块可读取
（见 `modules/beta.js`）。blob URL 方式 import 的模块不支持相对路径
import，跨模块引用请走该注册表。
