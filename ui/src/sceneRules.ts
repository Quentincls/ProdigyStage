// The product rule that keeps the timeline readable: scenes NEVER overlap.
// One lane, magnetic edges (Final Cut-style), so at any instant at most one
// scene replaces the console. All mutations funnel through these helpers.

import type { SceneSpec } from '../../core/effects'
import { round1 } from './TimeInput'

export const MIN_SCENE_SECONDS = 1
const SNAP_SECONDS = 0.5
const MIN_SLOT_SECONDS = 5

// Closest neighbors around a scene's original position.
function neighborBounds(
  scenes: SceneSpec[],
  sceneId: string,
  refStart: number,
  refEnd: number,
): { prevEnd: number; nextStart: number } {
  let prevEnd = 0
  let nextStart = Infinity
  for (const scene of scenes) {
    if (scene.id === sceneId) continue
    if (scene.end <= refStart + 0.001 && scene.end > prevEnd) prevEnd = scene.end
    if (scene.start >= refEnd - 0.001 && scene.start < nextStart) nextStart = scene.start
  }
  return { prevEnd, nextStart }
}

export function clampMove(
  scenes: SceneSpec[],
  sceneId: string,
  origStart: number,
  origEnd: number,
  newStart: number,
): number {
  const duration = origEnd - origStart
  const { prevEnd, nextStart } = neighborBounds(scenes, sceneId, origStart, origEnd)
  let start = Math.max(prevEnd, Math.min(newStart, nextStart - duration))
  if (Math.abs(start - prevEnd) < SNAP_SECONDS) start = prevEnd
  if (Math.abs(start + duration - nextStart) < SNAP_SECONDS) start = nextStart - duration
  return round1(Math.max(0, start))
}

export function clampTrimStart(
  scenes: SceneSpec[],
  sceneId: string,
  origStart: number,
  origEnd: number,
  newStart: number,
): number {
  const { prevEnd } = neighborBounds(scenes, sceneId, origStart, origEnd)
  let start = Math.max(prevEnd, Math.min(newStart, origEnd - MIN_SCENE_SECONDS))
  if (Math.abs(start - prevEnd) < SNAP_SECONDS) start = prevEnd
  return round1(Math.max(0, start))
}

export function clampTrimEnd(
  scenes: SceneSpec[],
  sceneId: string,
  origStart: number,
  origEnd: number,
  newEnd: number,
): number {
  const { nextStart } = neighborBounds(scenes, sceneId, origStart, origEnd)
  let end = Math.min(nextStart, Math.max(newEnd, origStart + MIN_SCENE_SECONDS))
  if (Math.abs(end - nextStart) < SNAP_SECONDS) end = nextStart
  return round1(end)
}

// First valid non-overlapping slot at or after desiredStart (creation and
// duplication). Skips gaps that are too small.
export function findFreeSlot(
  scenes: SceneSpec[],
  desiredStart: number,
  desiredDuration = 60,
): { start: number; end: number } {
  const sorted = [...scenes].sort((a, b) => a.start - b.start)
  let start = Math.max(0, desiredStart)
  for (const scene of sorted) {
    if (start + MIN_SLOT_SECONDS <= scene.start) break
    if (start < scene.end) start = scene.end
  }
  const next = sorted.find((scene) => scene.start >= start + 0.001)
  const end = Math.min(start + desiredDuration, next ? next.start : start + desiredDuration)
  return { start: round1(start), end: round1(end) }
}
