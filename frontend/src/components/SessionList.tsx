import { useState } from 'react'
import { api } from '../utils/api'
import { projectColor } from '../utils/projectColor'
import { Icon } from './Icon'
import { useI18n } from '../i18n'
import type { Session } from '../types'

interface Props {
  sessions: Session[]
  selectedId: string | null
  onSelect: (session: Session) => void
  onSessionUpdated: (session: Session) => void
  /** Show each session's project (recent / starred lists span projects) */
  showProject?: boolean
  /** Group under Today / Yesterday / This week / Earlier */
  groupByDay?: boolean
}

type DayGroup = 'today' | 'yesterday' | 'thisWeek' | 'earlier'

function dayGroup(ts: string | null): DayGroup {
  if (!ts) return 'earlier'
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const t = new Date(ts).getTime()
  const day = 24 * 3600 * 1000
  if (t >= startOfToday.getTime()) return 'today'
  if (t >= startOfToday.getTime() - day) return 'yesterday'
  if (t >= startOfToday.getTime() - 6 * day) return 'thisWeek'
  return 'earlier'
}

export function SessionList({ sessions, selectedId, onSelect, onSessionUpdated, showProject, groupByDay }: Props) {
  const { t, locale } = useI18n()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  const formatWhen = (ts: string | null) => {
    if (!ts) return t.unknownTime
    const d = new Date(ts)
    const group = dayGroup(ts)
    if (group === 'today' || group === 'yesterday') {
      return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    }
    if (group === 'thisWeek') return d.toLocaleDateString(locale, { weekday: 'short' })
    return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
  }

  const handleStar = async (e: React.MouseEvent, s: Session) => {
    e.stopPropagation()
    const result = await api.toggleSessionStar(s.id)
    onSessionUpdated({ ...s, starred: result.starred ? 1 : 0 })
  }

  const startRename = (e: React.MouseEvent, s: Session) => {
    e.stopPropagation()
    setEditingId(s.id)
    setEditValue(s.custom_name || '')
  }

  const saveRename = async (s: Session) => {
    const trimmed = editValue.trim()
    const result = await api.renameSession(s.id, trimmed)
    onSessionUpdated({ ...s, custom_name: result.custom_name })
    setEditingId(null)
  }

  const handleKeyDown = (e: React.KeyboardEvent, s: Session) => {
    if (e.key === 'Enter') saveRename(s)
    if (e.key === 'Escape') setEditingId(null)
  }

  const groupLabels: Record<DayGroup, string> = {
    today: t.today, yesterday: t.yesterday, thisWeek: t.thisWeek, earlier: t.earlier,
  }

  let lastGroup: DayGroup | null = null

  return (
    <div className="session-list">
      {sessions.map(s => {
        const when = s.last_active || s.start_time
        const group = dayGroup(when)
        const header = groupByDay && group !== lastGroup
          ? <div className="list-group-label">{groupLabels[group]}</div>
          : null
        lastGroup = group
        const title = s.custom_name || s.auto_title || formatWhen(s.start_time)

        return (
          <div key={s.id}>
            {header}
            <div
              className={`session-item${s.id === selectedId ? ' active' : ''}`}
              onClick={() => onSelect(s)}
            >
              {editingId === s.id ? (
                <input
                  className="inline-edit"
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onKeyDown={e => handleKeyDown(e, s)}
                  onBlur={() => saveRename(s)}
                  onClick={e => e.stopPropagation()}
                  placeholder={s.auto_title || ''}
                  autoFocus
                />
              ) : (
                <div className="session-item-title">
                  <span className="session-item-text">{title}</span>
                  <span className="row-actions">
                    <button className="row-action" onClick={e => startRename(e, s)} title={t.rename}>
                      <Icon name="pencil" size={13} />
                    </button>
                    <button
                      className={`row-action${s.starred ? ' starred' : ''}`}
                      onClick={e => handleStar(e, s)}
                      title={s.starred ? t.unstar : t.star}
                    >
                      <Icon name="star" size={13} filled={!!s.starred} />
                    </button>
                  </span>
                </div>
              )}
              <div className="session-item-meta">
                {showProject && s.project_name && (
                  <>
                    <span className="project-dot" style={{ background: projectColor(s.project_name) }} />
                    <span className="session-item-project">{s.project_name}</span>
                    <span className="sep">·</span>
                  </>
                )}
                <span>{t.msgShort(s.message_count)}</span>
                <span className="sep">·</span>
                <span>{formatWhen(when)}</span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
