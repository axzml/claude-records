import { Popover } from './Popover'
import { Icon } from './Icon'
import { useI18n } from '../i18n'
import type { MessageTypeFilter } from '../types'

const TYPES: MessageTypeFilter[] = ['user', 'assistant', 'system', 'progress']

interface Props {
  active: Set<MessageTypeFilter>
  onToggle: (type: MessageTypeFilter) => void
  showAllReplies: boolean
  onToggleAllReplies: () => void
  showTools: boolean
  onToggleTools: () => void
}

function Check({ on }: { on: boolean }) {
  return <span className={`check${on ? ' on' : ''}`}>{on && <Icon name="check" size={12} />}</span>
}

/** Which message kinds the session view shows (formerly a row of chips). */
export function FilterMenu({ active, onToggle, showAllReplies, onToggleAllReplies, showTools, onToggleTools }: Props) {
  const { t } = useI18n()
  const labels: Record<MessageTypeFilter, string> = {
    user: t.chipUser,
    assistant: t.chipAssistant,
    system: t.chipSystem,
    progress: t.chipProgress,
  }
  // Default view: prompts + final replies only
  const isDefault = active.size === 2 && active.has('user') && active.has('assistant')
    && !showAllReplies && !showTools

  return (
    <Popover
      label={<><Icon name="filter" /><span>{t.filterMenu}</span>{!isDefault && <span className="dot" />}</>}
      active={!isDefault}
    >
      <div className="menu-section">{t.showLabel}</div>
      {TYPES.map(type => (
        <button key={type} className="menu-item" onClick={() => onToggle(type)}>
          <Check on={active.has(type)} />{labels[type]}
        </button>
      ))}
      <div className="menu-sep" />
      <div className="menu-section">{t.replyOptions}</div>
      <button className="menu-item" onClick={onToggleAllReplies}>
        <Check on={showAllReplies} />{t.showAllReplies}
      </button>
      <button className="menu-item" onClick={onToggleTools}>
        <Check on={showTools} />{t.toolCalls}
      </button>
    </Popover>
  )
}
