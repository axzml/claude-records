export interface Project {
  id: number
  dir_name: string
  display_name: string
  path: string
  session_count: number
  last_active: string | null
}

export interface Session {
  id: string
  project_id: number
  start_time: string | null
  last_active: string | null
  message_count: number
  starred: number
  custom_name: string | null
  auto_title: string | null
  project_name?: string
  models?: string[]
}

export interface Message {
  id: number
  session_id: string
  uuid: string
  parent_uuid: string | null
  type: 'user' | 'assistant' | 'system' | 'progress'
  content_type: 'text' | 'tool_use' | 'thinking' | null
  content: string
  model: string | null
  timestamp: string
  starred: number
  images: string | null  // JSON array of {media_type, data}
}

export interface SearchResult {
  message_id: number
  session_id: string
  project_id: number
  project_name: string
  type: string
  content_type: string | null
  content: string
  snippet: string
  timestamp: string
  starred: boolean
  context: {
    question: string | null
    answer_preview: string | null
  } | null
  /** Which ranker found it (hybrid search); 'keyword' in keyword modes */
  match?: 'keyword' | 'semantic' | 'both'
}

export interface SearchFacet {
  project_id: number
  project_name: string
  count: number
}

export interface SearchResponse {
  total: number
  results: SearchResult[]
  /** Hit count per project over the whole result set (ignores the project filter) */
  facets?: SearchFacet[]
  /** Hybrid mode only: false when it fell back to keyword search */
  semantic?: boolean
}

/** AND / OR: keyword full-text search; HYBRID: keyword + semantic */
export type SearchMode = 'AND' | 'OR' | 'HYBRID'

export interface SemanticStatus {
  enabled: boolean
  available: boolean
  model: string | null
  indexed: number
  total: number
}

export interface SyncStatus {
  last_sync: string | null
  pending_changes: boolean
  stats: {
    project_count: number
    session_count: number
    message_count: number
  }
  semantic?: SemanticStatus
}

export type MessageTypeFilter = 'user' | 'assistant' | 'system' | 'progress'
export type ThemeMode = 'system' | 'light' | 'dark'
