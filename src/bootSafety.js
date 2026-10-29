// These deadlines guard the UI from Safari PWA requests that may never settle
// when switching to airplane mode. A timeout does not cancel the underlying
// request; callers must guard against late responses using a generation ID.
export class DeadlineExceeded extends Error {
  constructor(label) {
    super(label + '逾時。請確認連線或本機資料庫狀態。')
    this.name='DeadlineExceeded'
    this.code='DEADLINE_EXCEEDED'
  }
}

export function withDeadline(promise, milliseconds, label='操作') {
  if (!(milliseconds > 0)) return Promise.resolve(promise)
  let timeoutId
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_,reject)=>{
      timeoutId=setTimeout(()=>reject(new DeadlineExceeded(label)),milliseconds)
    }),
  ]).finally(()=>clearTimeout(timeoutId))
}

export function recoverableNetworkFailure(error, online) {
  const message=String(error?.message || error || '').toLowerCase()
  return !online || error?.code === 'DEADLINE_EXCEEDED' ||
    message.includes('fetch') || message.includes('network') ||
    message.includes('timeout') || message.includes('failed to fetch')
}
