import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { calculateCardSummary, calculateCardSummaryRange, formatMoney, formatPct } from './rewardEngine'
import { supabase } from './supabase'

const APP_VERSION = '0.3.5'
const BUILD_ID = import.meta.env.VITE_BUILD_ID || APP_VERSION

const LEGACY_PALETTES = [
  ['#222831','#38414d'],
  ['#193f32','#2e6654'],
  ['#3a1f4d','#704b87'],
  ['#45352d','#72574a'],
  ['#1d3150','#365b82'],
  ['#3b3032','#76575c'],
]

const PALETTES = [
  ['#171B24','#3A4454'], // graphite
  ['#0E3B32','#1C7A63'], // emerald
  ['#102B57','#2563A8'], // cobalt
  ['#4A1724','#A54457'], // burgundy
  ['#4B2F19','#A56B2D'], // bronze
  ['#321747','#7A3E96'], // plum
]

function App() {
  const [session, setSession] = useState(undefined)
  const [cards, setCards] = useState([])
  const [transactions, setTransactions] = useState([])
  const [selectedCardId, setSelectedCardId] = useState(null)
  const [month, setMonth] = useState(localMonth())
  const [periodMode, setPeriodMode] = useState('month')
  const [rangeStart, setRangeStart] = useState(`${localMonth()}-01`)
  const [rangeEnd, setRangeEnd] = useState(lastDayOfMonth(localMonth()))
  const [showRangePicker, setShowRangePicker] = useState(false)
  const [showTip, setShowTip] = useState(false)
  const [showAddTx, setShowAddTx] = useState(false)
  const [showCardEditor, setShowCardEditor] = useState(false)
  const [showCardList, setShowCardList] = useState(false)
  const [editingCardId, setEditingCardId] = useState(null)
  const [creatingCard, setCreatingCard] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showStats, setShowStats] = useState(false)
  const [editingTransaction, setEditingTransaction] = useState(null)
  const [undoDelete, setUndoDelete] = useState(null)
  const [loadingData, setLoadingData] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let stopped = false

    async function checkForUpdate() {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache:'no-store' })
        if (!res.ok) return
        const remote = await res.json()
        if (stopped || !remote.build || remote.build === BUILD_ID) return

        const lastReload = sessionStorage.getItem('card-rewards-reload-build')
        if (lastReload === remote.build) return
        sessionStorage.setItem('card-rewards-reload-build', remote.build)

        const next = new URL(window.location.href)
        next.searchParams.set('_v', String(remote.build).slice(0,10))
        window.location.replace(next.toString())
      } catch {
        // Update checks are best-effort; the app should keep working offline/with transient network errors.
      }
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') checkForUpdate()
    }

    checkForUpdate()
    window.addEventListener('focus', checkForUpdate)
    document.addEventListener('visibilitychange', onVisible)
    const timer = window.setInterval(checkForUpdate, 60000)

    return () => {
      stopped = true
      window.removeEventListener('focus', checkForUpdate)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!supabase) {
      setSession(null)
      setError('Supabase 尚未完成設定。')
      return
    }
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (session?.user) loadData()
    if (session === null) {
      setCards([])
      setTransactions([])
      setSelectedCardId(null)
    }
  }, [session?.user?.id])

  async function loadData(preferredSelectedId = null) {
    setLoadingData(true)
    setError('')
    const [cardsRes, programsRes, txRes, exclusionsRes] = await Promise.all([
      supabase.from('cards').select('*').order('sort_order').order('created_at'),
      supabase.from('reward_programs').select('*').order('created_at'),
      supabase.from('transactions').select('*').order('transaction_date', { ascending: false }),
      supabase.from('transaction_reward_exclusions').select('*'),
    ])

    const firstError = cardsRes.error || programsRes.error || txRes.error || exclusionsRes.error
    if (firstError) {
      setError(firstError.message)
      setLoadingData(false)
      return
    }

    const programsByCard = new Map()
    for (const p of programsRes.data || []) {
      const list = programsByCard.get(p.card_id) || []
      list.push(fromProgramRow(p))
      programsByCard.set(p.card_id, list)
    }

    const exclusionMap = new Map()
    for (const x of exclusionsRes.data || []) {
      const list = exclusionMap.get(x.transaction_id) || []
      list.push(x.reward_program_id)
      exclusionMap.set(x.transaction_id, list)
    }

    const nextCards = (cardsRes.data || []).map(row => ({
      id: row.id,
      name: row.name,
      bank: row.bank || '',
      last4: row.last4 || '',
      monthlySpendLimit: Number(row.monthly_spend_limit || 0),
      colors: normalizeCardColors(row.color_a, row.color_b),
      tip: row.tip || '',
      rewardDateBasis: row.reward_date_basis,
      rewardPrograms: programsByCard.get(row.id) || [],
      sortOrder: Number(row.sort_order || 0),
      archived: Number(row.sort_order || 0) < 0,
    })).sort((a,b) => (a.archived === b.archived ? a.sortOrder - b.sortOrder : a.archived ? 1 : -1))

    const nextTx = (txRes.data || []).map(row => ({
      id: row.id,
      cardId: row.card_id,
      date: row.transaction_date,
      postedDate: row.posted_date,
      title: row.title,
      amount: Number(row.amount),
      excluded: row.excluded,
      reconciled: row.reconciled,
      programExclusions: exclusionMap.get(row.id) || [],
    }))

    setCards(nextCards)
    setTransactions(nextTx)
    const activeCards = nextCards.filter(c => !c.archived)
    setSelectedCardId(prev =>
      preferredSelectedId && activeCards.some(c => c.id === preferredSelectedId)
        ? preferredSelectedId
        : activeCards.some(c => c.id === prev)
          ? prev
          : activeCards[0]?.id || null
    )
    setLoadingData(false)
  }

  const activeCards = cards.filter(c => !c.archived)
  const selectedCard = activeCards.find(c => c.id === selectedCardId) || null
  const summary = useMemo(
    () => selectedCard
      ? (periodMode === 'month'
          ? calculateCardSummary(selectedCard, transactions, month)
          : calculateCardSummaryRange(selectedCard, transactions, rangeStart, rangeEnd))
      : null,
    [selectedCard, transactions, month, periodMode, rangeStart, rangeEnd]
  )

  const visibleTransactions = useMemo(() => transactions.filter(t =>
    t.cardId === selectedCardId &&
    (periodMode === 'month'
      ? t.date.startsWith(month)
      : t.date >= rangeStart && t.date <= rangeEnd)
  ), [transactions, selectedCardId, periodMode, month, rangeStart, rangeEnd])

  const expiringPrograms = useMemo(() => {
    const today = localToday()
    const inTenDays = addDays(today, 10)
    return activeCards.flatMap(card => card.rewardPrograms
      .filter(p => p.endDate && p.endDate >= today && p.endDate <= inTenDays)
      .map(p => ({ ...p, cardName:card.name })))
      .sort((a,b) => a.endDate.localeCompare(b.endDate))
  }, [activeCards])

  const modalOpen = showRangePicker || showAddTx || showCardEditor || showCardList || showSettings || showStats || Boolean(editingTransaction)

  useEffect(() => {
    if (!modalOpen) return

    const scrollY = window.scrollY
    const body = document.body
    const previous = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow,
    }

    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.left = '0'
    body.style.right = '0'
    body.style.width = '100%'
    body.style.overflow = 'hidden'

    return () => {
      body.style.position = previous.position
      body.style.top = previous.top
      body.style.left = previous.left
      body.style.right = previous.right
      body.style.width = previous.width
      body.style.overflow = previous.overflow
      window.scrollTo(0, scrollY)
    }
  }, [modalOpen])

  async function addTransaction(tx) {
    const { data, error: insertError } = await supabase.from('transactions').insert({
      user_id: session.user.id,
      card_id: tx.cardId,
      transaction_date: tx.date,
      title: tx.title.trim(),
      amount: Number(tx.amount),
      excluded: false,
    }).select().single()

    if (insertError) throw insertError
    setTransactions(prev => [{
      id: data.id,
      cardId: data.card_id,
      date: data.transaction_date,
      postedDate: data.posted_date,
      title: data.title,
      amount: Number(data.amount),
      excluded: data.excluded,
      reconciled: data.reconciled,
      programExclusions: [],
    }, ...prev])
    setShowAddTx(false)
  }

  async function toggleExcluded(txId) {
    const tx = transactions.find(t => t.id === txId)
    if (!tx) return
    const { error: updateError } = await supabase.from('transactions').update({ excluded: !tx.excluded }).eq('id', txId)
    if (updateError) {
      setError(updateError.message)
      return
    }
    setTransactions(prev => prev.map(item => item.id === txId ? { ...item, excluded: !item.excluded } : item))
  }

  async function toggleReconciled(txId, forceValue) {
    const tx = transactions.find(t => t.id === txId)
    if (!tx) return false
    const next = typeof forceValue === 'boolean' ? forceValue : !tx.reconciled
    const { error: updateError } = await supabase.from('transactions').update({ reconciled: next }).eq('id', txId)
    if (updateError) {
      setError(updateError.message)
      return false
    }
    setTransactions(prev => prev.map(item => item.id === txId ? { ...item, reconciled: next } : item))
    return true
  }

  async function saveTransactionEdits(payload) {
    const previousTx = transactions.find(item => item.id === payload.id)
    const optimisticTx = previousTx ? {
      ...previousTx,
      cardId: payload.cardId,
      date: payload.date,
      postedDate: payload.postedDate || null,
      title: payload.title.trim(),
      amount: Number(payload.amount),
      excluded: payload.excluded,
      reconciled: payload.reconciled,
      programExclusions: [...(payload.programExclusions || [])],
    } : null

    if (optimisticTx) {
      setTransactions(prev => prev.map(item => item.id === payload.id ? optimisticTx : item))
    }

    try {
      const [{ error: updateError }, { error: clearError }] = await Promise.all([
        supabase.from('transactions').update({
          card_id: payload.cardId,
          transaction_date: payload.date,
          posted_date: payload.postedDate || null,
          title: payload.title.trim(),
          amount: Number(payload.amount),
          excluded: payload.excluded,
          reconciled: payload.reconciled,
        }).eq('id', payload.id),
        supabase.from('transaction_reward_exclusions').delete().eq('transaction_id', payload.id),
      ])
      if (updateError) throw updateError
      if (clearError) throw clearError

      if (payload.programExclusions?.length) {
        const rows = payload.programExclusions.map(rewardProgramId => ({
          user_id: session.user.id,
          transaction_id: payload.id,
          reward_program_id: rewardProgramId,
        }))
        const { error: exclusionError } = await supabase.from('transaction_reward_exclusions').insert(rows)
        if (exclusionError) throw exclusionError
      }

      setEditingTransaction(null)
    } catch (err) {
      if (previousTx) {
        setTransactions(prev => prev.map(item => item.id === payload.id ? previousTx : item))
      }
      throw err
    }
  }

  async function deleteTransaction(txId) {
    const tx = transactions.find(item => item.id === txId)
    if (!tx) return false
    if (undoDelete?.timer) clearTimeout(undoDelete.timer)
    setTransactions(prev => prev.filter(item => item.id !== txId))
    const timer = setTimeout(async () => {
      const { error: deleteError } = await supabase.from('transactions').delete().eq('id', txId)
      if (deleteError) {
        setError(deleteError.message)
        setTransactions(prev => [tx, ...prev])
      }
      setUndoDelete(null)
    }, 3500)
    setUndoDelete({ tx, timer })
    return true
  }

  function undoTransactionDelete() {
    if (!undoDelete) return
    clearTimeout(undoDelete.timer)
    setTransactions(prev => [undoDelete.tx, ...prev])
    setUndoDelete(null)
  }

  async function saveCard(payload) {
    const base = {
      user_id: session.user.id,
      name: payload.name.trim(),
      bank: payload.bank.trim() || null,
      last4: payload.last4.trim() || null,
      monthly_spend_limit: payload.monthlySpendLimit ? Number(payload.monthlySpendLimit) : null,
      tip: payload.tip.trim() || null,
      color_a: payload.colors[0],
      color_b: payload.colors[1],
      reward_date_basis: payload.rewardDateBasis,
    }

    if (payload.id) {
      const { error: updateError } = await supabase.from('cards').update(base).eq('id', payload.id)
      if (updateError) throw updateError
    } else {
      const { data, error: insertError } = await supabase.from('cards').insert(base).select().single()
      if (insertError) throw insertError
      setSelectedCardId(data.id)
      await loadData(data.id)
      return
    }
    await loadData()
  }

  async function saveProgram(cardId, p) {
    const row = {
      user_id: session.user.id,
      card_id: cardId,
      name: p.name.trim(),
      rate: Number(p.rate || 0),
      reward_cap: p.capType === 'reward' && p.capValue !== '' ? Number(p.capValue) : null,
      spend_cap: p.capType === 'spend' && p.capValue !== '' ? Number(p.capValue) : null,
      calc_mode: p.calcMode,
      rounding: p.rounding,
      start_date: p.startDate || null,
      end_date: p.endDate || null,
    }
    const query = p.id
      ? supabase.from('reward_programs').update(row).eq('id', p.id)
      : supabase.from('reward_programs').insert(row)
    const { error: saveError } = await query
    if (saveError) throw saveError
    await loadData()
  }

  async function deleteProgram(id) {
    const { error: deleteError } = await supabase.from('reward_programs').delete().eq('id', id)
    if (deleteError) throw deleteError
    await loadData()
  }

  async function reorderCards(orderedIds) {
    const active = orderedIds.map(id => cards.find(c => c.id === id)).filter(Boolean)
    setCards(prev => {
      const archived = prev.filter(c => c.archived)
      return [...active.map((card,index) => ({ ...card, sortOrder:index })), ...archived]
    })
    await Promise.all(active.map((card,index) => supabase.from('cards').update({ sort_order:index }).eq('id', card.id)))
  }

  async function archiveCard(cardId) {
    const card = cards.find(c => c.id === cardId)
    if (!card) return
    const { error: updateError } = await supabase.from('cards').update({ sort_order:-1 }).eq('id', cardId)
    if (updateError) throw updateError
    await loadData()
  }

  async function restoreCard(cardId) {
    const nextOrder = activeCards.length
    const { error: updateError } = await supabase.from('cards').update({ sort_order:nextOrder }).eq('id', cardId)
    if (updateError) throw updateError
    await loadData()
  }

  async function duplicateProgramsToNextPeriod(cardId) {
    const card = cards.find(c => c.id === cardId)
    if (!card?.rewardPrograms?.length) return 0
    const rows = card.rewardPrograms.map(p => {
      const shifted = shiftPeriod(p.startDate, p.endDate)
      return {
        user_id: session.user.id,
        card_id: cardId,
        name: p.name,
        rate: p.rate,
        reward_cap: p.rewardCap,
        spend_cap: p.spendCap,
        calc_mode: p.calcMode,
        rounding: p.rounding,
        start_date: shifted.startDate,
        end_date: shifted.endDate,
      }
    })
    const { error: insertError } = await supabase.from('reward_programs').insert(rows)
    if (insertError) throw insertError
    await loadData()
    return rows.length
  }

  async function signOut() {
    await supabase.auth.signOut()
    setShowSettings(false)
  }

  if (session === undefined) return <CenteredState title="正在開啟…" />
  if (!session) return <AuthScreen configError={error} />

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">CARD REWARDS</div>
          <h1>我的信用卡</h1>
        </div>
        <button className="icon-btn" aria-label="設定" onClick={() => setShowSettings(true)}>⚙︎</button>
      </header>

      {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}

      <section className="period-bar">
        <label className={`month-pill ${periodMode === 'month' ? 'active-period' : ''}`}>
          <span>{month.replace('-', ' / ')}</span>
          <input type="month" value={month} onChange={e => { setMonth(e.target.value); setPeriodMode('month') }} />
        </label>
        <button className={`ghost-btn range-trigger ${periodMode === 'range' ? 'active-range' : ''}`} onClick={() => setShowRangePicker(true)}>
          {periodMode === 'range' ? `${formatDateShort(rangeStart)}–${formatDateShort(rangeEnd)}` : '自訂區間'}
        </button>
      </section>

      {expiringPrograms.length > 0 && <div className="expiry-banner">
        <div><strong>活動即將到期</strong><span>{expiringPrograms.slice(0,2).map(p => `${p.cardName}・${p.name} ${formatDateShort(p.endDate)}`).join('　')}</span></div>
        <button onClick={() => { if (selectedCard) { setEditingCardId(selectedCard.id); setCreatingCard(false); setShowCardEditor(true) } }}>更新</button>
      </div>}

      {loadingData ? <CenteredState compact title="同步資料中…" /> : !selectedCard ? (
        <EmptyCards onAdd={() => { setEditingCardId(null); setCreatingCard(true); setShowCardEditor(true) }} />
      ) : (
        <>
          <CardStack cards={activeCards} selectedId={selectedCardId} onSelect={(id) => { setSelectedCardId(id); setShowTip(false) }} onReorder={reorderCards} />

          <section className="summary-card">
            <div className="summary-head">
              <div>
                <div className="title-line">
                  <h2>{selectedCard.name}</h2>
                  <button className="tip-button" onClick={() => setShowTip(v => !v)} aria-label="顯示提示">ⓘ</button>
                </div>
                <div className="muted">{periodMode === 'month' ? '本月刷卡' : '區間刷卡'}</div>
              </div>
              <div className={`status-badge ${periodMode === 'month' && summary.limitRatio >= 1 ? 'danger' : periodMode === 'month' && summary.limitRatio >= .85 ? 'warn' : ''}`}>
                {periodMode === 'range'
                  ? '自訂區間'
                  : selectedCard.monthlySpendLimit
                    ? (summary.limitRatio >= 1 ? '已超額' : `${Math.round(summary.limitRatio * 100)}%`)
                    : '未設上限'}
              </div>
            </div>

            {showTip && <div className="tip-popover"><strong>刷卡 Tip</strong><div>{selectedCard.tip || '尚未設定 Tip'}</div></div>}

            <div className="spend-row">
              <strong>{formatMoney(summary.totalSpend)}</strong>
              <span>{periodMode === 'range'
                ? `${formatDateShort(rangeStart)}–${formatDateShort(rangeEnd)}`
                : selectedCard.monthlySpendLimit
                  ? `/ ${formatMoney(selectedCard.monthlySpendLimit)}`
                  : '無刷卡上限'}</span>
            </div>
            {periodMode === 'month' && <div className="progress"><div style={{ width: `${selectedCard.monthlySpendLimit ? Math.min(100, summary.limitRatio * 100) : 0}%` }} /></div>}
            {periodMode === 'range' && <div className="range-note">跨月份時，各月份的回饋上限會分開計算後再加總。</div>}

            <div className="reward-hero">
              <div><span>預估總回饋</span><strong>{formatMoney(summary.totalReward)}</strong></div>
              <div className="rate-box"><span>實質回饋率</span><strong>{formatPct(summary.effectiveRate)}</strong></div>
            </div>

            <div className="program-list">
              {summary.programs.length ? summary.programs.map(p => (
                <div className="program-row" key={p.id}>
                  <div className="program-main">
                    <span className="program-name" title={p.name}>{p.name}</span>
                    <span className="program-rate">{p.rate}%</span>
                  </div>
                  <div className="program-value">
                    <strong>{formatMoney(p.reward)}</strong>
                    <span>{p.rewardCap == null
                      ? (p.spendCap == null ? '無上限' : `${periodMode === 'range' ? '月' : ''}消費上限 ${formatMoney(p.spendCap)}`)
                      : (periodMode === 'range' ? `月回饋上限 ${formatMoney(p.rewardCap)}` : `/ ${formatMoney(p.rewardCap)}`)}</span>
                    {p.capped && <span className="done">✓</span>}
                  </div>
                </div>
              )) : <div className="no-programs">尚未設定回饋活動</div>}
            </div>

            <div className="meta-grid">
              <div><span>有效回饋消費</span><strong>{formatMoney(summary.eligibleSpend)}</strong></div>
              <div><span>排除回饋</span><strong>{formatMoney(summary.excludedSpend)}</strong></div>
            </div>
          </section>

          <section className="transactions-section">
            <div className="section-head">
              <h3>最近紀錄</h3>
              <span className="record-count">{visibleTransactions.length} 筆</span>
            </div>
            <div className="transaction-list">
              {visibleTransactions.slice(0,8).map(tx => (
                <SwipeTransaction
                  key={tx.id}
                  tx={tx}
                  onToggleExcluded={() => toggleExcluded(tx.id)}
                  onToggleReconciled={() => toggleReconciled(tx.id)}
                  onDelete={() => deleteTransaction(tx.id)}
                  onEdit={() => setEditingTransaction(tx)}
                />
              ))}
              {!visibleTransactions.length && <div className="empty-list">{periodMode === 'month' ? '這個月還沒有刷卡紀錄' : '這個區間還沒有刷卡紀錄'}</div>}
            </div>
          </section>
        </>
      )}

      <nav className="bottom-nav">
        <button className="nav-item active"><span>▰</span><small>卡片</small></button>
        <button className="add-main" disabled={!selectedCard} onClick={() => selectedCard && setShowAddTx(true)}>＋</button>
        <button className="nav-item" onClick={() => setShowStats(true)}><span>▥</span><small>統計</small></button>
      </nav>

      {showAddTx && selectedCard && <AddTransactionModal card={selectedCard} transactions={transactions} onClose={() => setShowAddTx(false)} onSave={addTransaction} />}
      {showRangePicker && <RangePicker
        startDate={rangeStart}
        endDate={rangeEnd}
        onClose={() => setShowRangePicker(false)}
        onApply={(start, end) => {
          setRangeStart(start)
          setRangeEnd(end)
          setPeriodMode('range')
          setShowRangePicker(false)
        }}
      />}
      {editingTransaction && <TransactionEditor tx={editingTransaction} cards={activeCards} onClose={() => setEditingTransaction(null)} onSave={saveTransactionEdits} />}
      {showCardEditor && <CardEditor
        card={creatingCard ? null : (activeCards.find(c => c.id === editingCardId) || selectedCard)}
        onClose={() => { setShowCardEditor(false); setCreatingCard(false); setEditingCardId(null) }}
        onSaveCard={saveCard}
        onSaveProgram={saveProgram}
        onDeleteProgram={deleteProgram}
        onArchiveCard={archiveCard}
        onDuplicatePrograms={duplicateProgramsToNextPeriod}
      />}
      {showCardList && <CardListSheet
        cards={activeCards}
        onClose={() => setShowCardList(false)}
        onChoose={(id) => {
          setShowCardList(false)
          setEditingCardId(id)
          setCreatingCard(false)
          setShowCardEditor(true)
        }}
        onAdd={() => {
          setShowCardList(false)
          setEditingCardId(null)
          setCreatingCard(true)
          setShowCardEditor(true)
        }}
      />}
      {showStats && <StatsSheet cards={activeCards} transactions={transactions} month={month} onClose={() => setShowStats(false)} />}
      {showSettings && <AccountSheet
        version={APP_VERSION}
        email={session.user.email}
        cards={cards}
        onClose={() => setShowSettings(false)}
        onOpenCards={() => { setShowSettings(false); setShowCardList(true) }}
        onAddCard={() => { setShowSettings(false); setEditingCardId(null); setCreatingCard(true); setShowCardEditor(true) }}
        onRestoreCard={restoreCard}
        onSignOut={signOut}
      />}
      {undoDelete && <div className="undo-toast"><span>已刪除「{undoDelete.tx.title}」</span><button onClick={undoTransactionDelete}>復原</button></div>}
    </div>
  )
}

