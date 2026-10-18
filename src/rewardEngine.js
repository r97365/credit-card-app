// Cashback calculations. Each program has its own cap reset period; filtering the
// home screen NEVER resets or changes the periods used by these calculations.

export function getStatementPeriodBounds(card, key) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key || '')) return null
  const [year, month] = key.split('-').map(Number)
  const configured = Number(card?.statementCloseDay)
  if (!Number.isInteger(configured) || configured < 1 || configured > 31) return null
  const day = configured
  const closingDay = Math.min(day, new Date(year, month, 0).getDate())
  const previousMonth = new Date(year, month - 2, 1)
  const prevYear = previousMonth.getFullYear()
  const prevNumber = previousMonth.getMonth() + 1
  const previousCloseDay = Math.min(day, new Date(prevYear, prevNumber, 0).getDate())
  const previousClose = new Date(prevYear, prevNumber - 1, previousCloseDay)
  previousClose.setDate(previousClose.getDate() + 1)
  return {
    key,
    start: localDateString(previousClose),
    end: `${year}-${String(month).padStart(2,'0')}-${String(closingDay).padStart(2,'0')}`,
  }
}

export function getStatementPeriodKey(card, transaction) {
  if (!getStatementPeriodBounds(card,'2026-01')) return ''
  const override = transaction?.statementPeriodOverride
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(override || '')) return override
  const date = transaction?.postedDate || transaction?.date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return ''
  const key = date.slice(0,7)
  const closingDate = getStatementPeriodBounds(card, key)?.end
  if (!closingDate || date <= closingDate) return key
  return nextMonth(key)
}

export function isStatementPeriodEstimated(transaction) {
  return !transaction?.statementPeriodOverride && !transaction?.postedDate
}

