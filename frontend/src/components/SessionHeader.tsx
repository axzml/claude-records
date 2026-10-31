import { ExportButton } from './ExportButton'
import { projectColor } from '../utils/projectColor'
import { useI18n } from '../i18n'
import type { Project, Session } from '../types'

interface Props {
  project: Project | null
  session: Session | null
}

export function SessionHeader({ project, session }: Props) {
  const { t, locale } = useI18n()
  if (!project || !session) return null

  const formatDate = (ts: string | null) => {
    if (!ts) return t.unknownTime
    return new Date(ts).toLocaleString(locale, {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  const title = session.custom_name || session.auto_title || formatDate(session.start_time)

  return (
    <div className="session-header">
      <div className="session-crumb">
        <span className="project-dot" style={{ background: projectColor(project.display_name) }} />
        <span className="session-crumb-project">{project.display_name}</span>
        <span className="sep">/</span>
        <span className="session-crumb-path" title={project.path}>{project.path}</span>
      </div>
      <h1 className="session-title">{title}</h1>
      <div className="session-meta">
        <span>{formatDate(session.start_time)}</span>
        <span>{t.messageCount(session.message_count)}</span>
        {session.models?.map(m => <span key={m} className="model-tag">{m}</span>)}
        <span className="session-meta-actions">
          <ExportButton sessionId={session.id} project={project} session={session} />
        </span>
      </div>
    </div>
  )
}