function AuthScreen({ configError }) {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(configError || '')

  async function submit(e) {
    e.preventDefault()
    if (!supabase) return
    setMessage('')
    if (mode === 'signup' && password !== confirmPassword) {
      setMessage('兩次輸入的密碼不一致。')
      return
    }
    setBusy(true)
    if (mode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) setMessage(error.message)
    } else {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: 'https://r97365.github.io/credit-card-app/'
        }
      })
      if (error) setMessage(error.message)
      else if (!data.session) setMessage('註冊完成。Supabase 已寄驗證信到你的 Email，驗證後再回來登入。')
    }
    setBusy(false)
  }

  return <div className="auth-shell">
    <div className="auth-logo"><span>▰</span><b>%</b></div>
    <div className="eyebrow">CARD REWARDS</div>
    <h1>{mode === 'login' ? '登入你的卡片錢包' : '建立帳號'}</h1>
    <p>信用卡、回饋活動與刷卡紀錄會同步到 Supabase，不再只存在單一手機。</p>
    <form className="auth-card" onSubmit={submit}>
      <label>Email<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" /></label>
      <label>密碼
        <div className="password-field">
          <input type={showPassword ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={6} required value={password} onChange={e => setPassword(e.target.value)} placeholder="至少 6 碼" />
          <button type="button" className="password-eye" aria-label={showPassword ? '隱藏密碼' : '顯示密碼'} onClick={() => setShowPassword(v => !v)}><EyeIcon open={showPassword} /></button>
        </div>
      </label>
      {mode === 'signup' && <label>再次確認密碼
        <div className="password-field">
          <input type={showConfirmPassword ? 'text' : 'password'} autoComplete="new-password" minLength={6} required value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="再輸入一次密碼" />
          <button type="button" className="password-eye" aria-label={showConfirmPassword ? '隱藏密碼' : '顯示密碼'} onClick={() => setShowConfirmPassword(v => !v)}><EyeIcon open={showConfirmPassword} /></button>
        </div>
        {confirmPassword && password !== confirmPassword && <div className="password-mismatch">兩次密碼不一致</div>}
      </label>}
      {message && <div className="auth-message">{message}</div>}
      <button className="primary-btn" disabled={busy || (mode === 'signup' && (!confirmPassword || password !== confirmPassword))}>{busy ? '處理中…' : mode === 'login' ? '登入' : '註冊'}</button>
    </form>
    <button className="auth-switch" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setConfirmPassword(''); setShowPassword(false); setShowConfirmPassword(false); setMessage('') }}>{mode === 'login' ? '第一次使用？建立帳號' : '已經有帳號？登入'}</button>
  </div>
}

