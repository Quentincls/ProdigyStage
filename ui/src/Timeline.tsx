// Read-only show timeline (Phase 4): time ruler, live playhead driven by the
// Art-Net timecode, zoom/scroll, hand-placed section markers saved in
// data/show.json, and the run recorder / replayer controls.
// The canvas is drawn in a rAF loop reading feed.timecode directly; React only
// renders the chrome (buttons, selected-marker editor) at interaction rate.

import { useEffect, useMemo, useRef, useState } from 'react'
import { activeScene, hexToRgb, type SceneSpec } from '../../core/effects'
import { backToLive, editor, effectiveShowTime, isTimeOverridden } from './editor'
import { feed } from './feed'
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
const RULER_H = 16
const MARKER_TOP = 20
const MARKER_BOTTOM = 38
const SCENE_TOP = 42

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
  const [overridden, setOverridden] = useState(false)
  const fitRef = useRef<() => void>(() => {})

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
        if (x < 0) continue
        ctx.strokeStyle = '#262a31'
        ctx.beginPath()
        ctx.moveTo(x, RULER_H)
        ctx.lineTo(x, height)
        ctx.stroke()
        ctx.fillStyle = '#8a8f98'
        ctx.fillText(formatTime(t), x + 4, 3)
      }

      // Section markers (slim band) then scenes (main band, tinted by their
      // main look's color so the timeline reads at a glance).
      drawBand(ctx, markersRef.current, selectedRef.current, MARKER_TOP, MARKER_BOTTOM, width, {
        fill: 'rgba(91,140,255,0.16)',
        fillSelected: 'rgba(91,140,255,0.34)',
        stroke: 'rgba(91,140,255,0.45)',
        strokeSelected: '#5b8cff',
      })
      drawBand(
        ctx,
        scenesRef.current,
        selectedSceneRef.current,
        SCENE_TOP,
        height - 6,
        width,
        {
          fill: 'rgba(167,139,250,0.16)',
          fillSelected: 'rgba(167,139,250,0.38)',
          stroke: 'rgba(167,139,250,0.5)',
          strokeSelected: '#a78bfa',
        },
        (item) => sceneTint(item as SceneSpec),
        true,
      )

      // First-time hint in edit mode.
      if (modeRef.current === 'edit' && scenesRef.current.length === 0) {
        ctx.fillStyle = '#5f6570'
        ctx.font = '12px Inter, sans-serif'
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'center'
        ctx.fillText(
          'Press + Scene to create your first scene at the playhead',
          width / 2,
          (SCENE_TOP + height - 6) / 2,
        )
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
      }

      replayingRef.current = feed.stats?.replay.replaying ?? false

      // Playhead: green live, orange replay, violet preview/scrub.
      if (showTime !== null) {
        const x = Math.round(xOf(showTime)) + 0.5
        if (x >= 0 && x <= width) {
          ctx.strokeStyle = timeOverridden ? '#a78bfa' : replayingRef.current ? '#f5a623' : '#3ecf8e'
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.moveTo(x, 0)
          ctx.lineTo(x, height)
          ctx.stroke()
          ctx.lineWidth = 1
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
        tcSubRef.current.textContent = timeOverridden
          ? editor.playing
            ? 'PREVIEW LOOP'
            : 'SCRUB'
          : tc.receiving
            ? `${tc.fps} fps · ${replayingRef.current ? 'REPLAY' : 'LIVE'}`
            : 'no timecode'
      }
      if (nowPlayingRef.current) {
        const playing = showTime !== null ? activeScene(editor.scenes, showTime) : null
        const label = playing ? `▶ ${playing.name}` : ''
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
        mctx.fillStyle = rgba(sceneTint(scene) ?? '#a78bfa', 0.85)
        mctx.fillRect(mx(scene.start), h / 2 - 2, Math.max(2, mx(scene.end) - mx(scene.start)), 4)
      }
      if (showTime !== null) {
        mctx.fillStyle = timeOverridden ? '#a78bfa' : replayingRef.current ? '#f5a623' : '#3ecf8e'
        mctx.fillRect(mx(showTime) - 0.75, 0, 1.5, h)
      }
      const state = view.current
      const vx1 = mx(state.start)
      const vx2 = mx(state.start + mainWidth / state.pxPerSec)
      mctx.fillStyle = 'rgba(232,234,237,0.07)'
      mctx.strokeStyle = 'rgba(138,143,152,0.8)'
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
        ctx.fillStyle = tint
          ? rgba(tint, isSelected ? 0.38 : 0.18)
          : isSelected
            ? colors.fillSelected
            : colors.fill
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
        ctx.fillStyle = isSelected ? '#e8eaed' : '#aab2c0'
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
    const scrubTo = (clientX: number): void => {
      const rect = canvas.getBoundingClientRect()
      editor.playing = false
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
      if (y < RULER_H) {
        drag = { type: 'scrub' }
        scrubTo(event.clientX)
        return
      }
      if (y >= MARKER_TOP && y <= MARKER_BOTTOM) {
        const hit = [...markersRef.current]
          .reverse()
          .find((marker) => t >= marker.start && t <= marker.end)
        setSelectedId(hit?.id ?? null)
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
          const t = timeAt(event.clientX - rect.left)
          const y = event.clientY - rect.top
          const scene = sceneHit(t, y)
          canvas.style.cursor =
            y < RULER_H
              ? 'crosshair'
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
    <footer className="dock">
      <div className="tc-block">
        <span className="tc-readout" ref={tcRef}>
          --:--:--:--
        </span>
        <span className="tc-sub" ref={tcSubRef}>
          no timecode
        </span>
        <span className="now-playing" ref={nowPlayingRef} />
      </div>

      <div className="timeline-wrap" ref={wrapRef}>
        <canvas className="timeline-main" ref={canvasRef} />
        <canvas className="timeline-minimap" ref={minimapRef} />
        <button className="fit-button" onClick={() => fitRef.current()}>
          Fit
        </button>
        {mode === 'edit' && selected && (
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
          >
            + Scene
          </button>
          <button className="button" onClick={addSection}>
            + Section
          </button>
          {overridden && (
            <button
              className="button live-button"
              onClick={() => {
                backToLive()
                setOverridden(false)
              }}
            >
              Back to live
            </button>
          )}
          <span className={`save-state ${saveState}`}>
            {saveState === 'saving' ? 'saving…' : saveState === 'saved' ? 'saved' : saveState === 'error' ? 'save failed' : ''}
          </span>
        </div>
      ) : (
        overridden && (
          <div className="dock-controls">
            <button
              className="button live-button"
              onClick={() => {
                backToLive()
                setOverridden(false)
              }}
            >
              Back to live
            </button>
          </div>
        )
      )}
    </footer>
  )
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
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
