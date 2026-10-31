import { useState } from 'react'
import { api } from '../utils/api'
import { filterForExport, toMarkdown, toHTML, buildFilename, downloadFile } from '../utils/export'
import { Popover } from './Popover'
import { Icon } from './Icon'
import { useI18n } from '../i18n'
import type { Project, Session } from '../types'
import type { SessionMeta } from '../utils/export'

interface Props {
  sessionId: string
  project: Project
  session: Session
}

export function ExportButton({ sessionId, project, session }: Props) {
  const { t, locale } = useI18n()
  const [loading, setLoading] = useState(false)

  const buildMeta = (): SessionMeta => ({
    projectName: project.display_name,
    sessionName: session.custom_name || session.auto_title || null,
    path: project.path,
    date: session.start_time
      ? new Date(session.start_time).toLocaleString(locale)
      : t.unknownTime,
    messageCount: session.message_count,
  })

  const handleExport = async (format: 'md' | 'html') => {
    setLoading(true)

    try {
      const messages = await api.getMessages(sessionId)
      const filtered = filterForExport(messages)

      if (filtered.length === 0) {
        alert(t.nothingToExport)
        return
      }

      const meta = buildMeta()

      if (format === 'md') {
        const content = toMarkdown(filtered, meta)
        const filename = buildFilename(project.display_name, 'md')
        downloadFile(content, filename, 'text/markdown;charset=utf-8')
      } else {
        const content = await toHTML(filtered, meta)
        const filename = buildFilename(project.display_name, 'html')
        downloadFile(content, filename, 'text/html;charset=utf-8')
      }
    } catch (err) {
      console.error('Export failed:', err)
      alert(t.exportFailed)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Popover
      label={<><Icon name="download" /><span>{t.exportButton}</span></>}
      title={t.exportSession}
      disabled={loading}
    >
      {close => (
        <>
          <button className="menu-item" onClick={() => { close(); handleExport('md') }}>{t.exportMarkdown}</button>
          <button className="menu-item" onClick={() => { close(); handleExport('html') }}>{t.exportHTML}</button>
        </>
      )}
    </Popover>
  )
}
