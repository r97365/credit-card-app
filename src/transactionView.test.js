import test from 'node:test'
import assert from 'node:assert/strict'
import { transactionsInView, transactionIsInView } from './transactionView.js'

const card={id:'card',name:'Test',statementCloseDay:10}
const item=(i,date,opts={})=>({
  id:String(i),cardId:'card',date,amount:100,
  createdAt:'2026-10-29T18:00:'+String(i).padStart(2,'0')+'Z',
  ...opts,
})

test('all 15 saved transactions render; no hidden first-eight limit',()=>{
  const rows=Array.from({length:15},(_,i)=>item(i,'2026-10-29'))
  const shown=transactionsInView(rows,card,{mode:'month',month:'2026-10'})
  assert.equal(shown.length,15)
  assert.deepEqual(shown.map(tx=>tx.id),Array.from({length:15},(_,i)=>String(14-i)))
})

test('recent purchase on earlier day cannot be hidden by creation order',()=>{
  const rows=[item(1,'2026-10-01'),item(2,'2026-10-28'),item(3,'2026-10-20')]
  assert.deepEqual(transactionsInView(rows,card,{mode:'month',month:'2026-10'}).map(tx=>tx.id),['2','3','1'])
})

test('a statement-period view uses posted date and manual period override',()=>{
  const rows=[
    item(1,'2026-10-09',{postedDate:'2026-10-12'}),
    item(2,'2026-10-09',{postedDate:'2026-10-09'}),
    item(3,'2026-09-19',{statementPeriodOverride:'2026-11'})
  ]
  assert.deepEqual(transactionsInView(rows,card,{mode:'statement',month:'2026-11'}).map(tx=>tx.id),['1','3'])
  assert.deepEqual(transactionsInView(rows,card,{mode:'statement',month:'2026-10'}).map(tx=>tx.id),['2'])
})

test('custom date filters include their start and end days',()=>{
  const rows=[item(1,'2026-09-19'),item(2,'2026-09-20'),item(3,'2026-10-10'),item(4,'2026-10-11')]
  const selected=transactionsInView(rows,card,{
    mode:'range',month:'2026-10',rangeStart:'2026-09-20',rangeEnd:'2026-10-10'
  })
  assert.deepEqual(selected.map(tx=>tx.id),['3','2'])
})

test('other cards do not leak into the currently selected list',()=>{
  const rows=[item(1,'2026-10-29'),item(2,'2026-10-29',{cardId:'other'})]
  assert.equal(transactionsInView(rows,card,{mode:'month',month:'2026-10'}).length,1)
})

test('item outside chosen month is intentionally filtered, not lost',()=>{
  const tx=item(1,'2026-11-01')
  assert.equal(transactionIsInView(tx,card,{mode:'month',month:'2026-10'}),false)
  assert.equal(transactionIsInView(tx,card,{mode:'month',month:'2026-11'}),true)
})
