import { useState, useCallback, useLayoutEffect, useRef } from 'react'
import { SearchBar } from './components/SearchBar'
import { FilterMenu } from './components/FilterMenu'
import { Sidebar } from './components/Sidebar'
import { SessionHeader } from './components/SessionHeader'
import { MessageList } from './components/MessageList'
import { SearchResults } from './components/SearchResults'
import { StatusBar } from './components/StatusBar'
import { useTheme } from './hooks/useTheme'
import { useSearch, type SearchSnapshot } from './hooks/useSearch'
import { useViewHistory } from './hooks/useViewHistory'
import { useSync } from './hooks/useSync'
import { api } from './utils/api'
import { useI18n } from './i18n'
import type { MessageTypeFilter, SearchResult, SearchResponse, Project, Session } from './types'
import './themes/variables.css'
import './App.css'

/**
 * Date-picker value (YYYY-MM-DD, local) -> UTC ISO timestamp at the start or
 * end of that local day, matching how transcript timestamps are stored.
 */
function localDayBound(day: string, end: boolean): string | null {
  if (!day) return null
  const [y, m, d] = day.split('-').map(Number)
  return (end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)).toISOString()
}

/** Everything needed to bring back a view on back/forward */
interface ViewSnapshot {
  search: SearchSnapshot
  starredMessages: SearchResponse | null
  starredOnly: boolean
  selectedSessionId: string | null
  selectedProject: Project | null
  selectedSession: Session | null
  expandProjectId: number | null
  scrollTop: number
}

