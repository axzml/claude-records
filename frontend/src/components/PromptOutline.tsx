import { useEffect, useRef } from 'react'
import { Icon } from './Icon'
import { useI18n } from '../i18n'

export interface OutlinePrompt {
  id: number
  text: string
}

interface Props {
  prompts: OutlinePrompt[]
  activeId: number | null
  onJump: (id: number) => void
  collapsed: boolean
  onToggle: () => void
}

/** Right-hand index of the user's prompts in the open session; click to jump. */
export function PromptOutline({ prompts, activeId, onJump, collapsed, onToggle }: Props) {
  const { t } = useI18n()
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the highlighted prompt in view inside a long outline. Scroll only
  // the outline list: scrollIntoView would also scroll the conversation
  // and cut short its smooth scroll to a clicked prompt.
  useEffect(() => {
    const list = listRef.current
    const el = list?.querySelector<HTMLElement>('.outline-item.active')
    if (!list || !el) return
    const lr = list.getBoundingClientRect()
    const er = el.getBoundingClientRect()
    if (er.top < lr.top) list.scrollTop -= lr.top - er.top
    else if (er.bottom > lr.bottom) list.scrollTop += er.bottom - lr.bottom
  }, [activeId])

  if (collapsed) {
    return (
      <div className="outline-collapsed">
        <button className="icon-button" onClick={onToggle} title={t.outlineToggle}>
          <Icon name="outline" />
        </button>
      </div>
    )
  }

  return (
    <nav className="outline">
      <div className="outline-header">
        <span>{t.outlineTitle}</span>
        <span className="outline-count">{prompts.length}</span>
        <button className="icon-button" onClick={onToggle} title={t.outlineToggle}>
          <Icon name="outline" size={15} />
        </button>
      </div>
      <div className="outline-list" ref={listRef}>
        {prompts.map((p, i) => (
          <button
            key={p.id}
            className={`outline-item${p.id === activeId ? ' active' : ''}`}
            onClick={() => onJump(p.id)}
            title={p.text}
          >
            <span className="outline-index">{String(i + 1).padStart(2, '0')}</span>
            <span className="outline-text">{p.text}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
