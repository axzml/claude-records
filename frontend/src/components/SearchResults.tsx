import { useEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { useI18n } from '../i18n'
import { projectColor } from '../utils/projectColor'
import { Icon } from './Icon'
import type { SearchFacet, SearchResult } from '../types'

interface Props {
  results: SearchResult[]
  total: number
  onResultClick: (result: SearchResult) => void
  onLoadMore?: () => void
  loading?: boolean
  /** Loading the next page failed: stop auto-loading until the user retries */
  loadMoreFailed?: boolean
  onRetryLoadMore?: () => void
  facets?: SearchFacet[]
  activeProjectId?: number | null
  onProjectFilter?: (projectId: number | null) => void
  /** Replaces the default heading, e.g. for the starred-messages list */
  title?: { label: string; count: string }
}

const FACETS_COLLAPSED = 15

export function SearchResults({
  results, total, onResultClick, onLoadMore, loading, loadMoreFailed, onRetryLoadMore,
  facets, activeProjectId, onProjectFilter, title,
}: Props) {
  const { t, locale } = useI18n()
  const hasMore = !!onLoadMore && results.length < total
  const [facetsExpanded, setFacetsExpanded] = useState(false)
  // Facets arrive sorted by hit count; collapsed view keeps the top ones
  // plus the active tag, so a selection never disappears
  const visibleFacets = !facets || facetsExpanded
    ? facets
    : facets.filter((f, i) => i < FACETS_COLLAPSED || f.project_id === activeProjectId)
  const hiddenFacetCount = (facets?.length ?? 0) - (visibleFacets?.length ?? 0)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Infinite scroll: load the next page when the sentinel below the last
  // result comes within 300px of the viewport
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore || loading || loadMoreFailed) return
    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) onLoadMore!() },
      { rootMargin: '300px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loading, loadMoreFailed, onLoadMore, results.length])

  const formatTime = (ts: string) => {
    const d = new Date(ts)
    return d.toLocaleDateString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  const sanitize = (html: string) => DOMPurify.sanitize(html, { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: [] })

  return (
    <div className="search-results">
      <div className="results-header">
        <h2>{title ? title.label : t.searchTitle}</h2>
        <span className="results-count">{title ? title.count : t.matchCount(total)}</span>
      </div>
      {facets && facets.length > 1 && onProjectFilter && (
        <div className="search-facets">
          <button
            className={`search-facet${activeProjectId == null ? ' active' : ''}`}
            onClick={() => onProjectFilter(null)}
          >{t.allFacet} <span className="search-facet-count">{facets.reduce((n, f) => n + f.count, 0)}</span></button>
          {visibleFacets!.map(f => (
            <button
              key={f.project_id}
              className={`search-facet${activeProjectId === f.project_id ? ' active' : ''}`}
              onClick={() => onProjectFilter(f.project_id)}
            ><span className="project-dot" style={{ background: projectColor(f.project_name) }} />{f.project_name} <span className="search-facet-count">{f.count}</span></button>
          ))}
          {facets.length > FACETS_COLLAPSED && (
            <button className="search-facet search-facet-toggle" onClick={() => setFacetsExpanded(!facetsExpanded)}>
              {facetsExpanded ? t.collapse : t.moreFacets(hiddenFacetCount)}
            </button>
          )}
        </div>
      )}
      {results.map(r => (
        <div
          key={r.message_id}
          className="search-result-card"
          onClick={() => onResultClick(r)}
        >
          <div className="search-result-meta">
            <span className="project-dot" style={{ background: projectColor(r.project_name) }} />
            <span className="search-result-project">{r.project_name}</span>
            <span className="sep">·</span>
            <span className={`search-result-type type-${r.type}`}>
              {r.type === 'user' ? t.resultUser : t.resultAssistant}
            </span>
            <span className="sep">·</span>
            <span className="search-result-time">{formatTime(r.timestamp)}</span>
            {r.match === 'semantic' && (
              <span className="search-result-match" title={t.semanticMatchTitle}><Icon name="sparkle" size={12} />{t.semanticMatch}</span>
            )}
            {r.starred && <Icon name="star" size={13} filled className="search-result-star" />}
          </div>
          <div
            className="search-result-snippet"
            dangerouslySetInnerHTML={{ __html: sanitize(r.snippet) }}
          />
          {r.context && (
            <div className="search-result-context">
              {r.context.question && (
                <span>{t.contextQuestion}{r.context.question}</span>
              )}
              {r.context.answer_preview && (
                <span>{t.contextAnswer}{r.context.answer_preview}</span>
              )}
            </div>
          )}
        </div>
      ))}
      {hasMore && (
        <div ref={sentinelRef} className="search-load-more">
          {loadMoreFailed
            ? <button className="search-load-retry" onClick={onRetryLoadMore}>{t.loadFailedRetry}</button>
            : loading ? t.loadingMore : t.shownCount(results.length, total)}
        </div>
      )}
    </div>
  )
}
