const DB_NAME = 'card-rewards-offline'
const DB_VERSION = 2
const SNAPSHOTS = 'snapshots'
const SNAPSHOT_BACKUPS = 'snapshotBackups'
const QUEUE = 'mutationQueue'
const CONFLICTS = 'conflicts'

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(SNAPSHOTS)) {
        db.createObjectStore(SNAPSHOTS, { keyPath:'userId' })
      }
      if (!db.objectStoreNames.contains(SNAPSHOT_BACKUPS)) {
        db.createObjectStore(SNAPSHOT_BACKUPS, { keyPath:'userId' })
      }
      if (!db.objectStoreNames.contains(QUEUE)) {
        const store = db.createObjectStore(QUEUE, { keyPath:'id' })
        store.createIndex('userId', 'userId', { unique:false })
      }
      if (!db.objectStoreNames.contains(CONFLICTS)) {
        const store = db.createObjectStore(CONFLICTS, { keyPath:'id' })
        store.createIndex('userId', 'userId', { unique:false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('離線資料庫正在被另一個視窗使用，請關閉其他分頁後重試。'))
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

// Cards must be loaded alongside transactions. A transaction-only state is a
// *partial render*, not a valid complete snapshot.
export function isUsableSnapshot(snapshot) {
  return !!snapshot &&
    Array.isArray(snapshot.cards) &&
    Array.isArray(snapshot.transactions) &&
    (snapshot.cards.length > 0 || snapshot.transactions.length === 0)
}

export function supportsStatementCycles(snapshot) {
  if (!snapshot) return false
  if (snapshot.schemaVersion >= 2 || snapshot.cycleSchemaReady === true) return true
  return Array.isArray(snapshot.cards) && snapshot.cards.some(card =>
    Number.isInteger(Number(card?.statementCloseDay)) &&
      Number(card.statementCloseDay) >= 1 &&
      Number(card.statementCloseDay) <= 31
  )
}

export function shouldReplaceSnapshot(previous, incoming) {
  if (!isUsableSnapshot(incoming)) return false
  // Archiving cards retains them in the card array. There is currently no
  // delete-all-cards action, so do not overwrite a populated cache with [].
  if (isUsableSnapshot(previous) && previous.cards.length && !incoming.cards.length) return false
  return true
}

export async function saveSnapshot(userId, data) {
  if (!userId) return false
  const next = {
    userId,
    cards:data.cards,
    transactions:data.transactions,
    schemaVersion:data.schemaVersion || (data.cycleSchemaReady ? 2 : 1),
    savedAt:new Date().toISOString(),
  }
  if (!isUsableSnapshot(next)) return false

  const db = await openDb()
  try {
    const tx = db.transaction([SNAPSHOTS, SNAPSHOT_BACKUPS], 'readwrite')
    const primary = tx.objectStore(SNAPSHOTS)
    const backup = tx.objectStore(SNAPSHOT_BACKUPS)
    const previous = await requestResult(primary.get(userId))
    if (shouldReplaceSnapshot(previous, next)) {
      if (isUsableSnapshot(previous)) {
        backup.put(previous)
      }
      primary.put(next)
    }
    await txDone(tx)
    return shouldReplaceSnapshot(previous,next)
  } finally {
    db.close()
  }
}

export async function getSnapshot(userId) {
  if (!userId) return null
  const db = await openDb()
  try {
    const tx = db.transaction([SNAPSHOTS, SNAPSHOT_BACKUPS], 'readonly')
    const primary = await requestResult(tx.objectStore(SNAPSHOTS).get(userId))
    const backup = await requestResult(tx.objectStore(SNAPSHOT_BACKUPS).get(userId))
    await txDone(tx)
    // An older app might have written an empty primary just before a crash.
    // Prefer a populated last-known-good backup instead of treating it as a new wallet.
    if (isUsableSnapshot(backup) && backup.cards.length &&
        (!isUsableSnapshot(primary) || !primary.cards.length)) return backup
    return isUsableSnapshot(primary) ? primary : isUsableSnapshot(backup) ? backup : null
  } finally {
    db.close()
  }
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
    // Never mutate an enqueued create in-place. It may already be in flight,
    // so keep the create and append a separate update with its own queue ID.
    const previousUpdates = same.filter(item => item.op === 'update')
    const earliestBase = previousUpdates.find(item => item.baseUpdatedAt)?.baseUpdatedAt
      || next.baseUpdatedAt || null
    for (const item of previousUpdates) store.delete(item.id)
    next.baseUpdatedAt = earliestBase
    store.put(next)
  } else if (next.op === 'delete') {
    // An enqueued create might currently be uploading. Always retain the
    // delete tombstone instead of canceling create and risking resurrection.
    const previousUpdates = same.filter(item => item.op === 'update')
    const oldDelete = same.find(item => item.op === 'delete')
    const earliestBase = previousUpdates.find(item => item.baseUpdatedAt)?.baseUpdatedAt
      || oldDelete?.baseUpdatedAt || next.baseUpdatedAt || null
    for (const item of previousUpdates) store.delete(item.id)
    for (const item of same.filter(item => item.op === 'delete')) store.delete(item.id)
    next.baseUpdatedAt = earliestBase
    store.put(next)
  } else {
    for (const item of same.filter(item => item.op === 'create')) store.delete(item.id)
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

export async function getQueuedMutationById(id) {
  const db = await openDb()
  const tx = db.transaction(QUEUE, 'readonly')
  const item = await requestResult(tx.objectStore(QUEUE).get(id))
  await txDone(tx)
  db.close()
  return item || null
}

export async function countQueuedMutations(userId) {
  return (await getQueuedMutations(userId)).length
}

export async function saveConflict(userId, conflict) {
  const db = await openDb()
  const tx = db.transaction(CONFLICTS, 'readwrite')
  const store = tx.objectStore(CONFLICTS)
  const rows = await requestResult(store.index('userId').getAll(userId))
  const previous = rows.find(row => row.entity === conflict.entity && row.recordId === conflict.recordId)
  for (const row of rows) {
    if (row.entity === conflict.entity && row.recordId === conflict.recordId) store.delete(row.id)
  }
  const remoteUnchanged = previous &&
    JSON.stringify(previous.remotePayload) === JSON.stringify(conflict.remotePayload) &&
    JSON.stringify(previous.remoteProgramExclusions) === JSON.stringify(conflict.remoteProgramExclusions)
  const next = {
    ...conflict,
    id: conflict.id || previous?.id || crypto.randomUUID(),
    userId,
    inspectedAt:conflict.inspectedAt || (remoteUnchanged ? previous?.inspectedAt : null),
    createdAt:previous?.createdAt || new Date().toISOString(),
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


export async function removeConflictsForRecord(userId, entity, recordId) {
  const db = await openDb()
  const tx = db.transaction(CONFLICTS, 'readwrite')
  const store = tx.objectStore(CONFLICTS)
  const rows = await requestResult(store.index('userId').getAll(userId))
  for (const row of rows || []) {
    if (row.entity === entity && row.recordId === recordId) store.delete(row.id)
  }
  await txDone(tx)
  db.close()
}
