/* Binary media store for Voice Memos.
 *
 * Recorded audio (already codec-compressed — Opus) is stored as a BINARY Blob,
 * never base64-inflated into the text KV store. The KV store (`amos.vmemos`)
 * keeps only metadata; the audio bytes live here under the memo id.
 *
 * Backend: IndexedDB in the Tauri/browser webview (large, persistent, binary),
 * with an in-memory fallback for headless tests / environments without
 * IndexedDB. The seam is minimal and dependency-free so it is easy to unit-test
 * the memory backend and easy to swap to a Rust on-disk media cache later.
 */

export interface MediaStore {
  readonly name: string;
  put(id: string, blob: Blob): Promise<void>;
  get(id: string): Promise<Blob | null>;
  del(id: string): Promise<void>;
}

/** In-memory backend — used by tests and as a graceful fallback. */
export function memoryMediaStore(): MediaStore {
  const map = new Map<string, Blob>();
  return {
    name: "memory",
    async put(id, blob) {
      map.set(id, blob);
    },
    async get(id) {
      return map.get(id) ?? null;
    },
    async del(id) {
      map.delete(id);
    },
  };
}

/** IndexedDB-backed backend for the real shell (binary + persistent). */
export function indexedDbMediaStore(
  dbName = "amos-media",
  storeName = "voice",
): MediaStore {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const open = () => {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(storeName)) {
            req.result.createObjectStore(storeName);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
      });
    }
    return dbPromise;
  };
  const runReq = async <T>(mode: IDBTransactionMode, make: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> => {
    const db = await open();
    return new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const r = make(t.objectStore(storeName));
      let value: T | undefined;
      r.onsuccess = () => {
        value = r.result;
      };
      r.onerror = () => reject(r.error ?? new Error("request error"));
      // Resolve only when the transaction COMMITS, so writes are durable and
      // reads have returned their (possibly absent) value.
      t.oncomplete = () => resolve(value);
      t.onerror = () => reject(t.error ?? new Error("tx error"));
      t.onabort = () => reject(new Error("tx aborted"));
    });
  };
  return {
    name: "indexeddb",
    async put(id, blob) {
      await runReq<IDBValidKey>("readwrite", (s) => s.put(blob, id));
    },
    async get(id) {
      return (await runReq<Blob>("readonly", (s) => s.get(id))) ?? null;
    },
    async del(id) {
      await runReq<undefined>("readwrite", (s) => s.delete(id));
    },
  };
}

/** True when the platform exposes IndexedDB (real shell). */
export function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== "undefined";
  } catch {
    return false;
  }
}

/** The app-wide default store: IndexedDB in the shell, memory otherwise. */
let cached: MediaStore | null = null;
export function defaultMediaStore(): MediaStore {
  if (!cached) {
    cached = hasIndexedDb() ? indexedDbMediaStore() : memoryMediaStore();
  }
  return cached;
}
