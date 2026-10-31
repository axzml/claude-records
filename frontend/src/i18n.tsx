import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

export type Lang = 'zh' | 'en'

const STORAGE_KEY = 'claude-records-lang'

const zh = {
  // Top bar
  back: '后退（Alt+←）',
  forward: '前进（Alt+→）',
  searchPlaceholder: '搜索所有对话…',
  hybridTitle: (model: string | null) => `关键词 + 语义混合检索（${model ?? ''}）`,
  hybridUnavailableTitle: '语义检索不可用，将按关键词 AND 搜索（需运行 Ollama）',
  modeSmart: '智能',
  timeFilter: '时间',
  dateFrom: '开始日期',
  dateTo: '结束日期',
  clearDates: '清除',
  filterMenu: '筛选',
  starredFilter: '收藏',
  starredFilterTitle: '只看收藏的消息',
  switchLangLabel: 'EN',
  switchLangTitle: 'Switch to English',
  themeSystem: '外观：跟随系统',
  themeLight: '外观：浅色',
  themeDark: '外观：深色',

  // Filter menu
  showLabel: '显示的消息',
  chipUser: '我的提问',
  chipAssistant: 'Claude 回复',
  chipSystem: '系统消息',
  chipProgress: '进度信息',
  replyOptions: '回复',
  showAllReplies: '显示每轮的全部回复',
  toolCalls: '显示工具调用',

  // Sidebar
  tabBrowse: '项目',
  tabFavorites: '收藏',
  tabRecent: '最近',
  allProjects: '全部项目',
  starredSessions: (n: number) => `${n} 个收藏的会话`,
  noStarredSessions: '还没有收藏的会话',
  recentSessions: (n: number) => `最近 ${n} 个会话`,
  noRecentSessions: '还没有最近的会话',
  projects: (n: number) => `${n} 个项目`,
  sessionCount: (n: number) => `${n} 个会话`,
  messageCount: (n: number) => `${n} 条消息`,
  msgShort: (n: number) => `${n} 条`,
  stats: (p: number, s: number, m: number) =>
    `${p.toLocaleString()} 个项目 · ${s.toLocaleString()} 个会话 · ${m.toLocaleString()} 条消息`,
  sessions: (n: number) => `${n} 个会话`,
  today: '今天',
  yesterday: '昨天',
  thisWeek: '本周',
  earlier: '更早',
  rename: '重命名',
  star: '收藏',
  unstar: '取消收藏',
  unknownTime: '未知时间',

  // Messages
  emptyTitle: '选一个会话开始阅读',
  emptyHint: '从左侧选择项目或最近的会话，或按 Ctrl K 搜索所有对话。',
  loading: '加载中…',
  noMatchingMessages: '没有符合筛选条件的消息',
  thinking: '思考',
  roleUser: '你',
  roleAssistant: 'Claude',
  roleSystem: '系统',
  roleProgress: '进度',
  wordCount: (n: string) => `${n} 字`,
  copyContent: '复制',
  copied: '已复制',
  expandAll: '展开全文',
  toolCall: '工具调用',
  toolResult: '结果',
  toolResults: (n: number) => `${n} 个结果`,
  emptyResult: '（空）',
  outlineTitle: '本会话提问',
  outlineToggle: '提问目录',

  // Export
  exportSession: '导出会话',
  exportButton: '导出',
  exportMarkdown: 'Markdown',
  exportHTML: 'HTML 网页',
  nothingToExport: '没有可导出的消息',
  exportFailed: '导出失败，请重试',

  // Search results
  searchTitle: '搜索结果',
  matchCount: (n: number) => `${n} 条匹配`,
  starredTitle: '收藏的消息',
  starredCount: (n: number) => `${n} 条`,
  allFacet: '全部',
  collapse: '收起',
  moreFacets: (n: number) => `另外 ${n} 个`,
  resultUser: '你的提问',
  resultAssistant: 'Claude 回复',
  semanticMatch: '语义匹配',
  semanticMatchTitle: '按语义相关找到，未包含关键词',
  contextQuestion: '提问：',
  contextAnswer: '回复：',
  loadFailedRetry: '加载失败，点击重试',
  loadingMore: '加载中…',
  shownCount: (shown: number, total: number) => `已显示 ${shown} / ${total}`,

  // Status bar
  semanticModel: (model: string | null) => `语义检索模型：${model ?? ''}`,
  semanticDisconnected: '语义检索未连接',
  semanticDisconnectedHint: '（Ollama 未运行，搜索仅用关键词）',
  semanticIndexing: (done: string, total: string) => `语义索引 ${done} / ${total}`,
  semanticReady: '语义检索就绪',
  syncing: '同步中…',
  synced: (seconds: number | null) => `已同步${seconds !== null ? ` · ${seconds}s 前` : ''}`,
}

type Messages = typeof zh

