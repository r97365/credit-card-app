export function calculateCardSummary(card, allTransactions, month) {
  const txs = allTransactions.filter(t => t.cardId === card.id && t.date.startsWith(month))
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
      const amount = Math.max(0, Math.min(tx.amount, remainingSpendCap))
      remainingSpendCap -= amount
      return acc + roundMoney(amount * program.rate / 100, program.rounding)
    }, 0)
  } else {
    reward = roundMoney(eligibleSpend * program.rate / 100, program.rounding)
  }

  const uncappedReward = reward
  if (program.rewardCap != null) reward = Math.min(reward, program.rewardCap)

  return {
    ...program,
    eligibleSpend,
    reward,
    capped: program.rewardCap != null && uncappedReward >= program.rewardCap,
  }
}

function roundMoney(value, mode) {
  return mode === 'round' ? Math.round(value) : Math.floor(value)
}

function isProgramActiveForMonth(program, month) {
  const start = `${month}-01`
  const end = `${month}-31`
  return (!program.startDate || program.startDate <= end) && (!program.endDate || program.endDate >= start)
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
