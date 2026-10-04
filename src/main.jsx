import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { calculateCardSummary, formatMoney, formatPct } from './rewardEngine'
import { demoCards, demoTransactions } from './demoData'

function App() {
  const [selectedCardId, setSelectedCardId] = useState(demoCards[0].id)
  const [month, setMonth] = useState('2026-10')
  const [showTip, setShowTip] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [transactions, setTransactions] = useState(demoTransactions)

  const selectedCard = demoCards.find(c => c.id === selectedCardId)
  const summary = useMemo(
    () => calculateCardSummary(selectedCard, transactions, month),
    [selectedCard, transactions, month]
  )

  function addTransaction(tx) {
    setTransactions(prev => [{ ...tx, id: crypto.randomUUID() }, ...prev])
    setShowAdd(false)
  }

  function toggleExcluded(txId) {
    setTransactions(prev => prev.map(tx => tx.id === txId ? { ...tx, excluded: !tx.excluded } : tx))
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">CARD REWARDS</div>
          <h1>我的信用卡</h1>
        </div>
        <button className="icon-btn" aria-label="設定">⚙︎</button>
      </header>

      <section className="period-bar">
        <button className="month-pill" onClick={() => {}}>{month.replace('-', ' / ')}⌄</button>
        <button className="ghost-btn">自訂區間</button>
      </section>

      <CardStack
        cards={demoCards}
        selectedId={selectedCardId}
        onSelect={(id) => { setSelectedCardId(id); setShowTip(false) }}
      />

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
            {summary.limitRatio >= 1 ? '已超額' : `${Math.round(summary.limitRatio * 100)}%`}
          </div>
        </div>

        {showTip && <div className="tip-popover"><strong>刷卡 Tip</strong><div>{selectedCard.tip}</div></div>}

        <div className="spend-row">
          <strong>{formatMoney(summary.totalSpend)}</strong>
          <span>/ {formatMoney(selectedCard.monthlySpendLimit)}</span>
        </div>
        <div className="progress"><div style={{ width: `${Math.min(100, summary.limitRatio * 100)}%` }} /></div>

        <div className="reward-hero">
          <div>
            <span>預估總回饋</span>
            <strong>{formatMoney(summary.totalReward)}</strong>
          </div>
          <div className="rate-box">
            <span>實質回饋率</span>
            <strong>{formatPct(summary.effectiveRate)}</strong>
          </div>
        </div>

        <div className="program-list">
          {summary.programs.map(p => (
            <div className="program-row" key={p.id}>
              <div className="program-main">
                <span className="program-name">{p.name}</span>
                <span className="program-rate">{p.rate}%</span>
              </div>
              <div className="program-value">
                <strong>{formatMoney(p.reward)}</strong>
                <span>{p.rewardCap == null ? '無上限' : `/ ${formatMoney(p.rewardCap)}`}</span>
                {p.capped && <span className="done">✓</span>}
              </div>
            </div>
          ))}
        </div>

        <div className="meta-grid">
          <div><span>有效回饋消費</span><strong>{formatMoney(summary.eligibleSpend)}</strong></div>
          <div><span>排除回饋</span><strong>{formatMoney(summary.excludedSpend)}</strong></div>
        </div>
      </section>

      <section className="transactions-section">
        <div className="section-head">
          <h3>最近紀錄</h3>
          <button className="ghost-btn">查看全部</button>
        </div>
        <div className="transaction-list">
          {transactions.filter(t => t.cardId === selectedCardId && t.date.startsWith(month)).slice(0,6).map(tx => (
            <div className={`transaction ${tx.excluded ? 'excluded' : ''}`} key={tx.id}>
              <div>
                <strong>{tx.title}</strong>
                <span>{tx.date.slice(5).replace('-', '/')} {tx.excluded ? ' · 不計回饋' : ''}</span>
              </div>
              <div className="tx-right">
                <strong>{formatMoney(tx.amount)}</strong>
                <button className="mini-btn" onClick={() => toggleExcluded(tx.id)}>{tx.excluded ? '恢復' : '排除'}</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <nav className="bottom-nav">
        <button className="nav-item active"><span>▰</span><small>卡片</small></button>
        <button className="add-main" onClick={() => setShowAdd(true)}>＋</button>
        <button className="nav-item"><span>☷</span><small>紀錄</small></button>
      </nav>

      {showAdd && <AddTransactionModal card={selectedCard} onClose={() => setShowAdd(false)} onSave={addTransaction} />}
    </div>
  )
}

function CardStack({ cards, selectedId, onSelect }) {
  const selectedIndex = cards.findIndex(c => c.id === selectedId)
  const ordered = [...cards.slice(selectedIndex), ...cards.slice(0, selectedIndex)]
  return (
    <section className="wallet-stack" aria-label="選擇信用卡">
      {ordered.map((card, index) => (
        <button
          key={card.id}
          className={`wallet-card ${index === 0 ? 'selected' : ''}`}
          style={{ '--stack-index': index, '--card-a': card.colors[0], '--card-b': card.colors[1] }}
          onClick={() => onSelect(card.id)}
        >
          <div className="card-top"><span>{card.bank}</span><span>•••• {card.last4}</span></div>
          <div className="card-name">{card.name}</div>
          <div className="card-bottom"><span>REWARDS</span><span>%</span></div>
        </button>
      ))}
    </section>
  )
}

function AddTransactionModal({ card, onClose, onSave }) {
  const today = new Date().toISOString().slice(0,10)
  const [date, setDate] = useState(today)
  const [title, setTitle] = useState('')
  const [amount, setAmount] = useState('')

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="sheet" onMouseDown={e => e.stopPropagation()}>
        <div className="sheet-grabber" />
        <h3>新增刷卡</h3>
        <div className="selected-mini-card">{card.name}<span>{card.bank}</span></div>
        <label>日期<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        <label>刷卡項目<input autoFocus placeholder="手動輸入，例如：加油" value={title} onChange={e => setTitle(e.target.value)} /></label>
        <label>金額<input inputMode="decimal" placeholder="$ 0" value={amount} onChange={e => setAmount(e.target.value)} /></label>
        <button className="primary-btn" disabled={!title || !Number(amount)} onClick={() => onSave({ cardId: card.id, date, title, amount: Number(amount), excluded: false, programExclusions: [] })}>新增</button>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)
