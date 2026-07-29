// The list of what is in the room, next to the camera buttons.
//
// Secondary on purpose: the viewport is how you pick a light, and this is for
// the times when clicking a thirty-centimetre body in a dark room is not the
// fastest way to say "all the beams". Hovering a family lights it in the
// viewport; clicking selects it.
//
// The groups are derived from the patch rather than stored in it. patch.groups
// already means two other things -- the physical wiring of the two walls, and
// what an effect can target -- and a third meaning on the same field is how a
// small file becomes unreadable.

import { useEffect, useMemo, useRef, useState } from 'react'
import { kindOf } from '../../../core/fixtures'
import type { Fixture, Patch } from '../patch'

export interface LightGroup {
  id: string
  label: string
  ids: string[]
}

const FAMILY_LABEL: Record<string, string> = {
  batten: 'Battens',
  movinghead: 'Moving heads',
  blinder: 'Blinders',
  panel: 'Panels',
  fog: 'Haze',
  unknown: 'Unknown',
}

/** Families first, then the sides that actually exist. Empty groups are never
 *  offered: a menu of things that are not there is worse than a short menu. */
export function lightGroups(patch: Patch): LightGroup[] {
  const groups: LightGroup[] = []
  const byModel = new Map<string, Fixture[]>()
  for (const fixture of patch.fixtures) {
    const list = byModel.get(fixture.type) ?? []
    list.push(fixture)
    byModel.set(fixture.type, list)
  }

  for (const [type, fixtures] of byModel) {
    const profile = patch.fixtureTypes[type]
    if (!profile) continue
    groups.push({
      id: `model:${type}`,
      label: profile.name || (FAMILY_LABEL[kindOf(profile)] ?? type),
      ids: fixtures.map((fixture) => fixture.id),
    })
  }

  // Sides, from the group name the patch already carries.
  for (const [suffix, label] of [
    ['left', 'Everything stage left'],
    ['right', 'Everything stage right'],
  ] as const) {
    const ids = patch.fixtures
      .filter((fixture) => fixture.group.endsWith(suffix))
      .map((fixture) => fixture.id)
    if (ids.length > 0) groups.push({ id: `side:${suffix}`, label, ids })
  }

  return groups
}

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
