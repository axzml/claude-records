import { useState, useCallback, useRef } from 'react'
import { api } from '../utils/api'
import type { SearchResponse, SearchMode } from '../types'

type SearchRequest = Parameters<typeof api.search>[0]

export interface SearchSnapshot {
  results: SearchResponse | null
  lastRequest: SearchRequest | null
}

export function useSearch() {
  const [results, setResults] = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  // Set when loading the next page failed; stops infinite scroll from retrying in a loop
  const [loadMoreFailed, setLoadMoreFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('HYBRID')
  // Last executed search, so loadMore can request the next page with the same params
  const [lastRequest, setLastRequest] = useState<SearchRequest | null>(null)

  // Bumped by every action that replaces the shown results. A response is
  // applied only if no newer action happened meanwhile: hybrid search
  // latency varies, so an older query can otherwise finish last and win.
  const generation = useRef(0)

  const run = useCallback(async (
    request: SearchRequest,
    apply: (data: SearchResponse) => void,
    onError?: () => void,
  ) => {
    const gen = ++generation.current
    setLoading(true)
    try {
      const data = await api.search(request)
      if (gen !== generation.current) return
      apply(data)
      setLastRequest(request)
    } catch (err) {
      if (gen !== generation.current) return
      console.error('Search failed:', err)
      onError?.()
    } finally {
      if (gen === generation.current) setLoading(false)
    }
  }, [])

  const performSearch = useCallback(async (
    searchQuery: string,
    searchMode: string,
    options?: {
      project_id?: number | null
      types?: string[]
      starred_only?: boolean
      time_from?: string | null
      time_to?: string | null
      page?: number
    }
  ) => {
    if (!searchQuery.trim()) {
      generation.current++
      setResults(null)
      return
    }
    setLoadMoreFailed(false)
    await run({
      query: searchQuery,
      mode: searchMode,
      types: options?.types || ['user', 'assistant'],
      project_id: options?.project_id,
      starred_only: options?.starred_only,
      time_from: options?.time_from,
      time_to: options?.time_to,
      page: options?.page || 1,
    }, setResults)
  }, [run])

  const loadMore = useCallback(async () => {
    if (!lastRequest || !results || loading || loadMoreFailed) return
    await run(
      { ...lastRequest, page: (lastRequest.page || 1) + 1 },
      data => setResults(prev => prev && { ...data, results: [...prev.results, ...data.results] }),
      () => setLoadMoreFailed(true),
    )
  }, [lastRequest, results, loading, loadMoreFailed, run])

  // Re-run the last search restricted to one project (null = all projects)
  const filterByProject = useCallback(async (projectId: number | null) => {
    if (!lastRequest) return
    setLoadMoreFailed(false)
    await run({ ...lastRequest, project_id: projectId, page: 1 }, setResults)
  }, [lastRequest, run])

  const retryLoadMore = useCallback(() => setLoadMoreFailed(false), [])

  // Shown results, including pages loaded so far, for back/forward navigation
  const snapshot = useCallback((): SearchSnapshot => ({ results, lastRequest }), [results, lastRequest])

  const restore = useCallback((s: SearchSnapshot) => {
    generation.current++  // drop any in-flight response for the view being left
    setLoading(false)
    setLoadMoreFailed(false)
    setResults(s.results)
    setLastRequest(s.lastRequest)
    setQuery(s.lastRequest?.query ?? '')
  }, [])

  const clearSearch = useCallback(() => {
    generation.current++
    setLoading(false)
    setLoadMoreFailed(false)
    setQuery('')
    setResults(null)
    setLastRequest(null)
  }, [])

  return { results, loading, loadMoreFailed, retryLoadMore, snapshot, restore, query, setQuery, mode, setMode,
    performSearch, loadMore, filterByProject, activeProjectId: lastRequest?.project_id ?? null,
    resultsPage: lastRequest?.page ?? 1, clearSearch }
}
