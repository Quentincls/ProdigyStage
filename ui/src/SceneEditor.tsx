// The inspector: how the selected scene behaves.
//
// Flat on purpose. The information is structured with type, spacing and
// hairlines rather than with nested cards -- a settings panel made of boxes
// inside boxes reads as configuration, and this is meant to read as an
// instrument. Order follows what the eye should hit: what this scene is, the
// one action, the look it plays, the handful of things worth adjusting, then
// everything else behind Advanced.

import { useEffect, useRef, useState } from 'react'
import {
  defaultParams,
  EFFECTS,
  renderEffect,
  type EffectType,
  type ParamValue,
  type SceneSpec,
  type TrackSpec,
  type TrackTarget,
} from '../../core/effects'
import { backToLive, editor, startPreview } from './editor'
import { BUILTIN_PRESETS } from './presets'
import { clampTrimEnd, clampTrimStart, findFreeSlot } from './sceneRules'
import { type PresetSpec, type ShowFile } from './show'
import { round1, TimeInput } from './TimeInput'

interface SceneEditorProps {
  show: ShowFile
  sceneId: string
  onChange: (show: ShowFile) => void
  onClose: () => void
  onSelect: (id: string) => void
}

const TARGETS: { value: TrackTarget; label: string }[] = [
  { value: 'both', label: 'Both walls' },
  { value: 'wall-left', label: 'Left wall' },
  { value: 'wall-right', label: 'Right wall' },
]