function App() {
  const { mode: themeMode, cycleMode } = useTheme()
  const { t } = useI18n()
  const {
    results, loading, loadMoreFailed, retryLoadMore, snapshot: searchSnapshot, restore: restoreSearch, query, setQuery, mode, setMode,
    performSearch, loadMore, filterByProject, activeProjectId, resultsPage, clearSearch,
  } = useSearch()
  const { status, lastChecked } = useSync()
  // Visible-message count only changes when a sync indexed something new,
  // so it doubles as a cheap "data changed, refetch" signal.
  const refreshKey = status?.stats.message_count

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const [selectedSession, setSelectedSession] = useState<Session | null>(null)
  const [scrollToMessageId, setScrollToMessageId] = useState<number | null>(null)
  const [expandProjectId, setExpandProjectId] = useState<number | null>(null)
  const [activeFilters, setActiveFilters] = useState<Set<MessageTypeFilter>>(
    new Set(['user', 'assistant'])
  )
  const [showAllReplies, setShowAllReplies] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const [starredOnly, setStarredOnly] = useState(false)
  const [starredMessages, setStarredMessages] = useState<SearchResponse | null>(null)

  const contentRef = useRef<HTMLElement>(null)
  // Scroll positions to re-apply after a back/forward restore: search results
  // are in memory (applied on next layout), session messages are refetched
  // (applied by MessageList once loaded)
  const [pendingResultsScroll, setPendingResultsScroll] = useState<number | null>(null)
  const [pendingSessionScroll, setPendingSessionScroll] = useState<number | null>(null)

  const viewHistory = useViewHistory<ViewSnapshot>(
    () => ({
      search: searchSnapshot(),
      starredMessages, starredOnly,
      selectedSessionId, selectedProject, selectedSession, expandProjectId,
      scrollTop: contentRef.current?.scrollTop ?? 0,
    }),
    snap => {
      restoreSearch(snap.search)
      setStarredMessages(snap.starredMessages)
      setStarredOnly(snap.starredOnly)
      setSelectedSessionId(snap.selectedSessionId)
      setSelectedProject(snap.selectedProject)
      setSelectedSession(snap.selectedSession)
      setExpandProjectId(snap.expandProjectId)
      setScrollToMessageId(null)
      if (snap.search.results || snap.starredMessages) {
        setPendingResultsScroll(snap.scrollTop)
      } else {
        setPendingSessionScroll(snap.scrollTop)
      }
    },
  )

  // A new result set (first page) starts at the top; loading more pages keeps
  // the position. Declared before the restore effect below so a back/forward
  // restore still wins.
  useLayoutEffect(() => {
    if (results && resultsPage === 1 && contentRef.current) contentRef.current.scrollTop = 0
  }, [results, resultsPage])

  useLayoutEffect(() => {
    if (pendingResultsScroll == null || !contentRef.current) return
    contentRef.current.scrollTop = pendingResultsScroll
    setPendingResultsScroll(null)
  }, [pendingResultsScroll])
  const clearSessionScroll = useCallback(() => setPendingSessionScroll(null), [])

  const handleStarredToggle = useCallback(async () => {
    viewHistory.push()
    if (!starredOnly) {
      // Turn on: fetch starred messages
      try {
        const msgs = await api.getStarred()
        const results: SearchResult[] = msgs.map(m => ({
          message_id: m.id,
          session_id: m.session_id,
          project_id: (m as any).project_id,
          project_name: (m as any).project_name || '',
          type: m.type,
          content_type: m.content_type,
          content: m.content,
          snippet: m.content?.slice(0, 200) || '',
          timestamp: m.timestamp,
          starred: true,
          context: null,
        }))
        setStarredMessages({ total: results.length, results })
      } catch (err) {
        console.error('Failed to fetch starred messages:', err)
      }
    } else {
      setStarredMessages(null)
    }
    setStarredOnly(!starredOnly)
  }, [starredOnly, viewHistory])
  const [timeFrom, setTimeFrom] = useState('')
  const [timeTo, setTimeTo] = useState('')

  const handleSearch = useCallback(() => {
    if (!query.trim()) return
    viewHistory.push()
    performSearch(query, mode, {
      types: Array.from(activeFilters),
      starred_only: starredOnly,
      time_from: localDayBound(timeFrom, false),
      time_to: localDayBound(timeTo, true),
    })
  }, [query, mode, activeFilters, starredOnly, timeFrom, timeTo, performSearch, viewHistory])

  const handleFilterToggle = (type: MessageTypeFilter) => {
    setActiveFilters(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  const handleSessionSelect = useCallback((sessionId: string, project?: Project, session?: Session) => {
    // Picking a session from the sidebar leaves search / starred-messages mode,
    // otherwise the results list keeps covering the session view
    viewHistory.push()
    setStarredMessages(null)
    setStarredOnly(false)
    clearSearch()
    setSelectedSessionId(sessionId)
    if (project) {
      setSelectedProject(project)
      setExpandProjectId(project.id)
    }
    if (session) setSelectedSession(session)
  }, [clearSearch, viewHistory])

  const handleResultClick = async (result: SearchResult) => {
    viewHistory.push()
    setSelectedSessionId(result.session_id)
    setScrollToMessageId(result.message_id)
    setExpandProjectId(result.project_id)
    // Fetch project and session BEFORE clearing search to avoid
    // rendering SessionHeader with null project/session props
    const [project, sessions] = await Promise.all([
      api.getProject(result.project_id),
      api.getSessions(result.project_id),
    ])
    setSelectedProject(project)
    const s = sessions.find(s => s.id === result.session_id)
    if (s) setSelectedSession(s)
    setStarredMessages(null)
    setStarredOnly(false)
    clearSearch()
  }

  const isSearchMode = results !== null || starredMessages !== null
  const displayResults = starredMessages || results!

  const handleClearSearch = useCallback(() => {
    if (results) viewHistory.push()
    clearSearch()
  }, [results, clearSearch, viewHistory])

  return (
    <div className="app">
      <SearchBar
        query={query}
        onQueryChange={setQuery}
        mode={mode}
        onModeChange={setMode}
        semantic={status?.semantic}
        onSearch={handleSearch}
        onClear={handleClearSearch}
        starredOnly={starredOnly}
        onStarredToggle={handleStarredToggle}
        timeFrom={timeFrom}
        timeTo={timeTo}
        onTimeFromChange={setTimeFrom}
        onTimeToChange={setTimeTo}
        themeMode={themeMode}
        onThemeCycle={cycleMode}
        canBack={viewHistory.canBack}
        canForward={viewHistory.canForward}
        onBack={viewHistory.back}
        onForward={viewHistory.forward}
        filterMenu={
          <FilterMenu
            active={activeFilters}
            onToggle={handleFilterToggle}
            showAllReplies={showAllReplies}
            onToggleAllReplies={() => setShowAllReplies(!showAllReplies)}
            showTools={showTools}
            onToggleTools={() => setShowTools(!showTools)}
          />
        }
      />
      <div className="main-content">
        <Sidebar
          refreshKey={refreshKey}
          onSessionSelect={handleSessionSelect}
          selectedSessionId={selectedSessionId}
          expandProjectId={expandProjectId}
        />
        <main className="content-area" ref={contentRef}>
          {isSearchMode ? (
            <SearchResults
              results={displayResults.results}
              total={displayResults.total}
              onResultClick={handleResultClick}
              onLoadMore={starredMessages ? undefined : loadMore}
              loading={loading}
              loadMoreFailed={loadMoreFailed}
              onRetryLoadMore={retryLoadMore}
              facets={starredMessages ? undefined : displayResults.facets}
              activeProjectId={activeProjectId}
              onProjectFilter={filterByProject}
              title={starredMessages
                ? { label: t.starredTitle, count: t.starredCount(displayResults.total) }
                : undefined}
            />
          ) : (
            <MessageList
              header={<SessionHeader project={selectedProject} session={selectedSession} />}
              sessionId={selectedSessionId}
              refreshKey={refreshKey}
              activeFilters={activeFilters}
              showAllReplies={showAllReplies}
              showTools={showTools}
              scrollToMessageId={scrollToMessageId}
              onScrollComplete={() => setScrollToMessageId(null)}
              restoreScrollTop={pendingSessionScroll}
              onScrollRestored={clearSessionScroll}
            />
          )}
        </main>
      </div>
      <StatusBar status={status} lastChecked={lastChecked} />
    </div>
  )
}

export default App
