import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateCardSummary, calculateCardSummaryRange, calculateCardSummaryStatement, getStatementPeriodKey, getStatementPeriodBounds, isStatementPeriodEstimated } from './rewardEngine.js'

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


test('a 10th closing date produces complete adjacent nonoverlapping periods', () => {
  const item = { statementCloseDay:10 }
  assert.deepEqual(getStatementPeriodBounds(item,'2026-10'), {
    key:'2026-10', start:'2026-09-11',end:'2026-10-10',
  })
  assert.deepEqual(getStatementPeriodBounds(item,'2026-11'), {
    key:'2026-11', start:'2026-10-11',end:'2026-11-10',
  })
  assert.equal(getStatementPeriodKey(item,{ date:'2026-10-09',postedDate:'2026-10-12' }), '2026-11')
  assert.equal(getStatementPeriodKey(item,{ date:'2026-09-19',postedDate:'2026-09-19' }), '2026-10')
  assert.equal(getStatementPeriodKey(item,{ date:'2026-09-19',postedDate:'2026-09-19',statementPeriodOverride:'2026-11' }), '2026-11')
  assert.equal(isStatementPeriodEstimated({ date:'2026-10-10' }),true)
  assert.equal(isStatementPeriodEstimated({ date:'2026-10-10',postedDate:'2026-10-12' }),false)
  assert.equal(getStatementPeriodBounds({},'2026-10'),null)
})

test('closing day 31 correctly handles February and leap years', () => {
  const item={ statementCloseDay:31 }
  assert.deepEqual(getStatementPeriodBounds(item,'2028-02'),{
    key:'2028-02',start:'2028-02-01',end:'2028-02-29',
  })
  assert.deepEqual(getStatementPeriodBounds(item,'2027-03'),{
    key:'2027-03',start:'2027-03-01',end:'2027-03-31',
  })
})

test('calendar month cap and statement cap reset independently on same card', () => {
  const a={...reward({id:'a',name:'Calendar 1%',rate:1}),capPeriod:'calendar',rewardCap:50}
  const b={...reward({id:'b',name:'Statement 3%',rate:3}),capPeriod:'statement',rewardCap:300}
  const oneCard={...card([a,b]),statementCloseDay:10}
  const transactions=[
    tx('sep','2026-09-20',5000,'2026-09-22'),
    tx('oct9','2026-10-09',2000,'2026-10-12'),
    tx('oct20','2026-10-20',5000,'2026-10-21'),
  ]
  const oct=calculateCardSummary(oneCard,transactions,'2026-10')
  assert.equal(oct.totalSpend,7000)
  assert.equal(oct.programs.find(p=>p.id==='a').reward,50)
  assert.equal(oct.programs.find(p=>p.id==='b').reward,210)
  const octStatement=calculateCardSummaryStatement(oneCard,transactions,'2026-10')
  assert.equal(octStatement.totalSpend,5000)
  assert.equal(octStatement.programs.find(p=>p.id==='b').reward,150)
  const novStatement=calculateCardSummaryStatement(oneCard,transactions,'2026-11')
  assert.equal(novStatement.totalSpend,7000)
  assert.equal(novStatement.programs.find(p=>p.id==='a').reward,50)
  assert.equal(novStatement.programs.find(p=>p.id==='b').reward,210)
})

test('manually moving a late-posted transaction changes only its statement cap group', () => {
  const p={...reward({id:'statement',name:'Statement',rate:3}),capPeriod:'statement',rewardCap:100}
  const oneCard={...card([p]),statementCloseDay:10}
  const charge={...tx('tx','2026-09-19',1000,'2026-09-19'),statementPeriodOverride:'2026-11'}
  assert.equal(calculateCardSummaryStatement(oneCard,[charge],'2026-10').totalReward,0)
  assert.equal(calculateCardSummaryStatement(oneCard,[charge],'2026-11').totalReward,30)
  assert.equal(calculateCardSummary(oneCard,[charge],'2026-09').totalReward,30)
})

test('narrow custom range does not regrant monthly cashback cap', () => {
  const p={...reward({id:'calendar',name:'Calendar',rate:1}),capPeriod:'calendar',rewardCap:50}
  const rows=[tx('early','2026-10-05',4000),tx('late','2026-10-20',4000)]
  const summary=calculateCardSummaryRange(card([p]),rows,'2026-10-20','2026-10-20')
  assert.equal(summary.totalSpend,4000)
  assert.equal(summary.totalReward,10)
})

test('new year gets new reward program without altering past statement reward',()=>{
  const old={...reward({id:'old',name:'2026',rate:1,startDate:'2026-01-01',endDate:'2026-12-31'}),capPeriod:'statement',rewardCap:50}
  const next={...reward({id:'new',name:'2027',rate:3,startDate:'2027-01-01',endDate:'2027-12-31'}),capPeriod:'statement',rewardCap:100}
  const oneCard={...card([old,next]),statementCloseDay:10}
  const rows=[tx('old','2026-12-05',2000,'2026-12-08'),tx('new','2027-01-12',2000,'2027-01-15')]
  assert.equal(calculateCardSummaryStatement(oneCard,rows,'2026-12').totalReward,20)
  assert.equal(calculateCardSummaryStatement(oneCard,rows,'2027-02').totalReward,60)
})