function SheetGrabber({ onClose }) {
  const zoneRef = React.useRef(null)

  useEffect(() => {
    const zone = zoneRef.current
    const sheet = zone?.parentElement
    if (!sheet) return

    let startY = null
    let dragY = 0
    let dragging = false

    function resetSheet(animated = true) {
      sheet.style.transition = animated ? 'transform .22s cubic-bezier(.2,.8,.2,1)' : 'none'
      sheet.style.transform = 'translateY(0)'
      window.setTimeout(() => {
        if (sheet) sheet.style.transition = ''
      }, 230)
    }

    function handleStart(e) {
      const touch = e.touches?.[0]
      if (!touch || sheet.scrollTop > 0) return
      if (e.target.closest('button,input,select,textarea,a,[role="button"]')) return

      const rect = sheet.getBoundingClientRect()
      const localY = touch.clientY - rect.top
      if (localY < 0 || localY > rect.height) return

      startY = touch.clientY
      dragY = 0
      dragging = true
      sheet.style.transition = 'none'
    }

    function handleMove(e) {
      if (!dragging || startY == null) return
      const touch = e.touches?.[0]
      if (!touch) return

      const dy = touch.clientY - startY
      if (dy <= 0) {
        dragY = 0
        sheet.style.transform = 'translateY(0)'
        return
      }

      e.preventDefault()
      dragY = Math.min(dy, 220)
      sheet.style.transform = `translateY(${dragY}px)`
    }

    function handleEnd() {
      if (!dragging) return
      const shouldClose = dragY > 76
      startY = null
      dragging = false

      if (shouldClose) {
        sheet.style.transition = 'transform .18s ease-out'
        sheet.style.transform = 'translateY(110%)'
        window.setTimeout(onClose, 150)
      } else {
        resetSheet(true)
      }
      dragY = 0
    }

    sheet.addEventListener('touchstart', handleStart, { passive:true })
    sheet.addEventListener('touchmove', handleMove, { passive:false })
    sheet.addEventListener('touchend', handleEnd, { passive:true })
    sheet.addEventListener('touchcancel', handleEnd, { passive:true })

    return () => {
      sheet.removeEventListener('touchstart', handleStart)
      sheet.removeEventListener('touchmove', handleMove)
      sheet.removeEventListener('touchend', handleEnd)
      sheet.removeEventListener('touchcancel', handleEnd)
    }
  }, [onClose])

  return <div ref={zoneRef} className="sheet-grabber-zone"><div className="sheet-grabber" /></div>
}

