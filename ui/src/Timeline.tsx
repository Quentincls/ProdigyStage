// Read-only show timeline (Phase 4): time ruler, live playhead driven by the
// Art-Net timecode, zoom/scroll, hand-placed section markers saved in
// data/show.json, and the run recorder / replayer controls.
// The canvas is drawn in a rAF loop reading feed.timecode directly; React only
// renders the chrome (buttons, selected-marker editor) at interaction rate.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { feed } from './feed'
import {
  controlRecord,
  controlReplay,
  fetchRecordings,
  type Marker,
  type RecordingInfo,
  type ShowFile,
} from './show'

interface TimelineProps {
  show: ShowFile
  onChange: (show: ShowFile) => void
  saveState: 'idle' | 'saving' | 'saved' | 'error'
}

const RULER_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

export default function Timeline({ show, onChange, saveState }: TimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const tcRef = useRef<HTMLSpanElement>(null)
  const tcSubRef = useRef<HTMLSpanElement>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [recordings, setRecordings] = useState<RecordingInfo[]>([])
  const [replayFile, setReplayFile] = useState('')
  const { stats } = useSyncExternalStore(feed.subscribe, feed.getSnapshot)

  // Mutable view state read by the draw loop.
  const view = useRef({ start: -5, pxPerSec: 6, followPausedUntil: 0 })
  const markersRef = useRef(show.markers)
  markersRef.current = show.markers
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId
  const replayingRef = useRef(false)
  replayingRef.current = stats?.replay.replaying ?? false

  const selected = useMemo(
    () => show.markers.find((marker) => marker.id === selectedId) ?? null,
    [show, selectedId],
  )

  const recording = stats?.record.recording ?? false
  const replaying = stats?.replay.replaying ?? false

  useEffect(() => {
    void fetchRecordings().then(setRecordings)
  }, [])

  // Refresh the recordings list when a recording finishes.
  const wasRecording = useRef(false)
  useEffect(() => {
    if (wasRecording.current && !recording) void fetchRecordings().then(setRecordings)
    wasRecording.current = recording
  }, [recording])

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

      // Follow the playhead unless the user recently panned/zoomed.
      if (tc.receiving && performance.now() > state.followPausedUntil) {
        const x = xOf(tc.total)
        if (x > width * 0.88 || x < 0) state.start = tc.total - (width * 0.15) / state.pxPerSec
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
        ctx.moveTo(x, 16)
        ctx.lineTo(x, height)
        ctx.stroke()
        ctx.fillStyle = '#8a8f98'
        ctx.fillText(formatTime(t), x + 4, 3)
      }

      // Markers.
      const bandTop = 24
      const bandBottom = height - 6
      for (const marker of markersRef.current) {
        const x1 = xOf(marker.start)
        const x2 = xOf(marker.end)
        if (x2 < 0 || x1 > width) continue
        const isSelected = marker.id === selectedRef.current
        ctx.fillStyle = isSelected ? 'rgba(91,140,255,0.34)' : 'rgba(91,140,255,0.16)'
        ctx.strokeStyle = isSelected ? '#5b8cff' : 'rgba(91,140,255,0.45)'
        roundedRect(ctx, x1, bandTop, Math.max(2, x2 - x1), bandBottom - bandTop, 4)
        ctx.fill()
        ctx.stroke()
        ctx.fillStyle = isSelected ? '#e8eaed' : '#aab2c0'
        ctx.font = '11px Inter, sans-serif'
        ctx.save()
        ctx.beginPath()
        ctx.rect(x1 + 2, bandTop, Math.max(0, x2 - x1 - 4), bandBottom - bandTop)
        ctx.clip()
        ctx.fillText(marker.name, x1 + 7, bandTop + 6)
        ctx.restore()
      }

      // Playhead.
      if (tc.receiving) {
        const x = Math.round(xOf(tc.total)) + 0.5
        if (x >= 0 && x <= width) {
          ctx.strokeStyle = replayingRef.current ? '#f5a623' : '#3ecf8e'
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
        tcRef.current.textContent = tc.receiving
          ? `${pad(tc.hours)}:${pad(tc.minutes)}:${pad(tc.seconds)}:${pad(tc.frames)}`
          : '--:--:--:--'
      }
      if (tcSubRef.current) {
        tcSubRef.current.textContent = tc.receiving
          ? `${tc.fps} fps · ${replayingRef.current ? 'REPLAY' : 'LIVE'}`
          : 'no timecode'
      }
    }
    draw()

    // Interactions: drag to pan, wheel to zoom, click to select a marker.
    let down: { x: number; y: number; start: number; moved: boolean } | null = null

    const onPointerDown = (event: PointerEvent) => {
      down = { x: event.clientX, y: event.clientY, start: view.current.start, moved: false }
      canvas.setPointerCapture(event.pointerId)
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!down) return
      const dx = event.clientX - down.x
      if (Math.abs(dx) > 4) down.moved = true
      if (down.moved) {
        view.current.start = down.start - dx / view.current.pxPerSec
        view.current.followPausedUntil = performance.now() + 4000
      }
    }
    const onPointerUp = (event: PointerEvent) => {
      if (!down) return
      if (!down.moved) {
        const rect = canvas.getBoundingClientRect()
        const t = timeAt(event.clientX - rect.left)
        const hit = [...markersRef.current]
          .reverse()
          .find((marker) => t >= marker.start && t <= marker.end)
        setSelectedId(hit?.id ?? null)
      }
      down = null
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
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

      <div className="dock-controls">
        <button className="button" onClick={addSection}>
          Add section
        </button>
        <button
          className={`button record ${recording ? 'on' : ''}`}
          onClick={() => void controlRecord(recording ? 'stop' : 'start')}
        >
          {recording ? `■ REC ${formatTime(stats?.record.seconds ?? 0)}` : '● Record'}
        </button>
        <select
          className="recording-select"
          value={replayFile}
          onChange={(e) => setReplayFile(e.target.value)}
          onFocus={() => void fetchRecordings().then(setRecordings)}
        >
          <option value="">— recordings —</option>
          {recordings.map((entry) => (
            <option key={entry.file} value={entry.file}>
              {entry.file}
              {entry.durationMs ? ` (${formatTime(Math.round(entry.durationMs / 1000))})` : ''}
            </option>
          ))}
        </select>
        <button
          className="button"
          disabled={!replaying && replayFile === ''}
          onClick={() => void controlReplay(replaying ? 'stop' : 'start', replayFile)}
        >
          {replaying ? '■ Stop' : '▶ Replay'}
        </button>
        <span className={`save-state ${saveState}`}>
          {saveState === 'saving' ? 'saving…' : saveState === 'saved' ? 'saved' : saveState === 'error' ? 'save failed' : ''}
        </span>
      </div>
    </footer>
  )
}

function TimeInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(formatTime(value))
  useEffect(() => setText(formatTime(value)), [value])
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const parsed = parseTime(text)
        if (parsed !== null) onCommit(round1(parsed))
        else setText(formatTime(value))
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

function formatTime(t: number): string {
  const s = Math.max(0, Math.round(t))
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const seconds = s % 60
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`
}

function parseTime(text: string): number | null {
  const parts = text.trim().split(':').map(Number)
  if (parts.some((n) => Number.isNaN(n))) return null
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 1) return parts[0]
  return null
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
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
