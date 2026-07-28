// COMPOSE — the intention layer.
//
// The whole track, always visible at once, with no zoom and no scroll. That is
// not a missing feature: it is the line between this and Edit. Compose asks
// "what should this part feel like"; Edit asks "exactly how should every light
// behave". The moment you can zoom in here, the two become the same screen and
// the separation stops meaning anything.
//
// Two pieces sharing one store: the macro timeline along the bottom, and the
// intention inspector on the right. The viewport between them is the same
// previz Edit uses, showing the composition rather than the show.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  DENSITIES,
  FAMILIES,
  MOODS,
  MOVEMENTS,
  PALETTES,
  type DensityId,
  type LookFamily,
  type MoodId,
  type MovementId,
  type PaletteId,
} from '../../core/vocabulary'
import { composeStore, type ComposeDraft, type ComposeSection, type DirectionStatus } from './compose'
import { editor, effectiveShowTime, pauseAt, playLocal, seekTo, transportState } from './editor'
import { listMusic, type MusicFile } from './music'
import { theme } from './theme'
import { formatTime } from './TimeInput'

function useCompose(): number {
  return useSyncExternalStore(composeStore.subscribe, composeStore.getSnapshot)
}

// ============================================================== the dock =====

export function ComposeDock({ onSendToEdit }: { onSendToEdit: () => void }) {
  useCompose()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const clockRef = useRef<HTMLSpanElement>(null)
  const [transport, setTransport] = useState(transportState())

  useEffect(() => {
    const id = setInterval(() => setTransport(transportState()), 250)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0

    const draft = () => composeStore.draft
    const totalSeconds = (): number => draft()?.analysis.seconds ?? 1
    const xOf = (t: number, width: number): number => (t / totalSeconds()) * width
    const timeAt = (x: number, width: number): number => (x / width) * totalSeconds()

    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const current = draft()
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
      ctx.clearRect(0, 0, width, height)
      if (!current) return

      const { peaks } = current.analysis
      const mid = height * 0.62

      // The waveform, underneath everything: the shape of the set, there to be
      // recognised rather than measured.
      ctx.fillStyle = rgba(theme.text, 0.13)
      for (let x = 0; x < width; x++) {
        const peak = peaks[Math.min(peaks.length - 1, Math.floor((x / width) * peaks.length))] ?? 0
        const h = Math.max(1, peak * (height * 0.34))
        ctx.fillRect(x, mid - h, 1, h * 2)
      }

      // One band per section, carrying its palette and its energy.
      for (const [index, section] of current.sections.entries()) {
        const x1 = xOf(section.start, width)
        const x2 = xOf(section.end, width)
        const w = Math.max(2, x2 - x1)
        const selected = section.id === composeStore.selectedId
        const colour = PALETTES[section.intent.palette].colours[0]

        ctx.fillStyle = rgba(colour, selected ? 0.22 : 0.09)
        ctx.fillRect(x1, 0, w, height)
        ctx.fillStyle = colour
        ctx.fillRect(x1, 0, w, selected ? 3 : 2)

        // Energy as a line across the band: flat when the section holds, a
        // slope when it climbs. The show's dynamics, readable end to end.
        const yOf = (energy: number): number => height - 10 - (energy / 100) * (height - 34)
        const from = yOf(section.intent.energy)
        const to = yOf(section.intent.energyTo ?? section.intent.energy)
        ctx.strokeStyle = rgba(colour, selected ? 0.95 : 0.5)
        ctx.lineWidth = selected ? 2 : 1.5
        ctx.beginPath()
        ctx.moveTo(x1 + 2, from)
        ctx.lineTo(x2 - 2, to)
        ctx.stroke()
        ctx.lineWidth = 1

        ctx.save()
        ctx.beginPath()
        ctx.rect(x1 + 2, 0, Math.max(0, w - 4), height)
        ctx.clip()
        ctx.textBaseline = 'top'
        ctx.font = '10px "JetBrains Mono", Consolas, monospace'
        ctx.fillStyle = rgba(theme.text, selected ? 0.75 : 0.35)
        ctx.fillText(String(index + 1).padStart(2, '0'), x1 + 9, 12)
        ctx.font = selected ? '600 12px Inter, sans-serif' : '12px Inter, sans-serif'
        ctx.fillStyle = selected ? theme.text : rgba(theme.text, 0.62)
        ctx.fillText(section.name, x1 + 30, 11)
        ctx.font = '10px Inter, sans-serif'
        ctx.fillStyle = rgba(theme.text, 0.38)
        ctx.fillText(
          `${MOODS[section.intent.mood].label} · ${MOVEMENTS[section.intent.movement].label}`,
          x1 + 30,
          27,
        )
        ctx.restore()

        // The line between two sections, and the handle that moves it.
        if (index > 0) {
          ctx.strokeStyle = rgba(theme.text, 0.28)
          ctx.beginPath()
          ctx.moveTo(Math.round(x1) + 0.5, 0)
          ctx.lineTo(Math.round(x1) + 0.5, height)
          ctx.stroke()
        }
      }

      const showTime = effectiveShowTime(null)
      if (showTime !== null) {
        const x = Math.round(xOf(showTime, width)) + 0.5
        ctx.strokeStyle = theme.ok
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, height)
        ctx.stroke()
        ctx.fillStyle = theme.ok
        ctx.fillRect(x - 5, 0, 10, 3)
        if (clockRef.current) clockRef.current.textContent = formatTime(showTime)
      }
    }
    draw()

    // ----- pointer -----------------------------------------------------------
    let dragging: number | null = null
    const boundaryAt = (x: number, width: number): number | null => {
      const current = draft()
      if (!current) return null
      for (let index = 1; index < current.sections.length; index++) {
        if (Math.abs(xOf(current.sections[index].start, width) - x) <= 6) return index
      }
      return null
    }

    const onDown = (event: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect()
      const x = event.clientX - rect.left
      const boundary = boundaryAt(x, rect.width)
      if (boundary !== null) {
        dragging = boundary
        canvas.setPointerCapture(event.pointerId)
        return
      }
      const t = timeAt(x, rect.width)
      const hit = draft()?.sections.find((section) => t >= section.start && t < section.end)
      if (hit) composeStore.select(hit.id)
      seekTo(t)
    }
    const onMove = (event: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect()
      const x = event.clientX - rect.left
      if (dragging !== null) {
        composeStore.moveBoundary(dragging, timeAt(x, rect.width))
        return
      }
      canvas.style.cursor = boundaryAt(x, rect.width) !== null ? 'ew-resize' : 'pointer'
    }
    const onUp = (): void => {
      dragging = null
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    return () => {
      cancelAnimationFrame(raf)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
    }
  }, [])

  const draft = composeStore.draft
  const playing = transport === 'playing'

  return (
    <footer className="compose-dock">
      <div className="compose-bar">
        <div className="transport">
          <button className="transport-button" title="Back to the start" onClick={() => seekTo(0)}>
            |◀
          </button>
          <button
            className="transport-button play"
            title={playing ? 'Pause' : 'Play'}
            onClick={() => (playing ? pauseAt(null) : playLocal(null))}
          >
            {playing ? '❚❚' : '▶'}
          </button>
        </div>
        <span className="compose-clock" ref={clockRef}>
          0:00
        </span>
        <span className="compose-track">{draft?.file ?? 'no track'}</span>
        {composeStore.busy && <span className="compose-busy">{composeStore.busy}…</span>}
        {composeStore.error && <span className="error-text">{composeStore.error}</span>}
        <div className="compose-actions">
          {draft && (
            <button
              className="tl-action plain"
              title="Cut the selected section at the playhead"
              onClick={() => composeStore.splitAt(effectiveShowTime(null) ?? 0)}
            >
              Split here
            </button>
          )}
          <button className="ins-preview compact" onClick={onSendToEdit} disabled={!composeStore.composition}>
            <span className="ins-preview-label">Send to Edit</span>
            <span className="ins-preview-glyph">→</span>
          </button>
        </div>
      </div>
      <canvas className="compose-canvas" ref={canvasRef} />
    </footer>
  )
}

