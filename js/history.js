/** HistoryStore — 用 IndexedDB 持久化模块加载历史，支持查询与清理。 */
export class HistoryStore {
  constructor(dbName = 'module-loader-history') {
    this.dbName = dbName;
    this.db = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('loads')) {
          const store = db.createObjectStore('loads', { keyPath: 'key', autoIncrement: true });
          store.createIndex('moduleId', 'moduleId', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
      req.onsuccess = () => { this.db = req.result; resolve(this); };
      req.onerror = () => reject(req.error);
    });
  }

  _tx(mode, fn) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('db not open'));
      const tx = this.db.transaction('loads', mode);
      const result = fn(tx.objectStore('loads'));
      tx.oncomplete = () => resolve(result && result._value !== undefined ? result._value : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  add(record) {
    return this._tx('readwrite', (store) => store.add(record));
  }

  /** 查询最近 limit 条，按时间倒序 */
  recent(limit = 100) {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve([]);
      const tx = this.db.transaction('loads', 'readonly');
      const store = tx.objectStore('loads');
      const index = store.index('timestamp');
      const items = [];
      const cursorReq = index.openCursor(null, 'prev');
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor && items.length < limit) {
          items.push(cursor.value);
          cursor.continue();
        } else {
          resolve(items);
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  clear() {
    return this._tx('readwrite', (store) => store.clear());
  }

  close() {
    if (this.db) { this.db.close(); this.db = null; }
  }
}
