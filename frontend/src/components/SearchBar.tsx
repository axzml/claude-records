import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Icon } from './Icon'
import { Popover } from './Popover'
import { useI18n } from '../i18n'
import type { SearchMode, SemanticStatus, ThemeMode } from '../types'

interface Props {
  query: string
  onQueryChange: (q: string) => void
  mode: SearchMode
  onModeChange: (m: SearchMode) => void
  semantic?: SemanticStatus
  onSearch: () => void
  onClear: () => void
  starredOnly: boolean
  onStarredToggle: () => void
  timeFrom: string
  timeTo: string
  onTimeFromChange: (v: string) => void
  onTimeToChange: (v: string) => void
  themeMode: ThemeMode
  onThemeCycle: () => void
  canBack: boolean
  canForward: boolean
  onBack: () => void
  onForward: () => void
  /** The message filter menu, rendered among the toolbar buttons */
  filterMenu: ReactNode
}

const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' } as const

export function SearchBar({
  query, onQueryChange, mode, onModeChange, semantic,
  onSearch, onClear, starredOnly, onStarredToggle,
  timeFrom, timeTo, onTimeFromChange, onTimeToChange,
  themeMode, onThemeCycle,
  canBack, canForward, onBack, onForward, filterMenu,
}: Props) {
  const { t, lang, setLang, locale } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)

  // Ctrl/Cmd+K focuses search from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') onSearch()
    if (e.key === 'Escape') onClear()
  }

  const modes: { value: SearchMode; label: string; title?: string }[] = [
    {
      value: 'HYBRID',
      label: t.modeSmart,
      title: semantic?.enabled && semantic.available ? t.hybridTitle(semantic.model) : t.hybridUnavailableTitle,
    },
    { value: 'AND', label: 'AND' },
    { value: 'OR', label: 'OR' },
  ]

  const shortDate = (day: string) =>
    new Date(`${day}T00:00:00`).toLocaleDateString(locale, { month: 'short', day: 'numeric' })
  const hasDates = !!(timeFrom || timeTo)
  const dateLabel = hasDates
    ? `${timeFrom ? shortDate(timeFrom) : '…'} – ${timeTo ? shortDate(timeTo) : '…'}`
    : t.timeFilter

  const themeTitle = { system: t.themeSystem, light: t.themeLight, dark: t.themeDark }[themeMode]

  return (
    <header className="topbar">
      <div className="brand">Claude <span>Records</span></div>
      <div className="nav-buttons">
        <button className="icon-button" onClick={onBack} disabled={!canBack} title={t.back}>
          <Icon name="chevronLeft" />
        </button>
        <button className="icon-button" onClick={onForward} disabled={!canForward} title={t.forward}>
          <Icon name="chevronRight" />
        </button>
      </div>

      <div className="search-box">
        <Icon name="search" className="search-box-icon" />
        <input
          ref={inputRef}
          type="text"
          className="search-input"
          placeholder={t.searchPlaceholder}
          value={query}
          onChange={e => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        {query
          ? <button className="search-clear" onClick={onClear}><Icon name="x" size={14} /></button>
          : <kbd className="kbd">Ctrl K</kbd>}
        <div className="segmented">
          {modes.map(m => (
            <button
              key={m.value}
              className={mode === m.value ? 'on' : ''}
              onClick={() => onModeChange(m.value)}
              title={m.title}
            >{m.label}</button>
          ))}
        </div>
      </div>

      <div className="toolbar">
        <Popover
          label={<><Icon name="calendar" /><span>{dateLabel}</span></>}
          active={hasDates}
        >
          <label className="menu-field">
            <span>{t.dateFrom}</span>
            <input type="date" value={timeFrom} onChange={e => onTimeFromChange(e.target.value)} />
          </label>
          <label className="menu-field">
            <span>{t.dateTo}</span>
            <input type="date" value={timeTo} onChange={e => onTimeToChange(e.target.value)} />
          </label>
          {hasDates && (
            <button className="menu-item menu-item-muted" onClick={() => { onTimeFromChange(''); onTimeToChange('') }}>
              <Icon name="x" size={14} />{t.clearDates}
            </button>
          )}
        </Popover>
        {filterMenu}
        <button
          className={`tool-button${starredOnly ? ' is-active' : ''}`}
          onClick={onStarredToggle}
          title={t.starredFilterTitle}
        >
          <Icon name="star" filled={starredOnly} /><span>{t.starredFilter}</span>
        </button>
        <span className="toolbar-sep" />
        <button className="icon-button text-button" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')} title={t.switchLangTitle}>
          {t.switchLangLabel}
        </button>
        <button className="icon-button" onClick={onThemeCycle} title={themeTitle}>
          <Icon name={THEME_ICON[themeMode]} />
        </button>
      </div>
    </header>
  )
}
