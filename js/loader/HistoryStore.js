// IndexedDB 历史记录：每次批量加载保存一份会话快照，可回查
export class HistoryStore {
  constructor(dbName = 'module-loader-db') {
    this.dbName = dbName;
    this.db = null;
  }

  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('sessions')) {
          const store = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
          store.createIndex('ts', 'ts');
        }
      };
      req.onsuccess = () => { this.db = req.result; resolve(this.db); };
      req.onerror = () => reject(req.error);
    });
  }

  async saveSession(modules) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').add({ ts: Date.now(), modules });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async listSessions(limit = 20) {
    await this.open();
    return new Promise((resolve, reject) => {
      const out = [];
      const tx = this.db.transaction('sessions', 'readonly');
      const req = tx.objectStore('sessions').index('ts').openCursor(null, 'prev');
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor && out.length < limit) {
          out.push(cursor.value);
          cursor.continue();
        } else {
          resolve(out);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async clear() {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
