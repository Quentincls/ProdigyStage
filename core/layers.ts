// A light layer: one artistic intention, placed in the show.
//
//     RED IMPACT   20:32 -> 20:47
//       Tambora   Wave
//       Beams     Converge
//       Blinders  Hit
//
// One entry on the timeline, however many families it drives. The timeline
// never grows a track per fixture, and it never grows a track per family
// either -- a layer is one block that can be opened when you want to see what
// is inside it and closed again when you do not.
//
// Overrides are not a separate mechanism. A part that targets one fixture beats
// a part that targets its group, which beats a part that targets its family --
// so an exception is just a more specific part, and a fixture appears by name
// in the interface exactly when it is one.
//
// Pure and deterministic against show time, like everything in /core.

import {
  blankIntent,
  renderBehavior,
  type BehaviorType,
  type FixtureIntent,
} from './behaviors.js'
import type { ParamValue } from './effects.js'

/**
 * What a part drives.
 *
 * - `family` — every fixture of one model: `family:bpanel-3ch`
 * - `group`  — every fixture in one patch group: `group:wall-left`
 * - `fixture`— one fixture by id: `fixture:PL3`
 *
 * Three kinds rather than a free-form selector because the specificity order
 * between them is what makes overrides work without a second concept.
 */
export type TargetKind = 'family' | 'group' | 'fixture'

export interface LayerTarget {
  kind: TargetKind
  key: string
}

export interface LayerPart {
  id: string
  target: LayerTarget
  behavior: BehaviorType
  params: Record<string, ParamValue>
  fadeIn: number
  fadeOut: number
}

export interface LightLayer {
  id: string
  name: string
  /** Seconds of show timecode. */
  start: number
  end: number
  parts: LayerPart[]
}

export function layerActiveAt(layer: LightLayer, showTime: number): boolean {
  return showTime >= layer.start && showTime < layer.end
}

/** How far in, 0-1, through the fades at either end. */
export function partAmplitude(part: LayerPart, layer: LightLayer, showTime: number): number {
  const into = showTime - layer.start
  const left = layer.end - showTime
  let amplitude = 1
  if (part.fadeIn > 0) amplitude = Math.min(amplitude, into / part.fadeIn)
  if (part.fadeOut > 0) amplitude = Math.min(amplitude, left / part.fadeOut)
  return Math.max(0, Math.min(1, amplitude))
}

/** Higher wins. The whole override mechanism, in three numbers. */
const SPECIFICITY: Record<TargetKind, number> = { family: 1, group: 2, fixture: 3 }

export function targetKey(target: LayerTarget): string {
  return `${target.kind}:${target.key}`
}

export function parseTargetKey(key: string): LayerTarget | null {
  const at = key.indexOf(':')
  if (at < 0) return null
  const kind = key.slice(0, at)
  if (kind !== 'family' && kind !== 'group' && kind !== 'fixture') return null
  return { kind, key: key.slice(at + 1) }
}

/** Everything a part needs to know about the fixture it is driving. */
export interface FixtureRef {
  id: string
  /** The patch's fixtureType id. */
  type: string
  group: string
}

export function partMatches(part: LayerPart, fixture: FixtureRef): boolean {
  switch (part.target.kind) {
    case 'family':
      return part.target.key === fixture.type
    case 'group':
      return part.target.key === fixture.group
    case 'fixture':
      return part.target.key === fixture.id
  }
}

/**
 * The part that actually drives a fixture, out of all the parts that mention
 * it: the most specific one, and the later one when two are equally specific.
 */
export function partFor(layer: LightLayer, fixture: FixtureRef): LayerPart | null {
  let best: LayerPart | null = null
  let bestScore = -1
  for (const part of layer.parts) {
    if (!partMatches(part, fixture)) continue
    const score = SPECIFICITY[part.target.kind]
    if (score >= bestScore) {
      best = part
      bestScore = score
    }
  }
  return best
}

/** The active layer at an instant. Later layers win on overlap, as scenes do. */
export function activeLayer(layers: LightLayer[], showTime: number): LightLayer | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layerActiveAt(layers[i], showTime)) return layers[i]
  }
  return null
}

/**
 * Where a fixture sits inside the set its part is driving.
 *
 * A Wave has to travel along something, and that something is the group the
 * part targets -- ordered the way the room is, which for this plot means by the
 * number in the fixture id. Computed once per layer rather than per frame.
 */
export function partMembers(layer: LightLayer, part: LayerPart, fixtures: FixtureRef[]): string[] {
  return fixtures
    .filter((fixture) => partMatches(part, fixture) && partFor(layer, fixture)?.id === part.id)
    .map((fixture) => fixture.id)
}

export interface LayerEvaluation {
  layer: LightLayer
  part: LayerPart
  /** Position of this fixture inside its part's members, 0-1. */
  pos: number
  index: number
  count: number
}

/**
 * What a layer asks of one fixture at one instant, or null when no layer
 * mentions it -- which is the difference between "Stage wants this dark" and
 * "Stage has nothing to say, leave the console alone".
 *
 * `members` is the precomputed membership map, keyed by part id.
 */
export function renderLayerIntent(
  layer: LightLayer,
  fixture: FixtureRef,
  members: Map<string, string[]>,
  showTime: number,
  out: FixtureIntent = blankIntent(),
): FixtureIntent | null {
  if (!layerActiveAt(layer, showTime)) return null
  const part = partFor(layer, fixture)
  if (!part) return null

  const list = members.get(part.id) ?? [fixture.id]
  const index = Math.max(0, list.indexOf(fixture.id))
  const count = Math.max(1, list.length)
  renderBehavior(
    part.behavior,
    part.params,
    { index, count, pos: count > 1 ? index / (count - 1) : 0.5, time: showTime - layer.start },
    out,
  )

  const amplitude = partAmplitude(part, layer, showTime)
  if (amplitude < 1) {
    out.intensity *= amplitude
    if (out.fog !== null) out.fog *= amplitude
  }
  return out
}

/** Membership for every part of a layer, computed once when the layer changes. */
export function layerMembers(layer: LightLayer, fixtures: FixtureRef[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const part of layer.parts) map.set(part.id, partMembers(layer, part, fixtures))
  return map
}