export default function SceneEditor({ show, sceneId, onChange, onClose, onSelect }: SceneEditorProps) {
  const scene = show.scenes.find((s) => s.id === sceneId)
  const [advanced, setAdvanced] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const previewing = editor.playing && editor.previewSceneId === sceneId

  useEffect(() => {
    // Leaving the editor stops the local preview.
    return () => {
      if (editor.previewSceneId === sceneId) backToLive()
    }
  }, [sceneId])

  if (!scene) return null

  function updateScene(update: Partial<SceneSpec>): void {
    onChange({
      ...show,
      scenes: show.scenes.map((s) => (s.id === sceneId ? { ...s, ...update } : s)),
    })
  }

  function updateTrack(trackId: string, update: Partial<TrackSpec>): void {
    updateScene({
      tracks: scene!.tracks.map((t) => (t.id === trackId ? { ...t, ...update } : t)),
    })
  }

  function applyPreset(preset: PresetSpec): void {
    const main = scene!.tracks[0]
    const applied: TrackSpec = {
      id: main?.id ?? crypto.randomUUID(),
      target: preset.target,
      effect: preset.effect,
      params: { ...preset.params },
      fadeIn: preset.fadeIn,
      fadeOut: preset.fadeOut,
    }
    updateScene({ tracks: [applied, ...scene!.tracks.slice(1)] })
  }

  // One look per wall, never two on the same one.
  function splitWalls(): void {
    const main = scene!.tracks[0]
    if (!main) return
    updateScene({
      tracks: [
        { ...main, target: 'wall-left' },
        { ...main, id: crypto.randomUUID(), target: 'wall-right', params: { ...main.params } },
      ],
    })
  }

  function mergeWalls(): void {
    const main = scene!.tracks[0]
    if (!main) return
    updateScene({ tracks: [{ ...main, target: 'both' }] })
  }

  function saveAsPreset(track: TrackSpec): void {
    const def = EFFECTS.find((e) => e.type === track.effect)
    const preset: PresetSpec = {
      id: crypto.randomUUID(),
      name: `${def?.label ?? track.effect} ${show.presets.length + 1}`,
      target: track.target,
      effect: track.effect,
      params: { ...track.params },
      fadeIn: track.fadeIn,
      fadeOut: track.fadeOut,
    }
    onChange({ ...show, presets: [...show.presets, preset] })
  }

  function deleteScene(): void {
    if (!window.confirm(`Delete “${scene!.name}”?`)) return
    if (editor.previewSceneId === sceneId) backToLive()
    onChange({ ...show, scenes: show.scenes.filter((s) => s.id !== sceneId) })
    onClose()
  }

  function duplicateScene(): void {
    const source = scene!
    const slot = findFreeSlot(show.scenes, source.end, source.end - source.start)
    const copy: SceneSpec = {
      id: crypto.randomUUID(),
      name: `${source.name} copy`,
      start: slot.start,
      end: slot.end,
      tracks: source.tracks.map((track) => ({
        ...track,
        id: crypto.randomUUID(),
        params: { ...track.params },
      })),
    }
    onChange({ ...show, scenes: [...show.scenes, copy] })
    onSelect(copy.id)
  }

  const mainLook = scene.tracks[0]
  const extraLooks = scene.tracks.slice(1)
  const splitByWall = extraLooks.length > 0

  const library = [...BUILTIN_PRESETS, ...show.presets]
  const currentPreset = mainLook
    ? library.find(
        (preset) => preset.effect === mainLook.effect && sameParams(mainLook.params, preset.params),
      )
    : undefined
  const lookName =
    currentPreset?.name ?? `${EFFECTS.find((e) => e.type === mainLook?.effect)?.label ?? 'Custom'} (edited)`

  return (
    <aside className="inspector">
      <header className="ins-head">
        <input
          className="ins-title"
          value={scene.name}
          placeholder="Name this moment"
          title="A scene is one moment of the show. Name it after what happens then."
          onChange={(e) => updateScene({ name: e.target.value })}
        />
        <button className="ins-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      <div className="ins-when">
        <TimeInput
          value={scene.start}
          onCommit={(v) =>
            updateScene({ start: clampTrimStart(show.scenes, sceneId, scene.start, scene.end, v) })
          }
        />
        <span className="ins-when-sep">→</span>
        <TimeInput
          value={scene.end}
          onCommit={(v) =>
            updateScene({ end: clampTrimEnd(show.scenes, sceneId, scene.start, scene.end, v) })
          }
        />
        <span className="ins-duration">{formatDuration(scene.end - scene.start)}</span>
      </div>

      <button
        className={`ins-preview ${previewing ? 'on' : ''}`}
        onClick={() => (previewing ? backToLive() : startPreview(scene.id))}
      >
        {previewing ? 'Stop preview' : 'Preview this scene'}
      </button>

      {/* The look, shown rather than named. The library opens in place instead
          of sitting permanently open: the panel is about this scene, not about
          the catalogue. */}
      {mainLook && (
        <section className="ins-section">
          <div className="ins-section-head">
            <span className="ins-label">Look</span>
            <button className="ins-link" onClick={() => setLibraryOpen(!libraryOpen)}>
              {libraryOpen ? 'Close' : 'Browse'}
            </button>
          </div>
          <LookThumb type={mainLook.effect} params={mainLook.params} width={300} height={46} />
          <span className="ins-look-name">{lookName}</span>

          {libraryOpen && (
            <div className="look-grid">
              {library.map((preset) => (
                <button
                  key={preset.id}
                  className={`look-card ${currentPreset?.id === preset.id ? 'active' : ''}`}
                  onClick={() => applyPreset(preset)}
                >
                  <LookThumb type={preset.effect} params={preset.params} width={132} height={30} />
                  <span>{preset.name}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Only the handful of parameters this look actually has. */}
      {mainLook && (
        <section className="ins-section">
          {splitByWall && <span className="ins-label">Left wall</span>}
          <LookControls
            look={mainLook}
            onUpdate={(update) => updateTrack(mainLook.id, update)}
            onSavePreset={() => saveAsPreset(mainLook)}
            hideWalls={splitByWall}
          />
        </section>
      )}

      <button className="ins-disclosure" onClick={() => setAdvanced(!advanced)}>
        <span className={`ins-caret ${advanced ? 'open' : ''}`}>›</span>
        Advanced
      </button>

      {advanced && (
        <div className="ins-advanced">
          {mainLook && (
            <section className="ins-section">
              <span className="ins-label">Effect</span>
              <div className="effect-picker">
                {EFFECTS.map((def) => (
                  <EffectChip
                    key={def.type}
                    type={def.type}
                    label={def.label}
                    active={mainLook.effect === def.type}
                    onClick={() =>
                      updateTrack(mainLook.id, {
                        effect: def.type,
                        params: defaultParams(def.type),
                      })
                    }
                  />
                ))}
              </div>
            </section>
          )}

          {mainLook && (
            <section className="ins-section">
              <span className="ins-label">Fades</span>
              <div className="param">
                <span className="param-label">In</span>
                <input
                  className="param-number"
                  type="number"
                  min={0}
                  step={0.1}
                  value={mainLook.fadeIn}
                  onChange={(e) =>
                    updateTrack(mainLook.id, {
                      fadeIn: round1(Math.max(0, e.target.valueAsNumber || 0)),
                    })
                  }
                />
                <span className="param-unit">s</span>
              </div>
              <div className="param">
                <span className="param-label">Out</span>
                <input
                  className="param-number"
                  type="number"
                  min={0}
                  step={0.1}
                  value={mainLook.fadeOut}
                  onChange={(e) =>
                    updateTrack(mainLook.id, {
                      fadeOut: round1(Math.max(0, e.target.valueAsNumber || 0)),
                    })
                  }
                />
                <span className="param-unit">s</span>
              </div>
            </section>
          )}

          {/* A scene shows at most one look per wall: the engine applies the
              last look matching a wall, so a second look on the same wall would
              simply hide the first. Split by wall or not at all. */}
          <section className="ins-section">
            <span className="ins-label">Walls</span>
            {splitByWall ? (
              <>
                <p className="ins-note">
                  Each wall runs its own look. The one above is the left wall.
                </p>
                {extraLooks[0] && (
                  <>
                    <div className="ins-section-head">
                      <span className="ins-label">Right wall</span>
                      <button className="ins-link" onClick={() => saveAsPreset(extraLooks[0])}>
                        Save as look
                      </button>
                    </div>
                    <LookControls
                      look={extraLooks[0]}
                      onUpdate={(update) => updateTrack(extraLooks[0].id, update)}
                      showEffects
                    />
                  </>
                )}
                <button className="ins-button" onClick={mergeWalls}>
                  Use one look for both walls
                </button>
              </>
            ) : (
              <button className="ins-button" onClick={splitWalls}>
                Give each wall its own look
              </button>
            )}
          </section>

          <ManagePresets show={show} onChange={onChange} />
        </div>
      )}

      <footer className="ins-foot">
        <button className="ins-button" onClick={duplicateScene}>
          Duplicate
        </button>
        <button className="ins-button danger" onClick={deleteScene}>
          Delete
        </button>
      </footer>
    </aside>
  )
}

// Which walls, and the few parameters of the chosen look. The effect *type* is
// picked from the look library, so its raw picker only shows under Advanced --
// two ways to choose a look side by side just made people guess.
function LookControls({
  look,
  onUpdate,
  onSavePreset,
  showEffects = false,
  hideWalls = false,
}: {
  look: TrackSpec
  onUpdate: (update: Partial<TrackSpec>) => void
  onSavePreset?: () => void
  showEffects?: boolean
  hideWalls?: boolean
}) {
  return (
    <>
      {!hideWalls && (
        <label className="param">
          <span className="param-label">Walls</span>
          <select
            className="param-select"
            value={look.target}
            onChange={(e) => onUpdate({ target: e.target.value as TrackTarget })}
          >
            {TARGETS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {showEffects && (
        <div className="effect-picker">
          {EFFECTS.map((def) => (
            <EffectChip
              key={def.type}
              type={def.type}
              label={def.label}
              active={look.effect === def.type}
              onClick={() => onUpdate({ effect: def.type, params: defaultParams(def.type) })}
            />
          ))}
        </div>
      )}

      {EFFECTS.find((e) => e.type === look.effect)?.params.map((param) => (
        <label className="param" key={param.key}>
          <span className="param-label">{param.label}</span>
          {param.type === 'color' ? (
            <input
              className="param-color"
              type="color"
              value={String(look.params[param.key] ?? param.default)}
              onChange={(e) => onUpdate({ params: { ...look.params, [param.key]: e.target.value } })}
            />
          ) : (
            <>
              <input
                type="range"
                min={param.min}
                max={param.max}
                step={param.step}
                value={Number(look.params[param.key] ?? param.default)}
                onChange={(e) =>
                  onUpdate({ params: { ...look.params, [param.key]: e.target.valueAsNumber } })
                }
              />
              <span className="param-value">{Number(look.params[param.key] ?? param.default)}</span>
            </>
          )}
        </label>
      ))}

      {onSavePreset && (
        <button className="ins-link left" onClick={onSavePreset}>
          Save as a look
        </button>
      )}
    </>
  )
}

function ManagePresets({ show, onChange }: { show: ShowFile; onChange: (show: ShowFile) => void }) {
  if (show.presets.length === 0) return null
  return (
    <section className="ins-section">
      <span className="ins-label">Your looks</span>
      {show.presets.map((preset) => (
        <div className="preset-row" key={preset.id}>
          <input
            value={preset.name}
            onChange={(e) =>
              onChange({
                ...show,
                presets: show.presets.map((p) =>
                  p.id === preset.id ? { ...p, name: e.target.value } : p,
                ),
              })
            }
          />
          <button
            className="ins-icon"
            title="Delete this look"
            onClick={() =>
              onChange({ ...show, presets: show.presets.filter((p) => p.id !== preset.id) })
            }
          >
            ✕
          </button>
        </div>
      ))}
    </section>
  )
}

// Animated strip rendered by the real engine, so a look is chosen by seeing it
// rather than by reading parameter names.
export function LookThumb({
  type,
  params,
  width = 56,
  height = 10,
}: {
  type: EffectType
  params: Record<string, ParamValue>
  width?: number
  height?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const paramsKey = JSON.stringify(params)

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const rendered = JSON.parse(paramsKey) as Record<string, ParamValue>
    const interval = setInterval(() => {
      const t = performance.now() / 1000
      for (let x = 0; x < width; x++) {
        const [r, g, b] = renderEffect(type, rendered, x / width, x, t)
        ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`
        ctx.fillRect(x, 0, 1, height)
      }
    }, 120)
    return () => clearInterval(interval)
  }, [type, paramsKey, width, height])

  return <canvas className="look-thumb" ref={canvasRef} width={width} height={height} />
}

// Same effect strip, with the effect's default parameters.
function EffectChip({
  type,
  label,
  active,
  onClick,
}: {
  type: EffectType
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button className={`effect-chip ${active ? 'active' : ''}`} onClick={onClick}>
      <LookThumb type={type} params={defaultParams(type)} width={64} height={12} />
      <span>{label}</span>
    </button>
  )
}

// Two looks match when the engine would render them identically.
function sameParams(a: Record<string, ParamValue>, b: Record<string, ParamValue>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}
