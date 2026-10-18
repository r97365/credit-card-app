import test from 'node:test'
import assert from 'node:assert/strict'
import { isUsableSnapshot, shouldReplaceSnapshot } from './offlineStore.js'
import { resolveSelectedCard } from './cardPreference.js'

const full = {
  userId:'user',cards:[{id:'sport',name:'Sport',archived:false}],
  transactions:[{id:'charge',cardId:'sport',amount:300}],
  savedAt:'2026-10-19T00:00:00Z',
}

test('a transaction-only partial load cannot overwrite a complete offline snapshot',()=>{
  const partial={cards:[],transactions:[{id:'charge',cardId:'sport'}]}
  assert.equal(isUsableSnapshot(partial),false)
  assert.equal(shouldReplaceSnapshot(full,partial),false)
})

test('an empty rendering of a populated wallet cannot erase cached credit cards',()=>{
  assert.equal(shouldReplaceSnapshot(full,{cards:[],transactions:[]}),false)
})

test('new accounts may safely cache a genuinely empty wallet',()=>{
  assert.equal(shouldReplaceSnapshot(null,{cards:[],transactions:[]}),true)
})

test('valid edits on populated wallet are allowed, including a refund or removed charge',()=>{
  assert.equal(shouldReplaceSnapshot(full,{cards:full.cards,transactions:[]}),true)
})

test('offline fallback restores a visible card from the last selection',()=>{
  assert.equal(resolveSelectedCard(full.cards,{savedId:'sport',currentId:null}),'sport')
})

test('offline fallback chooses first available card if saved preference was archived',()=>{
  assert.equal(resolveSelectedCard([{id:'old',archived:true},...full.cards],{savedId:'old'}),'sport')
})