function EyeIcon({ open }) {
  return open
    ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 10.7a2 2 0 002.7 2.7M9.9 4.2A10.8 10.8 0 0112 4c5.5 0 9 5 9 5a17 17 0 01-2.5 3M6.6 6.6C4.2 8.2 3 10 3 10s3.5 5 9 5c1.4 0 2.7-.3 3.8-.8" /></svg>
    : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3.5-5 9-5 9 5 9 5-3.5 5-9 5-9-5-9-5z"/><circle cx="12" cy="12" r="2.5"/></svg>
}

function SwipeTransaction({ tx, onToggleExcluded, onToggleReconciled, onDelete, onEdit }) {
  const [offset, setOffset] = useState(0)
  const [touchStart, setTouchStart] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const revealWidth = 86
  const reconcileWidth = 86

  function handleTouchStart(e) {
    const t = e.touches[0]
    setTouchStart({ x: t.clientX, y: t.clientY, base: offset })
  }

  function handleTouchMove(e) {
    if (!touchStart) return
    const t = e.touches[0]
    const dx = t.clientX - touchStart.x
    const dy = t.clientY - touchStart.y
    if (Math.abs(dx) <= Math.abs(dy)) return
    const next = Math.max(-revealWidth, Math.min(reconcileWidth, touchStart.base + dx))
    setOffset(next)
  }

  async function handleTouchEnd() {
    if (offset > 38) {
      await onToggleReconciled()
      setOffset(0)
    } else {
      setOffset(offset < -34 ? -revealWidth : 0)
    }
    setTouchStart(null)
  }

  async function remove() {
    if (deleting) return
    setDeleting(true)
    const ok = await onDelete()
    if (!ok) {
      setDeleting(false)
      setOffset(0)
    }
  }

  return <div className={`swipe-row ${tx.reconciled ? 'is-reconciled' : ''}`}>
    <div className={`swipe-reconcile ${tx.reconciled ? 'undo-reconcile' : ''}`}><span>{tx.reconciled ? '↶' : '✓'}</span><small>{tx.reconciled ? '未核對' : '已核對'}</small></div>
    <button className="swipe-delete" onClick={remove} disabled={deleting}>{deleting ? '刪除中' : '刪除'}</button>
    <div
      className={`transaction swipe-content ${tx.excluded ? 'excluded' : ''}`}
      style={{ transform: `translateX(${offset}px)` }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onClick={() => {
        if (offset !== 0) setOffset(0)
        else onEdit()
      }}
    >
      <div><strong>{tx.title}</strong><span>{tx.date.slice(5).replace('-', '/')} {tx.excluded ? ' · 整筆不計回饋' : tx.programExclusions?.length ? ` · 已排除 ${tx.programExclusions.length} 個活動` : ''}{tx.reconciled ? ' · ✓ 已核對' : ''}</span></div>
      <div className="tx-right">
        <strong>{formatMoney(tx.amount)}</strong>
        <button className="mini-btn" onClick={(e) => { e.stopPropagation(); onToggleExcluded() }}>{tx.excluded ? '恢復回饋' : '排除回饋'}</button>
      </div>
    </div>
  </div>
}

function EmptyCards({ onAdd }) {
  return <section className="empty-cards">
    <div className="empty-card-visual"><span>＋</span></div>
    <h2>新增第一張信用卡</h2>
    <p>先建立卡片，再加入 A / B / C 等同時存在的回饋活動。</p>
    <button className="primary-btn" onClick={onAdd}>新增信用卡</button>
  </section>
}

function CardStack({ cards, selectedId, onSelect, onReorder }) {
  const ordered = cards
  const [drag, setDrag] = useState(null)
  const dragRef = React.useRef(null)
  const timerRef = React.useRef(null)

  function unlockDragScroll(state = dragRef.current) {
    if (!state?.scrollLock) return
    const { scrollY, bodyPrevious, preventMove } = state.scrollLock
    document.removeEventListener('touchmove', preventMove)
    const body = document.body
    body.style.position = bodyPrevious.position
    body.style.top = bodyPrevious.top
    body.style.left = bodyPrevious.left
    body.style.right = bodyPrevious.right
    body.style.width = bodyPrevious.width
    body.style.overflow = bodyPrevious.overflow
    window.scrollTo(0, scrollY)
  }

  function activateDrag(cardId, index, startY) {
    const body = document.body
    const scrollY = window.scrollY
    const bodyPrevious = {
      position:body.style.position,
      top:body.style.top,
      left:body.style.left,
      right:body.style.right,
      width:body.style.width,
      overflow:body.style.overflow,
    }
    const preventMove = e => e.preventDefault()
    document.addEventListener('touchmove', preventMove, { passive:false })

    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.left = '0'
    body.style.right = '0'
    body.style.width = '100%'
    body.style.overflow = 'hidden'

    const state = {
      cardId,
      index,
      startY,
      currentY:startY,
      targetIndex:index,
      active:true,
      scrollLock:{ scrollY, bodyPrevious, preventMove },
    }
    dragRef.current = state
    setDrag(state)
    if (navigator.vibrate) navigator.vibrate(12)
  }

  function handleTouchStart(e, cardId, index) {
    if (cards.length < 2) {
      dragRef.current = { active:false, cardId, index, startY:e.touches[0].clientY }
      return
    }

    const startY = e.touches[0].clientY
    dragRef.current = { active:false, pending:true, cardId, index, startY, currentY:startY }
    clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => activateDrag(cardId, index, startY), 300)
  }

  function handleTouchMove(e, cardId) {
    const state = dragRef.current
    if (!state || state.cardId !== cardId) return
    const y = e.touches[0].clientY

    if (!state.active) {
      if (Math.abs(y - state.startY) > 8) {
        clearTimeout(timerRef.current)
        state.pending = false
      }
      return
    }

    e.preventDefault()
    const slot = 38
    const delta = y - state.startY
    const rawTarget = state.index + Math.round(delta / slot)
    const targetIndex = Math.max(0, Math.min(ordered.length - 1, rawTarget))
    if (targetIndex !== state.targetIndex && navigator.vibrate) navigator.vibrate(7)
    const nextState = { ...state, currentY:y, targetIndex }
    dragRef.current = nextState
    setDrag(nextState)
  }

  async function handleTouchEnd(cardId) {
    clearTimeout(timerRef.current)
    const state = dragRef.current
    if (!state || state.cardId !== cardId) return

    if (!state.active) {
      dragRef.current = null
      setDrag(null)
      onSelect(cardId)
      return
    }

    unlockDragScroll(state)

    if (state.targetIndex !== state.index) {
      const next = [...ordered]
      const [moved] = next.splice(state.index, 1)
      next.splice(state.targetIndex, 0, moved)
      setDrag(null)
      dragRef.current = null
      onSelect(moved.id)
      await onReorder(next.map(card => card.id))
    } else {
      setDrag(null)
      dragRef.current = null
      onSelect(cardId)
    }
  }

  useEffect(() => () => {
    clearTimeout(timerRef.current)
    unlockDragScroll()
  }, [])

  function displayIndex(index) {
    if (!drag?.active) return index
    if (index === drag.index) return index
    if (drag.targetIndex > drag.index && index > drag.index && index <= drag.targetIndex) return index - 1
    if (drag.targetIndex < drag.index && index >= drag.targetIndex && index < drag.index) return index + 1
    return index
  }

  return <section className={`wallet-stack ${drag?.active ? 'reordering' : ''}`} aria-label="選擇信用卡">
    {ordered.map((card, index) => {
      const dragging = drag?.active && drag.cardId === card.id
      const shownIndex = displayIndex(index)
      const maxTravel = Math.max(38, (ordered.length - 1) * 38)
      const dy = dragging ? Math.max(-maxTravel, Math.min(maxTravel, drag.currentY - drag.startY)) : 0

      return <button
        key={card.id}
        className={`wallet-card ${card.id === selectedId ? 'selected' : ''} ${index > 0 ? 'stacked-behind' : ''} ${dragging ? 'dragging-card' : ''}`}
        style={{
          '--stack-index': shownIndex,
          '--drag-origin-index': index,
          '--card-a': card.colors[0],
          '--card-b': card.colors[1],
          '--drag-y': `${dy}px`,
        }}
        onTouchStart={e => handleTouchStart(e, card.id, index)}
        onTouchMove={e => handleTouchMove(e, card.id)}
        onTouchEnd={() => handleTouchEnd(card.id)}
        onTouchCancel={() => handleTouchEnd(card.id)}
        onContextMenu={e => e.preventDefault()}
      >
        <div className="card-top"><span>{card.bank || 'CARD'}</span><span>{card.last4 ? `•••• ${card.last4}` : ''}</span></div>
        <div className="card-name">{card.name}</div>
        <div className="card-bottom"><span>REWARDS</span><span>%</span></div>
        {index > 0 && <div className="stack-peek-label"><strong>{card.name}</strong><span>{card.bank || ''}</span></div>}
      </button>
    })}
    {cards.length > 1 && <div className="wallet-reorder-hint">{drag?.active ? '放開即可完成排序' : '長按卡片後上下拖曳排序'}</div>}
  </section>
}

