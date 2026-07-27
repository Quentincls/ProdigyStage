// Scene editor panel, radically simple (brief + Phase 5.5 UX pass):
// presets first, then ONE visible look (walls + effect + a few controls).
// Fades and extra layered looks live behind Advanced. No DMX anywhere.

import { useEffect, useRef, useState } from 'react'
import {
  defaultParams,
  EFFECTS,
  renderEffect,
  type EffectType,
  type SceneSpec,
  type TrackSpec,
  type TrackTarget,
} from '../../core/effects'
import { backToLive, editor, startPreview } from './editor'
import { type PresetSpec, type ShowFile } from './show'
import { round1, TimeInput } from './TimeInput'

interface SceneEditorProps {
  show: ShowFile
  sceneId: string
  onChange: (show: ShowFile) => void
  onClose: () => void
}

const TARGETS: { value: TrackTarget; label: string }[] = [
  { value: 'both', label: 'Both walls' },
  { value: 'wall-left', label: 'Left wall' },
  { value: 'wall-right', label: 'Right wall' },
]

export default function SceneEditor({ show, sceneId, onChange, onClose }: SceneEditorProps) {
  const scene = show.scenes.find((s) => s.id === sceneId)
  const [advanced, setAdvanced] = useState(false)
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

  function addLook(): void {
    updateScene({
      tracks: [
        ...scene!.tracks,
        {
          id: crypto.randomUUID(),
          target: 'both',
          effect: 'solid',
          params: defaultParams('solid'),
          fadeIn: 0.5,
          fadeOut: 0.5,
        },
      ],
    })
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
    if (editor.previewSceneId === sceneId) backToLive()
    onChange({ ...show, scenes: show.scenes.filter((s) => s.id !== sceneId) })
    onClose()
  }

  const mainLook = scene.tracks[0]
  const extraLooks = scene.tracks.slice(1)

  return (
    <aside className="panel panel-wide">
      <header className="panel-header scene-header">
        <input
          className="scene-name"
          value={scene.name}
          onChange={(e) => updateScene({ name: e.target.value })}
        />
        <button className="button" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="panel-section">
        <div className="field-row">
          <label className="field">
            <span>Start</span>
            <TimeInput value={scene.start} onCommit={(v) => updateScene({ start: v })} />
          </label>
          <label className="field">
            <span>End</span>
            <TimeInput value={scene.end} onCommit={(v) => updateScene({ end: v })} />
          </label>
          <div className="field">
            <span>&nbsp;</span>
            <button
              className={`button ${previewing ? '' : 'primary'}`}
              onClick={() => (previewing ? backToLive() : startPreview(scene.id))}
            >
              {previewing ? '■ Stop' : '▶ Preview'}
            </button>
          </div>
        </div>
      </div>

      {show.presets.length > 0 && (
        <div className="panel-section">
          <span className="panel-label">Start from a preset</span>
          <div className="chip-row">
            {show.presets.map((preset) => (
              <button key={preset.id} className="chip" onClick={() => applyPreset(preset)}>
                {preset.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {mainLook && (
        <LookControls
          look={mainLook}
          onUpdate={(update) => updateTrack(mainLook.id, update)}
          onSavePreset={() => saveAsPreset(mainLook)}
        />
      )}

      <button className="ghost-button advanced-toggle" onClick={() => setAdvanced(!advanced)}>
        {advanced ? '▾ Advanced' : '▸ Advanced'}
      </button>

      {advanced && (
        <>
          {mainLook && (
            <div className="panel-section">
              <span className="panel-label">Fades (s)</span>
              <div className="field-row">
                <label className="field">
                  <span>Fade in</span>
                  <input
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
                </label>
                <label className="field">
                  <span>Fade out</span>
                  <input
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
                </label>
              </div>
            </div>
          )}

          {extraLooks.map((look, index) => (
            <div className="panel-section track" key={look.id}>
              <div className="track-head">
                <span className="panel-label">Look {index + 2}</span>
                <div className="track-actions">
                  <button className="chip" onClick={() => saveAsPreset(look)}>
                    Save preset
                  </button>
                  <button
                    className="chip"
                    onClick={() =>
                      updateScene({ tracks: scene.tracks.filter((t) => t.id !== look.id) })
                    }
                  >
                    Remove
                  </button>
                </div>
              </div>
              <LookControls look={look} onUpdate={(update) => updateTrack(look.id, update)} />
            </div>
          ))}

          <button className="button" onClick={addLook}>
            + Add another look
          </button>

          <ManagePresets show={show} onChange={onChange} />

          <footer className="panel-footer">
            <button className="button danger" onClick={deleteScene}>
              Delete scene
            </button>
          </footer>
        </>
      )}
    </aside>
  )
}

// Target + effect + its few parameters. The whole vocabulary a user needs.
function LookControls({
  look,
  onUpdate,
  onSavePreset,
}: {
  look: TrackSpec
  onUpdate: (update: Partial<TrackSpec>) => void
  onSavePreset?: () => void
}) {
  return (
    <div className="panel-section">
      <select
        className="recording-select"
        value={look.target}
        onChange={(e) => onUpdate({ target: e.target.value as TrackTarget })}
      >
        {TARGETS.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>

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

      {EFFECTS.find((e) => e.type === look.effect)?.params.map((param) => (
        <label className="param-row" key={param.key}>
          <span>{param.label}</span>
          {param.type === 'color' ? (
            <input
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
        <button className="ghost-button save-preset" onClick={onSavePreset}>
          Save this look as a preset
        </button>
      )}
    </div>
  )
}

function ManagePresets({
  show,
  onChange,
}: {
  show: ShowFile
  onChange: (show: ShowFile) => void
}) {
  if (show.presets.length === 0) return null
  return (
    <div className="panel-section">
      <span className="panel-label">Manage presets</span>
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
            className="chip"
            onClick={() =>
              onChange({ ...show, presets: show.presets.filter((p) => p.id !== preset.id) })
            }
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

// Small animated strip previewing an effect with its default parameters.
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
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const params = defaultParams(type)
    const width = canvas.width
    const interval = setInterval(() => {
      const t = performance.now() / 1000
      for (let x = 0; x < width; x++) {
        const [r, g, b] = renderEffect(type, params, x / width, x, t)
        ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`
        ctx.fillRect(x, 0, 1, canvas.height)
      }
    }, 120)
    return () => clearInterval(interval)
  }, [type])

  return (
    <button className={`effect-chip ${active ? 'active' : ''}`} onClick={onClick}>
      <canvas ref={canvasRef} width={56} height={10} />
      <span>{label}</span>
    </button>
  )
}
