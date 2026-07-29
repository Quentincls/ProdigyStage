// What is selected. One notion, one place.
//
// There used to be two: `selection` held fixtures and `selectedSceneId` held a
// scene, and nothing said they were alternatives. So picking Panels from the
// Lights menu while a scene was open left the scene open -- the viewport lit
// sixteen panels and the inspector went on editing Undertow. Two states that
// are really one state always drift like that, and the drift is invisible in
// the code and glaring on screen.
//
// The rule the rest of the application can now rely on:
//
//     WHAT I SELECT IS WHAT THE INSPECTOR EDITS.
//
// One value, five shapes, and the inspector is a switch on the shape. Choosing
// anything replaces whatever was chosen before, because that is what "select"
// means everywhere else on a computer.

import type { LayerTarget, LightLayer } from '../../core/layers'
import { partFor, partMatches, type FixtureRef } from '../../core/layers'
import { families, selectionName } from './lightGroups'
import type { Patch } from './patch'

export type Selection =
  /** Nothing. The viewport is being watched, not edited. */
  | { kind: 'none' }
  /** Lights in the room: one, several, a family, a side, or a mix. */
  | { kind: 'fixtures'; ids: string[] }
  /** A scene on the timeline -- the wall-look engine. */
  | { kind: 'scene'; id: string }
  /** A light layer on the timeline. */
  | { kind: 'layer'; id: string }
  /** One family or one fixture inside a light layer: the part that drives it. */
  | { kind: 'layerPart'; layerId: string; partId: string }

export const NOTHING: Selection = { kind: 'none' }

export function isFixtureSelection(selection: Selection): selection is { kind: 'fixtures'; ids: string[] } {
  return selection.kind === 'fixtures'
}

export function sceneId(selection: Selection): string | null {
  return selection.kind === 'scene' ? selection.id : null
}

export function layerId(selection: Selection): string | null {
  if (selection.kind === 'layer') return selection.id
  if (selection.kind === 'layerPart') return selection.layerId
  return null
}

function refs(patch: Patch): FixtureRef[] {
  return patch.fixtures.map((fixture) => ({ id: fixture.id, type: fixture.type, group: fixture.group }))
}

/**
 * Which fixtures light up in the viewport for a selection.
 *
 * Selecting a light layer shows you where it lands in the room, and selecting
 * one family inside it narrows that to the family -- so the three zones stay
 * three views of the same thing rather than three panels that happen to be
 * open at once.
 */
export function highlightedFixtures(selection: Selection, patch: Patch | null, layers: LightLayer[]): string[] {
  if (!patch) return []
  switch (selection.kind) {
    case 'fixtures':
      return selection.ids
    case 'layer': {
      const layer = layers.find((each) => each.id === selection.id)
      if (!layer) return []
      const list = refs(patch)
      return list.filter((fixture) => partFor(layer, fixture) !== null).map((fixture) => fixture.id)
    }
    case 'layerPart': {
      const layer = layers.find((each) => each.id === selection.layerId)
      const part = layer?.parts.find((each) => each.id === selection.partId)
      if (!layer || !part) return []
      return refs(patch)
        .filter((fixture) => partMatches(part, fixture) && partFor(layer, fixture)?.id === part.id)
        .map((fixture) => fixture.id)
    }
    default:
      return []
  }
}

/**
 * What to call the selection.
 *
 * A set of lights that is exactly a family or exactly a side came from a word,
 * and the panel says that word back; anything else is counted. See
 * lightGroups.ts, which the Lights menu reads from too, so clicking "Stage
 * Left" cannot open a panel headed "24 lights".
 */
export function fixtureSelectionTitle(ids: string[], patch: Patch): string {
  const named = selectionName(patch, ids)
  if (named) return named
  if (ids.length === 1) return ids[0]
  return `${ids.length} lights`
}

/** The families a set of fixtures is made of, in patch order. */
export function selectionFamilies(patch: Patch, ids: string[]) {
  const chosen = new Set(ids)
  return families(
    patch,
    patch.fixtures.filter((fixture) => chosen.has(fixture.id)),
  )
}

/**
 * The shortest way to say "these fixtures" in a light layer.
 *
 * A whole family becomes one family target; a whole patch group becomes one
 * group target; anything left over is named fixture by fixture. This is what
 * keeps a layer readable -- "Tambora, Beams, Blinders" rather than a list of
 * seventy ids -- and it is the same rule that later makes a single named
 * fixture in a layer mean "this one is an exception".
 */
export function coverTargets(patch: Patch, ids: string[]): LayerTarget[] {
  const chosen = new Set(ids)
  const targets: LayerTarget[] = []
  const covered = new Set<string>()

  // Whole families first. "Tambora" is what the room calls them; "wall-left"
  // is how they are wired, and a layer that says Wall Left / Wall Right where
  // it could have said Tambora has turned one artistic idea into two.
  const byType = new Map<string, string[]>()
  for (const fixture of patch.fixtures) {
    const list = byType.get(fixture.type) ?? []
    list.push(fixture.id)
    byType.set(fixture.type, list)
  }
  for (const [type, members] of byType) {
    if (members.every((id) => chosen.has(id))) {
      targets.push({ kind: 'family', key: type })
      for (const id of members) covered.add(id)
    }
  }

  // Then whole patch groups, for anything a family did not already cover --
  // which is how "the panels on stage left" stays one target instead of eight.
  const byGroup = new Map<string, string[]>()
  for (const fixture of patch.fixtures) {
    const list = byGroup.get(fixture.group) ?? []
    list.push(fixture.id)
    byGroup.set(fixture.group, list)
  }
  for (const [group, members] of byGroup) {
    if (members.length > 1 && members.every((id) => chosen.has(id)) && members.some((id) => !covered.has(id))) {
      targets.push({ kind: 'group', key: group })
      for (const id of members) covered.add(id)
    }
  }

  // Whatever is left is named.
  for (const id of ids) if (!covered.has(id)) targets.push({ kind: 'fixture', key: id })
  return targets
}
