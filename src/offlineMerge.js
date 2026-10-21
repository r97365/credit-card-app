// Deterministic projection of queued offline writes onto a server or cached view.
// Queue payloads are the durable source of truth: an interrupted UI snapshot
// must not cause a newly created item or an edit to disappear.
const sortByDate = (a,b) => (b.date || '').localeCompare(a.date || '')

function rowToCard(row, previous) {
  if (!row) return previous
  const sortOrder = Number(row.sort_order ?? previous?.sortOrder ?? 0)
  return {
    ...previous,
    id:row.id,
    name:row.name,
    bank:row.bank || '',
    last4:row.last4 || '',
    colors:[row.color_a || previous?.colors?.[0] || '#171B24',row.color_b || previous?.colors?.[1] || '#3A4454'],
    monthlySpendLimit:Number(row.monthly_spend_limit || 0),
    tip:row.tip || '',
    rewardDateBasis:row.reward_date_basis || 'transaction',
    statementCloseDay:row.statement_close_day ?? previous?.statementCloseDay ?? null,
    sortOrder,
    archived:sortOrder<0,
    rewardPrograms:previous?.rewardPrograms || [],
    updatedAt:row.updated_at || previous?.updatedAt,
  }
}

function rowToProgram(row) {
  return {
    id:row.id,
    name:row.name,
    rate:Number(row.rate || 0),
    rewardCap:row.reward_cap == null ? null : Number(row.reward_cap),
    spendCap:row.spend_cap == null ? null : Number(row.spend_cap),
    calcMode:row.calc_mode || 'monthly_total',
    rounding:row.rounding || 'floor',
    startDate:row.start_date || null,
    endDate:row.end_date || null,
    capPeriod:row.cap_period || 'calendar',
    updatedAt:row.updated_at,
  }
}

function rowToTransaction(row, exclusions = []) {
  return {
    id:row.id,
    cardId:row.card_id,
    date:row.transaction_date,
    postedDate:row.posted_date || null,
    statementPeriodOverride:row.statement_period_override || null,
    title:row.title,
    amount:Number(row.amount),
    excluded:Boolean(row.excluded),
    reconciled:Boolean(row.reconciled),
    programExclusions:exclusions,
    updatedAt:row.updated_at,
  }
}

export function mergeCardsWithLocalPending(remoteCards, localCards, queue) {
  const remote = new Map(remoteCards.map(card=>[card.id,{...card,rewardPrograms:[...(card.rewardPrograms || [])]}]))
  const cached = new Map(localCards.map(card=>[card.id,card]))

  for (const mutation of queue.filter(item=>item.entity==='card')) {
    const id=mutation.recordId
    if(mutation.op==='delete') {
      remote.delete(id)
    } else if(mutation.payload) {
      const current=remote.get(id) || cached.get(id)
      remote.set(id,rowToCard(mutation.payload,current))
    } else if(cached.has(id)) {
      remote.set(id,cached.get(id))
    }
  }

  for(const mutation of queue.filter(item=>item.entity==='program')) {
    const parentId=mutation.payload?.card_id ||
      [...cached.values()].find(card=>card.rewardPrograms?.some(p=>p.id===mutation.recordId))?.id ||
      [...remote.values()].find(card=>card.rewardPrograms?.some(p=>p.id===mutation.recordId))?.id

    if(!parentId || !remote.has(parentId)) continue
    const card=remote.get(parentId)
    const programs=[...(card.rewardPrograms || [])]
    const index=programs.findIndex(p=>p.id===mutation.recordId)
    if(mutation.op==='delete') {
      if(index>=0) programs.splice(index,1)
    } else if(mutation.payload) {
      const next=rowToProgram(mutation.payload)
      if(index>=0) programs[index]=next
      else programs.push(next)
    } else {
      const cachedProgram=cached.get(parentId)?.rewardPrograms?.find(p=>p.id===mutation.recordId)
      if(cachedProgram) {
        if(index>=0) programs[index]=cachedProgram
        else programs.push(cachedProgram)
      }
    }
    remote.set(parentId,{...card,rewardPrograms:programs})
  }

  return [...remote.values()].sort((a,b)=>{
    if(a.archived!==b.archived) return a.archived ? 1 : -1
    return (a.sortOrder || 0)-(b.sortOrder || 0)
  })
}

export function mergeTransactionsWithLocalPending(remoteTransactions, localTransactions, queue) {
  const map=new Map(remoteTransactions.map(tx=>[tx.id,tx]))
  const cached=new Map(localTransactions.map(tx=>[tx.id,tx]))
  for(const mutation of queue.filter(item=>item.entity==='transaction')) {
    const id=mutation.recordId
    if(mutation.op==='delete') {
      map.delete(id)
      continue
    }
    const prior=map.get(id) || cached.get(id)
    if(mutation.payload) {
      const exclusions=Array.isArray(mutation.programExclusions)
        ? mutation.programExclusions
        : prior?.programExclusions || []
      map.set(id,rowToTransaction(mutation.payload,exclusions))
    } else if(cached.has(id)) {
      map.set(id,cached.get(id))
    }
  }
  return [...map.values()].sort(sortByDate)
}
