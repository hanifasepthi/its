type CacheEnvelope<T> = {
  key: string;
  value: T;
  storedAt: number;
};

const DATABASE_NAME = "its-map-detail-cache";
const STORE_NAME = "entries";
const DATABASE_VERSION = 1;

function openDatabase(): Promise<IDBDatabase | null> {
  if (!("indexedDB" in window)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function readEntry<T>(key: string): Promise<CacheEnvelope<T> | null> {
  const database = await openDatabase();
  if (!database) return null;
  return new Promise((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve((request.result as CacheEnvelope<T> | undefined) || null);
    request.onerror = () => resolve(null);
    transaction.oncomplete = () => database.close();
    transaction.onabort = () => database.close();
  });
}

async function writeEntry<T>(entry: CacheEnvelope<T>): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(entry);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
  database.close();
}

export const mapDetailCache = {
  async get<T>(key: string, maxAgeMs: number): Promise<T | null> {
    const entry = await readEntry<T>(key);
    if (!entry || Date.now() - entry.storedAt > maxAgeMs) return null;
    return entry.value;
  },

  async set<T>(key: string, value: T): Promise<void> {
    await writeEntry({ key, value, storedAt: Date.now() });
  },
};
