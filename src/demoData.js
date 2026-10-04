export const demoCards = [
  {
    id: 'sport', name: 'Sport 卡', bank: 'TAISHIN', last4: '1024', monthlySpendLimit: 15000,
    colors: ['#222831', '#38414d'],
    tip: '指定活動需完成登錄；部分繳費不列入加碼。',
    rewardPrograms: [
      { id:'sport-a', name:'A', rate:1, rewardCap:50, spendCap:null, calcMode:'monthly_total', rounding:'floor', startDate:'2026-10-01', endDate:'2026-12-31' },
      { id:'sport-b', name:'B', rate:1, rewardCap:null, spendCap:null, calcMode:'monthly_total', rounding:'floor', startDate:'2026-01-01', endDate:null },
      { id:'sport-c', name:'C', rate:3, rewardCap:300, spendCap:null, calcMode:'monthly_total', rounding:'floor', startDate:'2026-10-01', endDate:'2026-12-31' }
    ]
  },
  {
    id:'lb', name:'聯邦 LB', bank:'UBOT', last4:'6618', monthlySpendLimit:10000,
    colors:['#193f32','#2e6654'], tip:'刷卡前先確認本期指定通路。',
    rewardPrograms:[
      { id:'lb-a', name:'基本', rate:2, rewardCap:300, spendCap:null, calcMode:'monthly_total', rounding:'floor', startDate:'2026-10-01', endDate:'2026-12-31' }
    ]
  },
  {
    id:'aov', name:'傳說對決', bank:'CARD', last4:'8820', monthlySpendLimit:6000,
    colors:['#3a1f4d','#704b87'], tip:'遊戲與指定數位通路優先。',
    rewardPrograms:[
      { id:'aov-a', name:'數位', rate:4, rewardCap:240, spendCap:null, calcMode:'per_transaction', rounding:'floor', startDate:'2026-10-01', endDate:'2026-12-31' }
    ]
  },
  {
    id:'allme', name:'AllMe', bank:'CARD', last4:'1506', monthlySpendLimit:12000,
    colors:['#45352d','#72574a'], tip:'超過回饋門檻後建議改刷其他卡。',
    rewardPrograms:[
      { id:'allme-a', name:'一般', rate:2, rewardCap:200, spendCap:null, calcMode:'monthly_total', rounding:'round', startDate:'2026-10-01', endDate:'2026-12-31' }
    ]
  }
]

export const demoTransactions = [
  { id:'t1', cardId:'sport', date:'2026-10-04', title:'加油', amount:956, excluded:false, programExclusions:[] },
  { id:'t2', cardId:'sport', date:'2026-10-05', title:'Apple', amount:3200, excluded:false, programExclusions:[] },
  { id:'t3', cardId:'sport', date:'2026-10-08', title:'繳費', amount:600, excluded:true, programExclusions:[] },
  { id:'t4', cardId:'sport', date:'2026-10-10', title:'餐廳', amount:5777, excluded:false, programExclusions:[] },
  { id:'t5', cardId:'lb', date:'2026-10-07', title:'網購', amount:5666, excluded:false, programExclusions:[] },
  { id:'t6', cardId:'aov', date:'2026-10-03', title:'遊戲', amount:4460, excluded:false, programExclusions:[] },
  { id:'t7', cardId:'allme', date:'2026-10-09', title:'購物', amount:8350, excluded:false, programExclusions:[] }
]
