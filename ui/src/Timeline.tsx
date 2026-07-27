// Read-only show timeline (Phase 4): time ruler, live playhead driven by the
// Art-Net timecode, zoom/scroll, hand-placed section markers saved in
// data/show.json, and the run recorder / replayer controls.
// The canvas is drawn in a rAF loop reading feed.timecode directly; React only
// renders the chrome (buttons, selected-marker editor) at interaction rate.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SceneSpec } from '../../core/effects'
import { backToLive, editor, effectiveShowTime, isTimeOverridden } from './editor'
import { feed } from './feed'
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
  const wrapRef = useRef<HTMLDivElement>(null)
  const tcRef = useRef<HTMLSpanElement>(null)
  const tcSubRef = useRef<HTMLSpanElement>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [overridden, setOverridden] = useState(false)

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

      // Section markers (slim band) then scenes (main band).
      drawBand(ctx, markersRef.current, selectedRef.current, MARKER_TOP, MARKER_BOTTOM, width, {
        fill: 'rgba(91,140,255,0.16)',
        fillSelected: 'rgba(91,140,255,0.34)',
        stroke: 'rgba(91,140,255,0.45)',
        strokeSelected: '#5b8cff',
      })
      drawBand(ctx, scenesRef.current, selectedSceneRef.current, SCENE_TOP, height - 6, width, {
        fill: 'rgba(167,139,250,0.16)',
        fillSelected: 'rgba(167,139,250,0.38)',
        stroke: 'rgba(167,139,250,0.5)',
        strokeSelected: '#a78bfa',
      })

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
    }
    draw()

    function drawBand(
      ctx: CanvasRenderingContext2D,
      items: { id: string; name: string; start: number; end: number }[],
      selectedId: string | null,
      top: number,
      bottom: number,
      width: number,
      colors: { fill: string; fillSelected: string; stroke: string; strokeSelected: string },
    ): void {
      for (const item of items) {
        const x1 = xOf(item.start)
        const x2 = xOf(item.end)
        if (x2 < 0 || x1 > width) continue
        const isSelected = item.id === selectedId
        ctx.fillStyle = isSelected ? colors.fillSelected : colors.fill
        ctx.strokeStyle = isSelected ? colors.strokeSelected : colors.stroke
        roundedRect(ctx, x1, top, Math.max(2, x2 - x1), bottom - top, 4)
        ctx.fill()
        ctx.stroke()
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
      | { type: 'pan'; x: number; viewStart: number }
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
      // Empty area: scrub there and deselect, like clicking an editor's timeline.
      onSelectSceneRef.current(null)
      setSelectedId(null)
      drag = { type: 'scrub' }
      scrubTo(event.clientX)
    }

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      if (!drag) {
        // Hover feedback in edit mode: trim cursor on scene edges.
        if (modeRef.current === 'edit') {
          const t = timeAt(event.clientX - rect.left)
          const y = event.clientY - rect.top
          const scene = sceneHit(t, y)
          canvas.style.cursor =
            scene && edgeOf(scene, t) ? 'ew-resize' : scene ? 'pointer' : 'grab'
        } else {
          canvas.style.cursor = 'grab'
        }
        return
      }
      const dt = (event.clientX - ('x' in drag ? drag.x : event.clientX)) / view.current.pxPerSec
      switch (drag.type) {
        case 'pan':
          view.current.start = drag.viewStart - (event.clientX - drag.x) / view.current.pxPerSec
          view.current.followPausedUntil = performance.now() + 4000
          break
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
          const start = snap(drag.start + dt)
          updateScene(drag.sceneId, { start: round1(start), end: round1(start + duration) })
          break
        }
        case 'trim-l': {
          const start = Math.min(snap(drag.start + dt), drag.end - 1)
          updateScene(drag.sceneId, { start: round1(start) })
          break
        }
        case 'trim-r': {
          const end = Math.max(snap(drag.end + dt), drag.start + 1)
          updateScene(drag.sceneId, { end: round1(end) })
          break
        }
      }
    }

    const onPointerUp = () => {
      if (drag?.type === 'pending-scene') {
        onSelectSceneRef.current(drag.sceneId)
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

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    const observer = new ResizeObserver(() => {})
    observer.observe(wrap)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
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
      </div>

      <div className="timeline-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} />
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
