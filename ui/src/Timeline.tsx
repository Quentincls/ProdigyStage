// The show's timeline: the editor's centre of gravity, not a widget parked at
// the bottom of the screen.
//
// Layout follows an NLE rather than a dashboard: one toolbar carrying the
// transport, the position and the actions, then a track gutter naming the
// lanes, then the lanes themselves. Sections are the show's structure and are
// drawn as structure -- a thin, quiet band. Scenes are the material and are
// drawn as material -- solid blocks carrying their look's colour.
//
// The canvas is painted in a rAF loop reading feed.timecode directly; React
// only renders the chrome, at interaction rate.

import { useEffect, useMemo, useRef, useState } from 'react'
import { activeScene, hexToRgb, type SceneSpec } from '../../core/effects'
import {
  backToLive,
  editor,
  effectiveShowTime,
  isTimeOverridden,
  pauseAt,
  playLocal,
  seekTo,
  transportState,
} from './editor'
import { feed } from './feed'
import { theme } from './theme'
import { clampMove, clampTrimEnd, clampTrimStart } from './sceneRules'
import { type Marker, type ShowFile } from './show'
import { formatTime, pad, round1, TimeInput } from './TimeInput'
import { countLoop, countRender } from './perf'

interface TimelineProps {
  show: ShowFile
  mode: 'watch' | 'edit'
  onChange: (show: ShowFile) => void
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  selectedSceneId: string | null
  onSelectScene: (id: string | null) => void
  onAddScene: (start: number) => void
}

const RULER_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

// The track gutter: lane names live here instead of floating over the lanes
// they name. It is also what makes the two lanes read as a hierarchy.
const GUTTER = 84
const RULER_H = 24
const SECTION_TOP = 30
const SECTION_BOTTOM = 52
const SCENE_TOP = 60
const SCENE_BAND_MAX = 150
const EDGE_PX = 6
// How close to the playhead counts as grabbing it. Matches the trim handles,
// and is what makes the line itself draggable instead of the ruler only.
const PLAYHEAD_GRAB_PX = 8

