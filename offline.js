// ===========================================================================
// OFFLINE
// ===========================================================================
// A rehab happens in a driveway behind a block wall with one bar of signal.
// The rule here is that nothing you type is ever lost because of that:
//
//   - writes that cannot reach Supabase are put in a durable queue and replayed
//     the moment there is signal again
//   - photos are held as real blobs alongside the queue, not as fragile data
//     URLs, and uploaded with everything else
//   - the last data that did load is kept so opening the app offline shows the
//     project instead of an empty screen
//
// IndexedDB is used when it exists and an in-memory copy stands in when it does
// not, so private windows and locked-down browsers degrade to "works until you
// close the tab" rather than throwing.
const Offline = {
  db: null,
  memory: { queue: [], receipts: new Map() },
  listeners: [],
  urls: new Map(),      // receipt path -> object URL, for previewing what has not uploaded yet

  async init() {
    if (this.db !== null || typeof indexedDB === "undefined") return;
    try {
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("pet-offline", 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "id" });
          if (!db.objectStoreNames.contains("receipts")) db.createObjectStore("receipts", { keyPath: "path" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn("[offline] falling back to memory", err);
      this.db = null;
    }
  },

  _tx(store, mode, run) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      const req = run(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },

  online() {
    return typeof navigator === "undefined" || navigator.onLine !== false;
  },

  // A rejected write is only safe to queue if it failed on the way out. A
  // permission error or a bad column is a real answer from the server and must
  // surface, not sit in a queue retrying forever.
  isNetworkError(err) {
    if (!err) return false;
    if (!this.online()) return true;
    const msg = String(err.message || err).toLowerCase();
    return (
      err.name === "TypeError" ||
      err.name === "AbortError" ||
      msg.includes("failed to fetch") ||
      msg.includes("networkerror") ||
      msg.includes("network request failed") ||
      msg.includes("load failed") ||
      msg.includes("timeout")
    );
  },

  // ---------- the queue ----------
  async add(kind, payload) {
    await this.init();
    const item = {
      id: "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      kind,
      payload,
      at: new Date().toISOString(),
      tries: 0,
      error: "",
    };
    if (this.db) await this._tx("queue", "readwrite", (s) => s.put(item));
    else this.memory.queue.push(item);
    this.announce();
    return item;
  },

  async pending() {
    await this.init();
    const rows = this.db
      ? await this._tx("queue", "readonly", (s) => s.getAll())
      : this.memory.queue.slice();
    return rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  },

  async count() {
    return (await this.pending()).length;
  },

  async update(item) {
    await this.init();
    if (this.db) await this._tx("queue", "readwrite", (s) => s.put(item));
    else this.memory.queue = this.memory.queue.map((x) => (x.id === item.id ? item : x));
  },

  async remove(id) {
    await this.init();
    if (this.db) await this._tx("queue", "readwrite", (s) => s.delete(id));
    else this.memory.queue = this.memory.queue.filter((x) => x.id !== id);
    this.announce();
  },

  async clear() {
    await this.init();
    if (this.db) await this._tx("queue", "readwrite", (s) => s.clear());
    else this.memory.queue = [];
    this.announce();
  },

  // ---------- photos waiting for signal ----------
  async holdReceipt(path, blob) {
    await this.init();
    if (this.db) await this._tx("receipts", "readwrite", (s) => s.put({ path, blob }));
    else this.memory.receipts.set(path, blob);
    if (typeof URL !== "undefined" && URL.createObjectURL) {
      try {
        this.urls.set(path, URL.createObjectURL(blob));
      } catch (err) {
        console.warn("[offline] no preview for " + path, err);
      }
    }
  },

  async takeReceipt(path) {
    await this.init();
    if (this.db) {
      const row = await this._tx("receipts", "readonly", (s) => s.get(path));
      return row ? row.blob : null;
    }
    return this.memory.receipts.get(path) || null;
  },

  async dropReceipt(path) {
    await this.init();
    if (this.db) await this._tx("receipts", "readwrite", (s) => s.delete(path));
    else this.memory.receipts.delete(path);
    const url = this.urls.get(path);
    if (url && typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(url);
    this.urls.delete(path);
  },

  // Lets the ledger show a photo that exists only on this phone so far.
  previewUrl(path) {
    return this.urls.get(path) || null;
  },

  // ---------- last known good ----------
  // Kept per user so signing in as somebody else cannot show the previous
  // account's numbers, and wiped on sign-out.
  snapshotKey(userId) {
    return "pet-snapshot-" + (userId || "anon");
  },

  saveSnapshot(userId, data) {
    try {
      const json = JSON.stringify({ at: new Date().toISOString(), data });
      // A very large portfolio is not worth blowing the storage quota over;
      // the app simply loads from the network next time.
      if (json.length > 3_000_000) return;
      localStorage.setItem(this.snapshotKey(userId), json);
    } catch (err) {
      console.warn("[offline] could not save a snapshot", err);
    }
  },

  readSnapshot(userId) {
    try {
      const raw = localStorage.getItem(this.snapshotKey(userId));
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  },

  clearSnapshot(userId) {
    try {
      localStorage.removeItem(this.snapshotKey(userId));
    } catch (err) {
      /* nothing worth reporting */
    }
  },

  // ---------- telling the app ----------
  onChange(cb) {
    this.listeners.push(cb);
  },

  announce() {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (err) {
        console.error(err);
      }
    }
  },
};
