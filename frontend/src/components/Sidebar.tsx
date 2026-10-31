import { useState, useEffect, useCallback } from 'react'
import { api } from '../utils/api'
import { projectColor } from '../utils/projectColor'
import { ProjectList } from './ProjectList'
import { SessionList } from './SessionList'
import { Icon } from './Icon'
import { useI18n } from '../i18n'
import type { Project, Session } from '../types'

interface Props {
  /** Changes whenever a background sync indexed new messages */
  refreshKey?: number
  onSessionSelect: (sessionId: string, project?: Project, session?: Session) => void
  selectedSessionId: string | null
  expandProjectId?: number | null
}

type SidebarTab = 'browse' | 'favorites' | 'recent'

export function Sidebar({ refreshKey, onSessionSelect, selectedSessionId, expandProjectId }: Props) {
  const { t } = useI18n()
  const [projects, setProjects] = useState<Project[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [starredSessions, setStarredSessions] = useState<Session[]>([])
  const [recentSessions, setRecentSessions] = useState<Session[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const [tab, setTab] = useState<SidebarTab>('browse')

  useEffect(() => {
    api.getProjects().then(setProjects)
  }, [refreshKey])

  useEffect(() => {
    if (selectedProjectId) {
      api.getSessions(selectedProjectId).then(setSessions)
    }
  }, [selectedProjectId, refreshKey])

  // When a search result is clicked, open its project in the sidebar
  useEffect(() => {
    if (expandProjectId != null && expandProjectId !== selectedProjectId) {
      setSelectedProjectId(expandProjectId)
    }
  }, [expandProjectId])

  useEffect(() => {
    if (tab === 'favorites') {
      api.getStarredSessions().then(setStarredSessions)
    } else if (tab === 'recent') {
      api.getRecentSessions().then(setRecentSessions)
    }
  }, [tab, refreshKey])

  const selectedProject = projects.find(p => p.id === selectedProjectId) || null

  const handleProjectRenamed = (id: number, newName: string) => {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, display_name: newName } : p))
  }

  const handleSelect = useCallback((s: Session) => {
    const proj = projects.find(p => p.id === s.project_id)
    onSessionSelect(s.id, proj || undefined, s)
  }, [projects, onSessionSelect])

  const handleSessionUpdated = useCallback((updated: Session) => {
    setSessions(prev => prev.map(s => s.id === updated.id ? { ...s, ...updated } : s))
    setRecentSessions(prev => prev.map(s => s.id === updated.id ? { ...s, ...updated } : s))
    api.getStarredSessions().then(setStarredSessions)
  }, [])

  const tabs: { value: SidebarTab; label: string }[] = [
    { value: 'browse', label: t.tabBrowse },
    { value: 'favorites', label: t.tabFavorites },
    { value: 'recent', label: t.tabRecent },
  ]

  return (
    <aside className="sidebar">
      <div className="sidebar-tabs">
        {tabs.map(x => (
          <button
            key={x.value}
            className={`sidebar-tab${tab === x.value ? ' active' : ''}`}
            onClick={() => setTab(x.value)}
          >{x.label}</button>
        ))}
      </div>

      <div className="sidebar-body">
        {tab === 'browse' && !selectedProject && (
          <ProjectList projects={projects} onSelect={setSelectedProjectId} onProjectRenamed={handleProjectRenamed} />
        )}
        {tab === 'browse' && selectedProject && (
          <>
            <button className="drill-back" onClick={() => setSelectedProjectId(null)} title={t.allProjects}>
              <Icon name="chevronLeft" size={14} />{t.allProjects}
            </button>
            <div className="drill-title">
              <span className="project-dot" style={{ background: projectColor(selectedProject.display_name) }} />
              <span className="drill-name">{selectedProject.display_name}</span>
              <span className="drill-count">{t.sessions(sessions.length)}</span>
            </div>
            <SessionList
              sessions={sessions}
              selectedId={selectedSessionId}
              onSelect={handleSelect}
              onSessionUpdated={handleSessionUpdated}
              groupByDay
            />
          </>
        )}
        {tab === 'favorites' && (
          starredSessions.length === 0
            ? <div className="sidebar-empty">{t.noStarredSessions}</div>
            : <SessionList
                sessions={starredSessions}
                selectedId={selectedSessionId}
                onSelect={handleSelect}
                onSessionUpdated={handleSessionUpdated}
                showProject
              />
        )}
        {tab === 'recent' && (
          recentSessions.length === 0
            ? <div className="sidebar-empty">{t.noRecentSessions}</div>
            : <SessionList
                sessions={recentSessions}
                selectedId={selectedSessionId}
                onSelect={handleSelect}
                onSessionUpdated={handleSessionUpdated}
                showProject
                groupByDay
              />
        )}
      </div>
    </aside>
  )
}
