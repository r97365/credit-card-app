// Only the active visual selection is stored here. Permanent wallet ordering is
// still managed by the existing sort_order field and drag-and-drop behavior.
const PREFIX = 'card-rewards:last-selected-card:v1:'

export function readLastSelectedCard(userId, storage = globalThis.localStorage) {
  if (!userId) return null
  try {
    return storage.getItem(PREFIX + userId) || null
  } catch {
    // iOS private mode and disabled web storage should never break the app.
    return null
  }
}

export function rememberLastSelectedCard(userId, cardId, storage = globalThis.localStorage) {
  if (!userId) return
  try {
    if (cardId) storage.setItem(PREFIX + userId, cardId)
    else storage.removeItem(PREFIX + userId)
  } catch {
    // Visual selection continues to work for this session without storage.
  }
}

export function resolveSelectedCard(cards, { preferredId, savedId, currentId } = {}) {
  const active = cards.filter(card => !card.archived)
  const available = new Set(active.map(card => card.id))
  return [preferredId, savedId, currentId, active[0]?.id]
    .find(id => id && available.has(id)) || null
}

const VIEW_PREFIX = 'card-rewards:card-period:v1:'
const MONTH_PATTERN = /^\\d{4}-(0[1-9]|1[0-2])$/
const DATE_PATTERN = /^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$/

export function defaultCardView(month) {
  const validMonth = MONTH_PATTERN.test(month || '') ? month : '2000-01'
  const [year, number] = validMonth.split('-').map(Number)
  const end = new Date(year, number, 0).getDate()
  return {
    mode:'month',
    month:validMonth,
    rangeStart:validMonth + '-01',
    rangeEnd:validMonth + '-' + String(end).padStart(2,'0'),
  }
}

export function sanitizeCardView(view, { defaultMonth, statementAllowed = false }) {
  const fallback = defaultCardView(defaultMonth)
  if (!view || typeof view !== 'object') return fallback
  const month = MONTH_PATTERN.test(view.month || '') ? view.month : fallback.month
  const rangeStart = DATE_PATTERN.test(view.rangeStart || '') ? view.rangeStart : fallback.rangeStart
  const rangeEnd = DATE_PATTERN.test(view.rangeEnd || '') ? view.rangeEnd : fallback.rangeEnd
  const mode = ['month','statement','range'].includes(view.mode) ? view.mode : 'month'
  return {
    mode: mode === 'statement' && !statementAllowed ? 'month' : mode,
    month,
    rangeStart:rangeStart <= rangeEnd ? rangeStart : fallback.rangeStart,
    rangeEnd:rangeStart <= rangeEnd ? rangeEnd : fallback.rangeEnd,
  }
}

export function readCardView(userId, cardId, settings, storage) {
  const fallback = sanitizeCardView(null, settings)
  if (!userId || !cardId) return fallback
  try {
    const source = storage || globalThis.localStorage
    const raw = source.getItem(VIEW_PREFIX + userId + ':' + cardId)
    return sanitizeCardView(raw ? JSON.parse(raw) : null, settings)
  } catch {
    return fallback
  }
}

export function rememberCardView(userId, cardId, view, storage) {
  if (!userId || !cardId) return
  try {
    const target = storage || globalThis.localStorage
    target.setItem(VIEW_PREFIX + userId + ':' + cardId, JSON.stringify(view))
  } catch {
    // Selection of a period still works in memory if local storage is disabled.
  }
}
