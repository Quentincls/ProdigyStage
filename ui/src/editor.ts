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
  // Mouse scrub on the timeline ruler (seconds of show time), null = none.
  scrub: null as number | null,
  version: 0,
}

// The single time authority for scene rendering: preview loop > scrub > live.
export function effectiveShowTime(liveTime: number | null): number | null {
  if (editor.playing && editor.previewSceneId) {
    const scene = editor.scenes.find((s) => s.id === editor.previewSceneId)
    if (scene) {
      const duration = Math.max(0.1, scene.end - scene.start)
      return scene.start + (((performance.now() - editor.playStartedAt) / 1000) % duration)
    }
  }
  if (editor.scrub !== null) return editor.scrub
  return liveTime
}

export function isTimeOverridden(): boolean {
  return (editor.playing && editor.previewSceneId !== null) || editor.scrub !== null
}

export function backToLive(): void {
  editor.playing = false
  editor.previewSceneId = null
  editor.scrub = null
  editor.version++
}

export function startPreview(sceneId: string): void {
  editor.previewSceneId = sceneId
  editor.playing = true
  editor.playStartedAt = performance.now()
  editor.scrub = null
  editor.version++
}
