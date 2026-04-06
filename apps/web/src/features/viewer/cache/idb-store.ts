/**
 * IndexedDB store for dataset metadata registry and edit log storage.
 *
 * Uses a single database "viewer-cache" with two object stores:
 *   - datasets: dataset registry entries
 *   - editLogs: edit log entries (Phase 3)
 */

const DB_NAME = 'viewer-cache'
const DB_VERSION = 1
const DATASETS_STORE = 'datasets'
const EDIT_LOGS_STORE = 'editLogs'

export interface DatasetEntry {
  id: string
  fileName: string
  fileSize: number
  pointCount: number
  cacheSize: number
  lastAccess: number // timestamp ms
  createdAt: number // timestamp ms
}

export interface EditLogEntry {
  id: string
  datasetId: string
  timestamp: number
  operation: string
  payload: unknown
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(DATASETS_STORE)) {
        const store = db.createObjectStore(DATASETS_STORE, { keyPath: 'id' })
        store.createIndex('lastAccess', 'lastAccess')
      }

      if (!db.objectStoreNames.contains(EDIT_LOGS_STORE)) {
        const store = db.createObjectStore(EDIT_LOGS_STORE, { keyPath: 'id' })
        store.createIndex('datasetId', 'datasetId')
        store.createIndex('timestamp', 'timestamp')
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function txn<T>(
  storeName: string,
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    openDb()
      .then((db) => {
        const tx = db.transaction(storeName, mode)
        const store = tx.objectStore(storeName)
        const request = callback(store)
        request.onsuccess = () => {
          db.close()
          resolve(request.result)
        }
        request.onerror = () => {
          db.close()
          reject(request.error)
        }
      })
      .catch(reject)
  })
}

function txnAll<T>(
  storeName: string,
  callback: (store: IDBObjectStore) => IDBRequest<T[]>,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    openDb()
      .then((db) => {
        const tx = db.transaction(storeName, 'readonly')
        const store = tx.objectStore(storeName)
        const request = callback(store)
        request.onsuccess = () => {
          db.close()
          resolve(request.result)
        }
        request.onerror = () => {
          db.close()
          reject(request.error)
        }
      })
      .catch(reject)
  })
}

// --- Dataset CRUD ---

export async function getDataset(id: string): Promise<DatasetEntry | undefined> {
  return txn<DatasetEntry | undefined>(DATASETS_STORE, 'readonly', store =>
    store.get(id))
}

export async function listDatasets(): Promise<DatasetEntry[]> {
  return txnAll<DatasetEntry>(DATASETS_STORE, store => store.getAll())
}

export async function putDataset(entry: DatasetEntry): Promise<void> {
  await txn(DATASETS_STORE, 'readwrite', store => store.put(entry))
}

export async function deleteDataset(id: string): Promise<void> {
  await txn(DATASETS_STORE, 'readwrite', store => store.delete(id))
}

export async function touchDataset(id: string): Promise<void> {
  const entry = await getDataset(id)
  if (!entry)
    return
  await putDataset({ ...entry, lastAccess: Date.now() })
}

export async function updateCacheSize(
  id: string,
  cacheSize: number,
): Promise<void> {
  const entry = await getDataset(id)
  if (!entry)
    return
  await putDataset({ ...entry, cacheSize })
}

// --- Edit Log CRUD (Phase 3) ---

export async function putEditLog(entry: EditLogEntry): Promise<void> {
  await txn(EDIT_LOGS_STORE, 'readwrite', store => store.put(entry))
}

export async function getEditLogs(datasetId: string): Promise<EditLogEntry[]> {
  return new Promise((resolve, reject) => {
    openDb()
      .then((db) => {
        const tx = db.transaction(EDIT_LOGS_STORE, 'readonly')
        const store = tx.objectStore(EDIT_LOGS_STORE)
        const index = store.index('datasetId')
        const request = index.getAll(datasetId)
        request.onsuccess = () => {
          db.close()
          resolve(request.result)
        }
        request.onerror = () => {
          db.close()
          reject(request.error)
        }
      })
      .catch(reject)
  })
}

export async function deleteEditLogs(datasetId: string): Promise<void> {
  const logs = await getEditLogs(datasetId)
  const db = await openDb()
  const tx = db.transaction(EDIT_LOGS_STORE, 'readwrite')
  const store = tx.objectStore(EDIT_LOGS_STORE)

  for (const log of logs) {
    store.delete(log.id)
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
  })
}
