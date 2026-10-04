const DB_NAME = 'card-rewards-offline'
const DB_VERSION = 1
const SNAPSHOTS = 'snapshots'
const QUEUE = 'mutationQueue'
const CONFLICTS = 'conflicts'

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(SNAPSHOTS)) {
        db.createObjectStore(SNAPSHOTS, { keyPath: 'userId' })
      }
      if (!db.objectStoreNames.contains(QUEUE)) {
        const store = db.createObjectStore(QUEUE, { keyPath: 'id' })
        store.createIndex('userId', 'userId', { unique: false })
      }
      if (!db.objectStoreNames.contains(CONFLICTS)) {
        const store = db.createObjectStore(CONFLICTS, { keyPath: 'id' })
        store.createIndex('userId', 'userId', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'))
  })
}

export async function saveSnapshot(userId, data) {
  if (!userId) return
  const db = await openDb()
  const tx = db.transaction(SNAPSHOTS, 'readwrite')
  tx.objectStore(SNAPSHOTS).put({
    userId,
    cards: data.cards || [],
    transactions: data.transactions || [],
    savedAt: new Date().toISOString(),
  })
  await txDone(tx)
  db.close()
}

export async function getSnapshot(userId) {
  if (!userId) return null
  const db = await openDb()
  const tx = db.transaction(SNAPSHOTS, 'readonly')
  const result = await requestResult(tx.objectStore(SNAPSHOTS).get(userId))
  await txDone(tx)
  db.close()
  return result || null
}

export async function queueMutation(userId, mutation) {
  const db = await openDb()
  const tx = db.transaction(QUEUE, 'readwrite')
  const store = tx.objectStore(QUEUE)
  const existing = await requestResult(store.index('userId').getAll(userId))
  const same = existing
    .filter(item => item.entity === mutation.entity && item.recordId === mutation.recordId)
    .sort((a,b) => a.createdAt.localeCompare(b.createdAt))

  const next = {
    ...mutation,
    id: mutation.id || crypto.randomUUID(),
    userId,
    createdAt: mutation.createdAt || new Date().toISOString(),
  }

  if (next.op === 'update') {
    const create = same.find(item => item.op === 'create')
    if (create) {
      create.payload = next.payload
      create.updatedAt = new Date().toISOString()
      store.put(create)
      for (const item of same) {
        if (item.id !== create.id) store.delete(item.id)
      }
      await txDone(tx)
      db.close()
      return create
    }

    const earliestBase = same.find(item => item.baseUpdatedAt)?.baseUpdatedAt || next.baseUpdatedAt || null
    for (const item of same) store.delete(item.id)
    next.baseUpdatedAt = earliestBase
    store.put(next)
  } else if (next.op === 'delete') {
    const create = same.find(item => item.op === 'create')
    if (create) {
      for (const item of same) store.delete(item.id)
      await txDone(tx)
      db.close()
      return null
    }

    const earliestBase = same.find(item => item.baseUpdatedAt)?.baseUpdatedAt || next.baseUpdatedAt || null
    for (const item of same) store.delete(item.id)
    next.baseUpdatedAt = earliestBase
    store.put(next)
  } else {
    for (const item of same) store.delete(item.id)
    store.put(next)
  }

  await txDone(tx)
  db.close()
  return next
}

export async function getQueuedMutations(userId) {
  const db = await openDb()
  const tx = db.transaction(QUEUE, 'readonly')
  const rows = await requestResult(tx.objectStore(QUEUE).index('userId').getAll(userId))
  await txDone(tx)
  db.close()
  return (rows || []).sort((a,b) => a.createdAt.localeCompare(b.createdAt))
}

export async function removeMutation(id) {
  const db = await openDb()
  const tx = db.transaction(QUEUE, 'readwrite')
  tx.objectStore(QUEUE).delete(id)
  await txDone(tx)
  db.close()
}

export async function countQueuedMutations(userId) {
  return (await getQueuedMutations(userId)).length
}

export async function saveConflict(userId, conflict) {
  const db = await openDb()
  const tx = db.transaction(CONFLICTS, 'readwrite')
  const store = tx.objectStore(CONFLICTS)
  const rows = await requestResult(store.index('userId').getAll(userId))
  for (const row of rows) {
    if (row.entity === conflict.entity && row.recordId === conflict.recordId) store.delete(row.id)
  }
  const next = {
    ...conflict,
    id: conflict.id || crypto.randomUUID(),
    userId,
    createdAt: new Date().toISOString(),
  }
  store.put(next)
  await txDone(tx)
  db.close()
  return next
}

export async function getConflicts(userId) {
  const db = await openDb()
  const tx = db.transaction(CONFLICTS, 'readonly')
  const rows = await requestResult(tx.objectStore(CONFLICTS).index('userId').getAll(userId))
  await txDone(tx)
  db.close()
  return (rows || []).sort((a,b) => a.createdAt.localeCompare(b.createdAt))
}

export async function removeConflict(id) {
  const db = await openDb()
  const tx = db.transaction(CONFLICTS, 'readwrite')
  tx.objectStore(CONFLICTS).delete(id)
  await txDone(tx)
  db.close()
}
