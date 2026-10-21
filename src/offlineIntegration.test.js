import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  saveSnapshot,getSnapshot,queueMutation,queueMutations,getQueuedMutations,removeMutation,
  isUsableSnapshot,supportsStatementCycles,
} from './offlineStore.js'
import { mergeCardsWithLocalPending,mergeTransactionsWithLocalPending } from './offlineMerge.js'

const user='offline-integrated-test'
const card={id:'card',name:'Sport',bank:'E',statementCloseDay:10,archived:false,
  rewardPrograms:[{id:'p',name:'Cashback',rate:3,capPeriod:'statement'}],sortOrder:0}
const base={cards:[card],transactions:[{id:'t',cardId:'card',date:'2026-10-09',
  postedDate:'2026-10-12',amount:100,title:'Before',programExclusions:[]}]}

test('complete offline snapshot retains schema and reward settings after full app restart',async()=>{
  assert.equal(await saveSnapshot(user,{...base,cycleSchemaReady:true}),true)
  const restored=await getSnapshot(user)
  assert.equal(restored.cards[0].statementCloseDay,10)
  assert.equal(restored.cards[0].rewardPrograms[0].capPeriod,'statement')
  assert.equal(supportsStatementCycles(restored),true)
})

test('incomplete/empty card snapshots are rejected without damaging cached data',async()=>{
  assert.equal(await saveSnapshot(user,{cards:[],transactions:[{id:'t'}]}),false)
  assert.equal(await saveSnapshot(user,{cards:[],transactions:[]}),false)
  const restored=await getSnapshot(user)
  assert.equal(restored.cards[0].name,'Sport')
  assert.equal(isUsableSnapshot(restored),true)
})

test('offline newly created transaction persists in queue without a completed snapshot',async()=>{
  const mutation=await queueMutation(user,{entity:'transaction',recordId:'new',op:'create',payload:{
    id:'new',card_id:'card',transaction_date:'2026-10-10',title:'Offline purchase',
    amount:500,updated_at:'2026-10-21T10:00:00.000Z'
  },programExclusions:[]})
  const restored=await getSnapshot(user)
  const queue=await getQueuedMutations(user)
  const merged=mergeTransactionsWithLocalPending(restored.transactions,restored.transactions,queue)
  assert.equal(merged.find(t=>t.id==='new').amount,500)
  await removeMutation(mutation.id)
})

test('ordered create, edit and delete mutations survive a restart without merging away edits',async()=>{
  const a=await queueMutation(user,{entity:'transaction',recordId:'n2',op:'create',payload:{
    id:'n2',card_id:'card',transaction_date:'2026-10-10',title:'New',amount:300,
    updated_at:'2026-10-21T10:01:00.000Z'
  }})
  const b=await queueMutation(user,{entity:'transaction',recordId:'n2',op:'update',payload:{
    id:'n2',card_id:'card',transaction_date:'2026-10-10',title:'New update',amount:400,
    updated_at:'2026-10-21T10:02:00.000Z'
  },baseUpdatedAt:'2026-10-21T10:01:00.000Z'})
  const q=await getQueuedMutations(user)
  assert.deepEqual(q.filter(x=>x.recordId==='n2').map(x=>x.op),['create','update'])
  const restored=await getSnapshot(user)
  let output=mergeTransactionsWithLocalPending(restored.transactions,restored.transactions,q)
  assert.equal(output.find(x=>x.id==='n2').amount,400)

  const d=await queueMutation(user,{entity:'transaction',recordId:'n2',op:'delete',
    baseUpdatedAt:'2026-10-21T10:02:00.000Z',notBefore:Date.now()+1000})
  const finalQueue=await getQueuedMutations(user)
  assert.deepEqual(finalQueue.filter(x=>x.recordId==='n2').map(x=>x.op),['create','update','delete'])
  output=mergeTransactionsWithLocalPending(restored.transactions,restored.transactions,finalQueue)
  assert.equal(output.some(x=>x.id==='n2'),false)
  for(const m of [a,b,d]) await removeMutation(m.id)
})

test('applying an offline card edit from pending queue preserves statement view',async()=>{
  const edit=await queueMutation(user,{entity:'card',recordId:'card',op:'update',payload:{
    id:'card',name:'Sport updated',bank:'E',statement_close_day:10,sort_order:0,
    reward_date_basis:'transaction',color_a:'#171B24',color_b:'#3A4454'
  }})
  const restored=await getSnapshot(user)
  const updated=mergeCardsWithLocalPending(restored.cards,restored.cards,await getQueuedMutations(user))
  assert.equal(updated[0].statementCloseDay,10)
  assert.equal(updated[0].name,'Sport updated')
  await removeMutation(edit.id)
})

test('batch card reorder is persisted atomically and keeps the intended order',async()=>{
  const u='batch-reorder-offline'
  const payload=id=>({
    id,name:id,bank:'',sort_order:id==='A'?1:0,
    statement_close_day:10,updated_at:'2026-10-21T10:00:00.000Z'
  })
  const writes=await queueMutations(u,[
    {entity:'card',recordId:'A',op:'update',payload:payload('A')},
    {entity:'card',recordId:'B',op:'update',payload:payload('B')},
  ])
  assert.equal(writes.length,2)
  const ordered=await getQueuedMutations(u)
  assert.deepEqual(ordered.map(x=>x.recordId),['A','B'])
  assert.ok(ordered[0].sequence < ordered[1].sequence)
  for(const m of writes)await removeMutation(m.id)
})

test('rapid queued edits with identical wall-clock timestamps preserve their queue order',async()=>{
  const u='fast-queued-updates'
  const time='2026-10-21T10:00:00.000Z'
  const items=await queueMutations(u,[
    {entity:'transaction',op:'create',recordId:'new',
      createdAt:time,payload:{id:'new',amount:100,title:'First'}},
    {entity:'transaction',op:'update',recordId:'new',
      createdAt:time,payload:{id:'new',amount:200,title:'Second'}},
    {entity:'transaction',op:'delete',recordId:'new',
      createdAt:time,payload:null},
  ])
  assert.deepEqual((await getQueuedMutations(u)).map(x=>x.op),['create','update','delete'])
  for(const m of items)await removeMutation(m.id)
})
