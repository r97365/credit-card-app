export function calculateCardSummary(card, allTransactions, month) {
  const txs = allTransactions.filter(t => t.cardId === card.id && t.date.startsWith(month))
  return calculateSummaryFromTransactions(card, txs, month)
}

export function calculateCardSummaryRange(card, allTransactions, startDate, endDate) {
  const rangeTxs = allTransactions.filter(
    t => t.cardId === card.id && t.date >= startDate && t.date <= endDate
  )

  const months = monthsBetween(startDate.slice(0,7), endDate.slice(0,7))
  const monthly = months.map(month => {
    const txs = rangeTxs.filter(t => t.date.startsWith(month))
    return calculateSummaryFromTransactions(card, txs, month)
  })

  const totalSpend = sum(monthly.map(m => m.totalSpend))
  const eligibleSpend = sum(monthly.map(m => m.eligibleSpend))
  const excludedSpend = sum(monthly.map(m => m.excludedSpend))
  const totalReward = sum(monthly.map(m => m.totalReward))
  const effectiveRate = totalSpend > 0 ? (totalReward / totalSpend) * 100 : 0

  const programMap = new Map()
  for (const m of monthly) {
    for (const p of m.programs) {
      const existing = programMap.get(p.id)
      if (!existing) {
        programMap.set(p.id, {
          ...p,
          reward: p.reward,
          uncappedReward: p.uncappedReward,
          lostToCap: p.lostToCap,
          eligibleSpend: p.eligibleSpend,
          cappedMonths: p.capped ? 1 : 0,
          monthsCount: 1
        })
      } else {
        existing.reward += p.reward
        existing.uncappedReward += p.uncappedReward
        existing.lostToCap += p.lostToCap
        existing.eligibleSpend += p.eligibleSpend
        existing.cappedMonths += p.capped ? 1 : 0
        existing.monthsCount += 1
        existing.capped = existing.capped || p.capped
      }
    }
  }

  return {
    totalSpend,
    eligibleSpend,
    excludedSpend,
    totalReward,
    effectiveRate,
    limitRatio: 0,
    programs: [...programMap.values()],
    monthsCount: months.length,
    isRange: true,
  }
}

function calculateSummaryFromTransactions(card, txs, month) {
  const totalSpend = sum(txs.map(t => t.amount))
  const eligibleTxs = txs.filter(t => !t.excluded)
  const eligibleSpend = sum(eligibleTxs.map(t => t.amount))
  const excludedSpend = sum(txs.filter(t => t.excluded).map(t => t.amount))

  const programs = card.rewardPrograms
    .filter(p => isProgramActiveForMonth(p, month))
    .map(program => calculateProgram(program, eligibleTxs))

  const totalReward = sum(programs.map(p => p.reward))
  const effectiveRate = totalSpend > 0 ? (totalReward / totalSpend) * 100 : 0

  return {
    totalSpend,
    eligibleSpend,
    excludedSpend,
    totalReward,
    effectiveRate,
    limitRatio: card.monthlySpendLimit > 0 ? totalSpend / card.monthlySpendLimit : 0,
    programs,
    month,
  }
}

function calculateProgram(program, eligibleTxs) {
  const txs = eligibleTxs.filter(tx => !(tx.programExclusions || []).includes(program.id))
  let reward = 0
  let eligibleSpend = sum(txs.map(t => t.amount))

  if (program.spendCap != null) eligibleSpend = Math.min(eligibleSpend, program.spendCap)

  if (program.calcMode === 'per_transaction') {
    let remainingSpendCap = program.spendCap ?? Infinity
    reward = txs.reduce((acc, tx) => {
      const amount = Number(tx.amount || 0)
      if (amount < 0) {
        if (Number.isFinite(remainingSpendCap) && program.spendCap != null) {
          remainingSpendCap = Math.min(program.spendCap, remainingSpendCap + Math.abs(amount))
        }
        return acc + roundMoney(amount * program.rate / 100, program.rounding)
      }
      const rewardedAmount = Math.max(0, Math.min(amount, remainingSpendCap))
      remainingSpendCap -= rewardedAmount
      return acc + roundMoney(rewardedAmount * program.rate / 100, program.rounding)
    }, 0)
  } else {
    reward = roundMoney(eligibleSpend * program.rate / 100, program.rounding)
  }

  const uncappedReward = reward
  if (program.rewardCap != null) reward = Math.min(reward, program.rewardCap)
  const lostToCap = Math.max(0, uncappedReward - reward)

  return {
    ...program,
    eligibleSpend,
    reward,
    uncappedReward,
    lostToCap,
    capped: program.rewardCap != null && uncappedReward >= program.rewardCap,
  }
}

function roundMoney(value, mode) {
  if (mode === 'round') return Math.round(value)
  return value >= 0 ? Math.floor(value) : Math.ceil(value)
}

function isProgramActiveForMonth(program, month) {
  const start = `${month}-01`
  const end = `${month}-31`
  return (!program.startDate || program.startDate <= end) && (!program.endDate || program.endDate >= start)
}

function monthsBetween(startMonth, endMonth) {
  const [sy, sm] = startMonth.split('-').map(Number)
  const [ey, em] = endMonth.split('-').map(Number)
  const out = []
  let y = sy
  let m = sm
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2,'0')}`)
    m += 1
    if (m === 13) {
      m = 1
      y += 1
    }
  }
  return out
}

function sum(values) {
  return values.reduce((a,b) => a + Number(b || 0), 0)
}

export function formatMoney(value) {
  return new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', maximumFractionDigits: 0 }).format(value)
}

export function formatPct(value) {
  return `${value.toFixed(2)}%`
}
