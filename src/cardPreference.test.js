import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveSelectedCard, readLastSelectedCard, rememberLastSelectedCard, readCardView, rememberCardView } from './cardPreference.js'

const cards = [
  { id:'a', archived:false },
  { id:'b', archived:false },
  { id:'c', archived:true },
]

function fakeStorage() {
  const data=new Map()
  return {
    getItem:key=>data.get(key) || null,
    setItem:(key,value)=>data.set(key,value),
    removeItem:key=>data.delete(key),
  }
}

test('restores the previously tapped top card when app is reopened', () => {
  const storage=fakeStorage()
  rememberLastSelectedCard('user1','b',storage)
  assert.equal(resolveSelectedCard(cards,{savedId:readLastSelectedCard('user1',storage)}),'b')
})

test('selections remain scoped to one account', () => {
  const storage=fakeStorage()
  rememberLastSelectedCard('user1','b',storage)
  rememberLastSelectedCard('user2','a',storage)
  assert.equal(readLastSelectedCard('user1',storage),'b')
  assert.equal(readLastSelectedCard('user2',storage),'a')
})

test('archived or missing saved cards fall back to a visible card', () => {
  assert.equal(resolveSelectedCard(cards,{savedId:'c'}),'a')
  assert.equal(resolveSelectedCard(cards,{savedId:'gone'}),'a')
  assert.equal(resolveSelectedCard([],{savedId:'a'}),null)
})

test('explicitly selected card wins over the saved preference', () => {
  assert.equal(resolveSelectedCard(cards,{preferredId:'a',savedId:'b'}),'a')
})

test('storage can be cleared without affecting permanent drag sorting', () => {
  const storage=fakeStorage()
  rememberLastSelectedCard('user1','b',storage)
  rememberLastSelectedCard('user1',null,storage)
  assert.equal(readLastSelectedCard('user1',storage),null)
  assert.deepEqual(cards.map(c=>c.id),['a','b','c'])
})

test('failure to access storage does not crash selection', () => {
  const failing={getItem(){throw new Error('disabled')},setItem(){throw new Error('disabled')},removeItem(){throw new Error('disabled')}}
  assert.equal(readLastSelectedCard('user1',failing),null)
  assert.doesNotThrow(()=>rememberLastSelectedCard('user1','b',failing))
})

test('each credit card keeps its own last chosen mode and month',()=>{
 const storage=fakeStorage()
 rememberCardView('u','a',{mode:'statement',month:'2026-11',rangeStart:'2026-11-01',rangeEnd:'2026-11-30'},storage)
 rememberCardView('u','b',{mode:'month',month:'2026-10',rangeStart:'2026-10-01',rangeEnd:'2026-10-31'},storage)
 assert.equal(readCardView('u','a',{defaultMonth:'2026-10',statementAllowed:true},storage).month,'2026-11')
 assert.equal(readCardView('u','a',{defaultMonth:'2026-10',statementAllowed:true},storage).mode,'statement')
 assert.equal(readCardView('u','b',{defaultMonth:'2026-11',statementAllowed:false},storage).month,'2026-10')
 assert.equal(readCardView('u','b',{defaultMonth:'2026-11',statementAllowed:false},storage).mode,'month')
})

test('latest selection overwrites only the same card',()=>{
 const storage=fakeStorage()
 rememberCardView('u','a',{mode:'statement',month:'2026-11',rangeStart:'2026-10-01',rangeEnd:'2026-11-30'},storage)
 rememberCardView('u','b',{mode:'month',month:'2026-10',rangeStart:'2026-10-01',rangeEnd:'2026-10-31'},storage)
 rememberCardView('u','a',{mode:'statement',month:'2026-10',rangeStart:'2026-10-01',rangeEnd:'2026-11-30'},storage)
 assert.equal(readCardView('u','a',{defaultMonth:'2026-11',statementAllowed:true},storage).month,'2026-10')
 assert.equal(readCardView('u','b',{defaultMonth:'2026-11'},storage).month,'2026-10')
})

test('unsupported statement mode restores as calendar without changing saved preference',()=>{
 const storage=fakeStorage()
 rememberCardView('u','a',{mode:'statement',month:'2026-11',rangeStart:'2026-10-01',rangeEnd:'2026-11-30'},storage)
 assert.equal(readCardView('u','a',{defaultMonth:'2026-10',statementAllowed:false},storage).mode,'month')
 assert.equal(readCardView('u','a',{defaultMonth:'2026-10',statementAllowed:true},storage).mode,'statement')
})

test('custom date range restores correctly and preferences are per-account',()=>{
 const storage=fakeStorage()
 rememberCardView('u','a',{mode:'range',month:'2026-12',rangeStart:'2026-09-20',rangeEnd:'2026-10-10'},storage)
 const view=readCardView('u','a',{defaultMonth:'2026-10'},storage)
 assert.equal(view.mode,'range')
 assert.equal(view.rangeStart,'2026-09-20')
 assert.equal(view.rangeEnd,'2026-10-10')
 assert.equal(readCardView('another','a',{defaultMonth:'2026-10'},storage).mode,'month')
})
