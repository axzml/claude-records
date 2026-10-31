import { useState, useCallback, useEffect, useRef } from 'react'

// Distinguishes our history entries from ones left by an earlier page load,
// whose snapshots no longer exist in memory
const PAGE_TOKEN = Math.random().toString(36).slice(2)

interface EntryState {
  viewIdx: number
  token: string
}

/**
 * Back/forward navigation between in-app views on top of the browser history,
 * so the browser buttons, Alt+←/→ and mouse side buttons all work.
 *
 * Each history entry stores only an index; the view itself is kept as an
 * in-memory snapshot, captured when leaving it (so it includes everything
 * that happened on the view, e.g. loaded result pages and scroll position).
 */
export function useViewHistory<T>(capture: () => T, restore: (snapshot: T) => void) {
  const captureRef = useRef(capture)
  captureRef.current = capture
  const restoreRef = useRef(restore)
  restoreRef.current = restore

  const snapshots = useRef(new Map<number, T>())
  const idxRef = useRef(0)
  const [nav, setNav] = useState({ idx: 0, max: 0 })

  useEffect(() => {
    history.replaceState({ viewIdx: idxRef.current, token: PAGE_TOKEN } satisfies EntryState, '')
    const onPop = (e: PopStateEvent) => {
      const state = e.state as EntryState | null
      if (!state || state.token !== PAGE_TOKEN) return
      // Save the view being left, so the opposite direction can return to it
      snapshots.current.set(idxRef.current, captureRef.current())
      idxRef.current = state.viewIdx
      setNav(n => ({ ...n, idx: state.viewIdx }))
      const snapshot = snapshots.current.get(state.viewIdx)
      if (snapshot) restoreRef.current(snapshot)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  /** Call right before switching to a new view. */
  const push = useCallback(() => {
    snapshots.current.set(idxRef.current, captureRef.current())
    const idx = idxRef.current + 1
    // A new view after going back discards the forward entries, like a browser
    for (const k of [...snapshots.current.keys()]) {
      if (k >= idx) snapshots.current.delete(k)
    }
    history.pushState({ viewIdx: idx, token: PAGE_TOKEN } satisfies EntryState, '')
    idxRef.current = idx
    setNav({ idx, max: idx })
  }, [])

  return {
    push,
    canBack: nav.idx > 0,
    canForward: nav.idx < nav.max,
    back: useCallback(() => history.back(), []),
    forward: useCallback(() => history.forward(), []),
  }
}
