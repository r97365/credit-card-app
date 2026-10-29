import { getStatementPeriodKey } from './rewardEngine.js'

// The list and its displayed count must always refer to the same complete set.
// Never truncate the list without offering a separate explicit pagination control.
export function transactionIsInView(tx, card, { mode, month, rangeStart, rangeEnd }) {
  if (!tx || !card || tx.cardId !== card.id) return false
  const date=tx.date || ''
  if (mode === 'statement') return getStatementPeriodKey(card,tx) === month
  if (mode === 'range') return date >= rangeStart && date <= rangeEnd
  return date.startsWith(month || '')
}

export function transactionsInView(allTransactions, card, view) {
  if (!card) return []
  return allTransactions.filter(tx => transactionIsInView(tx,card,view))
    .sort((a,b) =>
      (b.date || '').localeCompare(a.date || '') ||
      (b.createdAt || b.updatedAt || '').localeCompare(a.createdAt || a.updatedAt || '') ||
      String(b.id || '').localeCompare(String(a.id || ''))
    )
}
