import { useI18n } from '../i18n'
import type { SyncStatus } from '../types'

interface Props {
  status: SyncStatus | null
  lastChecked: Date | null
}

export function StatusBar({ status, lastChecked }: Props) {
  const { t, locale } = useI18n()
  const stats = status?.stats
  const timeSince = lastChecked
    ? Math.round((Date.now() - lastChecked.getTime()) / 1000)
    : null

  const sem = status?.semantic
  let semanticText: string | null = null
  let semanticTitle = ''
  let semanticState = ''
  if (sem?.enabled) {
    semanticTitle = t.semanticModel(sem.model)
    if (!sem.available) {
      semanticText = t.semanticDisconnected
      semanticTitle += t.semanticDisconnectedHint
      semanticState = 'off'
    } else if (sem.indexed < sem.total) {
      semanticText = t.semanticIndexing(sem.indexed.toLocaleString(locale), sem.total.toLocaleString(locale))
      semanticState = 'busy'
    } else {
      semanticText = t.semanticReady
      semanticState = 'ok'
    }
  }

  return (
    <footer className="status-bar">
      <span className="status-stats">
        {stats
          ? t.stats(stats.project_count, stats.session_count, stats.message_count)
          : t.loading}
      </span>
      {semanticText && (
        <span className={`status-item status-${semanticState}`} title={semanticTitle}>{semanticText}</span>
      )}
      <span className={`status-item status-${status?.pending_changes ? 'busy' : 'ok'}`}>
        {status?.pending_changes
          ? t.syncing
          : t.synced(timeSince)}
      </span>
    </footer>
  )
}
