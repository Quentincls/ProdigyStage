// Edit-mode state shared between the timeline, the scene editor panel and the
// previz render loop. Mutable on purpose: the previz reads it at 60 fps, React
// components bump `version` after structural changes.

import { type SceneSpec } from '../../core/effects'

export const editor = {
  // Kept in sync with show.json by App.
  scenes: [] as SceneSpec[],
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
