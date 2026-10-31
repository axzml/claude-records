import type { Project, Session, Message, SearchResponse, SyncStatus } from '../types'

const BASE = '/api'

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(url, options)
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }))
    throw new Error(err.error || resp.statusText)
  }
  return resp.json()
}

export const api = {
  getProjects: () => fetchJSON<Project[]>(`${BASE}/projects`),

  getProject: (projectId: number) => fetchJSON<Project>(`${BASE}/project/${projectId}`),

  getSessions: (projectId: number) =>
    fetchJSON<Session[]>(`${BASE}/sessions/${projectId}`),

  getMessages: (sessionId: string, types?: string[]) => {
    const params = types?.map(t => `type=${t}`).join('&') || ''
    return fetchJSON<Message[]>(`${BASE}/messages/${sessionId}${params ? '?' + params : ''}`)
  },

  search: (params: {
    query: string
    mode?: string
    project_id?: number | null
    time_from?: string | null
    time_to?: string | null
    types?: string[]
    starred_only?: boolean
    page?: number
    page_size?: number
  }) => fetchJSON<SearchResponse>(`${BASE}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  }),

  toggleStar: (messageId: number) =>
    fetchJSON<{ starred: boolean }>(`${BASE}/star/${messageId}`, { method: 'POST' }),

  getStarred: () => fetchJSON<Message[]>(`${BASE}/starred`),

  getSyncStatus: () => fetchJSON<SyncStatus>(`${BASE}/sync/status`),

  triggerSync: () => fetchJSON<Record<string, number>>(`${BASE}/sync/trigger`, { method: 'POST' }),

  // Project rename
  renameProject: (projectId: number, displayName: string) =>
    fetchJSON<{ id: number; display_name: string }>(`${BASE}/project/rename/${projectId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: displayName }),
    }),

  // Session star / rename / starred list
  toggleSessionStar: (sessionId: string) =>
    fetchJSON<{ starred: boolean }>(`${BASE}/session/star/${sessionId}`, { method: 'POST' }),

  renameSession: (sessionId: string, customName: string) =>
    fetchJSON<{ id: string; custom_name: string | null }>(`${BASE}/session/rename/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom_name: customName }),
    }),

  getStarredSessions: () => fetchJSON<Session[]>(`${BASE}/sessions/starred`),

  getRecentSessions: () => fetchJSON<Session[]>(`${BASE}/sessions/recent`),
}
