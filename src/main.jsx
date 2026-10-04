import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { calculateCardSummary, formatMoney, formatPct } from './rewardEngine'
import { supabase } from './supabase'

const PALETTES = [
  ['#222831','#38414d'],
  ['#193f32','#2e6654'],
  ['#3a1f4d','#704b87'],
  ['#45352d','#72574a'],
  ['#1d3150','#365b82'],
  ['#3b3032','#76575c'],
]

function App() {
  const [session, setSession] = useState(undefined)
  const [cards, setCards] = useState([])
  const [transactions, setTransactions] = useState([])
  const [selectedCardId, setSelectedCardId] = useState(null)
  const [month, setMonth] = useState(localMonth())
  const [showTip, setShowTip] = useState(false)
  const [showAddTx, setShowAddTx] = useState(false)
  const [showCardEditor, setShowCardEditor] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [loadingData, setLoadingData] = useState(false)
  const [error, setError] = useState('')

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

  async function loadData() {
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
      colors: [row.color_a, row.color_b],
      tip: row.tip || '',
      rewardDateBasis: row.reward_date_basis,
      rewardPrograms: programsByCard.get(row.id) || [],
    }))

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
    setSelectedCardId(prev => nextCards.some(c => c.id === prev) ? prev : nextCards[0]?.id || null)
    setLoadingData(false)
  }

  const selectedCard = cards.find(c => c.id === selectedCardId) || null
  const summary = useMemo(
    () => selectedCard ? calculateCardSummary(selectedCard, transactions, month) : null,
    [selectedCard, transactions, month]
  )

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
        <label className="month-pill">
          <span>{month.replace('-', ' / ')}</span>
          <input type="month" value={month} onChange={e => setMonth(e.target.value)} />
        </label>
        <button className="ghost-btn" onClick={() => alert('自訂區間下一版接上；目前回饋上限先依月份計算。')}>自訂區間</button>
      </section>

      {loadingData ? <CenteredState compact title="同步資料中…" /> : !selectedCard ? (
        <EmptyCards onAdd={() => setShowCardEditor(true)} />
      ) : (
        <>
          <CardStack cards={cards} selectedId={selectedCardId} onSelect={(id) => { setSelectedCardId(id); setShowTip(false) }} />

          <section className="summary-card">
            <div className="summary-head">
              <div>
                <div className="title-line">
                  <h2>{selectedCard.name}</h2>
                  <button className="tip-button" onClick={() => setShowTip(v => !v)} aria-label="顯示提示">ⓘ</button>
                </div>
                <div className="muted">本月刷卡</div>
              </div>
              <div className={`status-badge ${summary.limitRatio >= 1 ? 'danger' : summary.limitRatio >= .85 ? 'warn' : ''}`}>
                {selectedCard.monthlySpendLimit ? (summary.limitRatio >= 1 ? '已超額' : `${Math.round(summary.limitRatio * 100)}%`) : '未設上限'}
              </div>
            </div>

            {showTip && <div className="tip-popover"><strong>刷卡 Tip</strong><div>{selectedCard.tip || '尚未設定 Tip'}</div></div>}

            <div className="spend-row">
              <strong>{formatMoney(summary.totalSpend)}</strong>
              <span>{selectedCard.monthlySpendLimit ? `/ ${formatMoney(selectedCard.monthlySpendLimit)}` : '無刷卡上限'}</span>
            </div>
            <div className="progress"><div style={{ width: `${selectedCard.monthlySpendLimit ? Math.min(100, summary.limitRatio * 100) : 0}%` }} /></div>

            <div className="reward-hero">
              <div><span>預估總回饋</span><strong>{formatMoney(summary.totalReward)}</strong></div>
              <div className="rate-box"><span>實質回饋率</span><strong>{formatPct(summary.effectiveRate)}</strong></div>
            </div>

            <div className="program-list">
              {summary.programs.length ? summary.programs.map(p => (
                <div className="program-row" key={p.id}>
                  <div className="program-main">
                    <span className="program-name">{p.name.slice(0,2)}</span>
                    <span className="program-rate">{p.rate}%</span>
                  </div>
                  <div className="program-value">
                    <strong>{formatMoney(p.reward)}</strong>
                    <span>{p.rewardCap == null ? (p.spendCap == null ? '無上限' : `消費上限 ${formatMoney(p.spendCap)}`) : `/ ${formatMoney(p.rewardCap)}`}</span>
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
              <span className="record-count">{transactions.filter(t => t.cardId === selectedCardId && t.date.startsWith(month)).length} 筆</span>
            </div>
            <div className="transaction-list">
              {transactions.filter(t => t.cardId === selectedCardId && t.date.startsWith(month)).slice(0,8).map(tx => (
                <div className={`transaction ${tx.excluded ? 'excluded' : ''}`} key={tx.id}>
                  <div><strong>{tx.title}</strong><span>{tx.date.slice(5).replace('-', '/')} {tx.excluded ? ' · 不計回饋' : ''}</span></div>
                  <div className="tx-right">
                    <strong>{formatMoney(tx.amount)}</strong>
                    <button className="mini-btn" onClick={() => toggleExcluded(tx.id)}>{tx.excluded ? '恢復回饋' : '排除回饋'}</button>
                  </div>
                </div>
              ))}
              {!transactions.some(t => t.cardId === selectedCardId && t.date.startsWith(month)) && <div className="empty-list">這個月還沒有刷卡紀錄</div>}
            </div>
          </section>
        </>
      )}

      <nav className="bottom-nav">
        <button className="nav-item active"><span>▰</span><small>卡片</small></button>
        <button className="add-main" disabled={!selectedCard} onClick={() => selectedCard && setShowAddTx(true)}>＋</button>
        <button className="nav-item" onClick={() => selectedCard && setShowCardEditor(true)}><span>⚙</span><small>卡片設定</small></button>
      </nav>

      {showAddTx && selectedCard && <AddTransactionModal card={selectedCard} month={month} transactions={transactions} onClose={() => setShowAddTx(false)} onSave={addTransaction} />}
      {showCardEditor && <CardEditor card={selectedCard} onClose={() => setShowCardEditor(false)} onSaveCard={saveCard} onSaveProgram={saveProgram} onDeleteProgram={deleteProgram} />}
      {showSettings && <AccountSheet email={session.user.email} onClose={() => setShowSettings(false)} onAddCard={() => { setShowSettings(false); setSelectedCardId(null); setShowCardEditor(true) }} onSignOut={signOut} />}
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

function EyeIcon({ open }) {
  return open
    ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 10.7a2 2 0 002.7 2.7M9.9 4.2A10.8 10.8 0 0112 4c5.5 0 9 5 9 5a17 17 0 01-2.5 3M6.6 6.6C4.2 8.2 3 10 3 10s3.5 5 9 5c1.4 0 2.7-.3 3.8-.8" /></svg>
    : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3.5-5 9-5 9 5 9 5-3.5 5-9 5-9-5-9-5z"/><circle cx="12" cy="12" r="2.5"/></svg>
}

function EmptyCards({ onAdd }) {
  return <section className="empty-cards">
    <div className="empty-card-visual"><span>＋</span></div>
    <h2>新增第一張信用卡</h2>
    <p>先建立卡片，再加入 A / B / C 等同時存在的回饋活動。</p>
    <button className="primary-btn" onClick={onAdd}>新增信用卡</button>
  </section>
}

function CardStack({ cards, selectedId, onSelect }) {
  const selectedIndex = Math.max(0, cards.findIndex(c => c.id === selectedId))
  const ordered = [...cards.slice(selectedIndex), ...cards.slice(0, selectedIndex)]
  return <section className="wallet-stack" aria-label="選擇信用卡">
    {ordered.map((card, index) => (
      <button key={card.id} className={`wallet-card ${index === 0 ? 'selected' : ''}`}
        style={{ '--stack-index': index, '--card-a': card.colors[0], '--card-b': card.colors[1] }} onClick={() => onSelect(card.id)}>
        <div className="card-top"><span>{card.bank || 'CARD'}</span><span>{card.last4 ? `•••• ${card.last4}` : ''}</span></div>
        <div className="card-name">{card.name}</div>
        <div className="card-bottom"><span>REWARDS</span><span>%</span></div>
      </button>
    ))}
  </section>
}

function AddTransactionModal({ card, month, transactions, onClose, onSave }) {
  const [date, setDate] = useState(localToday())
  const [title, setTitle] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const baseSummary = useMemo(() => calculateCardSummary(card, transactions, month), [card, transactions, month])
  const projected = useMemo(() => {
    if (!Number(amount) || !date.startsWith(month)) return null
    const fake = { id:'preview', cardId:card.id, date, title:title || 'preview', amount:Number(amount), excluded:false, programExclusions:[] }
    return calculateCardSummary(card, [fake, ...transactions], month)
  }, [amount, date, title, card, transactions, month])

  const capWarnings = useMemo(() => {
    if (!projected) return []
    return projected.programs.flatMap(after => {
      const before = baseSummary.programs.find(p => p.id === after.id)
      if (!before || before.capped || !after.capped || after.rate <= 0) return []
      let remainingSpend
      if (after.spendCap != null) remainingSpend = Math.max(0, after.spendCap - before.eligibleSpend)
      else if (after.rewardCap != null) remainingSpend = Math.max(0, (after.rewardCap - before.reward) / (after.rate / 100))
      if (remainingSpend == null || remainingSpend >= Number(amount)) return []
      return [{ name:after.name, rate:after.rate, eligible:Math.floor(remainingSpend), excess:Math.max(0, Math.ceil(Number(amount)-remainingSpend)) }]
    })
  }, [projected, baseSummary, amount])

  async function save() {
    setBusy(true)
    try { await onSave({ cardId:card.id, date, title, amount:Number(amount) }) }
    catch (e) { alert(e.message) }
    finally { setBusy(false) }
  }

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <div className="sheet" onMouseDown={e => e.stopPropagation()}>
      <div className="sheet-grabber" />
      <h3>新增刷卡</h3>
      <div className="selected-mini-card">{card.name}<span>{card.bank}</span></div>
      <label>日期<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
      <label>刷卡項目<input autoFocus placeholder="手動輸入，例如：加油" value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>金額<input inputMode="decimal" placeholder="$ 0" value={amount} onChange={e => setAmount(e.target.value)} /></label>
      {projected && <div className="reward-preview"><span>新增後本月預估總回饋</span><strong>{formatMoney(projected.totalReward)} · {formatPct(projected.effectiveRate)}</strong></div>}
      {capWarnings.map(w => <div className="cap-warning" key={w.name}><strong>{w.name}｜{w.rate}% 將達上限</strong><div>本筆約前 {formatMoney(w.eligible)} 仍可取得此活動回饋，剩餘 {formatMoney(w.excess)} 超過該活動上限；其他活動仍會各自計算。</div></div>)}
      <button className="primary-btn" disabled={busy || !title.trim() || !Number(amount)} onClick={save}>{busy ? '儲存中…' : '新增'}</button>
    </div>
  </div>
}

function CardEditor({ card, onClose, onSaveCard, onSaveProgram, onDeleteProgram }) {
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
      <div className="sheet-grabber" />
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
    <div className="two-col"><label>開始日期<input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)} /></label><label>結束日期<input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)} /></label></div>
    <button className="primary-btn" disabled={!name.trim() || Number(rate)<0} onClick={() => onSave({ ...value,name,rate,capType,capValue,calcMode,rounding,startDate,endDate })}>儲存回饋活動</button>
  </div>
}

function AccountSheet({ email, onClose, onAddCard, onSignOut }) {
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="sheet" onMouseDown={e=>e.stopPropagation()}>
    <div className="sheet-grabber" /><h3>帳號與資料</h3>
    <div className="account-email">{email}</div>
    <button className="settings-action" onClick={onAddCard}>＋ 新增信用卡</button>
    <button className="settings-action danger-text" onClick={onSignOut}>登出</button>
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

createRoot(document.getElementById('root')).render(<App />)
