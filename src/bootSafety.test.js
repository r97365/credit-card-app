import test from 'node:test'
import assert from 'node:assert/strict'
import { withDeadline, recoverableNetworkFailure } from './bootSafety.js'

test('offline startup deadlines do not hang forever on unresolved network calls',async()=>{
  await assert.rejects(
    withDeadline(new Promise(()=>{}),20,'離線同步'),
    err=>err.code==='DEADLINE_EXCEEDED'
  )
})

test('successful cache load returns before its deadline',async()=>{
  const snapshot={cards:[{id:'a'}],transactions:[]}
  assert.deepEqual(await withDeadline(Promise.resolve(snapshot),100,'快照'),snapshot)
})

test('expired network and airplane-mode failures use safe cached fallback',()=>{
  assert.equal(recoverableNetworkFailure({code:'DEADLINE_EXCEEDED'},true),true)
  assert.equal(recoverableNetworkFailure(new Error('Failed to fetch'),true),true)
  assert.equal(recoverableNetworkFailure(new Error('unexpected SQL'),true),false)
  assert.equal(recoverableNetworkFailure(new Error('anything'),false),true)
})