function nextMonth(month) {
  const [y,m] = month.split('-').map(Number)
  return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2,'0')}`
}

function localDateString(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
}

export function calculateCardSummary(card, allTransactions, month) {
  return calculateSummary(card, allTransactions, { type:'month', month })
}

export function calculateCardSummaryStatement(card, allTransactions, month) {
  return calculateSummary(card, allTransactions, { type:'statement', month })
}

export function calculateCardSummaryRange(card, allTransactions, startDate, endDate) {
  return calculateSummary(card, allTransactions, { type:'range', startDate, endDate })
}

function recognizedDate(card, tx) {
  return card.rewardDateBasis === 'posted' ? (tx.postedDate || tx.date) : tx.date
}

function isRewardEligibleOnDate(card, program, tx) {
  const date = recognizedDate(card, tx)
  return !!date && (!program.startDate || date >= program.startDate) &&
    (!program.endDate || date <= program.endDate)
}

function periodOfTransaction(card, program, tx) {
  return program.capPeriod === 'statement'
    ? getStatementPeriodKey(card, tx)
    : recognizedDate(card, tx)?.slice(0,7)
}

function withinVisiblePeriod(card, tx, period) {
  if (period.type === 'statement') return getStatementPeriodKey(card, tx) === period.month
  if (period.type === 'month') return tx.date.startsWith(period.month)
  return tx.date >= period.startDate && tx.date <= period.endDate
}

function overlapsProgram(period, program, card) {
  const bounds = period.type === 'statement'
    ? getStatementPeriodBounds(card, period.month)
    : period.type === 'month'
      ? { start:period.month + '-01', end:monthEnd(period.month) }
      : { start:period.startDate, end:period.endDate }
  if (!bounds) return false
  return (!program.startDate || program.startDate <= bounds.end) &&
    (!program.endDate || program.endDate >= bounds.start)
}

function monthEnd(month) {
  const [y,m]=month.split('-').map(Number)
  const day=new Date(y,m,0).getDate()
  return `${month}-${String(day).padStart(2,'0')}`
}

function calculateSummary(card, allTransactions, period) {
  const all = allTransactions.filter(tx => tx.cardId === card.id)
  const visible = all.filter(tx => withinVisiblePeriod(card,tx,period))
  const visibleIds = new Set(visible.map(tx => tx.id))
  const totalSpend = sum(visible.map(tx => tx.amount))
  const eligibleSpend = sum(visible.filter(tx => !tx.excluded).map(tx => tx.amount))
  const excludedSpend = sum(visible.filter(tx => tx.excluded).map(tx => tx.amount))

  const programs = (card.rewardPrograms || []).filter(program =>
    overlapsProgram(period,program,card) ||
    visible.some(tx => isRewardEligibleOnDate(card,program,tx))
  ).map(program => {
      // A cap applies to *all* charges in its genuine period, including charges
      // outside the currently visible calendar view.
      const grouped = new Map()
      for (const tx of all) {
        if (tx.excluded || (tx.programExclusions || []).includes(program.id) ||
            !isRewardEligibleOnDate(card,program,tx)) continue
        const key = periodOfTransaction(card,program,tx)
        if (!key) continue
        if (!grouped.has(key)) grouped.set(key,[])
        grouped.get(key).push(tx)
      }
      let earned=0, uncapped=0, countedSpend=0, lost=0, capped=false
      const groupKeys=[]
      for (const [key, group] of grouped) {
        const ordered = [...group].sort((a,b) =>
          (recognizedDate(card,a) || '').localeCompare(recognizedDate(card,b) || '') ||
          (a.id || '').localeCompare(b.id || ''))
        let previous = emptyProgramResult()
        let groupShown = false
        for (let i=0;i<ordered.length;i++) {
          const next = calculateProgram(program,ordered.slice(0,i+1))
          const tx = ordered[i]
          if (visibleIds.has(tx.id)) {
            earned += next.reward - previous.reward
            uncapped += next.uncappedReward - previous.uncappedReward
            countedSpend += next.eligibleSpend - previous.eligibleSpend
            lost += next.lostToCap - previous.lostToCap
            groupShown = true
          }
          previous = next
        }
        if (groupShown) {
          groupKeys.push(key)
          if (previous.capped) capped=true
        }
      }
      return {
        ...program,
        reward:earned,
        uncappedReward:uncapped,
        eligibleSpend:countedSpend,
        lostToCap:Math.max(0,lost),
        capped,
        groupsCount:groupKeys.length,
        capPeriod:program.capPeriod || 'calendar',
      }
    })

  const totalReward = sum(programs.map(p => p.reward))
  const summary = {
    totalSpend, eligibleSpend, excludedSpend, totalReward,
    effectiveRate:totalSpend > 0 ? totalReward / totalSpend * 100 : 0,
    limitRatio:card.monthlySpendLimit > 0 ? totalSpend / card.monthlySpendLimit : 0,
    programs,
    isRange:period.type === 'range',
    periodType:period.type,
  }
  if (period.type === 'range') {
    summary.monthsCount = monthsBetween(period.startDate.slice(0,7),period.endDate.slice(0,7)).length
  } else {
    summary.month = period.month
  }
  return summary
}

function emptyProgramResult() {
  return { reward:0, uncappedReward:0, eligibleSpend:0, lostToCap:0 }
}

// The existing rounding, refunds, and spend-cap rules are preserved here.
function calculateProgram(program, eligibleTxs) {
  const txs = eligibleTxs.filter(tx => !(tx.programExclusions || []).includes(program.id))
  let reward=0
  let eligibleSpend=sum(txs.map(tx=>tx.amount))
  if (program.spendCap != null) eligibleSpend = Math.min(eligibleSpend,program.spendCap)

  if (program.calcMode === 'per_transaction') {
    let remainingSpendCap=program.spendCap ?? Infinity
    reward=txs.reduce((acc,tx)=>{
      const amount=Number(tx.amount || 0)
      if (amount < 0) {
        if (Number.isFinite(remainingSpendCap) && program.spendCap != null) {
          remainingSpendCap=Math.min(program.spendCap,remainingSpendCap+Math.abs(amount))
        }
        return acc + roundMoney(amount * program.rate / 100,program.rounding)
      }
      const rewardedAmount=Math.max(0,Math.min(amount,remainingSpendCap))
      remainingSpendCap-=rewardedAmount
      return acc + roundMoney(rewardedAmount * program.rate / 100,program.rounding)
    },0)
  } else {
    reward=roundMoney(eligibleSpend*program.rate/100,program.rounding)
  }

  const uncappedReward=reward
  if (program.rewardCap != null) reward=Math.min(reward,program.rewardCap)
  const lostToCap=Math.max(0,uncappedReward-reward)
  return {
    eligibleSpend,reward,uncappedReward,lostToCap,
    capped:program.rewardCap != null && uncappedReward >= program.rewardCap,
  }
}

function roundMoney(value,mode) {
  return mode === 'round' ? Math.round(value) : value >= 0 ? Math.floor(value) : Math.ceil(value)
}

function monthsBetween(startMonth,endMonth) {
  const [sy,sm]=startMonth.split('-').map(Number)
  const [ey,em]=endMonth.split('-').map(Number)
  const months=[]
  let y=sy,m=sm
  while (y<ey || (y===ey && m<=em)) {
    months.push(`${y}-${String(m).padStart(2,'0')}`)
    m++
    if (m===13){ m=1;y++ }
  }
  return months
}

function sum(values) {
  return values.reduce((total,value)=>total + Number(value || 0),0)
}

export function formatMoney(value) {
  return new Intl.NumberFormat('zh-TW',{style:'currency',currency:'TWD',maximumFractionDigits:0}).format(value)
}
export function formatPct(value) {
  return `${value.toFixed(2)}%`
}
