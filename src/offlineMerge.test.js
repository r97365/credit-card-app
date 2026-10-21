import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeCardsWithLocalPending, mergeTransactionsWithLocalPending } from './offlineMerge.js'

const card=(id='card')=>({id,name:'Existing',bank:'Bank',statementCloseDay:10,
  rewardPrograms:[{id:'old',name:'Old',rate:1}],sortOrder:0,archived:false,colors:['#111','#222']})
const cardPayload=(id='card')=>({id,name:'Renamed',bank:'Bank',statement_close_day:10,
  reward_date_basis:'posted',sort_order:0,color_a:'#111',color_b:'#222'})
const tx=(id='tx')=>({id,cardId:'card',date:'2026-10-09',title:'Original',
  amount:100,programExclusions:[],updatedAt:'old'})
const payload=(id='tx')=>({id,card_id:'card',transaction_date:'2026-10-09',posted_date:'2026-10-12',
  title:'Offline edit',amount:500,statement_period_override:'2026-11',
  excluded:false,reconciled:true,updated_at:'new'})

test('cached statement close day and reward activities survive offline rehydration',()=>{
  const out=mergeCardsWithLocalPending([card()], [card()],[])
  assert.equal(out[0].statementCloseDay,10)
  assert.equal(out[0].rewardPrograms[0].rate,1)
})

test('offline edits recover from queued payload even when snapshot is stale',()=>{
  const out=mergeTransactionsWithLocalPending([tx()],[tx()],[{
    entity:'transaction',op:'update',recordId:'tx',payload:payload(),
    programExclusions:['old']
  }])
  assert.equal(out[0].amount,500)
  assert.equal(out[0].postedDate,'2026-10-12')
  assert.equal(out[0].statementPeriodOverride,'2026-11')
  assert.deepEqual(out[0].programExclusions,['old'])
})

test('offline create survives app close before a new snapshot is saved',()=>{
  const out=mergeTransactionsWithLocalPending([],[],[{
    entity:'transaction',op:'create',recordId:'new',
    payload:payload('new'),programExclusions:[]
  }])
  assert.equal(out.length,1)
  assert.equal(out[0].title,'Offline edit')
})

test('queued delete tombstone wins over old cache and stale remote responses',()=>{
  const out=mergeTransactionsWithLocalPending([tx()],[tx()],[{
    entity:'transaction',op:'delete',recordId:'tx'
  }])
  assert.equal(out.length,0)
})

test('create then modify then delete leaves no record',()=>{
  const out=mergeTransactionsWithLocalPending([],[],[
    {entity:'transaction',op:'create',recordId:'tx',payload:payload()},
    {entity:'transaction',op:'update',recordId:'tx',payload:{...payload(),amount:700}},
    {entity:'transaction',op:'delete',recordId:'tx'}
  ])
  assert.equal(out.length,0)
})

test('queued card updates recover closing date and sorting without loaded React state',()=>{
  const out=mergeCardsWithLocalPending([card()],[card()],[{
    entity:'card',op:'update',recordId:'card',payload:cardPayload()
  }])
  assert.equal(out[0].name,'Renamed')
  assert.equal(out[0].statementCloseDay,10)
  assert.equal(out[0].rewardDateBasis,'posted')
})

test('queued new card and new reward program survive app restart',()=>{
  const out=mergeCardsWithLocalPending([],[],[
    {entity:'card',op:'create',recordId:'card',payload:cardPayload()},
    {entity:'program',op:'create',recordId:'p',payload:{
      id:'p',card_id:'card',name:'Statement 3%',rate:3,cap_period:'statement',
      reward_cap:300,calc_mode:'monthly_total',rounding:'floor'
    }}
  ])
  assert.equal(out.length,1)
  assert.equal(out[0].rewardPrograms.length,1)
  assert.equal(out[0].rewardPrograms[0].capPeriod,'statement')
})

test('program delete only affects its owning card',()=>{
  const second={...card('second'),rewardPrograms:[{id:'other',name:'Other',rate:2}]}
  const out=mergeCardsWithLocalPending([card(),second],[card(),second],[
    {entity:'program',op:'delete',recordId:'old'}
  ])
  assert.equal(out.find(card=>card.id==='card').rewardPrograms.length,0)
  assert.equal(out.find(card=>card.id==='second').rewardPrograms[0].name,'Other')
})

test('queued programs retain their period setting over a stale remote version',()=>{
  const out=mergeCardsWithLocalPending([card()],[card()],[{
    entity:'program',op:'update',recordId:'old',payload:{
      id:'old',card_id:'card',name:'New 3%',rate:3,cap_period:'statement',reward_cap:300
    }
  }])
  assert.equal(out[0].rewardPrograms[0].capPeriod,'statement')
  assert.equal(out[0].rewardPrograms[0].rate,3)
})
