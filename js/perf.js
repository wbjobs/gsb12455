/** PerfMonitor — PerformanceObserver 观察模块加载 measure 与资源计时。 */
export class PerfMonitor {
  constructor(onEntry) {
    this.onEntry = onEntry;
    this.observer = null;
  }

  start() {
    if (!('PerformanceObserver' in window)) return;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name.startsWith('mod:') || entry.entryType === 'resource') {
            this.onEntry({
              type: entry.entryType,
              name: entry.name,
              duration: Math.round(entry.duration),
              startTime: Math.round(entry.startTime),
            });
          }
        }
      });
      this.observer.observe({ entryTypes: ['measure', 'resource'] });
    } catch { /* 某些浏览器不支持部分 entryType */ }
  }

  stop() {
    if (this.observer) { this.observer.disconnect(); this.observer = null; }
  }
}
