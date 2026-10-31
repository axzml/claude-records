import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react'
import type { ReactNode } from 'react'
import { api } from '../utils/api'
import { MessageCard } from './MessageCard'
import { PromptOutline } from './PromptOutline'
import type { OutlinePrompt } from './PromptOutline'
import { Icon } from './Icon'
import { useI18n } from '../i18n'
import type { Message, MessageTypeFilter } from '../types'

interface Props {
  sessionId: string | null
  /** Changes whenever a background sync indexed new messages */
  refreshKey?: number
  activeFilters: Set<MessageTypeFilter>
  showAllReplies: boolean
  showTools: boolean
  scrollToMessageId?: number | null
  onScrollComplete?: () => void
  /** Scroll position to restore once this session's messages are rendered (back/forward) */
  restoreScrollTop?: number | null
  onScrollRestored?: () => void
  /** Rendered above the messages, inside the reading column */
  header?: ReactNode
}

const OUTLINE_KEY = 'claude-records-outline-collapsed'

/** One-line preview of a prompt for the outline */
function promptPreview(content: string): string {
  return content.replace(/[#>*_`~]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90)
}

type MessageGroup =
  | { type: 'single'; message: Message }
  | { type: 'tool_group'; tool: Message; results: Message[] }

/**
 * Build grouped message list: tool_use + its children (tool_result) form a group.
 */
function buildGroups(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  const visited = new Set<string>()

  for (const msg of messages) {
    if (visited.has(msg.uuid)) continue
    visited.add(msg.uuid)

    if (msg.type === 'assistant' && msg.content_type === 'tool_use') {
      const children = messages.filter(m => m.parent_uuid === msg.uuid)
      children.forEach(c => visited.add(c.uuid))
      groups.push({ type: 'tool_group', tool: msg, results: children })
    } else {
      groups.push({ type: 'single', message: msg })
    }
  }
  return groups
}

/**
 * Find the last assistant text message in each "turn".
 */
function findLastAssistantPerTurn(msgs: Message[]): Set<string> {
  const keep = new Set<string>()
  let lastAssistantUuid: string | null = null

  for (const msg of msgs) {
    if (msg.type === 'user' && msg.content?.trim()) {
      if (lastAssistantUuid) keep.add(lastAssistantUuid)
      lastAssistantUuid = null
    } else if (
      msg.type === 'assistant' &&
      msg.content_type === 'text' &&
      msg.content?.trim()
    ) {
      lastAssistantUuid = msg.uuid
    }
  }
  if (lastAssistantUuid) keep.add(lastAssistantUuid)
  return keep
}

function getToolSummary(content: string): string {
  try {
    const obj = JSON.parse(content)
    const name = obj.name || 'Tool'
    const input = obj.input
    if (typeof input === 'string') return `${name}: ${input.slice(0, 100)}`
    if (typeof input === 'object' && input) {
      const keys = Object.keys(input).slice(0, 3)
      const preview = keys.map(k => {
        const v = String(input[k])
        return `${k}=${v.length > 40 ? v.slice(0, 40) + '...' : v}`
      }).join(', ')
      return `${name}: ${preview}`
    }
    return name
  } catch {
    return content.slice(0, 120)
  }
}

export function MessageList({ sessionId, refreshKey, activeFilters, showAllReplies, showTools, scrollToMessageId, onScrollComplete, restoreScrollTop, onScrollRestored, header }: Props) {
  const { t } = useI18n()
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set())
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  useEffect(() => {
    if (!sessionId) {
      setMessages([])
      return
    }
    setLoading(true)
    api.getMessages(sessionId).then(msgs => {
      setMessages(msgs)
      setLoading(false)
    })
  }, [sessionId])

  // Silent refresh: pull in messages written while this session is open
  // (e.g. a Claude Code conversation that is still running). No loading
  // state, so the current scroll position is kept.
  const currentSessionRef = useRef(sessionId)
  currentSessionRef.current = sessionId
  const listRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(false)
  useEffect(() => {
    if (!sessionId || refreshKey === undefined) return
    api.getMessages(sessionId).then(msgs => {
      // Drop the response if the user switched sessions meanwhile
      if (currentSessionRef.current !== sessionId) return
      setMessages(prev => {
        if (msgs.length === prev.length) return prev
        // Follow new messages only if the reader is already at the bottom;
        // someone scrolled up to read history keeps their position.
        const scroller = listRef.current?.closest('.content-area')
        followRef.current = !!scroller &&
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
        return msgs
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  useLayoutEffect(() => {
    if (!followRef.current) return
    followRef.current = false
    const scroller = listRef.current?.closest('.content-area')
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
  }, [messages])

  // A message opened from search stays visible even if the current filters
  // would hide it (e.g. an intermediate reply while only final replies show)
  const [revealId, setRevealId] = useState<number | null>(null)
  useEffect(() => { setRevealId(null) }, [sessionId])

  useEffect(() => {
    if (scrollToMessageId && !loading && messages.length > 0) {
      const el = messageRefs.current.get(scrollToMessageId)
      if (el) {
        setRevealId(scrollToMessageId)
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.classList.add('message-highlight')
        setTimeout(() => el.classList.remove('message-highlight'), 2000)
      }
      onScrollComplete?.()
    }
  }, [scrollToMessageId, loading, messages, onScrollComplete])

  useLayoutEffect(() => {
    // Wait for this session's messages: right after a session switch the
    // previous session's list is still in state for one render
    if (restoreScrollTop == null || loading || messages[0]?.session_id !== sessionId) return
    const scroller = listRef.current?.closest('.content-area')
    if (scroller) scroller.scrollTop = restoreScrollTop
    onScrollRestored?.()
  }, [restoreScrollTop, loading, messages, sessionId, onScrollRestored])

  const lastAssistantUuids = useMemo(
    () => findLastAssistantPerTurn(messages),
    [messages]
  )

  const messageGroups = useMemo(() => buildGroups(messages), [messages])

  const [outlineCollapsed, setOutlineCollapsed] = useState(() => localStorage.getItem(OUTLINE_KEY) === '1')
  const toggleOutline = useCallback(() => {
    setOutlineCollapsed(c => {
      localStorage.setItem(OUTLINE_KEY, c ? '0' : '1')
      return !c
    })
  }, [])
  const [activePromptId, setActivePromptId] = useState<number | null>(null)

  // Highlight, in the outline, the last prompt scrolled past the top edge
  useEffect(() => {
    const scroller = listRef.current?.closest('.content-area')
    if (!scroller) return
    let frame = 0
    const update = () => {
      frame = 0
      const top = scroller.getBoundingClientRect().top + 140
      let current: number | null = null
      listRef.current?.querySelectorAll<HTMLElement>('[data-prompt-id]').forEach(el => {
        if (el.getBoundingClientRect().top <= top) current = Number(el.dataset.promptId)
      })
      setActivePromptId(current)
    }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update) }
    update()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [messages, loading, activeFilters, showAllReplies, showTools])

  const toggleTool = (uuid: string) => {
    setExpandedTools(prev => {
      const next = new Set(prev)
      if (next.has(uuid)) next.delete(uuid)
      else next.add(uuid)
      return next
    })
  }

  if (!sessionId) {
    return (
      <div className="empty-hero">
        <div className="empty-hero-mark"><Icon name="search" size={22} /></div>
        <h2>{t.emptyTitle}</h2>
        <p>{t.emptyHint}</p>
      </div>
    )
  }

  if (loading) {
    return <div className="loading-state">{t.loading}</div>
  }

  // Filter groups
  const shouldShow = (group: MessageGroup) => {
    if (group.type === 'tool_group') {
      return showTools
    }

    const msg = group.message
    const hasContent = msg.content && msg.content.trim()
    const hasImages = !!msg.images
    if (!hasContent && !hasImages) return false
    if (msg.id === scrollToMessageId || msg.id === revealId) return true
    if (msg.type === 'user') return activeFilters.has('user')
    if (msg.type === 'assistant') {
      if (msg.content_type !== 'text') return false
      if (!activeFilters.has('assistant')) return false
      if (!showAllReplies && !lastAssistantUuids.has(msg.uuid)) return false
      return true
    }
    if (msg.type === 'system') return activeFilters.has('system')
    if (msg.type === 'progress') return activeFilters.has('progress')
    return false
  }

  const visibleGroups = messageGroups.filter(shouldShow)

  // Prompts shown in this view, numbered in order, for the outline
  const prompts: OutlinePrompt[] = []
  const promptIndex = new Map<number, number>()
  for (const g of visibleGroups) {
    if (g.type === 'single' && g.message.type === 'user') {
      prompts.push({ id: g.message.id, text: promptPreview(g.message.content || '') })
      promptIndex.set(g.message.id, prompts.length)
    }
  }

  const jumpTo = (id: number) => {
    messageRefs.current.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="session-view">
    <div className="message-list" ref={listRef}>
      {header}
      {visibleGroups.length === 0 ? (
        <div className="empty-state">{t.noMatchingMessages}</div>
      ) : (
        visibleGroups.map(group => {
          if (group.type === 'tool_group') {
            const isExpanded = expandedTools.has(group.tool.uuid)
            const summary = getToolSummary(group.tool.content || '')
            const resultCount = group.results.length

            return (
              <div
                key={group.tool.uuid}
                ref={el => { if (el) messageRefs.current.set(group.tool.id, el) }}
                className="tool-group"
              >
                <div className="tool-group-header" onClick={() => toggleTool(group.tool.uuid)}>
                  <Icon name={isExpanded ? 'chevronDown' : 'chevronRight'} size={14} className="tool-group-arrow" />
                  <Icon name="tool" size={13} className="tool-group-icon" />
                  <span className="tool-group-summary">{summary}</span>
                  {resultCount > 0 && (
                    <span className="tool-group-badge">{t.toolResults(resultCount)}</span>
                  )}
                </div>
                {isExpanded && (
                  <div className="tool-group-body">
                    <div className="tool-group-section">
                      <div className="tool-group-section-label">{t.toolCall}</div>
                      <pre className="tool-use-content">{group.tool.content}</pre>
                    </div>
                    {group.results.map(r => (
                      <div key={r.uuid} className="tool-group-section">
                        <div className="tool-group-section-label">{t.toolResult}</div>
                        <pre className="tool-use-content tool-result-content">{r.content || t.emptyResult}</pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          }

          return (
            <div
              key={group.message.uuid}
              ref={el => { if (el) messageRefs.current.set(group.message.id, el) }}
              data-prompt-id={promptIndex.has(group.message.id) ? group.message.id : undefined}
              className="message-anchor"
            >
              <MessageCard
                message={group.message}
                isVisible={true}
                promptIndex={promptIndex.get(group.message.id)}
              />
            </div>
          )
        })
      )}
    </div>
    {prompts.length > 1 && (
      <PromptOutline
        prompts={prompts}
        activeId={activePromptId}
        onJump={jumpTo}
        collapsed={outlineCollapsed}
        onToggle={toggleOutline}
      />
    )}
    </div>
  )
}