function AddTransactionModal({ card, transactions, onClose, onSave }) {
  const [date, setDate] = useState(localToday())
  const [title, setTitle] = useState('')
  const [amount, setAmount] = useState('')
  const [isRefund, setIsRefund] = useState(false)
  const [busy, setBusy] = useState(false)
  const previewMonth = date.slice(0,7)
  const signedAmount = Number(amount) ? (isRefund ? -Math.abs(Number(amount)) : Math.abs(Number(amount))) : 0
  const baseSummary = useMemo(() => calculateCardSummary(card, transactions, previewMonth), [card, transactions, previewMonth])
  const projected = useMemo(() => {
    if (!signedAmount) return null
    const fake = { id:'preview', cardId:card.id, date, title:title || 'preview', amount:signedAmount, excluded:false, programExclusions:[] }
    return calculateCardSummary(card, [fake, ...transactions], previewMonth)
  }, [signedAmount, date, title, card, transactions, previewMonth])

  const capWarnings = useMemo(() => {
    if (!projected) return []
    return projected.programs.flatMap(after => {
      const before = baseSummary.programs.find(p => p.id === after.id)
      if (!before || before.capped || !after.capped || after.rate <= 0) return []
      let remainingSpend
      if (after.spendCap != null) remainingSpend = Math.max(0, after.spendCap - before.eligibleSpend)
      else if (after.rewardCap != null) remainingSpend = Math.max(0, (after.rewardCap - before.reward) / (after.rate / 100))
      if (remainingSpend == null || remainingSpend >= Math.abs(signedAmount)) return []
      return [{ name:after.name, rate:after.rate, eligible:Math.floor(remainingSpend), excess:Math.max(0, Math.ceil(Math.abs(signedAmount)-remainingSpend)) }]
    })
  }, [projected, baseSummary, signedAmount, isRefund])

  const rewardBreakdown = useMemo(() => {
    if (!projected || !signedAmount || isRefund) return []
    return projected.programs.map(after => {
      const before = baseSummary.programs.find(p => p.id === after.id)
      const beforeReward = Number(before?.reward || 0)
      const gained = Math.max(0, Number(after.reward || 0) - beforeReward)
      return {
        id: after.id,
        name: after.name,
        rate: after.rate,
        gained,
        effective: signedAmount ? gained / Math.abs(signedAmount) * 100 : 0,
        capped: after.capped,
      }
    })
  }, [projected, baseSummary, signedAmount])

  async function save() {
    setBusy(true)
    try { await onSave({ cardId:card.id, date, title, amount:signedAmount }) }
    catch (e) { alert(e.message) }
    finally { setBusy(false) }
  }

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <div className="sheet" onMouseDown={e => e.stopPropagation()}>
      <SheetGrabber onClose={onClose} />
      <h3>新增刷卡</h3>
      <div className="selected-mini-card">{card.name}<span>{card.bank}</span></div>
      <label>日期<DateField value={date} onChange={setDate} /></label>
      <label>刷卡項目<input placeholder="手動輸入，例如：加油" value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>金額
        <div className="amount-with-refund">
          <input inputMode="decimal" placeholder="$ 0" value={amount} onChange={e => setAmount(e.target.value.replace(/^-/,''))} />
          <button type="button" className={`refund-chip ${isRefund ? 'active' : ''}`} onClick={() => setIsRefund(v => !v)}>退刷</button>
        </div>
      </label>
      {projected && <div className="reward-preview"><span>新增後本月預估總回饋</span><strong>{formatMoney(projected.totalReward)} · {formatPct(projected.effectiveRate)}</strong></div>}
      {rewardBreakdown.length > 0 && <div className="reward-breakdown">{rewardBreakdown.map(p => <div key={p.id}><span>{p.name} · {p.rate}%{p.capped ? ' · 已達上限' : ''}</span><strong>本筆 +{formatMoney(p.gained)} <small>({formatPct(p.effective)})</small></strong></div>)}</div>}
      {capWarnings.map(w => <div className="cap-warning" key={w.name}><strong>{w.name}｜{w.rate}% 將達上限</strong><div>本筆約前 {formatMoney(w.eligible)} 仍可取得此活動回饋，剩餘 {formatMoney(w.excess)} 超過該活動上限；其他活動仍會各自計算。</div></div>)}
      <button className="primary-btn" disabled={busy || !title.trim() || !signedAmount} onClick={save}>{busy ? '儲存中…' : '新增'}</button>
    </div>
  </div>
}

