import { useState } from 'react'
import { api } from '../utils/api'
import { projectColor } from '../utils/projectColor'
import { Icon } from './Icon'
import { useI18n } from '../i18n'
import type { Project } from '../types'

interface Props {
  projects: Project[]
  onSelect: (id: number) => void
  onProjectRenamed: (id: number, newName: string) => void
}

export function ProjectList({ projects, onSelect, onProjectRenamed }: Props) {
  const { t } = useI18n()
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')

  const startRename = (e: React.MouseEvent, p: Project) => {
    e.stopPropagation()
    setEditingId(p.id)
    setEditValue(p.display_name)
  }

  const saveRename = async (id: number) => {
    const trimmed = editValue.trim()
    if (trimmed) {
      await api.renameProject(id, trimmed)
      onProjectRenamed(id, trimmed)
    }
    setEditingId(null)
  }

  const handleKeyDown = (e: React.KeyboardEvent, id: number) => {
    if (e.key === 'Enter') saveRename(id)
    if (e.key === 'Escape') setEditingId(null)
  }

  return (
    <div className="project-list">
      <div className="list-group-label">{t.projects(projects.length)}</div>
      {projects.map(p => (
        <div key={p.id} className="project-item" onClick={() => onSelect(p.id)}>
          <span className="project-dot" style={{ background: projectColor(p.display_name) }} />
          {editingId === p.id ? (
            <input
              className="inline-edit"
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onKeyDown={e => handleKeyDown(e, p.id)}
              onBlur={() => saveRename(p.id)}
              onClick={e => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <>
              <span className="project-item-name">{p.display_name}</span>
              <span className="row-actions">
                <button className="row-action" onClick={e => startRename(e, p)} title={t.rename}>
                  <Icon name="pencil" size={13} />
                </button>
              </span>
              <span className="project-item-count">{p.session_count}</span>
              <Icon name="chevronRight" size={14} className="project-item-chevron" />
            </>
          )}
        </div>
      ))}
    </div>
  )
}