export default function Timeline({
  show,
  mode,
  onChange,
  saveState,
  selectedSceneId,
  onSelectScene,
  onAddScene,
}: TimelineProps) {
  countRender('Timeline')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const minimapRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const tcRef = useRef<HTMLSpanElement>(null)
  const tcSubRef = useRef<HTMLSpanElement>(null)
  const nowPlayingRef = useRef<HTMLSpanElement>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [, setOverridden] = useState(false)
  const fitRef = useRef<() => void>(() => {})
  const zoomRef = useRef<(factor: number) => void>(() => {})

  // Dock height: how much room the timeline deserves depends on the show and
  // the screen, so it is the operator's call. Kept across sessions.
  const [dockHeight, setDockHeight] = useState(readDockHeight)
  const [resizing, setResizing] = useState(false)

  function startResize(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = dockHeight
    const grip = event.currentTarget
    grip.setPointerCapture(event.pointerId)
    setResizing(true)
    let height = startHeight
    const onMove = (move: PointerEvent): void => {
      // Dragging up grows the dock, which is the direction that feels right
      // for a panel anchored to the bottom.
      height = clampDockHeight(startHeight - (move.clientY - startY))
      setDockHeight(height)
    }
    const onUp = (): void => {
      grip.removeEventListener('pointermove', onMove)
      grip.removeEventListener('pointerup', onUp)
      setResizing(false)
      try {
        localStorage.setItem(DOCK_HEIGHT_KEY, String(height))
      } catch {
        // Private browsing or a locked-down profile: not worth failing over.
      }
    }
    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', onUp)
  }

  // Mutable state read by the draw loop and the pointer handlers.
  const view = useRef({ start: -5, pxPerSec: 6, followPausedUntil: 0 })
  const markersRef = useRef(show.markers)
  markersRef.current = show.markers
  const scenesRef = useRef(show.scenes)
  scenesRef.current = show.scenes
  const showRef = useRef(show)
  showRef.current = show
  const modeRef = useRef(mode)
  modeRef.current = mode
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId
  const selectedSceneRef = useRef(selectedSceneId)
  selectedSceneRef.current = selectedSceneId
  const onSelectSceneRef = useRef(onSelectScene)
  onSelectSceneRef.current = onSelectScene
  const replayingRef = useRef(false)
  replayingRef.current = feed.stats?.replay.replaying ?? false
  // Where the draw loop last put the playhead, so the pointer handlers can hit
  // it without recomputing the time it stands for.
  const playheadXRef = useRef<number | null>(null)

  useEffect(() => {
    const poll = setInterval(() => setOverridden(isTimeOverridden()), 400)
    return () => clearInterval(poll)
  }, [])

  // Leaving edit mode clears marker selection.
  useEffect(() => {
    if (mode === 'watch') setSelectedId(null)
  }, [mode])

  const selected = useMemo(
    () => show.markers.find((marker) => marker.id === selectedId) ?? null,
    [show, selectedId],
  )

  useEffect(() => {
    const canvas = canvasRef.current!
    const wrap = wrapRef.current!

    // Time lives to the right of the gutter; everything left of it is chrome.
    const timeAt = (x: number) => view.current.start + (x - GUTTER) / view.current.pxPerSec
    const xOf = (t: number) => GUTTER + (t - view.current.start) * view.current.pxPerSec

    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      countLoop('timeline', drawFrame)
    }
    const drawFrame = () => {
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (width === 0) return
      const laneWidth = width - GUTTER
      const dpr = Math.min(devicePixelRatio, 2)
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr
        canvas.height = height * dpr
      }
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const tc = feed.timecode
      const state = view.current
      const liveTime = tc.receiving ? tc.total : null
      const showTime = effectiveShowTime(liveTime)
      const timeOverridden = isTimeOverridden()

      // Follow the playhead unless the user recently panned/zoomed.
      if (showTime !== null && performance.now() > state.followPausedUntil) {
        const x = xOf(showTime)
        if (x > GUTTER + laneWidth * 0.88 || x < GUTTER) {
          state.start = showTime - (laneWidth * 0.15) / state.pxPerSec
        }
      }

      ctx.clearRect(0, 0, width, height)

      const sceneBottom = Math.min(height - 4, SCENE_TOP + SCENE_BAND_MAX)

      // Everything time-based is clipped to the lanes, so nothing ever slides
      // under the gutter.
      ctx.save()
      ctx.beginPath()
      ctx.rect(GUTTER, 0, laneWidth, height)
      ctx.clip()

      // Ruler: times in the same face the clock uses, and a grid quiet enough
      // to be read past rather than read.
      const step = RULER_STEPS.find((s) => s * state.pxPerSec >= 76) ?? 3600
      ctx.font = '10px "JetBrains Mono", Consolas, monospace'
      ctx.textBaseline = 'top'
      const first = Math.floor(state.start / step) * step
      for (let t = first; xOf(t) < width; t += step) {
        const x = Math.round(xOf(t)) + 0.5
        // The show starts at 0: formatTime clamps negatives, so ticks before
        // the start all read "0:00" and stack up on the left.
        if (x < GUTTER || t < 0) continue
        ctx.strokeStyle = rgba(theme.text, 0.035)
        ctx.beginPath()
        ctx.moveTo(x, SECTION_TOP)
        ctx.lineTo(x, height)
        ctx.stroke()
        ctx.fillStyle = rgba(theme.text, 0.35)
        ctx.fillText(formatTime(t), x + 6, 7)
      }

      // Sections: the show's chapters. Numbered, spanning, and dividing --
      // their boundaries run the full height of the lanes, so the scenes below
      // read as belonging to a chapter rather than as a flat sequence.
      drawSections(ctx, width, sceneBottom)

      // Scenes: the material. Neutral until they matter -- an inactive scene
      // states its colour in a single line, the selected one wears it.
      drawScenes(ctx, width, sceneBottom, showTime)

      // First-time hint.
      if (modeRef.current === 'edit' && scenesRef.current.length === 0) {
        ctx.fillStyle = rgba(theme.textDim, 0.8)
        ctx.font = '12px Inter, sans-serif'
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'center'
        ctx.fillText(
          'Add a scene to take the lights over for a moment of the show',
          GUTTER + laneWidth / 2,
          (SCENE_TOP + sceneBottom) / 2,
        )
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
      }

      replayingRef.current = feed.stats?.replay.replaying ?? false

      // Playhead: green live, orange replay, violet parked. It carries a head
      // in the ruler -- a line one pixel wide reads as decoration, and nobody
      // thinks to drag it.
      playheadXRef.current = showTime === null ? null : xOf(showTime)
      if (showTime !== null) {
        const x = Math.round(xOf(showTime)) + 0.5
        if (x >= GUTTER - 12 && x <= width + 12) {
          const color = timeOverridden ? theme.edit : replayingRef.current ? theme.warn : theme.ok
          ctx.strokeStyle = color
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(x, RULER_H - 6)
          ctx.lineTo(x, height)
          ctx.stroke()

          ctx.fillStyle = color
          const headWidth = 20
          const headHeight = RULER_H - 7
          roundedRect(ctx, x - headWidth / 2, 2, headWidth, headHeight, 3)
          ctx.fill()
          ctx.strokeStyle = rgba(theme.panel, 0.9)
          ctx.beginPath()
          ctx.moveTo(x - 3, 6)
          ctx.lineTo(x - 3, headHeight - 1)
          ctx.moveTo(x + 3, 6)
          ctx.lineTo(x + 3, headHeight - 1)
          ctx.stroke()
        }
      }
      ctx.restore()

      drawGutter(ctx, height)

      // Timecode readout (imperative, outside React).
      if (tcRef.current) {
        if (timeOverridden && showTime !== null) {
          const s = Math.floor(showTime)
          const frames = Math.floor((showTime - s) * tc.fps)
          tcRef.current.textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}:${pad(frames)}`
        } else {
          tcRef.current.textContent = tc.receiving
            ? `${pad(tc.hours)}:${pad(tc.minutes)}:${pad(tc.seconds)}:${pad(tc.frames)}`
            : '--:--:--:--'
        }
      }
      if (tcSubRef.current) {
        // Same words as the transport buttons, so the readout never invents
        // vocabulary of its own.
        const transport = transportState()
        tcSubRef.current.textContent =
          transport === 'preview'
            ? 'preview loop'
            : transport === 'playing'
              ? 'playing'
              : transport === 'paused'
                ? 'paused'
                : tc.receiving
                  ? `${tc.fps} fps · ${replayingRef.current ? 'replay' : 'live'}`
                  : 'no timecode'
      }
      if (nowPlayingRef.current) {
        const playing = showTime !== null ? activeScene(editor.scenes, showTime) : null
        const label = playing ? playing.name : ''
        if (nowPlayingRef.current.textContent !== label) nowPlayingRef.current.textContent = label
      }

      drawMinimap(showTime, timeOverridden, laneWidth)
    }
    draw()

    // Full-show extent used by the minimap and the Fit button. Function
    // declaration on purpose: draw() runs synchronously before this line.
    function extentOf(): number {
      let end = 600
      for (const scene of scenesRef.current) end = Math.max(end, scene.end)
      for (const marker of markersRef.current) end = Math.max(end, marker.end)
      if (feed.timecode.receiving) end = Math.max(end, feed.timecode.total)
      return end + 60
    }

    fitRef.current = () => {
      const extent = extentOf()
      const laneWidth = canvas.clientWidth - GUTTER
      if (laneWidth <= 0) return
      view.current.pxPerSec = clamp(laneWidth / extent, 0.05, 400)
      view.current.start = 0
      view.current.followPausedUntil = performance.now() + 4000
    }

    // Zoom around the centre of the view: the keyboard-free way to do what the
    // wheel does, for anyone on a trackpad or a touchscreen.
    zoomRef.current = (factor: number) => {
      const laneWidth = canvas.clientWidth - GUTTER
      if (laneWidth <= 0) return
      const centre = view.current.start + laneWidth / 2 / view.current.pxPerSec
      view.current.pxPerSec = clamp(view.current.pxPerSec * factor, 0.05, 400)
      view.current.start = centre - laneWidth / 2 / view.current.pxPerSec
      view.current.followPausedUntil = performance.now() + 4000
    }

    // ----- painting ---------------------------------------------------------

    function drawGutter(ctx: CanvasRenderingContext2D, height: number): void {
      ctx.fillStyle = theme.panel
      ctx.fillRect(0, 0, GUTTER, height)
      ctx.strokeStyle = rgba(theme.text, 0.08)
      ctx.beginPath()
      ctx.moveTo(GUTTER - 0.5, 0)
      ctx.lineTo(GUTTER - 0.5, height)
      ctx.stroke()

      // Two names, and the indent says which contains which. Chapters first,
      // the material they hold underneath and set in.
      ctx.font = '9px Inter, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      ctx.fillStyle = rgba(theme.text, 0.55)
      ctx.fillText('SECTIONS', 14, (SECTION_TOP + SECTION_BOTTOM) / 2)
      ctx.fillStyle = rgba(theme.text, 0.3)
      ctx.fillText('SCENES', 24, SCENE_TOP + 10)
      ctx.textBaseline = 'top'
    }

    function drawSections(ctx: CanvasRenderingContext2D, width: number, bottom: number): void {
      const y = SECTION_TOP
      const h = SECTION_BOTTOM - SECTION_TOP
      const ordered = [...markersRef.current].sort((a, b) => a.start - b.start)
      for (const [index, marker] of ordered.entries()) {
        const x1 = xOf(marker.start)
        const x2 = xOf(marker.end)
        if (x2 < GUTTER || x1 > width) continue
        const isSelected = marker.id === selectedRef.current
        const w = Math.max(2, x2 - x1)

        // The chapter's boundary, carried down through the scenes: this is what
        // makes a section feel like it contains the show rather than sit above
        // it. Faint by design -- it is a division, not an object.
        ctx.strokeStyle = rgba(theme.text, isSelected ? 0.22 : 0.1)
        ctx.beginPath()
        ctx.moveTo(Math.round(x1) + 0.5, y)
        ctx.lineTo(Math.round(x1) + 0.5, bottom)
        ctx.moveTo(Math.round(x2) + 0.5, y)
        ctx.lineTo(Math.round(x2) + 0.5, bottom)
        ctx.stroke()

        // The chapter's own band: a rule it hangs from, and its title on it.
        ctx.fillStyle = rgba(theme.text, isSelected ? 0.07 : 0.028)
        ctx.fillRect(x1, y, w, h)
        ctx.fillStyle = isSelected ? rgba(theme.text, 0.55) : rgba(theme.text, 0.22)
        ctx.fillRect(x1, y, w, 1)

        ctx.save()
        ctx.beginPath()
        ctx.rect(x1 + 2, y, Math.max(0, w - 4), h)
        ctx.clip()
        // Numbered like chapters, because that is what they are. The number is
        // the constant; the name is whatever the show calls that moment.
        ctx.textBaseline = 'middle'
        const midY = y + h / 2 + 1
        ctx.font = '10px "JetBrains Mono", Consolas, monospace'
        ctx.fillStyle = isSelected ? rgba(theme.text, 0.85) : rgba(theme.text, 0.3)
        const number = String(index + 1).padStart(2, '0')
        ctx.fillText(number, x1 + 9, midY)
        ctx.font = '10px Inter, sans-serif'
        ctx.fillStyle = isSelected ? theme.text : rgba(theme.text, 0.5)
        ctx.fillText(marker.name.toUpperCase(), x1 + 30, midY)
        ctx.restore()
        ctx.textBaseline = 'top'

        // Grips only on the selected chapter: nothing to grab means nothing to
        // catch by accident.
        if (isSelected) {
          ctx.fillStyle = rgba(theme.text, 0.7)
          ctx.fillRect(x1, y, 2, h)
          ctx.fillRect(x2 - 2, y, 2, h)
        }
      }
    }

    // Colour carries one meaning here: this is the light this scene puts in the
    // room. A row of blocks each shouting its own hue is decoration, and it
    // makes the timeline unreadable at a glance -- so an idle scene states its
    // colour in a single stripe and stays graphite, the scene under the
    // playhead lifts, and the selected one wears its colour outright.
    function drawScenes(
      ctx: CanvasRenderingContext2D,
      width: number,
      bottom: number,
      showTime: number | null,
    ): void {
      const top = SCENE_TOP
      const h = bottom - top
      if (h <= 0) return
      for (const scene of scenesRef.current) {
        const x1 = xOf(scene.start)
        const x2 = xOf(scene.end)
        if (x2 < GUTTER || x1 > width) continue
        const isSelected = scene.id === selectedSceneRef.current
        const isPlaying =
          showTime !== null && showTime >= scene.start && showTime < scene.end && !isSelected
        const tint = sceneTint(scene) ?? theme.edit
        const w = Math.max(2, x2 - x1)

        if (isSelected) {
          const wash = ctx.createLinearGradient(0, top, 0, bottom)
          wash.addColorStop(0, rgba(tint, 0.34))
          wash.addColorStop(1, rgba(tint, 0.07))
          ctx.fillStyle = wash
        } else {
          ctx.fillStyle = rgba(theme.text, isPlaying ? 0.08 : 0.035)
        }
        roundedRect(ctx, x1, top, w, h, 3)
        ctx.fill()
        ctx.strokeStyle = isSelected
          ? rgba(tint, 0.9)
          : rgba(theme.text, isPlaying ? 0.28 : 0.09)
        ctx.stroke()

        // The signature: the scene's colour, once, at the edge it starts on.
        ctx.fillStyle = rgba(tint, isSelected ? 1 : isPlaying ? 0.85 : 0.6)
        ctx.fillRect(x1 + 1, top + 1, isSelected ? 3 : 2, h - 2)

        if (isSelected) {
          ctx.fillStyle = rgba(tint, 0.95)
          const notch = top + h / 2 - 7
          ctx.fillRect(x2 - 4.5, notch, 3, 14)
        }

        ctx.save()
        ctx.beginPath()
        ctx.rect(x1 + 2, top, Math.max(0, w - 4), h)
        ctx.clip()
        ctx.textBaseline = 'top'
        ctx.font = isSelected || isPlaying ? '500 11px Inter, sans-serif' : '11px Inter, sans-serif'
        ctx.fillStyle = isSelected || isPlaying ? theme.text : rgba(theme.text, 0.58)
        ctx.fillText(scene.name, x1 + 11, top + 9)
        // Duration only when the block can hold it without crowding the name.
        if (w > 130 && h > 34) {
          ctx.font = '10px "JetBrains Mono", Consolas, monospace'
          ctx.fillStyle = rgba(theme.text, isSelected ? 0.5 : 0.3)
          ctx.fillText(formatDuration(scene.end - scene.start), x1 + 11, top + 26)
        }
        ctx.restore()
      }
    }

    function drawMinimap(showTime: number | null, timeOverridden: boolean, laneWidth: number): void {
      const minimap = minimapRef.current
      if (!minimap) return
      const w = minimap.clientWidth
      const h = minimap.clientHeight
      if (w === 0) return
      const dpr = Math.min(devicePixelRatio, 2)
      if (minimap.width !== w * dpr || minimap.height !== h * dpr) {
        minimap.width = w * dpr
        minimap.height = h * dpr
      }
      const mctx = minimap.getContext('2d')!
      mctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      mctx.clearRect(0, 0, w, h)
      const extent = extentOf()
      const mx = (t: number) => (t / extent) * w

      // Same reading as the lanes above, in miniature: chapters as faint
      // grounds, scenes as their own colour -- this is the one place where the
      // colours are worth stating together, because finding a scene fast is
      // exactly what the strip is for.
      for (const marker of markersRef.current) {
        mctx.fillStyle = rgba(theme.text, 0.07)
        mctx.fillRect(mx(marker.start), 0, Math.max(1, mx(marker.end) - mx(marker.start)), h)
      }
      for (const scene of scenesRef.current) {
        const selected = scene.id === selectedSceneRef.current
        mctx.fillStyle = rgba(sceneTint(scene) ?? theme.edit, selected ? 1 : 0.62)
        mctx.fillRect(mx(scene.start), h / 2 - 2, Math.max(2, mx(scene.end) - mx(scene.start)), 4)
      }
      if (showTime !== null) {
        mctx.fillStyle = timeOverridden ? theme.edit : replayingRef.current ? theme.warn : theme.ok
        mctx.fillRect(mx(showTime) - 0.75, 0, 1.5, h)
      }
      const state = view.current
      const vx1 = mx(state.start)
      const vx2 = mx(state.start + laneWidth / state.pxPerSec)
      mctx.fillStyle = rgba(theme.text, 0.07)
      mctx.strokeStyle = rgba(theme.text, 0.35)
      mctx.fillRect(vx1, 0.5, Math.max(8, vx2 - vx1), h - 1)
      mctx.strokeRect(vx1 + 0.5, 0.5, Math.max(8, vx2 - vx1), h - 1)
    }

    // ----- interactions -----------------------------------------------------
    // Direct manipulation, borrowed from video editors: drag a scene to move
    // it, drag its edges to trim, grab the playhead anywhere, drag empty space
    // to pan. Wheel zooms, horizontal wheel pans.
    type Drag =
      | { type: 'pan'; x: number; viewStart: number; moved?: boolean; deselect?: boolean }
      | { type: 'scrub' }
      | { type: 'pending-scene'; x: number; sceneId: string; start: number; end: number }
      | { type: 'move' | 'trim-l' | 'trim-r'; x: number; sceneId: string; start: number; end: number }
      | { type: 'pending-marker'; x: number; markerId: string; start: number; end: number }
      | {
          type: 'marker-move' | 'marker-trim-l' | 'marker-trim-r'
          x: number
          markerId: string
          start: number
          end: number
        }
    let drag: Drag | null = null

    const sceneHit = (t: number, y: number): SceneSpec | null => {
      if (y < SCENE_TOP) return null
      const tolerance = EDGE_PX / view.current.pxPerSec
      return (
        [...scenesRef.current]
          .reverse()
          .find((scene) => t >= scene.start - tolerance && t <= scene.end + tolerance) ?? null
      )
    }
    const edgeOf = (scene: SceneSpec, t: number): 'trim-l' | 'trim-r' | null => {
      const tolerance = EDGE_PX / view.current.pxPerSec
      if (Math.abs(t - scene.start) <= tolerance) return 'trim-l'
      if (Math.abs(t - scene.end) <= tolerance) return 'trim-r'
      return null
    }
    const onPlayhead = (x: number): boolean => {
      const head = playheadXRef.current
      return head !== null && Math.abs(x - head) <= PLAYHEAD_GRAB_PX
    }
    const snap = (t: number): number => {
      const grid = view.current.pxPerSec >= 40 ? 0.1 : 1
      return Math.max(0, Math.round(t / grid) * grid)
    }
    const updateScene = (sceneId: string, update: Partial<SceneSpec>): void => {
      const current = showRef.current
      onChangeRef.current({
        ...current,
        scenes: current.scenes.map((scene) =>
          scene.id === sceneId ? { ...scene, ...update } : scene,
        ),
      })
    }
    const updateMarker = (markerId: string, update: Partial<Marker>): void => {
      const current = showRef.current
      onChangeRef.current({
        ...current,
        markers: current.markers.map((marker) =>
          marker.id === markerId ? { ...marker, ...update } : marker,
        ),
      })
    }
    // Grabbing the playhead always parks time under the pointer, whether we
    // were following the console or playing locally.
    const scrubTo = (clientX: number): void => {
      const rect = canvas.getBoundingClientRect()
      editor.playing = false
      editor.previewSceneId = null
      editor.localFrom = null
      editor.scrub = Math.max(0, timeAt(clientX - rect.left))
      editor.version++
      setOverridden(true)
    }

    const onPointerDown = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      const t = timeAt(x)
      // The gutter names the lanes; it is not a surface you edit on.
      if (x < GUTTER) return
      canvas.setPointerCapture(event.pointerId)

      if (modeRef.current === 'watch' || event.shiftKey) {
        drag = { type: 'pan', x: event.clientX, viewStart: view.current.start }
        return
      }
      // The playhead comes first, at any height: it is the control the operator
      // reaches for most. A scene edge sitting exactly under it can still be
      // trimmed -- move the playhead off it first.
      if (onPlayhead(x) || y < RULER_H) {
        drag = { type: 'scrub' }
        scrubTo(event.clientX)
        return
      }
      // Sections move and trim like scenes, and a plain click travels to one.
      if (y >= SECTION_TOP && y <= SECTION_BOTTOM) {
        const tolerance = EDGE_PX / view.current.pxPerSec
        const hit = [...markersRef.current]
          .reverse()
          .find((marker) => t >= marker.start - tolerance && t <= marker.end + tolerance)
        if (!hit) {
          setSelectedId(null)
          return
        }
        const edge =
          Math.abs(t - hit.start) <= tolerance
            ? 'marker-trim-l'
            : Math.abs(t - hit.end) <= tolerance
              ? 'marker-trim-r'
              : null
        drag = edge
          ? { type: edge, x: event.clientX, markerId: hit.id, start: hit.start, end: hit.end }
          : {
              type: 'pending-marker',
              x: event.clientX,
              markerId: hit.id,
              start: hit.start,
              end: hit.end,
            }
        return
      }
      const scene = sceneHit(t, y)
      if (scene) {
        const edge = edgeOf(scene, t)
        drag = edge
          ? { type: edge, x: event.clientX, sceneId: scene.id, start: scene.start, end: scene.end }
          : {
              type: 'pending-scene',
              x: event.clientX,
              sceneId: scene.id,
              start: scene.start,
              end: scene.end,
            }
        return
      }
      // Empty area: drag pans; a plain click deselects.
      drag = { type: 'pan', x: event.clientX, viewStart: view.current.start, deselect: true }
    }

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      if (!drag) {
        const x = event.clientX - rect.left
        if (x < GUTTER) {
          canvas.style.cursor = 'default'
          return
        }
        if (modeRef.current === 'edit') {
          const t = timeAt(x)
          const y = event.clientY - rect.top
          if (onPlayhead(x)) {
            canvas.style.cursor = 'ew-resize'
            return
          }
          const scene = sceneHit(t, y)
          const tolerance = EDGE_PX / view.current.pxPerSec
          const marker =
            y >= SECTION_TOP && y <= SECTION_BOTTOM
              ? [...markersRef.current]
                  .reverse()
                  .find((m) => t >= m.start - tolerance && t <= m.end + tolerance)
              : undefined
          canvas.style.cursor =
            y < RULER_H
              ? 'crosshair'
              : marker
                ? Math.abs(t - marker.start) <= tolerance || Math.abs(t - marker.end) <= tolerance
                  ? 'ew-resize'
                  : 'pointer'
                : scene && edgeOf(scene, t)
                  ? 'ew-resize'
                  : scene
                    ? 'pointer'
                    : 'grab'
        } else {
          canvas.style.cursor = 'grab'
        }
        return
      }
      const dt = (event.clientX - ('x' in drag ? drag.x : event.clientX)) / view.current.pxPerSec
      switch (drag.type) {
        case 'pan': {
          const dx = event.clientX - drag.x
          if (Math.abs(dx) > 4) drag.moved = true
          view.current.start = drag.viewStart - dx / view.current.pxPerSec
          view.current.followPausedUntil = performance.now() + 4000
          break
        }
        case 'scrub':
          scrubTo(event.clientX)
          break
        case 'pending-scene':
          if (Math.abs(event.clientX - drag.x) > 4) drag = { ...drag, type: 'move' }
          break
        case 'pending-marker':
          if (Math.abs(event.clientX - drag.x) > 4) drag = { ...drag, type: 'marker-move' }
          break
        case 'marker-move': {
          const duration = drag.end - drag.start
          const start = Math.max(0, snap(drag.start + dt))
          updateMarker(drag.markerId, { start, end: start + duration })
          break
        }
        case 'marker-trim-l': {
          const start = Math.min(snap(drag.start + dt), drag.end - 1)
          updateMarker(drag.markerId, { start: Math.max(0, start) })
          break
        }
        case 'marker-trim-r': {
          updateMarker(drag.markerId, { end: Math.max(snap(drag.end + dt), drag.start + 1) })
          break
        }
        case 'move': {
          const duration = drag.end - drag.start
          const start = clampMove(
            scenesRef.current,
            drag.sceneId,
            drag.start,
            drag.end,
            snap(drag.start + dt),
          )
          updateScene(drag.sceneId, { start, end: round1(start + duration) })
          break
        }
        case 'trim-l': {
          updateScene(drag.sceneId, {
            start: clampTrimStart(
              scenesRef.current,
              drag.sceneId,
              drag.start,
              drag.end,
              snap(drag.start + dt),
            ),
          })
          break
        }
        case 'trim-r': {
          updateScene(drag.sceneId, {
            end: clampTrimEnd(
              scenesRef.current,
              drag.sceneId,
              drag.start,
              drag.end,
              snap(drag.end + dt),
            ),
          })
          break
        }
      }
    }

    const onPointerUp = () => {
      if (drag?.type === 'pending-scene') {
        onSelectSceneRef.current(drag.sceneId)
        setSelectedId(null)
      } else if (drag?.type === 'pending-marker') {
        // Clicking a section is how you get to it -- that is what makes the
        // lane a table of contents rather than a row of labels.
        setSelectedId(drag.markerId)
        onSelectSceneRef.current(null)
        seekTo(drag.start)
        setOverridden(true)
      } else if (drag?.type === 'pan' && drag.deselect && !drag.moved) {
        onSelectSceneRef.current(null)
        setSelectedId(null)
      }
      drag = null
    }

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        view.current.start += event.deltaX / view.current.pxPerSec
        view.current.followPausedUntil = performance.now() + 4000
        return
      }
      const cursorX = Math.max(GUTTER, event.clientX - rect.left)
      const cursorTime = timeAt(cursorX)
      const factor = Math.pow(1.0015, -event.deltaY)
      view.current.pxPerSec = clamp(view.current.pxPerSec * factor, 0.05, 400)
      view.current.start = cursorTime - (cursorX - GUTTER) / view.current.pxPerSec
      view.current.followPausedUntil = performance.now() + 4000
    }

    // Minimap: drag the view window, or click outside it to jump there.
    const minimap = minimapRef.current!
    let minimapDrag: { grabOffset: number } | null = null
    const minimapTime = (clientX: number): number => {
      const rect = minimap.getBoundingClientRect()
      return ((clientX - rect.left) / rect.width) * extentOf()
    }
    const onMiniDown = (event: PointerEvent) => {
      minimap.setPointerCapture(event.pointerId)
      const t = minimapTime(event.clientX)
      const state = view.current
      const viewSeconds = (canvas.clientWidth - GUTTER) / state.pxPerSec
      if (t >= state.start && t <= state.start + viewSeconds) {
        minimapDrag = { grabOffset: t - state.start }
      } else {
        state.start = t - viewSeconds / 2
        minimapDrag = { grabOffset: viewSeconds / 2 }
      }
      state.followPausedUntil = performance.now() + 4000
    }
    const onMiniMove = (event: PointerEvent) => {
      if (!minimapDrag) return
      view.current.start = minimapTime(event.clientX) - minimapDrag.grabOffset
      view.current.followPausedUntil = performance.now() + 4000
    }
    const onMiniUp = () => {
      minimapDrag = null
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    minimap.addEventListener('pointerdown', onMiniDown)
    minimap.addEventListener('pointermove', onMiniMove)
    minimap.addEventListener('pointerup', onMiniUp)

    const observer = new ResizeObserver(() => {})
    observer.observe(wrap)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      minimap.removeEventListener('pointerdown', onMiniDown)
      minimap.removeEventListener('pointermove', onMiniMove)
      minimap.removeEventListener('pointerup', onMiniUp)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [])

  function viewCentre(): number {
    const canvas = canvasRef.current!
    return view.current.start + (canvas.clientWidth - GUTTER) / 2 / view.current.pxPerSec
  }

  function addSection(): void {
    const tc = feed.timecode
    const start = Math.max(0, tc.receiving ? tc.total : viewCentre())
    const marker: Marker = {
      id: crypto.randomUUID(),
      name: `Section ${show.markers.length + 1}`,
      start: round1(start),
      end: round1(start + 60),
    }
    onChange({ ...show, markers: [...show.markers, marker] })
    setSelectedId(marker.id)
  }

  function updateSelected(update: Partial<Marker>): void {
    if (!selected) return
    onChange({
      ...show,
      markers: show.markers.map((marker) =>
        marker.id === selected.id ? { ...marker, ...update } : marker,
      ),
    })
  }

  function deleteSelected(): void {
    if (!selected) return
    onChange({ ...show, markers: show.markers.filter((marker) => marker.id !== selected.id) })
    setSelectedId(null)
  }

  return (
    <footer className="timeline" style={{ height: dockHeight }}>
      <div
        className={`timeline-grip ${resizing ? 'dragging' : ''}`}
        title="Drag to resize the timeline"
        onPointerDown={startResize}
      />

      {/* One bar: where we are, what it is doing, and what can be done to it.
          The transport used to sit in a box of its own, which read as a
          separate module parked next to the timeline rather than part of it. */}
      <div className="timeline-bar">
        <Transport markers={show.markers} />
        <div className="tl-clock">
          <span className="tl-time" ref={tcRef}>
            --:--:--:--
          </span>
          <span className="tl-state" ref={tcSubRef}>
            no timecode
          </span>
        </div>
        <span className="tl-now" ref={nowPlayingRef} />
        <div className="tl-actions">
          <span className={`tl-save ${saveState}`}>
            {saveState === 'saving'
              ? 'saving'
              : saveState === 'saved'
                ? 'saved'
                : saveState === 'error'
                  ? 'save failed'
                  : ''}
          </span>
          {mode === 'edit' && (
            <>
              <button
                className="tl-action"
                onClick={() => {
                  const tc = feed.timecode
                  onAddScene(Math.max(0, round1(tc.receiving ? tc.total : viewCentre())))
                }}
                title="A scene takes the lights over for a moment of the show"
              >
                Scene
              </button>
              <button
                className="tl-action"
                onClick={addSection}
                title="A section is a chapter of the show. It never changes the lights."
              >
                Section
              </button>
              <span className="tl-sep" />
            </>
          )}
          <button className="tl-icon" title="Zoom out" onClick={() => zoomRef.current(1 / 1.5)}>
            −
          </button>
          <button className="tl-icon" title="Zoom in" onClick={() => zoomRef.current(1.5)}>
            +
          </button>
          <button className="tl-icon text" title="Fit the whole show" onClick={() => fitRef.current()}>
            Fit
          </button>
        </div>
      </div>

      {/* The show's table of contents. Aligned with the gutter so the list and
          the lane it summarises line up. */}
      {mode === 'edit' && (
        <div className="section-bar">
          {/* No heading here: the gutter directly below already names this lane,
              and the chapter numbers say what the row is. */}
          <div className="section-chips">
            {show.markers.length === 0 && (
              <span className="section-empty">
                No chapters yet — add a section to give the show its structure
              </span>
            )}
            {[...show.markers]
              .sort((a, b) => a.start - b.start)
              .map((marker, index) => (
                <button
                  key={marker.id}
                  className={`section-chip ${selectedId === marker.id ? 'active' : ''}`}
                  title={`Go to ${formatTime(marker.start)}`}
                  onClick={() => {
                    setSelectedId(marker.id)
                    onSelectScene(null)
                    seekTo(marker.start)
                    setOverridden(true)
                  }}
                >
                  <span className="section-chip-index">{String(index + 1).padStart(2, '0')}</span>
                  {marker.name}
                </button>
              ))}
          </div>
          {selected && (
            <div className="marker-editor">
              <input
                className="marker-name"
                value={selected.name}
                onChange={(e) => updateSelected({ name: e.target.value })}
              />
              <TimeInput value={selected.start} onCommit={(v) => updateSelected({ start: v })} />
              <span className="marker-editor-sep">→</span>
              <TimeInput value={selected.end} onCommit={(v) => updateSelected({ end: v })} />
              <button className="tl-icon" title="Delete this section" onClick={deleteSelected}>
                ✕
              </button>
            </div>
          )}
        </div>
      )}

      <div className="timeline-lanes" ref={wrapRef}>
        <canvas className="timeline-canvas" ref={canvasRef} />
      </div>
      <canvas className="timeline-minimap" ref={minimapRef} />
    </footer>
  )
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

const DOCK_HEIGHT_KEY = 'lumenstage.dockHeight'
const DOCK_MIN = 150
const DOCK_DEFAULT = 224
const DOCK_MAX = 360

// Never more than half the window, and never past the point where the extra
// height stops buying anything: the previz is what the screen is for.
function clampDockHeight(height: number): number {
  const ceiling = Math.max(DOCK_MIN, Math.min(DOCK_MAX, window.innerHeight * 0.5))
  return Math.round(clamp(height, DOCK_MIN, ceiling))
}

function readDockHeight(): number {
  try {
    const stored = Number(localStorage.getItem(DOCK_HEIGHT_KEY))
    if (Number.isFinite(stored) && stored > 0) return clampDockHeight(stored)
  } catch {
    // Storage unavailable: the default is fine.
  }
  return DOCK_DEFAULT
}

// The color of a scene's main look, used to tint its timeline block.
function sceneTint(scene: SceneSpec): string | null {
  const params = scene.tracks[0]?.params
  if (!params) return null
  const value = params.color ?? params.colorA
  return typeof value === 'string' ? value : null
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r},${g},${b},${alpha})`
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// Transport. The show normally runs on the console's timecode, but editing
// needs the timeline to hold still -- and to be reviewable with the console
// stopped. Three states, always visible: following the console (Live), parked,
// or playing on this machine's clock.
function Transport({ markers }: { markers: Marker[] }) {
  const [state, setState] = useState(transportState())
  const markersRef = useRef(markers)
  markersRef.current = markers

  // The editor store is mutable and read at 60 fps by the canvases; polling it
  // four times a second is enough to keep four buttons honest.
  useEffect(() => {
    const id = setInterval(() => setState(transportState()), 250)
    return () => clearInterval(id)
  }, [])

  const liveTime = (): number | null => (feed.timecode.receiving ? feed.timecode.total : null)
  const playing = state === 'playing' || state === 'preview'

  // Sections are the show's structure, so they are how you travel through it.
  const jumpSection = (direction: -1 | 1): void => {
    const now = effectiveShowTime(liveTime()) ?? 0
    const starts = markersRef.current.map((m) => m.start).sort((a, b) => a - b)
    const target =
      direction === 1
        ? starts.find((s) => s > now + 0.05)
        : [...starts].reverse().find((s) => s < now - 0.05)
    seekTo(target ?? (direction === 1 ? now : 0))
  }

  return (
    <div className="transport">
      <button className="transport-button" title="Previous section" onClick={() => jumpSection(-1)}>
        |◀
      </button>
      <button className="transport-button" title="Back to the start" onClick={() => seekTo(0)}>
        ◀◀
      </button>
      <button
        className="transport-button play"
        title={playing ? 'Pause' : 'Play the timeline'}
        onClick={() => (playing ? pauseAt(liveTime()) : playLocal(liveTime()))}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <button className="transport-button" title="Next section" onClick={() => jumpSection(1)}>
        ▶|
      </button>
      <button
        className={`transport-button live ${state === 'live' ? 'active' : ''}`}
        title="Follow the console again"
        onClick={() => backToLive()}
      >
        LIVE
      </button>
    </div>
  )
}
