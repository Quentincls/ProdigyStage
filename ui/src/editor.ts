// Edit-mode state shared between the timeline, the scene editor panel and the
// previz render loop. Mutable on purpose: the previz reads it at 60 fps, React
// components bump `version` after structural changes.

import { type BehaviorType } from '../../core/behaviors'
import { type ParamValue, type SceneSpec } from '../../core/effects'
import { layerMembers, type FixtureRef, type LightLayer } from '../../core/layers'

export const editor = {
  // Kept in sync with show.json by App.
  scenes: [] as SceneSpec[],
  // Light layers: the same show file, the other lane of the timeline.
  layers: [] as LightLayer[],
  /**
   * What the inspector is doing to the selection right now, before it has been
   * committed to anything.
   *
   * This is previewState, and it is deliberately not editorState: turning a
   * slider must light the room immediately, and must not have written a layer
   * into the show file that the operator never asked for. Committing is the
   * separate, explicit act of making a light layer out of it.
   *
   * It holds the behaviour rather than one frozen result, because a Wave has to
   * travel and a Chase has to run -- a preview that could not move would be
   * showing something the layer will never do.
   */
  preview: null as {
    ids: string[]
    behavior: BehaviorType
    params: Record<string, ParamValue>
    startedAt: number
  } | null,
  // Local preview: loops the given scene without external timecode.
  previewSceneId: null as string | null,
  playing: false,
  playStartedAt: 0, // performance.now() ms
  // Parked show time (seconds), null = not parked. Set by scrubbing or Pause.
  scrub: null as number | null,
  // Local playback: the show time runs on this machine's clock instead of the
  // console's, so the timeline can be reviewed with the console stopped.
  localFrom: null as number | null,
  localStartedAt: 0, // performance.now() ms
  version: 0,
}

// Membership per part, rebuilt only when the layers change: a Wave has to know
// how many fixtures it is travelling along, and recomputing that for seventy
// fixtures on every frame would be work done sixty times a second to get the
// same answer.
let membersVersion = -1
let membersByLayer = new Map<string, Map<string, string[]>>()

export function layerMembership(fixtures: FixtureRef[]): Map<string, Map<string, string[]>> {
  if (membersVersion !== editor.version) {
    membersVersion = editor.version
    membersByLayer = new Map()
    for (const layer of editor.layers) membersByLayer.set(layer.id, layerMembers(layer, fixtures))
  }
  return membersByLayer
}

/**
 * Start, or update, the live preview of what the inspector is doing.
 *
 * The clock is kept across parameter changes: dragging the speed of a running
 * wave should change its speed, not restart it from the beginning.
 */
export function setPreview(
  ids: string[],
  behavior: BehaviorType,
  params: Record<string, ParamValue>,
): void {
  const startedAt = editor.preview?.startedAt ?? performance.now()
  editor.preview = { ids, behavior, params, startedAt }
  editor.version++
}

export function clearPreview(): void {
  if (!editor.preview) return
  editor.preview = null
  editor.version++
}

// The single time authority for scene rendering:
// scene preview > local playback > parked time > console timecode.
export function effectiveShowTime(liveTime: number | null): number | null {
  if (editor.playing && editor.previewSceneId) {
    const scene = editor.scenes.find((s) => s.id === editor.previewSceneId)
    if (scene) {
      const duration = Math.max(0.1, scene.end - scene.start)
      return scene.start + (((performance.now() - editor.playStartedAt) / 1000) % duration)
    }
  }
  if (editor.localFrom !== null) {
    return editor.localFrom + (performance.now() - editor.localStartedAt) / 1000
  }
  if (editor.scrub !== null) return editor.scrub
  return liveTime
}

export function isTimeOverridden(): boolean {
  return (
    (editor.playing && editor.previewSceneId !== null) ||
    editor.scrub !== null ||
    editor.localFrom !== null
  )
}

export type Transport = 'live' | 'playing' | 'paused' | 'preview'

export function transportState(): Transport {
  if (editor.playing && editor.previewSceneId) return 'preview'
  if (editor.localFrom !== null) return 'playing'
  if (editor.scrub !== null) return 'paused'
  return 'live'
}

export function backToLive(): void {
  editor.playing = false
  editor.previewSceneId = null
  editor.scrub = null
  editor.localFrom = null
  editor.version++
}

export function startPreview(sceneId: string): void {
  editor.previewSceneId = sceneId
  editor.playing = true
  editor.playStartedAt = performance.now()
  editor.scrub = null
  editor.localFrom = null
  editor.version++
}

// Freeze time where it currently is -- the move you make before editing.
export function pauseAt(liveTime: number | null): void {
  const now = effectiveShowTime(liveTime)
  editor.playing = false
  editor.previewSceneId = null
  editor.localFrom = null
  editor.scrub = Math.max(0, now ?? 0)
  editor.version++
}

// Run the timeline on this machine's clock, from wherever we are parked.
export function playLocal(liveTime: number | null): void {
  const from = effectiveShowTime(liveTime) ?? 0
  editor.playing = false
  editor.previewSceneId = null
  editor.scrub = null
  editor.localFrom = Math.max(0, from)
  editor.localStartedAt = performance.now()
  editor.version++
}

export function seekTo(seconds: number): void {
  const wasPlaying = editor.localFrom !== null
  editor.playing = false
  editor.previewSceneId = null
  if (wasPlaying) {
    editor.localFrom = Math.max(0, seconds)
    editor.localStartedAt = performance.now()
    editor.scrub = null
  } else {
    editor.scrub = Math.max(0, seconds)
    editor.localFrom = null
  }
  editor.version++
}
