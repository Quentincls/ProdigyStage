// Read-only show timeline (Phase 4): time ruler, live playhead driven by the
// Art-Net timecode, zoom/scroll, hand-placed section markers saved in
// data/show.json, and the run recorder / replayer controls.
// The canvas is drawn in a rAF loop reading feed.timecode directly; React only
// renders the chrome (buttons, selected-marker editor) at interaction rate.

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
const RULER_H = 22
const MARKER_TOP = 26
const MARKER_BOTTOM = 44
const SCENE_TOP = 48
// How close to the playhead counts as grabbing it. Matches the trim handles,
// and is what makes the line itself draggable instead of the ruler only.
const PLAYHEAD_GRAB_PX = 8
const SCENE_BAND_MAX = 170

export default function Timeline({
  show,
  mode,
  onChange,
  saveState,
  selectedSceneId,
  onSelectScene,
  onAddScene,
}: TimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const minimapRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const tcRef = useRef<HTMLSpanElement>(null)
  const tcSubRef = useRef<HTMLSpanElement>(null)
  const nowPlayingRef = useRef<HTMLSpanElement>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [, setOverridden] = useState(false)
  const fitRef = useRef<() => void>(() => {})

  // Dock height: the lanes were cramped at a fixed 132px, and how much room
  // the timeline deserves depends on the show and the screen. Kept across
  // sessions -- resizing it every night would be its own annoyance.
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

    const timeAt = (x: number) => view.current.start + x / view.current.pxPerSec
    const xOf = (t: number) => (t - view.current.start) * view.current.pxPerSec

    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (width === 0) return
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
        if (x > width * 0.88 || x < 0) state.start = showTime - (width * 0.15) / state.pxPerSec
      }

      ctx.clearRect(0, 0, width, height)

      // Ruler.
      const step = RULER_STEPS.find((s) => s * state.pxPerSec >= 72) ?? 3600
      ctx.font = '10px Inter, sans-serif'
      ctx.textBaseline = 'top'
      const first = Math.floor(state.start / step) * step
      for (let t = first; xOf(t) < width; t += step) {
        const x = Math.round(xOf(t)) + 0.5
        // The show starts at 0: formatTime clamps negatives, so ticks before
        // the start all read "0:00" and stack up on the left.
        if (x < 0 || t < 0) continue
        ctx.strokeStyle = theme.border
        ctx.beginPath()
        ctx.moveTo(x, RULER_H)
        ctx.lineTo(x, height)
        ctx.stroke()
        ctx.fillStyle = theme.textDim
        ctx.fillText(formatTime(t), x + 4, 3)
      }

      // Section markers (slim band) then scenes (main band, tinted by their
      // main look's color so the timeline reads at a glance).
      // Sections carry trim handles too, now that they move and resize.
      drawBand(
        ctx,
        markersRef.current,
        selectedRef.current,
        MARKER_TOP,
        MARKER_BOTTOM,
        width,
        {
          fill: rgba(theme.accentBright, 0.16),
          fillSelected: rgba(theme.accentBright, 0.34),
          stroke: rgba(theme.accentBright, 0.5),
          strokeSelected: theme.accentBright,
        },
        undefined,
        true,
      )
      // The scene lane takes the height the operator gave the dock, but stops
      // growing once a block is comfortable to grab: past that it is just a
      // coloured slab, and the room below reads as breathing space.
      const sceneBottom = Math.min(height - 6, SCENE_TOP + SCENE_BAND_MAX)
      drawBand(
        ctx,
        scenesRef.current,
        selectedSceneRef.current,
        SCENE_TOP,
        sceneBottom,
        width,
        {
          fill: rgba(theme.edit, 0.16),
          fillSelected: rgba(theme.edit, 0.38),
          stroke: rgba(theme.edit, 0.5),
          strokeSelected: theme.edit,
        },
        (item) => sceneTint(item as SceneSpec),
        true,
      )

      // Name the two lanes. Sections and scenes looked like the same object
      // in two colours; only a label says one is a bookmark and the other
      // actually takes the lights over.
      ctx.font = '9px Inter, sans-serif'
      ctx.textBaseline = 'middle'
      // A block that starts before the view used to run its own name under the
      // lane name. A short fade of the dock's background keeps the label
      // legible without hiding anything that begins inside the view.
      const laneLabel = (text: string, y: number, color: string): void => {
        const fadeWidth = ctx.measureText(text).width + 22
        const fade = ctx.createLinearGradient(0, 0, fadeWidth, 0)
        fade.addColorStop(0, rgba(theme.panel, 0.95))
        fade.addColorStop(0.65, rgba(theme.panel, 0.95))
        fade.addColorStop(1, rgba(theme.panel, 0))
        ctx.fillStyle = fade
        ctx.fillRect(0, y - 7, fadeWidth, 14)
        ctx.fillStyle = color
        ctx.fillText(text, 6, y)
      }
      laneLabel('SECTIONS', (MARKER_TOP + MARKER_BOTTOM) / 2, rgba(theme.textDim, 0.6))
      laneLabel('SCENES', SCENE_TOP + 9, rgba(theme.edit, 0.6))
      ctx.textBaseline = 'top'

      // First-time hint in edit mode.
      if (modeRef.current === 'edit' && scenesRef.current.length === 0) {
        ctx.fillStyle = rgba(theme.textDim, 0.8)
        ctx.font = '12px Inter, sans-serif'
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'center'
        ctx.fillText(
          'Press + Scene to create your first scene at the playhead',
          width / 2,
          (SCENE_TOP + sceneBottom) / 2,
        )
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
      }

      replayingRef.current = feed.stats?.replay.replaying ?? false

      // Playhead: green live, orange replay, violet preview/scrub. It carries a
      // head in the ruler -- a line one pixel wide reads as decoration, and
      // nobody thinks to drag it.
      playheadXRef.current = showTime === null ? null : xOf(showTime)
      if (showTime !== null) {
        const x = Math.round(xOf(showTime)) + 0.5
        if (x >= -10 && x <= width + 10) {
          const color = timeOverridden ? theme.edit : replayingRef.current ? theme.warn : theme.ok
          ctx.strokeStyle = color
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.moveTo(x, RULER_H - 4)
          ctx.lineTo(x, height)
          ctx.stroke()
          ctx.lineWidth = 1

          ctx.fillStyle = color
          const headWidth = 22
          const headHeight = RULER_H - 5
          roundedRect(ctx, x - headWidth / 2, 1, headWidth, headHeight, 3)
          ctx.fill()
          // Two grip lines on the head, the universal "this one moves".
          ctx.strokeStyle = rgba(theme.panel, 0.85)
          ctx.beginPath()
          ctx.moveTo(x - 3.5, 5)
          ctx.lineTo(x - 3.5, headHeight - 3)
          ctx.moveTo(x + 3.5, 5)
          ctx.lineTo(x + 3.5, headHeight - 3)
          ctx.stroke()
        }
      }

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
        const state = transportState()
        tcSubRef.current.textContent =
          state === 'preview'
            ? 'PREVIEW LOOP'
            : state === 'playing'
              ? 'PLAYING'
              : state === 'paused'
                ? 'PAUSED'
                : tc.receiving
                  ? `${tc.fps} fps · ${replayingRef.current ? 'REPLAY' : 'LIVE'}`
                  : 'no timecode'
      }
      if (nowPlayingRef.current) {
        const playing = showTime !== null ? activeScene(editor.scenes, showTime) : null
        // "Scene 1" on its own read as a stray control; say what it is.
        const label = playing ? `Now: ${playing.name}` : ''
        if (nowPlayingRef.current.textContent !== label) nowPlayingRef.current.textContent = label
      }

      drawMinimap(showTime, timeOverridden, width)
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
      const width = canvas.clientWidth
      if (width === 0) return
      view.current.pxPerSec = clamp(width / extent, 0.05, 400)
      view.current.start = 0
      view.current.followPausedUntil = performance.now() + 4000
    }

    function drawMinimap(showTime: number | null, timeOverridden: boolean, mainWidth: number): void {
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

      for (const scene of scenesRef.current) {
        mctx.fillStyle = rgba(sceneTint(scene) ?? theme.edit, 0.85)
        mctx.fillRect(mx(scene.start), h / 2 - 2, Math.max(2, mx(scene.end) - mx(scene.start)), 4)
      }
      if (showTime !== null) {
        mctx.fillStyle = timeOverridden ? theme.edit : replayingRef.current ? theme.warn : theme.ok
        mctx.fillRect(mx(showTime) - 0.75, 0, 1.5, h)
      }
      const state = view.current
      const vx1 = mx(state.start)
      const vx2 = mx(state.start + mainWidth / state.pxPerSec)
      mctx.fillStyle = rgba(theme.text, 0.07)
      mctx.strokeStyle = rgba(theme.textDim, 0.8)
      mctx.fillRect(vx1, 0.5, Math.max(8, vx2 - vx1), h - 1)
      mctx.strokeRect(vx1 + 0.5, 0.5, Math.max(8, vx2 - vx1), h - 1)
    }

    function drawBand(
      ctx: CanvasRenderingContext2D,
      items: { id: string; name: string; start: number; end: number }[],
      selectedId: string | null,
      top: number,
      bottom: number,
      width: number,
      colors: { fill: string; fillSelected: string; stroke: string; strokeSelected: string },
      colorOf?: (item: unknown) => string | null,
      handles = false,
    ): void {
      for (const item of items) {
        const x1 = xOf(item.start)
        const x2 = xOf(item.end)
        if (x2 < 0 || x1 > width) continue
        const isSelected = item.id === selectedId
        const tint = colorOf?.(item) ?? null
        if (tint) {
          // The colour reads as a label along the top of the block rather than
          // a flat field: now that blocks can be tall, a solid tint turned the
          // lane into one large slab of colour.
          const wash = ctx.createLinearGradient(0, top, 0, bottom)
          wash.addColorStop(0, rgba(tint, isSelected ? 0.5 : 0.28))
          wash.addColorStop(1, rgba(tint, isSelected ? 0.16 : 0.07))
          ctx.fillStyle = wash
        } else {
          ctx.fillStyle = isSelected ? colors.fillSelected : colors.fill
        }
        ctx.strokeStyle = tint
          ? rgba(tint, isSelected ? 1 : 0.55)
          : isSelected
            ? colors.strokeSelected
            : colors.stroke
        roundedRect(ctx, x1, top, Math.max(2, x2 - x1), bottom - top, 4)
        ctx.fill()
        ctx.stroke()
        // Trim handles on the selected block: two notches at the edges.
        if (handles && isSelected) {
          ctx.fillStyle = tint ? rgba(tint, 1) : colors.strokeSelected
          const notchTop = top + (bottom - top) / 2 - 6
          ctx.fillRect(x1 + 1.5, notchTop, 3, 12)
          ctx.fillRect(x2 - 4.5, notchTop, 3, 12)
        }
        ctx.fillStyle = isSelected ? theme.text : rgba(theme.text, 0.68)
        ctx.font = '11px Inter, sans-serif'
        ctx.save()
        ctx.beginPath()
        ctx.rect(x1 + 2, top, Math.max(0, x2 - x1 - 4), bottom - top)
        ctx.clip()
        ctx.fillText(item.name, x1 + 7, top + 4)
        ctx.restore()
      }
    }

    // Interactions, borrowed from simple video editors (iMovie / Cut page):
    // direct manipulation. In Edit: drag a scene block to move it, drag its
    // edges to trim, click empty space or the ruler to scrub, shift+drag to
    // pan. In Watch: drag pans, nothing else. Wheel zooms, horizontal wheel
    // pans, everywhere.
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
    const EDGE_PX = 6

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
      canvas.setPointerCapture(event.pointerId)

      if (modeRef.current === 'watch') {
        drag = { type: 'pan', x: event.clientX, viewStart: view.current.start }
        return
      }
      if (event.shiftKey) {
        drag = { type: 'pan', x: event.clientX, viewStart: view.current.start }
        return
      }
      // The playhead comes first, at any height: it is the control the operator
      // reaches for most, and it used to be catchable only in the ruler strip.
      // A scene edge sitting exactly under it can still be trimmed -- move the
      // playhead off it first.
      if (onPlayhead(x)) {
        drag = { type: 'scrub' }
        scrubTo(event.clientX)
        return
      }
      if (y < RULER_H) {
        drag = { type: 'scrub' }
        scrubTo(event.clientX)
        return
      }
      // Sections are the table of contents: they move and trim like scenes,
      // and a plain click on one travels to it.
      if (y >= MARKER_TOP && y <= MARKER_BOTTOM) {
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
      // Empty area: drag pans (natural editor gesture); a plain click deselects.
      drag = { type: 'pan', x: event.clientX, viewStart: view.current.start, deselect: true }
    }

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      if (!drag) {
        // Hover feedback in edit mode: scrub cursor on the ruler, trim cursor
        // on scene edges.
        if (modeRef.current === 'edit') {
          const x = event.clientX - rect.left
          const t = timeAt(x)
          const y = event.clientY - rect.top
          if (onPlayhead(x)) {
            canvas.style.cursor = 'ew-resize'
            return
          }
          const scene = sceneHit(t, y)
          const tolerance = EDGE_PX / view.current.pxPerSec
          const marker =
            y >= MARKER_TOP && y <= MARKER_BOTTOM
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
          if (Math.abs(event.clientX - drag.x) > 4) {
            drag = { ...drag, type: 'move' }
          }
          break
        case 'pending-marker':
          if (Math.abs(event.clientX - drag.x) > 4) {
            drag = { ...drag, type: 'marker-move' }
          }
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
      const cursorX = event.clientX - rect.left
      const cursorTime = timeAt(cursorX)
      const factor = Math.pow(1.0015, -event.deltaY)
      view.current.pxPerSec = clamp(view.current.pxPerSec * factor, 0.2, 400)
      view.current.start = cursorTime - cursorX / view.current.pxPerSec
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
      const viewSeconds = canvas.clientWidth / state.pxPerSec
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

  function addSection(): void {
    const tc = feed.timecode
    const canvas = canvasRef.current!
    const viewCenter =
      view.current.start + canvas.clientWidth / 2 / view.current.pxPerSec
    const start = Math.max(0, tc.receiving ? tc.total : viewCenter)
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
    <footer className="dock" style={{ height: dockHeight }}>
      <div
        className={`dock-grip ${resizing ? 'dragging' : ''}`}
        title="Drag to resize the timeline"
        onPointerDown={startResize}
      />
      <div className="tc-block">
        <span className="tc-readout" ref={tcRef}>
          --:--:--:--
        </span>
        <span className="tc-sub" ref={tcSubRef}>
          no timecode
        </span>
        <span className="now-playing" ref={nowPlayingRef} />
        <Transport markers={show.markers} />
      </div>

      <div className="timeline-wrap" ref={wrapRef}>
        {/* The show's table of contents, above the timeline: every section in
            order, click to travel there. Editing happens here too instead of
            floating over the lanes it is meant to line up with. */}
        {mode === 'edit' && (
          <div className="section-bar">
            <div className="section-chips">
              {show.markers.length === 0 && (
                <span className="section-empty">
                  No sections yet — add one to split the show into parts
                </span>
              )}
              {[...show.markers]
                .sort((a, b) => a.start - b.start)
                .map((marker) => (
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
                    <span className="section-chip-time">{formatTime(marker.start)}</span>
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
                <label>
                  <span>Start</span>
                  <TimeInput value={selected.start} onCommit={(v) => updateSelected({ start: v })} />
                </label>
                <label>
                  <span>End</span>
                  <TimeInput value={selected.end} onCommit={(v) => updateSelected({ end: v })} />
                </label>
                <button className="button" onClick={deleteSelected}>
                  Delete
                </button>
                <button className="button" onClick={() => setSelectedId(null)}>
                  Close
                </button>
              </div>
            )}
          </div>
        )}
        <canvas className="timeline-main" ref={canvasRef} />
        <canvas className="timeline-minimap" ref={minimapRef} />
      </div>

      {mode === 'edit' ? (
        <div className="dock-controls">
          <button
            className="button primary"
            onClick={() => {
              const canvas = canvasRef.current!
              const tc = feed.timecode
              const center = view.current.start + canvas.clientWidth / 2 / view.current.pxPerSec
              onAddScene(Math.max(0, round1(tc.receiving ? tc.total : center)))
            }}
            title="A scene takes the lights over for a moment of the show"
          >
            + Scene
          </button>
          <button
            className="button"
            onClick={addSection}
            title="A section is just a bookmark on the timeline. It never changes the lights."
          >
            + Section
          </button>
          {/* Returning to live is the transport's LIVE button -- one control,
              one place, rather than two buttons doing the same thing. */}
          <button className="button subtle" onClick={() => fitRef.current()}>
            Fit
          </button>
          <span className={`save-state ${saveState}`}>
            {saveState === 'saving' ? 'saving…' : saveState === 'saved' ? 'saved' : saveState === 'error' ? 'save failed' : ''}
          </span>
        </div>
      ) : (
        <div className="dock-controls">
          <button className="button subtle" onClick={() => fitRef.current()}>
            Fit
          </button>
        </div>
      )}
    </footer>
  )
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

const DOCK_HEIGHT_KEY = 'lumenstage.dockHeight'
const DOCK_MIN = 132
const DOCK_DEFAULT = 190
const DOCK_MAX = 320

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
// stopped. Three states, always visible: following the console (Live),
// parked, or playing on this machine's clock.
function Transport({ markers }: { markers: Marker[] }) {
  const [state, setState] = useState(transportState())
  const markersRef = useRef(markers)
  markersRef.current = markers

  // The editor store is mutable and read at 60 fps by the canvases; polling
  // it four times a second is enough to keep three buttons honest.
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
      <button
        className="transport-button"
        title="Previous section"
        onClick={() => jumpSection(-1)}
      >
        |◀
      </button>
      <button
        className="transport-button"
        title="Back to the start"
        onClick={() => seekTo(0)}
      >
        ◀◀
      </button>
      <button
        className="transport-button play"
        title={playing ? 'Pause' : 'Play the timeline'}
        onClick={() => (playing ? pauseAt(liveTime()) : playLocal(liveTime()))}
      >
        {playing ? '‖' : '▶'}
      </button>
      <button
        className="transport-button"
        title="Next section"
        onClick={() => jumpSection(1)}
      >
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
