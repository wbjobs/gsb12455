// PerformanceObserver：收集模块 measure 与资源加载耗时
export class PerfMonitor {
  constructor(onEntry) {
    this.onEntry = onEntry;
    this.observer = null;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'measure' && entry.name.startsWith('module:')) {
            this.onEntry({ kind: 'measure', name: entry.name, duration: entry.duration });
          }
          if (entry.entryType === 'resource' && /\.js(\?|$)/.test(entry.name)) {
            this.onEntry({
              kind: 'resource',
              name: entry.name,
              duration: entry.duration,
              size: entry.transferSize,
            });
          }
        }
      });
      this.observer.observe({ entryTypes: ['measure', 'resource'] });
    } catch {
      this.observer = null;
    }
  }

  disconnect() {
    if (this.observer) this.observer.disconnect();
  }
}
