import { supabase } from './supabase'
import {
  getQueuedMutations,
  removeMutation,
  saveConflict,
  getConflicts,
  removeConflict,
} from './offlineStore'

const TABLES = {
  card: 'cards',
  program: 'reward_programs',
  transaction: 'transactions',
  exclusion: 'transaction_reward_exclusions',
}

function isProbablyOffline(error) {
  if (!navigator.onLine) return true
  const message = String(error?.message || error || '').toLowerCase()
  return message.includes('fetch') || message.includes('network') || message.includes('failed to fetch')
}

async function getRemoteRow(entity, recordId) {
  const table = TABLES[entity]
  if (!table || entity === 'exclusion') return null
  const { data, error } = await supabase.from(table).select('*').eq('id', recordId).maybeSingle()
  if (error) throw error
  return data || null
}

async function applyMutation(mutation, { force = false } = {}) {
  const table = TABLES[mutation.entity]
  if (!table) throw new Error(`Unknown sync entity: ${mutation.entity}`)

  if (!force && mutation.op !== 'create' && mutation.entity !== 'exclusion' && mutation.baseUpdatedAt) {
    const remote = await getRemoteRow(mutation.entity, mutation.recordId)
    if (remote?.updated_at && remote.updated_at !== mutation.baseUpdatedAt) {
      return { conflict:true, remote }
    }
  }

  if (mutation.op === 'delete') {
    const { error } = await supabase.from(table).delete().eq('id', mutation.recordId)
    if (error) throw error
    return { ok:true }
  }

  const payload = {
    ...mutation.payload,
    updated_at: mutation.entity === 'exclusion'
      ? undefined
      : (mutation.payload?.updated_at || new Date().toISOString()),
  }
  if (payload.updated_at === undefined) delete payload.updated_at

  const exclusions = mutation.programExclusions
  if (mutation.op === 'create') {
    const { error } = await supabase.from(table).insert(payload)
    if (error) throw error
  } else {
    const { error } = await supabase.from(table).update(payload).eq('id', mutation.recordId)
    if (error) throw error
  }

  if (mutation.entity === 'transaction' && Array.isArray(exclusions)) {
    const { error: clearError } = await supabase
      .from('transaction_reward_exclusions')
      .delete()
      .eq('transaction_id', mutation.recordId)
    if (clearError) throw clearError

    if (exclusions.length) {
      const rows = exclusions.map(rewardProgramId => ({
        user_id: mutation.userId,
        transaction_id: mutation.recordId,
        reward_program_id: rewardProgramId,
      }))
      const { error: exclusionError } = await supabase
        .from('transaction_reward_exclusions')
        .insert(rows)
      if (exclusionError) throw exclusionError
    }
  }

  return { ok:true }
}

export async function flushMutationQueue(userId) {
  if (!userId || !navigator.onLine) return { synced:0, conflicts:0, offline:true }

  const queue = await getQueuedMutations(userId)
  let synced = 0
  let conflicts = 0

  for (const mutation of queue) {
    try {
      const result = await applyMutation(mutation)
      if (result.conflict) {
        await saveConflict(userId, {
          entity:mutation.entity,
          recordId:mutation.recordId,
          mutationId:mutation.id,
          localPayload:mutation.payload,
          remotePayload:result.remote,
          op:mutation.op,
          baseUpdatedAt:mutation.baseUpdatedAt,
        })
        conflicts += 1
        continue
      }
      await removeMutation(mutation.id)
      synced += 1
    } catch (error) {
      if (isProbablyOffline(error)) {
        return { synced, conflicts, offline:true }
      }
      throw error
    }
  }

  return { synced, conflicts, offline:false }
}

export async function resolveConflict(userId, conflict, choice) {
  if (choice === 'local') {
    const mutation = {
      id: conflict.mutationId,
      userId,
      entity: conflict.entity,
      recordId: conflict.recordId,
      op: conflict.op,
      payload: conflict.localPayload,
      baseUpdatedAt: conflict.baseUpdatedAt,
    }
    await applyMutation(mutation, { force:true })
  }

  if (conflict.mutationId) await removeMutation(conflict.mutationId)
  await removeConflict(conflict.id)
}

export async function loadConflicts(userId) {
  return getConflicts(userId)
}

export function networkError(error) {
  return isProbablyOffline(error)
}