function RangePicker({ startDate, endDate, onClose, onApply }) {
  const [mode, setMode] = useState('date')
  const [start, setStart] = useState(startDate)
  const [end, setEnd] = useState(endDate)
  const [startMonth, setStartMonth] = useState(startDate.slice(0,7))
  const [endMonth, setEndMonth] = useState(endDate.slice(0,7))

  function apply() {
    let s = start
    let e = end
    if (mode === 'month') {
      s = `${startMonth}-01`
      e = lastDayOfMonth(endMonth)
    }
    if (!s || !e) return
    if (s > e) {
      alert('開始日期不能晚於結束日期。')
      return
    }
    onApply(s, e)
  }

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <div className="sheet" onMouseDown={e => e.stopPropagation()}>
      <SheetGrabber onClose={onClose} />
      <div className="sheet-title-row"><h3>自訂區間</h3><button className="close-btn" onClick={onClose}>×</button></div>
      <div className="segment-control">
        <button className={mode === 'date' ? 'selected' : ''} onClick={() => setMode('date')}>自訂日期</button>
        <button className={mode === 'month' ? 'selected' : ''} onClick={() => setMode('month')}>月份區間</button>
      </div>
      {mode === 'date' ? <div className="two-col range-date-grid">
        <label>開始日期<DateField value={start} onChange={setStart} /></label>
        <label>結束日期<DateField value={end} onChange={setEnd} /></label>
      </div> : <div className="two-col range-month-grid">
        <label>起始月份<MonthField value={startMonth} onChange={setStartMonth} /></label>
        <label>結束月份<MonthField value={endMonth} onChange={setEndMonth} /></label>
      </div>}
      <div className="range-explain">區間跨越多個月份時，每個月份會各自套用該月的回饋活動與上限，再將結果加總。</div>
      <button className="primary-btn" onClick={apply}>套用區間</button>
    </div>
  </div>
}

function DateField({ value, onChange, placeholder = '選擇日期' }) {
  return <div className={`custom-date-field ${value ? '' : 'empty'}`}>
    <span>{value ? formatDateLong(value) : placeholder}</span>
    <span className="date-chevron">⌄</span>
    <input
      type="date"
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      aria-label={placeholder}
    />
  </div>
}

function MonthField({ value, onChange, placeholder = '選擇月份' }) {
  return <div className={`custom-date-field custom-month-field ${value ? '' : 'empty'}`}>
    <span>{value ? formatMonthLong(value) : placeholder}</span>
    <span className="date-chevron">⌄</span>
    <input
      type="month"
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      aria-label={placeholder}
    />
  </div>
}

function TransactionEditor({ tx, cards, onClose, onSave }) {
  const currentCard = cards.find(c => c.id === tx.cardId) || cards[0]
  const [cardId,setCardId] = useState(tx.cardId)
  const [date,setDate] = useState(tx.date)
  const [postedDate,setPostedDate] = useState(tx.postedDate || '')
  const [title,setTitle] = useState(tx.title)
  const [amount,setAmount] = useState(String(Math.abs(tx.amount)))
  const [isRefund,setIsRefund] = useState(Number(tx.amount) < 0)
  const [excluded,setExcluded] = useState(tx.excluded)
  const [reconciled,setReconciled] = useState(tx.reconciled)
  const [programExclusions,setProgramExclusions] = useState(tx.programExclusions || [])
  const [busy,setBusy] = useState(false)
  const selected = cards.find(c=>c.id===cardId) || currentCard

  function toggleProgram(id) {
    setProgramExclusions(prev => prev.includes(id) ? prev.filter(x=>x!==id) : [...prev,id])
  }

  async function save() {
    setBusy(true)
    try {
      await onSave({ id:tx.id,cardId,date,postedDate,title,amount:isRefund ? -Math.abs(Number(amount)) : Math.abs(Number(amount)),excluded,reconciled,programExclusions })
    } catch(e){ alert(e.message) }
    finally { setBusy(false) }
  }

  return <div className="modal-backdrop" onMouseDown={onClose}><div className="sheet sheet-tall" onMouseDown={e=>e.stopPropagation()}>
    <SheetGrabber onClose={onClose} /><div className="sheet-title-row"><h3>編輯刷卡紀錄</h3><button className="close-btn" onClick={onClose}>×</button></div>
    <label>信用卡<select value={cardId} onChange={e=>{setCardId(e.target.value);setProgramExclusions([])}}>{cards.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    <div className="transaction-date-grid"><label>交易日<DateField value={date} onChange={setDate} /></label><label>入帳日（選填）<DateField value={postedDate} onChange={setPostedDate} placeholder="未設定" /></label></div>
    <label>刷卡項目<input value={title} onChange={e=>setTitle(e.target.value)} /></label>
    <label>金額
      <div className="amount-with-refund">
        <input inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value.replace(/^-/,''))} />
        <button type="button" className={`refund-chip ${isRefund ? 'active' : ''}`} onClick={()=>setIsRefund(v=>!v)}>退刷</button>
      </div>
    </label>
    <div className="toggle-row"><span>整筆不計回饋</span><button className={excluded?'toggle on':'toggle'} onClick={()=>setExcluded(v=>!v)}><i /></button></div>
    <div className="toggle-row"><span>已核對帳單</span><button className={reconciled?'toggle on':'toggle'} onClick={()=>setReconciled(v=>!v)}><i /></button></div>
    {!excluded && selected?.rewardPrograms?.length > 0 && <>
      <div className="field-label">只排除指定回饋活動</div>
      <div className="program-exclusion-list">{selected.rewardPrograms.map(p=><button key={p.id} className={programExclusions.includes(p.id)?'chosen':''} onClick={()=>toggleProgram(p.id)}>{programExclusions.includes(p.id)?'✓ ':''}{p.name} · {p.rate}%</button>)}</div>
    </>}
    <button className="primary-btn" disabled={busy || !title.trim() || !Number.isFinite(Number(amount))} onClick={save}>{busy?'儲存中…':'儲存修改'}</button>
  </div></div>
}

