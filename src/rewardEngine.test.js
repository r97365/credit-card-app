import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateCardSummary, calculateCardSummaryRange } from './rewardEngine.js'

const reward = ({ id, name, rate, startDate, endDate }) => ({
  id, name, rate, startDate, endDate,
  rewardCap:null, spendCap:null,
  calcMode:'monthly_total', rounding:'floor',
})
const card = (programs, basis='transaction') => ({
  id:'card-1',
  rewardPrograms:programs,
  rewardDateBasis:basis,
  monthlySpendLimit:10000,
})
const tx = (id, date, amount, postedDate=null) => ({
  id, cardId:'card-1', date, postedDate,
  amount, excluded:false, programExclusions:[],
})

test('new 2027 programs do not alter 2026 transactions or historical rewards', () => {
  const old = reward({ id:'old', name:'2026 basic', rate:1, startDate:'2026-01-01', endDate:'2026-12-31' })
  const renewed = reward({ id:'new', name:'2027 basic', rate:3, startDate:'2027-01-01', endDate:'2027-12-31' })
  const records = [tx('a','2026-12-20',1000),tx('b','2027-01-05',2000)]

  const decemberBefore = calculateCardSummary(card([old]), records,'2026-12')
  const decemberAfter = calculateCardSummary(card([old,renewed]), records,'2026-12')
  assert.equal(decemberBefore.totalReward,10)
  assert.equal(decemberAfter.totalReward,10)
  assert.deepEqual(decemberAfter.programs.map(p=>p.id),['old'])

  const january = calculateCardSummary(card([old,renewed]),records,'2027-01')
  assert.equal(january.totalReward,60)
  assert.deepEqual(january.programs.map(p=>p.id),['new'])
})

test('mid-month program starts apply only to eligible dates within that month', () => {
  const p=reward({id:'jan',name:'Jan 10 onwards',rate:3,startDate:'2027-01-10',endDate:'2027-01-31'})
  const records=[tx('early','2027-01-05',1000),tx('later','2027-01-15',1000)]
  const result=calculateCardSummary(card([p]),records,'2027-01')
  assert.equal(result.totalSpend,2000)
  assert.equal(result.programs[0].eligibleSpend,1000)
  assert.equal(result.totalReward,30)
})

test('posted-date recognition respects posting date when supplied', () => {
  const p=reward({id:'p',name:'Jan',rate:2,startDate:'2027-01-10',endDate:'2027-01-31'})
  const records=[tx('a','2027-01-05',1000,'2027-01-15')]
  assert.equal(calculateCardSummary(card([p],'posted'),records,'2027-01').totalReward,20)
  assert.equal(calculateCardSummary(card([p],'transaction'),records,'2027-01').totalReward,0)
})

test('cross-month range calculation retains monthly caps and exact program windows', () => {
  const old={...reward({id:'old',name:'2026',rate:1,startDate:'2026-01-01',endDate:'2026-12-31'}),rewardCap:10}
  const next={...reward({id:'next',name:'2027',rate:3,startDate:'2027-01-01',endDate:'2027-12-31'}),rewardCap:30}
  const rows=[tx('a','2026-12-31',2000),tx('b','2027-01-01',2000)]
  const results=calculateCardSummaryRange(card([old,next]),rows,'2026-12-01','2027-01-31')
  assert.equal(results.totalReward,40)
  assert.equal(results.programs.length,2)
})
