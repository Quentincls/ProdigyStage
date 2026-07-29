// The list of what is in the room, next to the camera buttons.
//
// Secondary on purpose: the viewport is how you pick a light, and this is for
// the times when clicking a thirty-centimetre body in a dark room is not the
// fastest way to say "all the beams". Hovering a family lights it in the
// viewport; clicking selects it.
//
// The names come from ../lightGroups, which the inspector reads too.

import { useEffect, useMemo, useRef, useState } from 'react'
import { lightGroups } from '../lightGroups'
import type { Patch } from '../patch'

export function LightPicker({
  patch,
  selection,
  onSelect,
  onHover,
}: {
  patch: Patch
  selection: string[]
  onSelect: (ids: string[]) => void
  onHover: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const groups = useMemo(() => lightGroups(patch), [patch])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  // Leaving the menu must clear the highlight, however it was left.
  useEffect(() => {
    if (!open) onHover([])
  }, [open, onHover])

  const selected = new Set(selection)
  return (
    <div className="light-picker" ref={rootRef}>
      <button className={`previz-view ${open ? 'active' : ''}`} onClick={() => setOpen(!open)}>
        Lights ▾
      </button>
      {open && (
        <div className="light-menu" onMouseLeave={() => onHover([])}>
          <button
            className="light-item"
            onMouseEnter={() => onHover(patch.fixtures.map((fixture) => fixture.id))}
            onClick={() => {
              onSelect(patch.fixtures.map((fixture) => fixture.id))
              setOpen(false)
            }}
          >
            <span className="light-item-label">All lights</span>
            <span className="light-item-count">{patch.fixtures.length}</span>
          </button>
          <span className="light-menu-rule" />
          {groups.map((group) => {
            const all = group.ids.every((id) => selected.has(id))
            return (
              <button
                key={group.id}
                className={`light-item ${all && selected.size === group.ids.length ? 'on' : ''}`}
                onMouseEnter={() => onHover(group.ids)}
                onClick={() => {
                  onSelect(group.ids)
                  setOpen(false)
                }}
              >
                <span className="light-item-label">{group.label}</span>
                <span className="light-item-count">{group.ids.length}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