function CardEditor({ card, onClose, onSaveCard, onSaveProgram, onDeleteProgram, onArchiveCard, onDuplicatePrograms }) {
  const isNew = !card
  const [name, setName] = useState(card?.name || '')
  const [bank, setBank] = useState(card?.bank || '')
  const [last4, setLast4] = useState(card?.last4 || '')
  const [limit, setLimit] = useState(card?.monthlySpendLimit || '')
  const [tip, setTip] = useState(card?.tip || '')
  const [colors, setColors] = useState(card?.colors || PALETTES[0])
  const [basis, setBasis] = useState(card?.rewardDateBasis || 'transaction')
  const [programEditing, setProgramEditing] = useState(null)
  const [busy, setBusy] = useState(false)

  async function saveCard() {
    setBusy(true)
    try {
      await onSaveCard({ id:card?.id, name, bank, last4, monthlySpendLimit:limit, tip, colors, rewardDateBasis:basis })
      if (isNew) onClose()
    } catch (e) { alert(e.message) }
    finally { setBusy(false) }
  }

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <div className="sheet sheet-tall" onMouseDown={e => e.stopPropagation()}>
      <SheetGrabber onClose={onClose} />
      <div className="sheet-title-row"><h3>{isNew ? '新增信用卡' : '卡片設定'}</h3><button className="close-btn" onClick={onClose}>×</button></div>
      <label>卡片名稱<input value={name} onChange={e => setName(e.target.value)} placeholder="例如：Sport 卡" /></label>
      <div className="two-col">
        <label>銀行<input value={bank} onChange={e => setBank(e.target.value)} placeholder="例如：台新" /></label>
        <label>末四碼（選填）<input inputMode="numeric" maxLength={4} value={last4} onChange={e => setLast4(e.target.value.replace(/\D/g,'').slice(0,4))} /></label>
      </div>
      <label>每月刷卡總額上限<input inputMode="decimal" value={limit} onChange={e => setLimit(e.target.value)} placeholder="例如：15000" /></label>
      <label>回饋認列日期
        <select value={basis} onChange={e => setBasis(e.target.value)}><option value="transaction">交易日</option><option value="posted">入帳日</option></select>
      </label>
      <label>Tip<textarea value={tip} onChange={e => setTip(e.target.value)} placeholder="只有點 ⓘ 才會顯示" /></label>
      <div className="field-label">卡片樣式</div>
      <div className="palette-list">{PALETTES.map((p,i) => <button key={i} className={`palette ${colors[0]===p[0]?'chosen':''}`} style={{background:`linear-gradient(135deg,${p[0]},${p[1]})`}} onClick={() => setColors(p)} />)}</div>
      <button className="primary-btn" disabled={busy || !name.trim()} onClick={saveCard}>{busy ? '儲存中…' : isNew ? '建立卡片' : '儲存卡片設定'}</button>

      {!isNew && <>
        <div className="divider" />
        <div className="sheet-title-row"><h3 className="subheading">回饋活動</h3><button className="small-add" onClick={() => setProgramEditing({})}>＋ 新增</button></div>
        <button className="duplicate-programs" onClick={async () => {
          try {
            const count = await onDuplicatePrograms(card.id)
            alert(`已複製 ${count} 個活動到下一期，可再逐一調整日期與回饋率。`)
          } catch(e) { alert(e.message) }
        }}>⧉ 複製所有活動到下一期</button>
        <div className="program-settings-list">
          {card.rewardPrograms.map(p => <div className="program-setting" key={p.id}>
            <button className="program-setting-main" onClick={() => setProgramEditing(p)}>
              <strong>{p.name} · {p.rate}%</strong>
              <span>{p.rewardCap != null ? `回饋上限 ${formatMoney(p.rewardCap)}` : p.spendCap != null ? `消費上限 ${formatMoney(p.spendCap)}` : '無上限'} · {p.calcMode === 'monthly_total' ? '整月加總' : '單筆計算'}</span>
            </button>
            <button className="delete-mini" onClick={async () => { if(confirm('刪除這個回饋活動？')) { try { await onDeleteProgram(p.id) } catch(e){ alert(e.message) } } }}>刪除</button>
          </div>)}
          {!card.rewardPrograms.length && <div className="empty-list">尚未建立回饋活動</div>}
        </div>
      </>}

      {!isNew && <button className="archive-card-btn" onClick={async () => {
        if(confirm('封存這張卡？封存後會從首頁隱藏，交易資料仍保留。')) {
          try { await onArchiveCard(card.id); onClose() } catch(e){ alert(e.message) }
        }
      }}>封存這張信用卡</button>}

      {programEditing && <ProgramEditor value={programEditing} onCancel={() => setProgramEditing(null)} onSave={async p => { try { await onSaveProgram(card.id,p); setProgramEditing(null) } catch(e){ alert(e.message) } }} />}
    </div>
  </div>
}

function ProgramEditor({ value, onCancel, onSave }) {
  const initialCapType = value.rewardCap != null ? 'reward' : value.spendCap != null ? 'spend' : 'none'
  const [name,setName]=useState(value.name || '')
  const [rate,setRate]=useState(value.rate ?? '')
  const [capType,setCapType]=useState(initialCapType)
  const [capValue,setCapValue]=useState(value.rewardCap ?? value.spendCap ?? '')
  const [calcMode,setCalcMode]=useState(value.calcMode || 'monthly_total')
  const [rounding,setRounding]=useState(value.rounding || 'floor')
  const [startDate,setStartDate]=useState(value.startDate || '')
  const [endDate,setEndDate]=useState(value.endDate || '')
  return <div className="inline-editor">
    <div className="sheet-title-row"><h4>{value.id ? '編輯回饋活動' : '新增回饋活動'}</h4><button className="close-btn" onClick={onCancel}>×</button></div>
    <div className="two-col"><label>活動名稱<input value={name} onChange={e=>setName(e.target.value)} placeholder="A / 基本回饋" /></label><label>回饋 %<input inputMode="decimal" value={rate} onChange={e=>setRate(e.target.value)} placeholder="3" /></label></div>
    <label>上限類型<select value={capType} onChange={e=>setCapType(e.target.value)}><option value="none">無上限</option><option value="reward">回饋金上限</option><option value="spend">消費金額上限</option></select></label>
    {capType !== 'none' && <label>{capType === 'reward' ? '回饋金上限' : '消費金額上限'}<input inputMode="decimal" value={capValue} onChange={e=>setCapValue(e.target.value)} /></label>}
    <div className="two-col"><label>計算方式<select value={calcMode} onChange={e=>setCalcMode(e.target.value)}><option value="monthly_total">整月加總後計算</option><option value="per_transaction">單項計算再加總</option></select></label><label>小數處理<select value={rounding} onChange={e=>setRounding(e.target.value)}><option value="floor">無條件捨去</option><option value="round">四捨五入</option></select></label></div>
    <div className="two-col range-date-grid"><label>開始日期<DateField value={startDate} onChange={setStartDate} placeholder="未設定" /></label><label>結束日期<DateField value={endDate} onChange={setEndDate} placeholder="未設定" /></label></div>
    <button className="primary-btn" disabled={!name.trim() || Number(rate)<0} onClick={() => onSave({ ...value,name,rate,capType,capValue,calcMode,rounding,startDate,endDate })}>儲存回饋活動</button>
  </div>
}

