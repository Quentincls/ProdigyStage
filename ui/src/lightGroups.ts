// What you can select, named the way the show is talked about.
//
// One vocabulary, used in two places that must agree: the Lights menu offers
// these names, and the inspector reads a selection back in the same ones. If
// clicking "Stage Left" produced a panel headed "24 lights", the interface
// would have forgotten what you just said to it.
//
// The groups are derived from the patch rather than stored in it. patch.groups
// already means two other things -- the physical wiring of the two walls, and
// what an effect can target -- and a third meaning on the same field is how a
// small file becomes unreadable.

import { familyName } from '../../core/fixtures'
import type { Fixture, Patch } from './patch'

export interface LightGroup {
  id: string
  label: string
  ids: string[]
}

/** Families first, then the sides that actually exist. Empty groups are never
 *  offered: a menu of things that are not there is worse than a short menu. */
export function lightGroups(patch: Patch): LightGroup[] {
  const groups: LightGroup[] = families(patch, patch.fixtures).map((family) => ({
    id: `model:${family.type}`,
    label: family.label,
    ids: family.ids,
  }))

  // The two sides, from the group name the patch already carries. "Stage left"
  // is not a model and not a wall -- it is 16 battens and 8 panels, which is
  // exactly the sort of thing you want to turn one colour in one gesture.
  for (const [suffix, label] of [
    ['left', 'Stage Left'],
    ['right', 'Stage Right'],
  ] as const) {
    const ids = patch.fixtures
      .filter((fixture) => fixture.group.endsWith(suffix))
      .map((fixture) => fixture.id)
    if (ids.length > 0) groups.push({ id: `side:${suffix}`, label, ids })
  }

  return groups
}

export interface Family {
  type: string
  label: string
  ids: string[]
}

/** What a set of lights is made of, in patch order. The inspector's "includes"
 *  list, and the way you narrow "everything stage left" down to the panels. */
export function families(patch: Patch, fixtures: Fixture[]): Family[] {
  const byType = new Map<string, Family>()
  for (const fixture of fixtures) {
    const found = byType.get(fixture.type)
    if (found) {
      found.ids.push(fixture.id)
      continue
    }
    byType.set(fixture.type, {
      type: fixture.type,
      label: familyName(patch.fixtureTypes[fixture.type]),
      ids: [fixture.id],
    })
  }
  return [...byType.values()]
}

/**
 * The name of a selection, when it has one.
 *
 * Selecting is not always naming: three lights picked by hand in the viewport
 * are three lights and nothing more. But a selection that is exactly a family,
 * exactly a side, or exactly the whole rig came from a word, and the panel
 * should say that word back. Returns null when there is no such word.
 */
export function selectionName(patch: Patch, ids: string[]): string | null {
  if (ids.length === 0) return null
  if (ids.length === patch.fixtures.length) return 'All lights'
  const chosen = new Set(ids)
  for (const group of lightGroups(patch)) {
    if (group.ids.length === chosen.size && group.ids.every((id) => chosen.has(id))) {
      return group.label
    }
  }
  return null
}
