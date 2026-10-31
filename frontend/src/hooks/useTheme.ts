import { useState, useEffect } from 'react'
import type { ThemeMode } from '../types'

const STORAGE_KEY = 'claude-records-theme'
const MODES: ThemeMode[] = ['system', 'light', 'dark']

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)')

/**
 * Appearance: 'light' (paper) / 'dark' (graphite), or 'system' to follow the
 * OS setting live. The resolved scheme is set as <html data-theme>.
 */
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as ThemeMode | null
    return saved && MODES.includes(saved) ? saved : 'system'
  })
  const [systemDark, setSystemDark] = useState(() => darkQuery().matches)

  useEffect(() => {
    const query = darkQuery()
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const resolved = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved)
    localStorage.setItem(STORAGE_KEY, mode)
  }, [mode, resolved])

  const cycleMode = () => setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length])

  return { mode, cycleMode }
}
