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
