import { useState, useEffect, useCallback } from 'react'
import { api } from '../utils/api'
import type { SyncStatus } from '../types'

export function useSync(intervalMs: number = 30000) {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [lastChecked, setLastChecked] = useState<Date | null>(null)

  const checkSync = useCallback(async () => {
    try {
      const s = await api.getSyncStatus()
      setStatus(s)
      setLastChecked(new Date())
      return s
    } catch (err) {
      console.error('Sync check failed:', err)
      return null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    // The backend syncs in the background, so poll quickly while a sync is
    // running to pick up its results, then fall back to the normal interval.
    const tick = async () => {
      const s = await checkSync()
      if (cancelled) return
      timer = setTimeout(tick, s?.pending_changes ? 3000 : intervalMs)
    }
    tick()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [checkSync, intervalMs])

  return { status, lastChecked, checkSync }
}
