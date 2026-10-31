import { useState, useRef, useEffect } from 'react'
import type { ReactNode } from 'react'

interface Props {
  /** Trigger button content */
  label: ReactNode
  title?: string
  /** Highlights the trigger, e.g. when the menu holds a non-default setting */
  active?: boolean
  disabled?: boolean
  align?: 'left' | 'right'
  className?: string
  children: ReactNode | ((close: () => void) => ReactNode)
}

/** A trigger button with a dropdown panel; closes on outside click or Escape. */
export function Popover({ label, title, active, disabled, align = 'right', className, children }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const close = () => setOpen(false)

  return (
    <div className={`popover${className ? ` ${className}` : ''}`} ref={ref}>
      <button
        className={`tool-button${active ? ' is-active' : ''}${open ? ' is-open' : ''}`}
        onClick={() => setOpen(!open)}
        title={title}
        disabled={disabled}
      >
        {label}
      </button>
      {open && (
        <div className={`popover-panel popover-${align}`}>
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  )
}
