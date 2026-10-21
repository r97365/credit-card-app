import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import './styles.css'
import { readLastSelectedCard, rememberLastSelectedCard, resolveSelectedCard, readCardView, rememberCardView, defaultCardView } from './cardPreference'
import { calculateCardSummary, calculateCardSummaryStatement, calculateCardSummaryRange, getStatementPeriodBounds, getStatementPeriodKey, isStatementPeriodEstimated, formatMoney, formatPct } from './rewardEngine'
import { supabase } from './supabase'
import { saveSnapshot, getSnapshot, queueMutation, countQueuedMutations, getQueuedMutations, removeMutation, supportsStatementCycles } from './offlineStore'
import { mergeCardsWithLocalPending, mergeTransactionsWithLocalPending } from './offlineMerge'
import { flushMutationQueue, resolveConflict, inspectSyncConflict, loadConflicts, networkError } from './syncEngine'

const APP_VERSION = '0.4.13'
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
  const restoredUserRef = React.useRef(null)
  const [month, setMonth] = useState(localMonth())
  const [periodMode, setPeriodMode] = useState('month')
  const viewCardIdRef = React.useRef(null)
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
  const [loadedUserId, setLoadedUserId] = useState(null)
  const [offlineDataMissing, setOfflineDataMissing] = useState(false)
  const [cycleSchemaReady, setCycleSchemaReady] = useState(false)
  const [error, setError] = useState('')
  const [online, setOnline] = useState(navigator.onLine)
  const [pendingSync, setPendingSync] = useState(0)
  const [syncConflicts, setSyncConflicts] = useState([])
  const [syncBusy, setSyncBusy] = useState(false)
  const [showSyncSheet, setShowSyncSheet] = useState(false)
  const [snapshotSavedAt, setSnapshotSavedAt] = useState(null)

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
    if (!('serviceWorker' in navigator)) return
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => {})
  }, [])

  useEffect(() => {
    const handleOnline = () => {
      setOnline(true)
      if (session?.user) syncNow(true)
    }
    const handleOffline = () => setOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [session?.user?.id])

  useEffect(() => {
    if (!session?.user) return
    const handleVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) syncNow(true)
    }
    window.addEventListener('focus', handleVisible)
    document.addEventListener('visibilitychange', handleVisible)
    return () => {
      window.removeEventListener('focus', handleVisible)
      document.removeEventListener('visibilitychange', handleVisible)
    }
  }, [session?.user?.id])

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
    if (session?.user) {
      restoredUserRef.current = session.user.id
      loadData()
    }
    if (session === null) {
      setCards([])
      setTransactions([])
      setSelectedCardId(null)
      setLoadedUserId(null)
      setOfflineDataMissing(false)
      viewCardIdRef.current = null
      restoredUserRef.current = null
    }
  }, [session?.user?.id])

  useEffect(() => {
    // Do not persist an incomplete startup view or a previous user's data.
    if (!session?.user || loadedUserId !== session.user.id || loadingData) return
    if (!cards.length && transactions.length) return
    saveSnapshot(session.user.id, { cards, transactions, cycleSchemaReady })
      .then(saved => { if (saved) setSnapshotSavedAt(new Date().toISOString()) })
      .catch(err => setError('本機離線資料儲存失敗：' + (err?.message || '未知錯誤')))
  }, [session?.user?.id, loadedUserId, loadingData, cards, transactions])

  async function refreshSyncStatus() {
    if (!session?.user) return
    const [pending, conflicts] = await Promise.all([
      countQueuedMutations(session.user.id),
      loadConflicts(session.user.id),
    ])
    setPendingSync(pending)
    setSyncConflicts(conflicts)
  }

  async function syncNow(reload = false) {
    if (!session?.user || !navigator.onLine || syncBusy) return
    setSyncBusy(true)
    try {
      await flushMutationQueue(session.user.id)
      await refreshSyncStatus()
      if (reload) await loadData(null, { skipFlush:true })
    } catch (e) {
      if (!networkError(e)) setError(e.message)
    } finally {
      setSyncBusy(false)
    }
  }

  async function queueLocalMutation(mutation) {
    if (!session?.user) return
    await queueMutation(session.user.id, mutation)
    await refreshSyncStatus()
    if (navigator.onLine) {
      flushMutationQueue(session.user.id)
        .then(refreshSyncStatus)
        .catch(e => { if (!networkError(e)) setError(e.message) })
    }
  }

  async function safeGetSnapshot(userId) {
    try {
      return await getSnapshot(userId)
    } catch (err) {
      setError('無法讀取離線資料庫：' + (err?.message || '請恢復網路後重新開啟 App'))
      return null
    }
  }

  async function loadData(preferredSelectedId = null, options = {}) {
    if (!session?.user) return
    setLoadingData(true)
    setError('')
    setOfflineDataMissing(false)

    try {
      if (!navigator.onLine) {
        const snapshot = await safeGetSnapshot(session.user.id)
        if (snapshot) {
          const pending = await getQueuedMutations(session.user.id)
          const restoredCards = mergeCardsWithLocalPending(snapshot.cards || [], snapshot.cards || [], pending)
          const restoredTx = mergeTransactionsWithLocalPending(snapshot.transactions || [], snapshot.transactions || [], pending)
          setCards(restoredCards)
          setTransactions(restoredTx)
          setLoadedUserId(session.user.id)
          setOfflineDataMissing(false)
          setCycleSchemaReady(supportsStatementCycles(snapshot))
          setSnapshotSavedAt(snapshot.savedAt || null)
          setSelectedCardId(prev => resolveSelectedCard(restoredCards, {
            preferredId:preferredSelectedId,
            savedId:readLastSelectedCard(session.user.id),
            currentId:prev,
          }))
        } else {
          setLoadedUserId(null)
          setOfflineDataMissing(true)
          setError('目前沒有可用的離線卡片快取。請恢復網路開啟一次，完成資料載入後再測試離線模式。')
        }
        await refreshSyncStatus()
        return
      }

      if (!options.skipFlush) {
        try { await flushMutationQueue(session.user.id) } catch (e) {
          if (!networkError(e)) throw e
        }
      }

      const [cardsRes, programsRes, txRes, exclusionsRes] = await Promise.all([
        supabase.from('cards').select('*').order('sort_order').order('created_at'),
        supabase.from('reward_programs').select('*').order('created_at'),
        supabase.from('transactions').select('*').order('transaction_date', { ascending: false }),
        supabase.from('transaction_reward_exclusions').select('*'),
      ])

      const firstError = cardsRes.error || programsRes.error || txRes.error || exclusionsRes.error
      if (firstError) throw firstError
      let hasCycleFields = cardsRes.data?.length
        ? Object.prototype.hasOwnProperty.call(cardsRes.data[0], 'statement_close_day')
        : programsRes.data?.length
          ? Object.prototype.hasOwnProperty.call(programsRes.data[0], 'cap_period')
          : txRes.data?.length
            ? Object.prototype.hasOwnProperty.call(txRes.data[0], 'statement_period_override')
            : false
      if (!cardsRes.data?.length && !programsRes.data?.length && !txRes.data?.length) {
        const probe = await supabase.from('cards').select('statement_close_day').limit(1)
        hasCycleFields = !probe.error
      }
      setCycleSchemaReady(Boolean(hasCycleFields))

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

      let nextCards = (cardsRes.data || []).map(row => ({
        id: row.id,
        name: row.name,
        bank: row.bank || '',
        last4: row.last4 || '',
        monthlySpendLimit: Number(row.monthly_spend_limit || 0),
        colors: normalizeCardColors(row.color_a, row.color_b),
        tip: row.tip || '',
        rewardDateBasis: row.reward_date_basis,
        statementCloseDay:row.statement_close_day ?? null,
        rewardPrograms: programsByCard.get(row.id) || [],
        sortOrder: Number(row.sort_order || 0),
        archived: Number(row.sort_order || 0) < 0,
        updatedAt: row.updated_at,
      })).sort((a,b) => (a.archived === b.archived ? a.sortOrder - b.sortOrder : a.archived ? 1 : -1))

      let nextTx = (txRes.data || []).map(row => ({
        id: row.id,
        cardId: row.card_id,
        date: row.transaction_date,
        postedDate: row.posted_date,
        statementPeriodOverride:row.statement_period_override || null,
        title: row.title,
        amount: Number(row.amount),
        excluded: row.excluded,
        reconciled: row.reconciled,
        programExclusions: exclusionMap.get(row.id) || [],
        updatedAt: row.updated_at,
      }))

      const queue = await getQueuedMutations(session.user.id)
      const snapshot = await safeGetSnapshot(session.user.id)
      if (queue.length && snapshot) {
        nextCards = mergeCardsWithLocalPending(nextCards, snapshot.cards || [], queue)
        nextTx = mergeTransactionsWithLocalPending(nextTx, snapshot.transactions || [], queue)
      }

      // A successful-looking but empty response is unsafe when we know this
      // account has cards. Keep the last valid local view until revalidated.
      if (!nextCards.length && snapshot?.cards?.length) {
        const recoveredCards = mergeCardsWithLocalPending(snapshot.cards, snapshot.cards, queue)
        const recoveredTx = mergeTransactionsWithLocalPending(snapshot.transactions || [], snapshot.transactions || [], queue)
        setCards(recoveredCards)
        setTransactions(recoveredTx)
        setLoadedUserId(session.user.id)
        setOfflineDataMissing(false)
        setSelectedCardId(prev => resolveSelectedCard(recoveredCards, {
          preferredId:preferredSelectedId,
          savedId:readLastSelectedCard(session.user.id),
          currentId:prev,
        }))
        setError('雲端暫時沒有回傳任何信用卡，已保留本機上次的資料；請確認網路後再同步，避免誤建重複卡片。')
        await refreshSyncStatus()
        return
      }

      // Transactions without their cards are not a valid account state.
      if (!nextCards.length && nextTx.length) {
        setLoadedUserId(null)
        setOfflineDataMissing(true)
        setError('偵測到刷卡紀錄，但信用卡資料未載入完成。請確認連線，避免建立重複卡片。')
        return
      }

      setCards(nextCards)
      setTransactions(nextTx)
      setLoadedUserId(session.user.id)
      setOfflineDataMissing(false)
      const didSave=await saveSnapshot(session.user.id, { cards:nextCards, transactions:nextTx, cycleSchemaReady:hasCycleFields })
      if (didSave) setSnapshotSavedAt(new Date().toISOString())

      setSelectedCardId(prev => resolveSelectedCard(nextCards, {
        preferredId:preferredSelectedId,
        savedId:readLastSelectedCard(session.user.id),
        currentId:prev,
      }))
      await refreshSyncStatus()
    } catch (e) {
      if (networkError(e)) {
        setOnline(false)
        const snapshot = await safeGetSnapshot(session.user.id)
        if (snapshot) {
          const pending = await getQueuedMutations(session.user.id)
          const restoredCards = mergeCardsWithLocalPending(snapshot.cards || [], snapshot.cards || [], pending)
          const restoredTx = mergeTransactionsWithLocalPending(snapshot.transactions || [], snapshot.transactions || [], pending)
          setCards(restoredCards)
          setTransactions(restoredTx)
          setLoadedUserId(session.user.id)
          setOfflineDataMissing(false)
          setCycleSchemaReady(supportsStatementCycles(snapshot))
          setSnapshotSavedAt(snapshot.savedAt || null)
          setSelectedCardId(prev => resolveSelectedCard(restoredCards, {
            preferredId:preferredSelectedId,
            savedId:readLastSelectedCard(session.user.id),
            currentId:prev,
          }))
        } else {
          setLoadedUserId(null)
          setOfflineDataMissing(true)
          setError('網路連線失敗，且沒有可用的離線卡片資料；請恢復網路重新載入。')
        }
      } else {
        setError(e.message)
      }
    } finally {
      setLoadingData(false)
    }
  }

  function selectCard(id) {
    if (!session?.user || !id) return
    if (selectedCardId === id) return
    const card = cards.find(item => item.id === id && !item.archived)
    if (!card) return
    const view = readCardView(session.user.id, id, {
      defaultMonth:localMonth(),
      statementAllowed:Boolean(card.statementCloseDay),
    })
    viewCardIdRef.current = id
    setMonth(view.month)
    setPeriodMode(view.mode)
    setRangeStart(view.rangeStart)
    setRangeEnd(view.rangeEnd)
    setSelectedCardId(id)
    rememberLastSelectedCard(session.user.id,id)
    setShowTip(false)
  }

  function changeView(next) {
    if (!session?.user || !selectedCardId) return
    const view = {
      mode:next.mode ?? periodMode,
      month:next.month ?? month,
      rangeStart:next.rangeStart ?? rangeStart,
      rangeEnd:next.rangeEnd ?? rangeEnd,
    }
    // Persist only a deliberate user action, never a render or data reload.
    rememberCardView(session.user.id,selectedCardId,view)
    setPeriodMode(view.mode)
    setMonth(view.month)
    setRangeStart(view.rangeStart)
    setRangeEnd(view.rangeEnd)
  }

  const activeCards = cards.filter(c => !c.archived)
  const selectedCard = activeCards.find(c => c.id === selectedCardId) || activeCards[0] || null
  useEffect(() => {
    if (!session?.user || !selectedCardId || !selectedCard) return
    if (viewCardIdRef.current !== selectedCardId) {
      const view=readCardView(session.user.id, selectedCardId, {
        defaultMonth:localMonth(),
        statementAllowed:Boolean(selectedCard.statementCloseDay),
      })
      viewCardIdRef.current=selectedCardId
      setPeriodMode(view.mode)
      setMonth(view.month)
      setRangeStart(view.rangeStart)
      setRangeEnd(view.rangeEnd)
    } else if (periodMode === 'statement' && !selectedCard.statementCloseDay) {
      changeView({mode:'month'})
    }
  }, [selectedCardId, session?.user?.id, selectedCard?.statementCloseDay, cycleSchemaReady])
  const summary = useMemo(
    () => selectedCard
      ? (periodMode === 'month'
          ? calculateCardSummary(selectedCard, transactions, month)
          : periodMode === 'statement'
            ? calculateCardSummaryStatement(selectedCard, transactions, month)
            : calculateCardSummaryRange(selectedCard, transactions, rangeStart, rangeEnd))
      : null,
    [selectedCard, transactions, month, periodMode, rangeStart, rangeEnd]
  )

  const visibleTransactions = useMemo(() => transactions.filter(t =>
    t.cardId === selectedCardId &&
    (periodMode === 'month'
      ? t.date.startsWith(month)
      : periodMode === 'statement'
        ? getStatementPeriodKey(selectedCard, t) === month
        : t.date >= rangeStart && t.date <= rangeEnd)
  ), [transactions, selectedCardId, selectedCard, periodMode, month, rangeStart, rangeEnd])

  const expiringPrograms = useMemo(() => {
    const today = localToday()
    const inTenDays = addDays(today, 10)
    return activeCards.flatMap(card => card.rewardPrograms
      .filter(p => p.endDate && p.endDate >= today && p.endDate <= inTenDays)
      .map(p => ({ ...p, cardName:card.name })))
      .sort((a,b) => a.endDate.localeCompare(b.endDate))
  }, [activeCards])

  const modalOpen = showRangePicker || showAddTx || showCardEditor || showCardList || showSettings || showStats || showSyncSheet || Boolean(editingTransaction)

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
    const id = crypto.randomUUID()
    const updatedAt = new Date().toISOString()
    const localTx = {
      id,
      cardId:tx.cardId,
      date:tx.date,
      postedDate:null,
      statementPeriodOverride:null,
      title:tx.title.trim(),
      amount:Number(tx.amount),
      excluded:false,
      reconciled:false,
      programExclusions:[],
      updatedAt,
    }



    await queueLocalMutation({
      entity:'transaction',
      recordId:id,
      op:'create',
      payload:{
        id,
        user_id:session.user.id,
        card_id:tx.cardId,
        transaction_date:tx.date,
        posted_date:null,
        title:tx.title.trim(),
        amount:Number(tx.amount),
        excluded:false,
        reconciled:false,
        updated_at:updatedAt,
      },
      programExclusions:[],
    })
    setTransactions(prev => [localTx, ...prev])
    setShowAddTx(false)
  }

  async function toggleExcluded(txId) {
    const tx = transactions.find(t => t.id === txId)
    if (!tx) return
    const nextValue = !tx.excluded
    const updatedAt = new Date().toISOString()
    const nextTx = { ...tx, excluded:nextValue, updatedAt }


    await queueLocalMutation({
      entity:'transaction',
      recordId:txId,
      op:'update',
      baseUpdatedAt:tx.updatedAt || null,
      payload:toTransactionRow(nextTx, session.user.id, cycleSchemaReady),
      programExclusions:nextTx.programExclusions || [],
    })
    setTransactions(prev => prev.map(item => item.id === txId ? nextTx : item))
  }

  async function toggleReconciled(txId, forceValue) {
    const tx = transactions.find(t => t.id === txId)
    if (!tx) return false
    const nextValue = typeof forceValue === 'boolean' ? forceValue : !tx.reconciled
    const updatedAt = new Date().toISOString()
    const nextTx = { ...tx, reconciled:nextValue, updatedAt }


    await queueLocalMutation({
      entity:'transaction',
      recordId:txId,
      op:'update',
      baseUpdatedAt:tx.updatedAt || null,
      payload:toTransactionRow(nextTx, session.user.id, cycleSchemaReady),
      programExclusions:nextTx.programExclusions || [],
    })
    setTransactions(prev => prev.map(item => item.id === txId ? nextTx : item))
    return true
  }

  async function saveTransactionEdits(payload) {
    const previousTx = transactions.find(item => item.id === payload.id)
    if (!previousTx) return

    const updatedAt = new Date().toISOString()
    const nextTx = {
      ...previousTx,
      cardId:payload.cardId,
      date:payload.date,
      postedDate:payload.postedDate || null,
      statementPeriodOverride:payload.statementPeriodOverride || null,
      title:payload.title.trim(),
      amount:Number(payload.amount),
      excluded:payload.excluded,
      reconciled:payload.reconciled,
      programExclusions:[...(payload.programExclusions || [])],
      updatedAt,
    }



    await queueLocalMutation({
      entity:'transaction',
      recordId:payload.id,
      op:'update',
      baseUpdatedAt:previousTx.updatedAt || null,
      payload:toTransactionRow(nextTx, session.user.id, cycleSchemaReady),
      programExclusions:nextTx.programExclusions,
    })
    setTransactions(prev => prev.map(item => item.id === payload.id ? nextTx : item))
    setEditingTransaction(null)
  }

  async function deleteTransaction(txId) {
    const tx=transactions.find(item=>item.id===txId)
    if (!tx || !session?.user) return false

    // Make the deletion durable BEFORE hiding it. New cloud fetches merge away
    // tombstoned rows even when the user immediately creates another charge.
    const deadline=Date.now()+3500
    const mutation=await queueMutation(session.user.id,{
      entity:'transaction',recordId:txId,op:'delete',
      baseUpdatedAt:tx.updatedAt || null,payload:null,notBefore:deadline,
    })
    if (!mutation) return false
    setTransactions(prev=>prev.filter(item=>item.id!==txId))
    await refreshSyncStatus()

    // Each delete is independently queued. Replacing the undo prompt must
    // never cancel the previous deletion.
    if (undoDelete?.timer) clearTimeout(undoDelete.timer)
    const timer=window.setTimeout(()=>{
      setUndoDelete(current=>current?.mutationId===mutation.id ? null : current)
      if (navigator.onLine) {
        flushMutationQueue(session.user.id).then(refreshSyncStatus).catch(e=>{
          if (!networkError(e)) setError(e.message)
        })
      }
    },Math.max(0,deadline-Date.now())+30)
    setUndoDelete({tx,timer,mutationId:mutation.id})
    return true
  }

  async function undoTransactionDelete() {
    if (!undoDelete || !session?.user) return
    const item=undoDelete
    clearTimeout(item.timer)
    setUndoDelete(null)
    try {
      const queue=await getQueuedMutations(session.user.id)
      const stillPending=queue.some(m=>m.id===item.mutationId && m.op==='delete')
      if (!stillPending) {
        setError('刪除已完成同步，無法直接復原。')
        return
      }
      await removeMutation(item.mutationId)
      setTransactions(prev=>prev.some(t=>t.id===item.tx.id)?prev:[item.tx,...prev])
      await refreshSyncStatus()
    } catch(e) { setError(e.message) }
  }

  async function saveCard(payload) {
    const existing = payload.id ? cards.find(card => card.id === payload.id) : null
    if (existing?.rewardPrograms?.some(p => p.capPeriod === 'statement') &&
        cycleSchemaReady && !payload.statementCloseDay) {
      throw new Error('這張卡有使用帳單週期的回饋活動，請先調整那些活動，再清除結帳日。')
    }
    const id = payload.id || crypto.randomUUID()
    const updatedAt = new Date().toISOString()
    const sortOrder = existing?.sortOrder ?? activeCards.length

    const nextCard = {
      id,
      name:payload.name.trim(),
      bank:payload.bank.trim() || '',
      last4:payload.last4.trim() || '',
      monthlySpendLimit:payload.monthlySpendLimit ? Number(payload.monthlySpendLimit) : 0,
      tip:payload.tip.trim() || '',
      colors:payload.colors,
      rewardDateBasis:payload.rewardDateBasis,
      statementCloseDay:cycleSchemaReady ? (payload.statementCloseDay ? Number(payload.statementCloseDay) : null) : (existing?.statementCloseDay || null),
      rewardPrograms:existing?.rewardPrograms || [],
      sortOrder,
      archived:sortOrder < 0,
      updatedAt,
    }



    await queueLocalMutation({
      entity:'card',
      recordId:id,
      op:existing ? 'update' : 'create',
      baseUpdatedAt:existing?.updatedAt || null,
      payload:toCardRow(nextCard, session.user.id, cycleSchemaReady),
    })
    if (existing) {
      setCards(prev => prev.map(card => card.id === id ? nextCard : card))
    } else {
      setCards(prev => [...prev.filter(card => card.archived === false), nextCard, ...prev.filter(card => card.archived)])
      setSelectedCardId(id)
      viewCardIdRef.current = null
      rememberLastSelectedCard(session.user.id,id)
    }
  }

  async function saveProgram(cardId, p) {
    const card = cards.find(c => c.id === cardId)
    if (!card) return
    if (p.capPeriod === 'statement' && (!cycleSchemaReady || !card.statementCloseDay)) {
      throw new Error('請先儲存卡片的每月結帳日，再設定帳單週期回饋。')
    }

    const existing = p.id ? card.rewardPrograms.find(program => program.id === p.id) : null
    const id = p.id || crypto.randomUUID()
    const updatedAt = new Date().toISOString()
    const nextProgram = {
      id,
      name:p.name.trim(),
      rate:Number(p.rate || 0),
      rewardCap:p.capType === 'reward' && p.capValue !== '' ? Number(p.capValue) : null,
      spendCap:p.capType === 'spend' && p.capValue !== '' ? Number(p.capValue) : null,
      calcMode:p.calcMode,
      rounding:p.rounding,
      startDate:p.startDate || null,
      endDate:p.endDate || null,
      capPeriod:cycleSchemaReady ? (p.capPeriod || 'calendar') : 'calendar',
      updatedAt,
    }



    await queueLocalMutation({
      entity:'program',
      recordId:id,
      op:existing ? 'update' : 'create',
      baseUpdatedAt:existing?.updatedAt || null,
      payload:toProgramRow(nextProgram, cardId, session.user.id, cycleSchemaReady),
    })
    setCards(prev => prev.map(item => item.id !== cardId ? item : {
      ...item,
      rewardPrograms:existing
        ? item.rewardPrograms.map(program => program.id === id ? nextProgram : program)
        : [...item.rewardPrograms, nextProgram],
    }))
  }

  async function deleteProgram(id) {
    const card = cards.find(c => c.rewardPrograms.some(program => program.id === id))
    const program = card?.rewardPrograms.find(p => p.id === id)
    if (!card || !program) return



    await queueLocalMutation({
      entity:'program',
      recordId:id,
      op:'delete',
      baseUpdatedAt:program.updatedAt || null,
      payload:null,
    })
    setCards(prev => prev.map(item => item.id !== card.id ? item : {
      ...item,
      rewardPrograms:item.rewardPrograms.filter(p => p.id !== id),
    }))
  }

  async function reorderCards(orderedIds) {
    const active = orderedIds.map(id => cards.find(c => c.id === id)).filter(Boolean)
    const updatedAt = new Date().toISOString()
    const nextActive = active.map((card,index) => ({ ...card, sortOrder:index, updatedAt }))
    const archived = cards.filter(c => c.archived)
    setCards([...nextActive, ...archived])

    for (const card of nextActive) {
      await queueMutation(session.user.id, {
        entity:'card',
        recordId:card.id,
        op:'update',
        baseUpdatedAt:active.find(x => x.id === card.id)?.updatedAt || null,
        payload:toCardRow(card, session.user.id, cycleSchemaReady),
      })
    }
    await refreshSyncStatus()
    if (navigator.onLine) flushMutationQueue(session.user.id).then(refreshSyncStatus).catch(() => {})
  }

  async function archiveCard(cardId) {
    const card = cards.find(c => c.id === cardId)
    if (!card) return
    const updated = { ...card, sortOrder:-1, archived:true, updatedAt:new Date().toISOString() }
    setCards(prev => prev.map(item => item.id === cardId ? updated : item))
    if (selectedCardId === cardId) {
      const fallback=activeCards.find(c=>c.id!==cardId)?.id || null
      setSelectedCardId(fallback)
      viewCardIdRef.current = null
      rememberLastSelectedCard(session.user.id,fallback)
    }

    await queueLocalMutation({
      entity:'card',
      recordId:cardId,
      op:'update',
      baseUpdatedAt:card.updatedAt || null,
      payload:toCardRow(updated, session.user.id, cycleSchemaReady),
    })
  }

  async function restoreCard(cardId) {
    const card = cards.find(c => c.id === cardId)
    if (!card) return
    const updated = { ...card, sortOrder:activeCards.length, archived:false, updatedAt:new Date().toISOString() }
    setCards(prev => prev.map(item => item.id === cardId ? updated : item))

    await queueLocalMutation({
      entity:'card',
      recordId:cardId,
      op:'update',
      baseUpdatedAt:card.updatedAt || null,
      payload:toCardRow(updated, session.user.id, cycleSchemaReady),
    })
  }

  async function duplicateProgramsToNextPeriod(cardId) {
    const card = cards.find(c => c.id === cardId)
    if (!card?.rewardPrograms?.length) return 0

    const copies = card.rewardPrograms.map(p => {
      const shifted = shiftPeriod(p.startDate, p.endDate)
      return {
        id:crypto.randomUUID(),
        name:p.name,
        rate:p.rate,
        rewardCap:p.rewardCap,
        spendCap:p.spendCap,
        calcMode:p.calcMode,
        rounding:p.rounding,
        capPeriod:p.capPeriod || 'calendar',
        startDate:shifted.startDate,
        endDate:shifted.endDate,
        updatedAt:new Date().toISOString(),
      }
    })

    setCards(prev => prev.map(item => item.id !== cardId ? item : {
      ...item,
      rewardPrograms:[...item.rewardPrograms, ...copies],
    }))

    for (const program of copies) {
      await queueMutation(session.user.id, {
        entity:'program',
        recordId:program.id,
        op:'create',
        payload:toProgramRow(program, cardId, session.user.id, cycleSchemaReady),
      })
    }
    await refreshSyncStatus()
    if (navigator.onLine) flushMutationQueue(session.user.id).then(refreshSyncStatus).catch(() => {})
    return copies.length
  }

  async function handleInspectConflict(conflict) {
    if (!session?.user) throw new Error('請先登入，再查看衝突。')
    const latest = await inspectSyncConflict(session.user.id, conflict)
    setSyncConflicts(prev => prev.map(item => item.id === latest.id ? latest : item))
    return latest
  }

  async function handleResolveConflict(conflict, choice) {
    if (!session?.user || !navigator.onLine) throw new Error('連線後才能解決同步衝突。')
    setSyncBusy(true)
    try {
      await resolveConflict(session.user.id, conflict, choice)
      await refreshSyncStatus()
      await loadData(null, { skipFlush:true })
      return true
    } catch (e) {
      await refreshSyncStatus().catch(() => {})
      setError(e.message)
      throw e
    } finally {
      setSyncBusy(false)
    }
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
      {(!online || pendingSync > 0 || syncConflicts.length > 0 || syncBusy) && <button className={`sync-banner ${!online ? 'offline' : syncConflicts.length ? 'conflict' : ''}`} onClick={() => setShowSyncSheet(true)}>
        <span className="sync-dot" />
        <div>
          <strong>{!online ? '離線模式' : syncConflicts.length ? `${syncConflicts.length} 筆同步衝突` : syncBusy ? '同步中…' : `${pendingSync} 筆待同步`}</strong>
          <span>{!online ? '你仍可使用 App；恢復網路後會自動同步。' : syncConflicts.length ? '點這裡選擇保留本機或雲端版本。' : '資料會自動同步到 Supabase。'}</span>
        </div>
        <span className="sync-chevron">›</span>
      </button>}

      <section className="period-controls">
        <div className="period-modes">
          <button className={periodMode === 'month' ? 'selected' : ''} onClick={()=>changeView({mode:'month'})}>日曆月</button>
          <button
            disabled={!selectedCard?.statementCloseDay || (!cycleSchemaReady && navigator.onLine)}
            className={periodMode === 'statement' ? 'selected' : ''}
            onClick={()=>changeView({mode:'statement'})}
          >帳單週期</button>
          <button className={periodMode === 'range' ? 'selected' : ''} onClick={()=>setShowRangePicker(true)}>自訂區間</button>
        </div>
        <section className="period-bar">
          {periodMode !== 'range' ? <label className="month-pill active-period">
            <span>{month.replace('-', ' / ')}{periodMode === 'statement' ? ' 帳單' : ''}</span>
            <input type="month" value={month} onChange={e => changeView({month:e.target.value})} />
          </label> : <button className="month-pill active-period" onClick={()=>setShowRangePicker(true)}>
            {formatDateShort(rangeStart)}～{formatDateShort(rangeEnd)}
          </button>}
          <span className="period-view-hint">{periodMode === 'statement' ? '依帳單歸屬查看' : periodMode === 'range' ? '自行指定日期' : '依刷卡日期查看'}</span>
        </section>
      </section>
      {selectedCard && !selectedCard.statementCloseDay && <div className="cycle-help-text period-cycle-hint">若要以帳單週期檢視，請先在這張卡的「卡片設定」輸入每月結帳日。</div>}
      {periodMode === 'statement' && selectedCard?.statementCloseDay && <div className="statement-period-info">
        <strong>{formatDateLong(getStatementPeriodBounds(selectedCard,month).start)}～{formatDateLong(getStatementPeriodBounds(selectedCard,month).end)}</strong>
        <span>此期帳單 · {visibleTransactions.filter(isStatementPeriodEstimated).length} 筆尚未入帳（帳期預估）</span>
      </div>}

      {expiringPrograms.length > 0 && <div className="expiry-banner">
        <div><strong>活動即將到期</strong><span>{expiringPrograms.slice(0,2).map(p => `${p.cardName}・${p.name} ${formatDateShort(p.endDate)}`).join('　')}</span></div>
        <button onClick={() => { if (selectedCard) { setEditingCardId(selectedCard.id); setCreatingCard(false); setShowCardEditor(true) } }}>更新</button>
      </div>}

      {loadingData ? <CenteredState compact title="同步資料中…" /> : offlineDataMissing ? (
        <CenteredState compact title="離線卡片資料尚未準備；請恢復網路開啟一次，避免新增重複卡片。" />
      ) : !selectedCard ? (
        <EmptyCards onAdd={() => { setEditingCardId(null); setCreatingCard(true); setShowCardEditor(true) }} />
      ) : (
        <>
          <CardStack cards={activeCards} selectedId={selectedCardId} onSelect={selectCard} onReorder={reorderCards} />

          <section className="summary-card">
            <div className="summary-head">
              <div>
                <div className="title-line">
                  <h2>{selectedCard.name}</h2>
                  <button className="tip-button" onClick={() => setShowTip(v => !v)} aria-label="顯示提示">ⓘ</button>
                </div>
                <div className="muted">{periodMode === 'month' ? '本月刷卡' : periodMode === 'statement' ? '本期帳單' : '區間刷卡'}</div>
              </div>
              <div className={`status-badge ${periodMode !== 'range' && summary.limitRatio >= 1 ? 'danger' : periodMode !== 'range' && summary.limitRatio >= .85 ? 'warn' : ''}`}>
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
            {periodMode !== 'range' && <div className="progress"><div style={{ width: `${selectedCard.monthlySpendLimit ? Math.min(100, summary.limitRatio * 100) : 0}%` }} /></div>}
            {periodMode === 'range' && <div className="range-note">回饋上限按照每個活動真正的日曆月或帳單週期計算；縮小查看區間不會重新獲得完整上限。</div>}

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
                    <span>{p.capPeriod === 'statement' ? '帳期' : '月'} · {p.rewardCap == null
                      ? (p.spendCap == null ? '無上限' : `消費上限 ${formatMoney(p.spendCap)}`)
                      : `回饋上限 ${formatMoney(p.rewardCap)}`}</span>
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
              {!visibleTransactions.length && <div className="empty-list">{periodMode === 'month' ? '這個月還沒有刷卡紀錄' : periodMode === 'statement' ? '這期帳單還沒有刷卡紀錄' : '這個區間還沒有刷卡紀錄'}</div>}
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
          changeView({rangeStart:start,rangeEnd:end,mode:'range'})
          setShowRangePicker(false)
        }}
      />}
      {editingTransaction && <TransactionEditor tx={editingTransaction} cards={activeCards} cycleSchemaReady={cycleSchemaReady} onClose={() => setEditingTransaction(null)} onSave={saveTransactionEdits} />}
      {showCardEditor && <CardEditor
        card={creatingCard ? null : (activeCards.find(c => c.id === editingCardId) || selectedCard)}
        cycleSchemaReady={cycleSchemaReady}
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
      {showSyncSheet && <SyncSheet
        online={online}
        pending={pendingSync}
        conflicts={syncConflicts}
        cards={cards}
        busy={syncBusy}
        snapshotSavedAt={snapshotSavedAt}
        onClose={() => setShowSyncSheet(false)}
        onSync={() => syncNow(true)}
        onInspect={handleInspectConflict}
        onResolve={handleResolveConflict}
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
  // Selection affects presentation only; dragging is what saves permanent order.
  const [visualOrderIds, setVisualOrderIds] = useState(null)
  const ordered = useMemo(() => {
    if (!visualOrderIds) {
      const selected = cards.find(card => card.id === selectedId)
      return selected
        ? [selected, ...cards.filter(card => card.id !== selectedId)]
        : cards
    }
    const byId = new Map(cards.map(card => [card.id, card]))
    const listed = visualOrderIds.map(id => byId.get(id)).filter(Boolean)
    const seen = new Set(listed.map(card => card.id))
    return [...listed, ...cards.filter(card => !seen.has(card.id))]
  }, [cards, selectedId, visualOrderIds])
  const [drag, setDrag] = useState(null)

  useEffect(() => {
    if (!selectedId) return
    setVisualOrderIds(previous => {
      const ids = (previous || cards.map(card => card.id)).filter(id => cards.some(card => card.id === id))
      if (!ids.includes(selectedId) || ids[0] === selectedId) return previous
      return [selectedId, ...ids.filter(id => id !== selectedId)]
    })
  }, [selectedId])
  const dragRef = React.useRef(null)
  const timerRef = React.useRef(null)
  const lastTouchAtRef = React.useRef(0)

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
    lastTouchAtRef.current = Date.now()
    clearTimeout(timerRef.current)
    if (e.touches.length !== 1) {
      dragRef.current = null
      return
    }
    const startY = e.touches[0].clientY
    dragRef.current = {
      active:false, pending:cards.length >= 2, moved:false,
      cardId, index, startY, currentY:startY,
    }
    if (cards.length >= 2) {
      timerRef.current = window.setTimeout(() => {
        const state = dragRef.current
        if (state?.cardId === cardId && state.pending && !state.moved) {
          activateDrag(cardId, index, startY)
        }
      }, 350)
    }
  }

  function handleTouchMove(e, cardId) {
    const state = dragRef.current
    if (!state || state.cardId !== cardId) return
    if (e.touches.length !== 1) {
      clearTimeout(timerRef.current)
      state.pending = false
      state.moved = true
      return
    }
    const y = e.touches[0].clientY

    if (!state.active) {
      if (Math.abs(y - state.startY) > 7) {
        clearTimeout(timerRef.current)
        state.pending = false
        state.moved = true
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

  async function handleTouchEnd(cardId, cancelled = false) {
    clearTimeout(timerRef.current)
    const state = dragRef.current
    if (!state || state.cardId !== cardId) return

    if (!state.active) {
      dragRef.current = null
      setDrag(null)
      // Scrolling is not a tap. It must never change selection or card order.
      if (!cancelled && !state.moved) onSelect(cardId)
      return
    }

    if (cancelled) {
      unlockDragScroll(state)
      dragRef.current = null
      setDrag(null)
      return
    }

    unlockDragScroll(state)

    if (state.targetIndex !== state.index) {
      const next = [...ordered]
      const [moved] = next.splice(state.index, 1)
      next.splice(state.targetIndex, 0, moved)
      setDrag(null)
      dragRef.current = null
      setVisualOrderIds(next.map(card => card.id))
      await onReorder(next.map(card => card.id))
    } else {
      setDrag(null)
      dragRef.current = null
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

  return <section
    className={`wallet-stack ${drag?.active ? 'reordering' : ''}`}
    style={{ height:`calc(var(--wallet-card-height, 190px) + ${Math.max(0, ordered.length - 1) * 38 + 18}px)` }}
    aria-label="選擇信用卡"
  >
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
        onTouchCancel={() => handleTouchEnd(card.id, true)}
        onClick={() => {
          // Mobile taps are handled on touchend; never replay a synthetic click.
          if (Date.now() - lastTouchAtRef.current > 800 && !dragRef.current?.active) onSelect(card.id)
        }}
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
      onChange={e => onChange(e.target.value || '')}
      onInput={e => {
        // iOS native date picker Reset can fire input rather than change.
        if (!e.currentTarget.value && value) onChange('')
      }}
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

function TransactionEditor({ tx, cards, cycleSchemaReady, onClose, onSave }) {
  const currentCard = cards.find(c => c.id === tx.cardId) || cards[0]
  const [cardId,setCardId] = useState(tx.cardId)
  const [date,setDate] = useState(tx.date)
  const [postedDate,setPostedDate] = useState(tx.postedDate || '')
  const [statementPeriodOverride,setStatementPeriodOverride] = useState(tx.statementPeriodOverride || '')
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
      await onSave({ id:tx.id,cardId,date,postedDate,statementPeriodOverride,title,amount:isRefund ? -Math.abs(Number(amount)) : Math.abs(Number(amount)),excluded,reconciled,programExclusions })
    } catch(e){ alert(e.message) }
    finally { setBusy(false) }
  }

  return <div className="modal-backdrop" onMouseDown={onClose}><div className="sheet sheet-tall" onMouseDown={e=>e.stopPropagation()}>
    <SheetGrabber onClose={onClose} /><div className="sheet-title-row"><h3>編輯刷卡紀錄</h3><button className="close-btn" onClick={onClose}>×</button></div>
    <label>信用卡<select value={cardId} onChange={e=>{setCardId(e.target.value);setProgramExclusions([]);setStatementPeriodOverride('')}}>{cards.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    <div className="transaction-date-grid"><label>交易日<DateField value={date} onChange={setDate} /></label><label><span className="date-label-row"><span>入帳日（選填）</span>{postedDate && <button type="button" className="posted-date-clear" onClick={e=>{e.preventDefault();setPostedDate('')}}>清除</button>}</span><DateField value={postedDate} onChange={setPostedDate} placeholder="未設定" /></label></div>
    {cycleSchemaReady && selected?.statementCloseDay && <div className="cycle-assignment">
      <label>歸屬帳期
        <select value={statementPeriodOverride} onChange={e=>setStatementPeriodOverride(e.target.value)}>
          <option value="">自動判定（{formatMonthLong(getStatementPeriodKey(selected,{ date,postedDate }))}帳單）</option>
          {nearbyStatementKeys(getStatementPeriodKey(selected,{date,postedDate})).map(key=>
            <option key={key} value={key}>{formatMonthLong(key)}帳單</option>)}
        </select>
      </label>
      <div className="cycle-help-text">{statementPeriodOverride
        ? '手動指定：下次同步也會保留這個帳期，不修改原始交易日。'
        : postedDate ? '依入帳日自動歸類，與銀行實際帳單不同時可手動指定。'
          : '尚未填入入帳日，目前依交易日預估帳期；請在帳單出來後核對。'}</div>
    </div>}
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

function CardEditor({ card, cycleSchemaReady, onClose, onSaveCard, onSaveProgram, onDeleteProgram, onArchiveCard, onDuplicatePrograms }) {
  const isNew = !card
  const [name, setName] = useState(card?.name || '')
  const [bank, setBank] = useState(card?.bank || '')
  const [last4, setLast4] = useState(card?.last4 || '')
  const [limit, setLimit] = useState(card?.monthlySpendLimit || '')
  const [tip, setTip] = useState(card?.tip || '')
  const [colors, setColors] = useState(card?.colors || PALETTES[0])
  const [basis, setBasis] = useState(card?.rewardDateBasis || 'transaction')
  const [statementCloseDay, setStatementCloseDay] = useState(card?.statementCloseDay || '')
  const [programEditing, setProgramEditing] = useState(null)
  const [busy, setBusy] = useState(false)
  const sheetRef = React.useRef(null)
  const programEditorRef = React.useRef(null)
  const programNameRef = React.useRef(null)

  function revealProgramEditor() {
    requestAnimationFrame(() => {
      const sheet = sheetRef.current
      const editor = programEditorRef.current
      if (!sheet || !editor) return
      const sheetBounds = sheet.getBoundingClientRect()
      const editorBounds = editor.getBoundingClientRect()
      const target = sheet.scrollTop + editorBounds.top - sheetBounds.top - 48
      sheet.scrollTo({ top:Math.max(0, target), behavior:'smooth' })
    })
  }

  function addProgram() {
    // ReactDOM's flushSync mounts the input within this user's tap for iPhone focus.
    flushSync(() => setProgramEditing({}))
    const input = programNameRef.current
    if (input) input.focus({ preventScroll:true })
    revealProgramEditor()
  }

  function editProgram(p) {
    flushSync(() => setProgramEditing(p))
    revealProgramEditor()
  }

  async function saveCard() {
    setBusy(true)
    try {
      await onSaveCard({ id:card?.id, name, bank, last4, monthlySpendLimit:limit, tip, colors, rewardDateBasis:basis, statementCloseDay })
      onClose()
    } catch (e) { alert(e.message) }
    finally { setBusy(false) }
  }

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <div className="sheet sheet-tall" ref={sheetRef} onMouseDown={e => e.stopPropagation()}>
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
      <label>銀行每月結帳日（選填）
        <select disabled={!cycleSchemaReady} value={statementCloseDay} onChange={e => setStatementCloseDay(e.target.value)}>
          <option value="">尚未設定</option>
          {Array.from({ length:31 },(_,i)=>i+1).map(day => <option key={day} value={day}>{day} 號</option>)}
        </select>
      </label>
      {!cycleSchemaReady && <div className="cycle-setup-note">帳期功能需要先在 Supabase 執行 002_statement_cycles.sql，再重新開啟 App。</div>}
      <p className="cycle-help-text">如果銀行固定每月 10 號結帳，系統會自動分成 9/11～10/10、10/11～11/10 等帳期。尚未入帳的交易只會預估歸期。</p>
      <label>Tip<textarea value={tip} onChange={e => setTip(e.target.value)} placeholder="只有點 ⓘ 才會顯示" /></label>
      <div className="field-label">卡片樣式</div>
      <div className="palette-list">{PALETTES.map((p,i) => <button key={i} className={`palette ${colors[0]===p[0]?'chosen':''}`} style={{background:`linear-gradient(135deg,${p[0]},${p[1]})`}} onClick={() => setColors(p)} aria-label={`卡片配色 ${i+1}`} />)}</div>
      <button className="primary-btn" disabled={busy || !name.trim()} onClick={saveCard}>{busy ? '儲存中…' : isNew ? '建立卡片' : '儲存卡片設定'}</button>

      {!isNew && <>
        <div className="divider" />
        <div className="sheet-title-row"><h3 className="subheading">回饋活動</h3><button className="small-add" onClick={addProgram}>＋ 新增</button></div>
        {programEditing && <ProgramEditor
          key={programEditing.id || 'new-program'}
          value={programEditing}
          cardCloseDay={statementCloseDay}
          cycleSchemaReady={cycleSchemaReady}
          containerRef={programEditorRef}
          nameInputRef={programNameRef}
          onCancel={() => setProgramEditing(null)}
          onSave={async p => {
            await onSaveProgram(card.id, p)
            setProgramEditing(null)
          }}
        />}
        <button className="duplicate-programs" onClick={async () => {
          try {
            const count = await onDuplicatePrograms(card.id)
            alert(`已複製 ${count} 個活動到下一期，可再逐一調整日期與回饋率。`)
          } catch(e) { alert(e.message) }
        }}>⧉ 複製所有活動到下一期</button>
        <div className="program-settings-list">
          {card.rewardPrograms.map(p => <div className="program-setting" key={p.id}>
            <button className="program-setting-main" onClick={() => editProgram(p)}>
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
    </div>
  </div>
}

function ProgramEditor({ value, cardCloseDay, cycleSchemaReady, containerRef, nameInputRef, onCancel, onSave }) {
  const initialCapType = value.rewardCap != null ? 'reward' : value.spendCap != null ? 'spend' : 'none'
  const [name,setName]=useState(value.name || '')
  const [rate,setRate]=useState(value.rate ?? '')
  const [capType,setCapType]=useState(initialCapType)
  const [capValue,setCapValue]=useState(value.rewardCap ?? value.spendCap ?? '')
  const [calcMode,setCalcMode]=useState(value.calcMode || 'monthly_total')
  const [rounding,setRounding]=useState(value.rounding || 'floor')
  const [capPeriod,setCapPeriod]=useState(value.capPeriod || 'calendar')
  const [startDate,setStartDate]=useState(value.startDate || '')
  const [endDate,setEndDate]=useState(value.endDate || '')
  const [saving,setSaving]=useState(false)
  const rateRef = React.useRef(null)
  const capRef = React.useRef(null)

  async function saveProgram() {
    if (saving || !name.trim() || rate === '' || !Number.isFinite(Number(rate)) || Number(rate) < 0) return
    if (startDate && endDate && endDate < startDate) return
    if (capPeriod === 'statement' && (!cycleSchemaReady || !Number(cardCloseDay))) {
      alert('請先在信用卡設定中填寫每月結帳日，並完成資料庫更新。')
      return
    }
    setSaving(true)
    try {
      await onSave({ ...value, name, rate, capType, capValue, calcMode, rounding, capPeriod, startDate, endDate })
    } catch (e) {
      alert(e.message)
    } finally {
      setSaving(false)
    }
  }

  return <div ref={containerRef} className="inline-editor">
    <div className="sheet-title-row"><h4>{value.id ? '編輯回饋活動' : '新增回饋活動'}</h4><button className="close-btn" onClick={onCancel}>×</button></div>
    <div className="two-col program-main-inputs">
      <label>活動名稱
        <input ref={nameInputRef} value={name} onChange={e=>setName(e.target.value)} placeholder="A / 基本回饋"
          enterKeyHint="next" autoComplete="off"
          onKeyDown={e=>{ if(e.key==='Enter'){e.preventDefault();rateRef.current?.focus()} }} />
      </label>
      <label>回饋 %
        <input ref={rateRef} inputMode="decimal" enterKeyHint="next" value={rate} onChange={e=>setRate(e.target.value)} placeholder="3"
          onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();if(capType!=='none')capRef.current?.focus(); else e.currentTarget.blur()}}} />
      </label>
    </div>
    <label>上限類型<select value={capType} onChange={e=>setCapType(e.target.value)}><option value="none">無上限</option><option value="reward">回饋金上限</option><option value="spend">消費金額上限</option></select></label>
    {capType !== 'none' && <label>{capType === 'reward' ? '回饋金上限' : '消費金額上限'}<input ref={capRef} inputMode="decimal" enterKeyHint="done" value={capValue} onChange={e=>setCapValue(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur()}} /></label>}
    <div className="two-col"><label>計算方式<select value={calcMode} onChange={e=>setCalcMode(e.target.value)}><option value="monthly_total">該期合併後計算</option><option value="per_transaction">單項計算再加總</option></select></label><label>小數處理<select value={rounding} onChange={e=>setRounding(e.target.value)}><option value="floor">無條件捨去</option><option value="round">四捨五入</option></select></label></div>
    <label>回饋上限重置週期
      <select value={capPeriod} onChange={e=>setCapPeriod(e.target.value)} disabled={!cycleSchemaReady}>
        <option value="calendar">日曆月（每月 1 日重置）</option>
        <option value="statement" disabled={!Number(cardCloseDay)}>帳單週期（依此卡結帳日重置）</option>
      </select>
    </label>
    {capPeriod === 'statement' && <div className="cycle-help-text">每月 {cardCloseDay || '—'} 號結帳，每期獨立計算活動上限。</div>}
    {!cycleSchemaReady && <div className="cycle-setup-note">先執行資料庫更新，才能選帳單週期。</div>}
    <ProgramDateRange
      start={startDate}
      end={endDate}
      onChange={(nextStart,nextEnd)=>{setStartDate(nextStart);setEndDate(nextEnd)}}
    />
    <button className="primary-btn" disabled={saving || !name.trim() || rate === '' || !Number.isFinite(Number(rate)) || Number(rate)<0 || (startDate && endDate && endDate<startDate)} onClick={saveProgram}>{saving ? '儲存中…' : '儲存回饋活動'}</button>
  </div>
}

function ProgramDateRange({ start, end, onChange }) {
  const [open,setOpen] = useState(false)
  const [viewMonth,setViewMonth] = useState((start || localToday()).slice(0,7))
  const [draftStart,setDraftStart] = useState(start || '')
  const [draftEnd,setDraftEnd] = useState(end || '')
  const [phase,setPhase] = useState('start')
  const [monthError,setMonthError] = useState('')

  function openPicker() {
    document.activeElement?.blur?.()
    setDraftStart('')
    setDraftEnd('')
    setViewMonth((start || localToday()).slice(0,7))
    setPhase('start')
    setMonthError('')
    setOpen(true)
  }

  function pickDay(day) {
    setMonthError('')
    if (phase === 'start') {
      setDraftStart(day)
      setDraftEnd('')
      setPhase('end')
    } else {
      if (day < draftStart) {
        setDraftStart(day)
        setDraftEnd(draftStart)
      } else {
        setDraftEnd(day)
      }
      setPhase('done')
    }
  }

  function commit() {
    if (!draftStart || !draftEnd) {
      setMonthError('請先選好開始和結束日期。')
      return
    }
    onChange(draftStart,draftEnd)
    setOpen(false)
  }

  const [year,month] = viewMonth.split('-').map(Number)
  const firstWeekday = new Date(year,month-1,1).getDay()
  const dayCount = new Date(year,month,0).getDate()
  const dates = Array.from({length:Math.ceil((firstWeekday+dayCount)/7)*7},(_,index)=>{
    const number=index-firstWeekday+1
    return number>=1 && number<=dayCount ? `${viewMonth}-${String(number).padStart(2,'0')}` : null
  })

  return <div className="program-date-range">
    <div className="program-date-label">活動期間（選填）</div>
    <div className="program-date-pair">
      <button type="button" className="program-date-choice" onClick={openPicker}>
        <small>開始日期</small><span>{start ? formatDateLong(start) : '選擇日期'}</span>
      </button>
      <button type="button" className="program-date-choice" onClick={openPicker}>
        <small>結束日期</small><span>{end ? formatDateLong(end) : '選擇日期'}</span>
      </button>
    </div>
    {!start && !end && !open && <p className="program-date-hint">若沒有設定活動期間，回饋會套用到歷史月份。跨年度換活動時，建議設定明確的開始與結束日期。</p>}
    {open && <div className="program-calendar">
      <div className="calendar-top">
        <button type="button" onClick={()=>setViewMonth(shiftCalendarMonth(viewMonth,-1))} aria-label="上個月">‹</button>
        <strong>{formatMonthLong(viewMonth)}</strong>
        <button type="button" onClick={()=>setViewMonth(shiftCalendarMonth(viewMonth,1))} aria-label="下個月">›</button>
      </div>
      <div className="calendar-phase">{phase==='start' ? '① 選擇開始日期' : phase==='end' ? '② 接著選擇結束日期' : '✓ 日期選好了，按完成套用'}</div>
      <div className="calendar-days">
        {['日','一','二','三','四','五','六'].map(d=><span className="calendar-weekday" key={d}>{d}</span>)}
        {dates.map((day,i)=>{
          const between=day && draftStart && draftEnd && day>=draftStart && day<=draftEnd
          const endpoint=day && (day===draftStart || day===draftEnd)
          return day ? <button type="button" key={day}
            className={`calendar-day ${between?'in-range':''} ${endpoint?'range-endpoint':''} ${day===localToday()?'today':''}`}
            onClick={()=>pickDay(day)}>{Number(day.slice(-2))}</button>
            : <span key={`blank-${i}`} />
        })}
      </div>
      {monthError && <div className="calendar-validation">{monthError}</div>}
      <div className="calendar-selected">
        <span>{draftStart ? formatDateLong(draftStart) : '開始日未選'}</span>
        <span className="calendar-arrow">→</span>
        <span>{draftEnd ? formatDateLong(draftEnd) : '結束日未選'}</span>
      </div>
      <div className="calendar-actions">
        <button type="button" onClick={()=>{onChange('','');setOpen(false)}}>清除期間</button>
        <button type="button" onClick={()=>setOpen(false)}>取消</button>
        <button type="button" className="calendar-done" disabled={!draftStart || !draftEnd} onClick={commit}>✓ 完成</button>
      </div>
    </div>}
  </div>
}

function shiftCalendarMonth(month, delta) {
  const [year, number] = month.split('-').map(Number)
  const value = new Date(year, number - 1 + delta, 1)
  return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}`
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

function SyncSheet({ online, pending, conflicts, cards, busy, snapshotSavedAt, onClose, onSync, onInspect, onResolve }) {
  const [expandedId, setExpandedId] = useState(null)
  const [inspectingId, setInspectingId] = useState(null)
  const [confirmChoice, setConfirmChoice] = useState(null)
  const [detailError, setDetailError] = useState('')

  async function toggleDetails(conflict) {
    setConfirmChoice(null)
    setDetailError('')
    if (expandedId === conflict.id) {
      setExpandedId(null)
      return
    }
    setExpandedId(conflict.id)
    if (!online) return
    await refreshDetails(conflict)
  }

  async function refreshDetails(conflict) {
    if (!online) return
    setInspectingId(conflict.id)
    setDetailError('')
    setConfirmChoice(null)
    try {
      await onInspect(conflict)
    } catch (err) {
      setDetailError(err.message || '取得雲端資料失敗，請稍後再試。')
    } finally {
      setInspectingId(null)
    }
  }

  async function confirmResolve(conflict) {
    if (!confirmChoice || busy) return
    setDetailError('')
    try {
      await onResolve(conflict, confirmChoice.choice)
      setExpandedId(null)
      setConfirmChoice(null)
    } catch (err) {
      setDetailError(err.message || '解決衝突失敗，請稍後重試。')
      setConfirmChoice(null)
    }
  }

  return <div className="modal-backdrop" onMouseDown={onClose}><div className="sheet sheet-tall sync-sheet" onMouseDown={e=>e.stopPropagation()}>
    <SheetGrabber onClose={onClose} />
    <div className="sheet-title-row"><h3>同步狀態</h3><button className="close-btn" onClick={onClose}>×</button></div>

    <div className={`sync-status-card ${online ? 'online' : 'offline'}`}>
      <strong>{online ? '已連線' : '目前離線'}</strong>
      <span>{online
        ? conflicts.length ? `${conflicts.length} 筆需要確認，${pending} 筆變更待處理` : pending ? `${pending} 筆變更等待同步` : '所有變更都已同步'
        : '變更會先保存在這台裝置，連線後再同步。'}</span>
      {snapshotSavedAt && <small>本機快取：{formatSyncTime(snapshotSavedAt)}</small>}
    </div>

    {conflicts.length > 0 && <>
      <div className="field-label">需要你決定的同步衝突（{conflicts.length} 筆）</div>
      <p className="sync-conflict-intro">每一筆都可以查看是哪筆資料、哪些欄位不同。確認後才會採用你選的版本，不會自動覆蓋。</p>
      <div className="conflict-list">
        {conflicts.map(conflict => {
          const expanded = expandedId === conflict.id
          const fields = comparisonFields(conflict, cards)
          const changedCount = fields.filter(field => field.different).length
          const canChoose = online && !busy && !inspectingId && !!conflict.inspectedAt && !detailError
          const localTime = conflict.localPayload?.updated_at
          const cloudTime = conflict.remotePayload?.updated_at
          return <div className="conflict-item" key={conflict.id}>
            <button className="conflict-summary" onClick={() => toggleDetails(conflict)} aria-expanded={expanded}>
              <span className="conflict-summary-main">
                <small>{syncEntityLabel(conflict.entity)}</small>
                <strong>{conflictRecordName(conflict, cards)}</strong>
                <span>{conflict.op === 'delete' ? '本機有待同步的刪除操作' : '本機與雲端存在不同版本'}</span>
              </span>
              <span className="conflict-expand-icon">{expanded ? '⌃' : '⌄'}</span>
            </button>

            {expanded && <div className="conflict-details">
              {inspectingId === conflict.id
                ? <div className="conflict-fetching">正在確認雲端最新資料…</div>
                : <div className="conflict-detail-heading">
                    <span>{changedCount ? `${changedCount} 個欄位不同` : '欄位內容相同，請確認是否仍要處理'}</span>
                    {online && <button disabled={busy} onClick={() => refreshDetails(conflict)}>重新比對 <span aria-hidden="true">↻</span></button>}
                  </div>}
              {!online && <div className="conflict-info-warning">目前離線，這是上次取得的雲端版本；連線後才能做最後選擇。</div>}
              {online && !conflict.inspectedAt && inspectingId !== conflict.id && <div className="conflict-info-warning">尚未取得最新雲端資料，請點「重新比對」。</div>}
              <div className="conflict-versions">
                <div><b>本機版本</b><span>{localTime ? formatSyncTime(localTime) : '待同步'}</span></div>
                <div><b>雲端版本</b><span>{cloudTime ? formatSyncTime(cloudTime) : '無版本時間'}</span></div>
              </div>
              {conflict.op === 'delete' && <div className="conflict-delete-note">本機操作：刪除這筆資料。選擇「保留本機」將執行刪除。</div>}
              {!conflict.remotePayload && <div className="conflict-delete-note">目前雲端已沒有這筆資料。選擇保留本機可能重新建立它。</div>}
              <div className="conflict-diff-list">
                {fields.map(field => <div className={`conflict-diff-row ${field.different ? 'changed' : ''}`} key={field.key}>
                  <div className="conflict-field-label">{field.label}{field.different && <span>不同</span>}</div>
                  <div className="conflict-value-pair">
                    <div className="local-value">{field.local}</div>
                    <div className="cloud-value">{field.remote}</div>
                  </div>
                </div>)}
              </div>
              {expandedId === conflict.id && detailError && <div className="conflict-detail-error">{detailError}</div>}
              <div className="conflict-actions">
                <button disabled={!canChoose} onClick={() => setConfirmChoice({ id:conflict.id, choice:'remote' })}>採用雲端</button>
                <button disabled={!canChoose} className="primary-choice" onClick={() => setConfirmChoice({ id:conflict.id, choice:'local' })}>保留本機</button>
              </div>
              {confirmChoice?.id === conflict.id && <div className="conflict-confirm">
                <strong>確定要{confirmChoice.choice === 'local' ? '保留本機版本' : '採用雲端版本'}？</strong>
                <p>{confirmChoice.choice === 'local'
                  ? '本機這筆待同步的修改會寫到雲端，取代雲端同一筆資料。'
                  : '這筆本機待同步操作會被取消，改以雲端版本為準。'}</p>
                <div className="conflict-confirm-actions">
                  <button onClick={() => setConfirmChoice(null)}>再想想</button>
                  <button disabled={!canChoose} onClick={() => confirmResolve(conflict)}>確認套用</button>
                </div>
              </div>}
            </div>}
          </div>
        })}
      </div>
    </>}

    <button className="primary-btn" disabled={!online || busy} onClick={onSync}>{busy ? '同步中…' : '立即同步'}</button>
    {!online && <div className="sync-note">恢復網路後，App 會在回到前景時自動重試。</div>}
  </div></div>
}

function conflictRecordName(conflict, cards) {
  const row = conflict.localPayload || conflict.remotePayload || {}
  const card = cards.find(item => item.id === row.card_id)
  const cardName = card?.name || (row.card_id ? `卡片 ${String(row.card_id).slice(0,8)}` : '')
  if (conflict.entity === 'transaction') {
    return [cardName, row.title || '未命名刷卡', row.amount == null ? '' : formatMoney(Number(row.amount))].filter(Boolean).join(' · ')
  }
  if (conflict.entity === 'program') return [cardName, row.name || '未命名回饋活動'].filter(Boolean).join(' · ')
  if (conflict.entity === 'card') return row.name || '未命名信用卡'
  return '需要確認的資料'
}

function comparisonFields(conflict, cards) {
  const fieldsByEntity = {
    transaction: [
      ['card_id','信用卡'], ['transaction_date','交易日'], ['posted_date','入帳日'],
      ['title','刷卡項目'], ['amount','金額'], ['excluded','整筆排除回饋'],
      ['reconciled','已核對帳單'], ['statement_period_override','手動帳期'], ['programExclusions','指定排除的活動'],
    ],
    card: [
      ['name','卡片名稱'], ['bank','銀行'], ['last4','末四碼'], ['monthly_spend_limit','月刷卡控制上限'],
      ['tip','卡片 Tip'], ['reward_date_basis','回饋認列日期'], ['statement_close_day','每月結帳日'], ['sort_order','排序／封存'],
      ['color_a','卡面底色'], ['color_b','卡面漸層色'],
    ],
    program: [
      ['card_id','信用卡'], ['name','活動名稱'], ['rate','回饋比例'],
      ['reward_cap','回饋金上限'], ['spend_cap','消費金額上限'],
      ['calc_mode','計算方式'], ['rounding','小數處理'], ['cap_period','回饋上限週期'],
      ['start_date','開始日期'], ['end_date','結束日期'],
    ],
  }
  const list = fieldsByEntity[conflict.entity] || []
  const localRow = conflict.op === 'delete' ? null : conflict.localPayload
  const remoteRow = conflict.remotePayload
  return list.map(([key,label]) => {
    const localRaw = key === 'programExclusions' ? conflict.programExclusions : localRow?.[key]
    const remoteRaw = key === 'programExclusions' ? conflict.remoteProgramExclusions : remoteRow?.[key]
    const local = !localRow ? '已刪除' : conflictValue(key, localRaw, cards)
    const remote = !remoteRow ? '雲端不存在' : conflictValue(key, remoteRaw, cards)
    return { key, label, local, remote, different:local !== remote }
  }).sort((a,b) => Number(b.different) - Number(a.different))
}

function conflictValue(key, value, cards) {
  if (value == null || value === '') return key === 'programExclusions' && value === undefined ? '資料尚未取得' : '未設定'
  if (key === 'card_id') return cards.find(c => c.id === value)?.name || `卡片 ${String(value).slice(0,8)}`
  if (key === 'programExclusions') {
    if (!Array.isArray(value)) return '資料尚未取得'
    if (!value.length) return '無'
    return value.map(id => cards.flatMap(c => c.rewardPrograms || []).find(p => p.id === id)?.name || `活動 ${String(id).slice(0,8)}`).sort().join('、')
  }
  if (['amount','monthly_spend_limit','reward_cap','spend_cap'].includes(key)) return formatMoney(Number(value))
  if (key === 'rate') return `${Number(value)}%`
  if (key === 'excluded' || key === 'reconciled') return value === true || value === 'true' ? '是' : '否'
  if (key === 'reward_date_basis') return value === 'posted' ? '入帳日' : '交易日'
  if (key === 'cap_period') return value === 'statement' ? '帳單週期' : '日曆月'
  if (key === 'statement_period_override') return formatMonthLong(value) + '帳單'
  if (key === 'statement_close_day') return '每月 ' + value + ' 號'
  if (key === 'calc_mode') return value === 'per_transaction' ? '每筆分別計算' : '每月合併計算'
  if (key === 'rounding') return value === 'round' ? '四捨五入' : '無條件捨去'
  if (key === 'sort_order') return Number(value) < 0 ? '已封存' : `第 ${Number(value)+1} 張`
  if (['transaction_date','posted_date','start_date','end_date'].includes(key)) return String(value).replaceAll('-','/')
  return String(value)
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
    startDate:p.start_date, endDate:p.end_date, capPeriod:p.cap_period || 'calendar', updatedAt:p.updated_at,
  }
}
function toTransactionRow(tx, userId, cycleSchemaReady = false){
  return {
    id:tx.id,
    user_id:userId,
    card_id:tx.cardId,
    transaction_date:tx.date,
    posted_date:tx.postedDate || null,
    ...(cycleSchemaReady ? { statement_period_override:tx.statementPeriodOverride || null } : {}),
    title:tx.title,
    amount:Number(tx.amount),
    excluded:Boolean(tx.excluded),
    reconciled:Boolean(tx.reconciled),
    updated_at:tx.updatedAt || new Date().toISOString(),
  }
}

function toCardRow(card, userId, cycleSchemaReady = false){
  return {
    id:card.id,
    user_id:userId,
    name:card.name,
    bank:card.bank || null,
    last4:card.last4 || null,
    color_a:card.colors?.[0] || PALETTES[0][0],
    color_b:card.colors?.[1] || PALETTES[0][1],
    monthly_spend_limit:card.monthlySpendLimit || null,
    tip:card.tip || null,
    reward_date_basis:card.rewardDateBasis || 'transaction',
    ...(cycleSchemaReady ? { statement_close_day:card.statementCloseDay || null } : {}),
    sort_order:Number(card.sortOrder || 0),
    updated_at:card.updatedAt || new Date().toISOString(),
  }
}

function toProgramRow(program, cardId, userId, cycleSchemaReady = false){
  return {
    id:program.id,
    user_id:userId,
    card_id:cardId,
    name:program.name,
    rate:Number(program.rate || 0),
    reward_cap:program.rewardCap == null ? null : Number(program.rewardCap),
    spend_cap:program.spendCap == null ? null : Number(program.spendCap),
    calc_mode:program.calcMode || 'monthly_total',
    rounding:program.rounding || 'floor',
    ...(cycleSchemaReady ? { cap_period:program.capPeriod || 'calendar' } : {}),
    start_date:program.startDate || null,
    end_date:program.endDate || null,
    updated_at:program.updatedAt || new Date().toISOString(),
  }
}

function syncEntityLabel(entity){
  if (entity === 'transaction') return '刷卡紀錄'
  if (entity === 'card') return '信用卡設定'
  if (entity === 'program') return '回饋活動'
  return '資料'
}

function formatSyncTime(value){
  try {
    return new Intl.DateTimeFormat('zh-TW', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }).format(new Date(value))
  } catch {
    return '已儲存'
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
function nearbyStatementKeys(month) {
  if (!month) return []
  const [year,number] = month.split('-').map(Number)
  return [-2,-1,0,1,2].map(delta=>{
    const date = new Date(year, number - 1 + delta, 1)
    return date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0')
  })
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