// ========================================================= the inspector =====

export function ComposeInspector() {
  useCompose()
  const [directing, setDirecting] = useState(false)
  const draft = composeStore.draft
  const section = composeStore.selected

  if (!draft) return <TrackPicker />
  if (directing) return <DirectionPanel draft={draft} onDone={() => setDirecting(false)} />
  return (
    <aside className="inspector">
      <DirectionStrip draft={draft} onOpen={() => setDirecting(true)} />
      {section ? (
        <IntentEditor section={section} />
      ) : (
        <span className="muted-note">Select a part of the track to give it an intention.</span>
      )}
    </aside>
  )
}

function TrackPicker() {
  useCompose()
  const [files, setFiles] = useState<MusicFile[] | null>(null)
  const [dir, setDir] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listMusic()
      .then((result) => {
        setFiles(result.files)
        setDir(result.dir)
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  return (
    <aside className="inspector">
      <header className="ins-head">
        <h2 className="ins-title-static">Compose</h2>
      </header>
      <p className="ins-note">
        Choose the show's music. Prodigy Stage listens to it, finds where it changes and how fast
        each part runs, and you say what each part should feel like.
      </p>

      {error && <span className="error-text">{error}</span>}
      {files === null && !error && <span className="muted-note">Reading the music folder…</span>}
      {files !== null && files.length === 0 && (
        <section className="ins-section">
          <span className="ins-label">Nothing to listen to</span>
          <p className="ins-note">Drop the show's WAV into this folder and reopen Compose:</p>
          <code className="music-path">{dir}</code>
        </section>
      )}
      {files !== null && files.length > 0 && (
        <section className="ins-section">
          <span className="ins-label">Track</span>
          {files.map((file) => (
            <button
              key={file.file}
              className="music-file"
              onClick={() => void composeStore.analyse(file.file)}
            >
              <span className="music-file-name">{file.file}</span>
              <span className="music-file-size">{(file.sizeBytes / 1e6).toFixed(0)} MB</span>
            </button>
          ))}
        </section>
      )}
      {composeStore.busy === 'analysing' && (
        <span className="muted-note">Listening to the whole track…</span>
      )}
    </aside>
  )
}

// ========================================================== the direction =====
// The one thing in Compose that is about the whole show rather than one part of
// it, so it sits above the section and reads as a different level. It is a
// door, not a panel: the show's story is written once and then referred to.

function DirectionStrip({ draft, onOpen }: { draft: ComposeDraft; onOpen: () => void }) {
  const working = composeStore.busy === 'directing'
  return (
    <button className="direction-strip" onClick={onOpen} disabled={working}>
      <span className="direction-strip-label">Direction</span>
      <span className={`direction-strip-value ${draft.arc ? '' : 'empty'}`}>
        {working ? 'Reading the whole track…' : (draft.arc ?? 'Say what the show is about')}
      </span>
      <span className="direction-strip-go">›</span>
    </button>
  )
}

function DirectionPanel({ draft, onDone }: { draft: ComposeDraft; onDone: () => void }) {
  useCompose()
  const [brief, setBrief] = useState(draft.brief ?? '')
  const [status, setStatus] = useState<DirectionStatus | null>(null)
  const [key, setKey] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const working = composeStore.busy === 'directing'

  useEffect(() => {
    composeStore
      .directionStatus()
      .then(setStatus)
      .catch(() => setStatus({ configured: false, source: null, model: '' }))
  }, [])

  const ask = async (): Promise<void> => {
    await composeStore.direct(brief)
    // Stay on failure so the reason is next to the thing that failed; leave on
    // success, because the answer is out there on the timeline, not in here.
    if (!composeStore.error) onDone()
  }

  const saveKey = async (): Promise<void> => {
    setKeyError(null)
    try {
      setStatus(await composeStore.saveDirectionKey(key))
      setKey('')
    } catch (error) {
      setKeyError((error as Error).message)
    }
  }

  return (
    <aside className="inspector">
      <header className="ins-head">
        <h2 className="ins-title-static">Direction</h2>
        <button className="ins-close" title="Back to the section" onClick={onDone}>
          ←
        </button>
      </header>
      <p className="ins-note">
        Describe the show in your own words — the story, the places it goes, the colours you already
        have in mind. Every part of the track gets a name and an intention from it, and you edit
        them afterwards like anything else here.
      </p>

      <section className="ins-section">
        <span className="ins-label">The show</span>
        <textarea
          className="direction-brief"
          value={brief}
          rows={7}
          spellCheck={false}
          placeholder={
            'A narrative show. It opens in a cold cave, blue and almost still. ' +
            'After the first drop it breaks into a red, aggressive world and stays there. ' +
            'The last ten minutes are white and euphoric.'
          }
          onChange={(event) => setBrief(event.target.value)}
        />
      </section>

      {status !== null && !status.configured ? (
        <section className="ins-section">
          <span className="ins-label">Not connected</span>
          <p className="ins-note">
            The direction is written over the internet. Paste an API key to use it — it stays on
            this machine. Compose works without it: every part keeps the intention its own rules
            gave it.
          </p>
          <input
            className="direction-key"
            type="password"
            placeholder="sk-…"
            value={key}
            spellCheck={false}
            onChange={(event) => setKey(event.target.value)}
          />
          {keyError && <span className="error-text">{keyError}</span>}
          <button className="ins-button" disabled={key.trim().length === 0} onClick={() => void saveKey()}>
            Save the key
          </button>
        </section>
      ) : (
        <button className="ins-preview" disabled={working || status === null} onClick={() => void ask()}>
          <span className="ins-preview-glyph">{working ? '◍' : '◆'}</span>
          <span className="ins-preview-label">
            {working ? 'Reading the track…' : draft.arc ? 'Direct it again' : 'Propose a direction'}
          </span>
        </button>
      )}

      {composeStore.error && <span className="error-text">{composeStore.error}</span>}

      {draft.arc && (
        <section className="ins-section">
          <span className="ins-label">Now</span>
          <p className="direction-arc">{draft.arc}</p>
        </section>
      )}
    </aside>
  )
}

// ==================================================== the section's intent ====

function IntentEditor({ section }: { section: ComposeSection }) {
  const { intent } = section
  const set = (patch: Partial<typeof intent>): void =>
    composeStore.update(section.id, { intent: patch })

  return (
    <>
      <header className="ins-head">
        <input
          className="ins-title"
          value={section.name}
          onChange={(e) => composeStore.update(section.id, { name: e.target.value })}
        />
      </header>
      <div className="ins-when">
        <span className="compose-when-value">{formatTime(section.start)}</span>
        <span className="ins-when-sep">→</span>
        <span className="compose-when-value">{formatTime(section.end)}</span>
        <span className="ins-duration">{formatDuration(section.end - section.start)}</span>
      </div>
      {section.why && <p className="direction-why">{section.why}</p>}

      <section className="ins-section">
        <span className="ins-label">Palette</span>
        <div className="palette-grid">
          {(Object.keys(PALETTES) as PaletteId[]).map((id) => (
            <button
              key={id}
              className={`palette ${intent.palette === id ? 'active' : ''}`}
              title={PALETTES[id].label}
              onClick={() => set({ palette: id })}
            >
              <span className="palette-strip">
                {PALETTES[id].colours.map((colour) => (
                  <span key={colour} style={{ background: colour }} />
                ))}
              </span>
              <span className="palette-name">{PALETTES[id].label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="ins-section">
        <span className="ins-label">Mood</span>
        <Choice
          options={(Object.keys(MOODS) as MoodId[]).map((id) => ({ id, label: MOODS[id].label }))}
          value={intent.mood}
          onPick={(mood) => set({ mood })}
        />
      </section>

      <section className="ins-section">
        <div className="ins-section-head">
          <span className="ins-label">Energy</span>
          <button
            className="ins-link"
            onClick={() =>
              set({ energyTo: intent.energyTo === null ? Math.min(100, intent.energy + 40) : null })
            }
          >
            {intent.energyTo === null ? 'Make it climb' : 'Hold it steady'}
          </button>
        </div>
        <div className="param">
          <span className="param-label">{intent.energyTo === null ? 'Level' : 'From'}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={intent.energy}
            onChange={(e) => set({ energy: e.target.valueAsNumber })}
          />
          <span className="param-value">{intent.energy}</span>
        </div>
        {intent.energyTo !== null && (
          <div className="param">
            <span className="param-label">To</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={intent.energyTo}
              onChange={(e) => set({ energyTo: e.target.valueAsNumber })}
            />
            <span className="param-value">{intent.energyTo}</span>
          </div>
        )}
      </section>

      <section className="ins-section">
        <span className="ins-label">Movement</span>
        <Choice
          options={(Object.keys(MOVEMENTS) as MovementId[]).map((id) => ({
            id,
            label: MOVEMENTS[id].label,
          }))}
          value={intent.movement}
          onPick={(movement) => set({ movement })}
        />
      </section>

      <section className="ins-section">
        <span className="ins-label">Density</span>
        <Choice
          options={(Object.keys(DENSITIES) as DensityId[]).map((id) => ({
            id,
            label: DENSITIES[id].label,
          }))}
          value={intent.density}
          onPick={(density) => set({ density })}
        />
      </section>

      <section className="ins-section">
        <span className="ins-label">Looks</span>
        <div className="family-list">
          {(Object.keys(FAMILIES) as LookFamily[]).map((id) => (
            <button
              key={id}
              className={`family ${intent.families.includes(id) ? 'active' : ''}`}
              onClick={() => composeStore.toggleFamily(section.id, id)}
            >
              <b>{FAMILIES[id].label}</b>
              <em>{FAMILIES[id].note}</em>
            </button>
          ))}
        </div>
      </section>

      <footer className="ins-foot compose-foot">
        <button
          className="ins-button"
          title="Another take on the same intention"
          onClick={() => composeStore.regenerate(section.id)}
        >
          Regenerate
        </button>
        <button
          className="ins-button"
          title="Join this section to the one after it"
          onClick={() => composeStore.mergeWithNext(section.id)}
        >
          Merge next
        </button>
      </footer>
    </>
  )
}

function Choice<T extends string>({
  options,
  value,
  onPick,
}: {
  options: { id: T; label: string }[]
  value: T
  onPick: (id: T) => void
}) {
  return (
    <div className="choice">
      {options.map((option) => (
        <button
          key={option.id}
          className={`choice-item ${value === option.id ? 'active' : ''}`}
          onClick={() => onPick(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function rgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

// Compose previews on the local clock: there is no console involved in
// deciding what a section should feel like.
export function enterCompose(): void {
  composeStore.preview()
  if (editor.localFrom === null && editor.scrub === null) seekTo(0)
}
