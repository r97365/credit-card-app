import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveSelectedCard, readLastSelectedCard, rememberLastSelectedCard } from './cardPreference.js'

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