function AccountSheet({ version, email, cards, onClose, onOpenCards, onAddCard, onRestoreCard, onSignOut }) {
  const archived = cards.filter(c => c.archived)

  return <div className="modal-backdrop" onMouseDown={onClose}><div className="sheet sheet-tall" onMouseDown={e=>e.stopPropagation()}>
    <SheetGrabber onClose={onClose} /><div className="sheet-title-row"><h3>帳號與卡片</h3><button className="close-btn" onClick={onClose}>×</button></div>
    <div className="account-email">{email}</div>
    <button className="settings-action" onClick={onOpenCards}>▰ 卡片設定</button>
    <button className="settings-action" onClick={onAddCard}>＋ 新增信用卡</button>
    {archived.length > 0 && <>
      <div className="field-label">已封存</div>
      <div className="archived-list">{archived.map(card => <div className="archived-card" key={card.id}><span>{card.name}</span><button onClick={async()=>{try{await onRestoreCard(card.id)}catch(e){alert(e.message)}}}>恢復</button></div>)}</div>
    </>}
    <div className="app-version">Card Rewards v{version}</div>
    <button className="settings-action danger-text" onClick={onSignOut}>登出</button>
  </div></div>
}

function CardListSheet({ cards, onClose, onChoose, onAdd }) {
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="sheet sheet-tall" onMouseDown={e=>e.stopPropagation()}>
    <SheetGrabber onClose={onClose} />
    <div className="sheet-title-row"><h3>卡片設定</h3><button className="close-btn" onClick={onClose}>×</button></div>
    <div className="card-settings-list">
      {cards.map(card => <button className="card-settings-item" key={card.id} onClick={() => onChoose(card.id)}>
        <div className="card-settings-swatch" style={{background:`linear-gradient(135deg,${card.colors[0]},${card.colors[1]})`}} />
        <div className="card-settings-copy">
          <strong>{card.name}</strong>
          <span>{card.bank || '未設定銀行'}{card.last4 ? ` · •••• ${card.last4}` : ''}</span>
        </div>
        <span className="card-settings-chevron">›</span>
      </button>)}
      {!cards.length && <div className="empty-list">尚未新增信用卡</div>}
    </div>
    <button className="primary-btn" onClick={onAdd}>＋ 新增信用卡</button>
  </div></div>
}

function StatsSheet({ cards, transactions, month, onClose }) {
  const rows = cards.map(card => {
    const s = calculateCardSummary(card, transactions, month)
    const lost = s.programs.reduce((sum,p) => sum + Number(p.lostToCap || 0), 0)
    return { card, ...s, lost }
  })
  const totalSpend = rows.reduce((s,r)=>s+r.totalSpend,0)
  const totalReward = rows.reduce((s,r)=>s+r.totalReward,0)
  const totalLost = rows.reduce((s,r)=>s+r.lost,0)
  const best = [...rows].filter(r=>r.totalSpend>0).sort((a,b)=>b.effectiveRate-a.effectiveRate)[0]

  return <div className="modal-backdrop" onMouseDown={onClose}><div className="sheet sheet-tall stats-sheet" onMouseDown={e=>e.stopPropagation()}>
    <SheetGrabber onClose={onClose} /><div className="sheet-title-row"><h3>{month.replace('-',' / ')} 統計</h3><button className="close-btn" onClick={onClose}>×</button></div>
    <div className="stats-hero">
      <div><span>總刷卡</span><strong>{formatMoney(totalSpend)}</strong></div>
      <div><span>總回饋</span><strong>{formatMoney(totalReward)}</strong></div>
      <div><span>整體回饋率</span><strong>{totalSpend ? formatPct(totalReward/totalSpend*100) : '0.00%'}</strong></div>
    </div>
    {best && <div className="best-card">本月效率最高 <strong>{best.card.name}</strong><span>{formatPct(best.effectiveRate)}</span></div>}
    {totalLost > 0 && <div className="lost-reward">因活動上限未取得的理論回饋：約 <strong>{formatMoney(totalLost)}</strong></div>}
    <div className="stats-list">
      {rows.map(r => <div className="stats-row" key={r.card.id}>
        <div><strong>{r.card.name}</strong><span>{formatMoney(r.totalSpend)} 刷卡</span></div>
        <div><strong>{formatMoney(r.totalReward)}</strong><span>{formatPct(r.effectiveRate)}</span></div>
      </div>)}
    </div>
  </div></div>
}

function CenteredState({ title, compact=false }) { return <div className={compact ? 'center-state compact' : 'center-state'}>{title}</div> }

function fromProgramRow(p) {
  return {
    id:p.id, name:p.name, rate:Number(p.rate), rewardCap:p.reward_cap == null ? null : Number(p.reward_cap),
    spendCap:p.spend_cap == null ? null : Number(p.spend_cap), calcMode:p.calc_mode, rounding:p.rounding,
    startDate:p.start_date, endDate:p.end_date,
  }
}
function localToday(){ const d=new Date(); const off=d.getTimezoneOffset(); return new Date(d.getTime()-off*60000).toISOString().slice(0,10) }
function localMonth(){ return localToday().slice(0,7) }
function lastDayOfMonth(month){
  const [year, mon] = month.split('-').map(Number)
  const d = new Date(year, mon, 0)
  return `${year}-${String(mon).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function formatDateShort(date){
  const [,m,d] = date.split('-')
  return `${Number(m)}/${Number(d)}`
}
function formatDateLong(date){
  const [y,m,d] = date.split('-')
  return `${Number(y)}年${Number(m)}月${Number(d)}日`
}
function formatMonthLong(month){
  const [y,m] = month.split('-')
  return `${Number(y)}年${Number(m)}月`
}
function normalizeCardColors(colorA, colorB){
  const index = LEGACY_PALETTES.findIndex(([a,b]) => a === colorA && b === colorB)
  return index >= 0 ? PALETTES[index] : [colorA || PALETTES[0][0], colorB || PALETTES[0][1]]
}
function addDays(dateStr, days){
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate()+days)
  return d.toISOString().slice(0,10)
}
function shiftPeriod(startDate,endDate){
  if(!startDate && !endDate) return {startDate:null,endDate:null}
  if(startDate && endDate){
    const start = new Date(startDate+'T12:00:00')
    const end = new Date(endDate+'T12:00:00')
    const span = Math.max(1, Math.round((end-start)/86400000)+1)
    const nextStart = new Date(end); nextStart.setDate(nextStart.getDate()+1)
    const nextEnd = new Date(nextStart); nextEnd.setDate(nextEnd.getDate()+span-1)
    return {startDate:nextStart.toISOString().slice(0,10),endDate:nextEnd.toISOString().slice(0,10)}
  }
  if(endDate){
    const end = new Date(endDate+'T12:00:00'); const next = new Date(end); next.setDate(next.getDate()+1)
    return {startDate:next.toISOString().slice(0,10),endDate:null}
  }
  const start = new Date(startDate+'T12:00:00'); const next = new Date(start); next.setMonth(next.getMonth()+1)
  return {startDate:next.toISOString().slice(0,10),endDate:null}
}

createRoot(document.getElementById('root')).render(<App />)