const en: Messages = {
  // Top bar
  back: 'Back (Alt+←)',
  forward: 'Forward (Alt+→)',
  searchPlaceholder: 'Search all conversations…',
  hybridTitle: (model: string | null) => `Keyword + semantic hybrid search (${model ?? ''})`,
  hybridUnavailableTitle: 'Semantic search unavailable; falls back to keyword AND search (requires Ollama)',
  modeSmart: 'Smart',
  timeFilter: 'Date',
  dateFrom: 'From',
  dateTo: 'To',
  clearDates: 'Clear',
  filterMenu: 'Filter',
  starredFilter: 'Starred',
  starredFilterTitle: 'Show starred messages only',
  switchLangLabel: '中',
  switchLangTitle: '切换到中文',
  themeSystem: 'Appearance: system',
  themeLight: 'Appearance: light',
  themeDark: 'Appearance: dark',

  // Filter menu
  showLabel: 'Show messages',
  chipUser: 'My prompts',
  chipAssistant: 'Claude replies',
  chipSystem: 'System',
  chipProgress: 'Progress',
  replyOptions: 'Replies',
  showAllReplies: 'All replies in each turn',
  toolCalls: 'Tool calls',

  // Sidebar
  tabBrowse: 'Projects',
  tabFavorites: 'Starred',
  tabRecent: 'Recent',
  allProjects: 'All projects',
  starredSessions: (n: number) => `${n} starred sessions`,
  noStarredSessions: 'No starred sessions yet',
  recentSessions: (n: number) => `${n} recent sessions`,
  noRecentSessions: 'No recent sessions yet',
  projects: (n: number) => `${n} projects`,
  sessionCount: (n: number) => `${n} sessions`,
  messageCount: (n: number) => `${n} messages`,
  msgShort: (n: number) => `${n} msgs`,
  stats: (p: number, s: number, m: number) =>
    `${p.toLocaleString()} projects · ${s.toLocaleString()} sessions · ${m.toLocaleString()} messages`,
  sessions: (n: number) => `${n} sessions`,
  today: 'Today',
  yesterday: 'Yesterday',
  thisWeek: 'This week',
  earlier: 'Earlier',
  rename: 'Rename',
  star: 'Star',
  unstar: 'Unstar',
  unknownTime: 'Unknown time',

  // Messages
  emptyTitle: 'Pick a session to start reading',
  emptyHint: 'Choose a project or a recent session on the left, or press Ctrl K to search everything.',
  loading: 'Loading…',
  noMatchingMessages: 'No messages match the current filters',
  thinking: 'Thinking',
  roleUser: 'You',
  roleAssistant: 'Claude',
  roleSystem: 'System',
  roleProgress: 'Progress',
  wordCount: (n: string) => `${n} words`,
  copyContent: 'Copy',
  copied: 'Copied',
  expandAll: 'Show full message',
  toolCall: 'Tool call',
  toolResult: 'Result',
  toolResults: (n: number) => `${n} result${n > 1 ? 's' : ''}`,
  emptyResult: '(empty)',
  outlineTitle: 'Prompts in this session',
  outlineToggle: 'Prompt outline',

  // Export
  exportSession: 'Export session',
  exportButton: 'Export',
  exportMarkdown: 'Markdown',
  exportHTML: 'HTML page',
  nothingToExport: 'Nothing to export',
  exportFailed: 'Export failed, please try again',

  // Search results
  searchTitle: 'Search results',
  matchCount: (n: number) => `${n} matches`,
  starredTitle: 'Starred messages',
  starredCount: (n: number) => `${n}`,
  allFacet: 'All',
  collapse: 'Collapse',
  moreFacets: (n: number) => `${n} more`,
  resultUser: 'Your prompt',
  resultAssistant: 'Claude reply',
  semanticMatch: 'Semantic match',
  semanticMatchTitle: 'Found by meaning; does not contain the keywords',
  contextQuestion: 'Prompt: ',
  contextAnswer: 'Reply: ',
  loadFailedRetry: 'Load failed, click to retry',
  loadingMore: 'Loading…',
  shownCount: (shown: number, total: number) => `Showing ${shown} / ${total}`,

  // Status bar
  semanticModel: (model: string | null) => `Semantic model: ${model ?? ''}`,
  semanticDisconnected: 'Semantic search offline',
  semanticDisconnectedHint: ' (Ollama is not running; keyword search only)',
  semanticIndexing: (done: string, total: string) => `Semantic index ${done} / ${total}`,
  semanticReady: 'Semantic search ready',
  syncing: 'Syncing…',
  synced: (seconds: number | null) => `Synced${seconds !== null ? ` · ${seconds}s ago` : ''}`,
}

const MESSAGES: Record<Lang, Messages> = { zh, en }

const toLocale = (lang: Lang) => (lang === 'zh' ? 'zh-CN' : 'en-US')

function initialLang(): Lang {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved === 'zh' || saved === 'en') return saved
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

// Mirrors the provider state so non-React modules (utils/export.ts) can read it
let activeLang: Lang = initialLang()

export function currentLocale(): string {
  return toLocale(activeLang)
}

export function currentMessages(): Messages {
  return MESSAGES[activeLang]
}

interface I18nContextValue {
  lang: Lang
  setLang: (lang: Lang) => void
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(activeLang)
  activeLang = lang

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, lang)
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  const value = useMemo(() => ({ lang, setLang }), [lang])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  const { lang, setLang } = ctx
  return { t: MESSAGES[lang], lang, setLang, locale: toLocale(lang) }
}
