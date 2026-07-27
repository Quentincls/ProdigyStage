// Scene editor panel (brief Phase 5B). Radically simple on purpose: a scene
// is a time range plus a list of tracks; a track is target + effect + at most
// four controls + fades. No DMX concept anywhere.

import { useEffect, useRef } from 'react'
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

  function addTrack(from?: PresetSpec): void {
    const track: TrackSpec = from
      ? {
          id: crypto.randomUUID(),
          target: from.target,
          effect: from.effect,
          params: { ...from.params },
          fadeIn: from.fadeIn,
          fadeOut: from.fadeOut,
        }
      : {
          id: crypto.randomUUID(),
          target: 'both',
          effect: 'wave',
          params: defaultParams('wave'),
          fadeIn: 0.5,
          fadeOut: 0.5,
        }
    updateScene({ tracks: [...scene!.tracks, track] })
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

  function updatePreset(presetId: string, update: Partial<PresetSpec>): void {
    onChange({
      ...show,
      presets: show.presets.map((p) => (p.id === presetId ? { ...p, ...update } : p)),
    })
  }

  function deletePreset(presetId: string): void {
    onChange({ ...show, presets: show.presets.filter((p) => p.id !== presetId) })
  }

  function deleteScene(): void {
    if (editor.previewSceneId === sceneId) backToLive()
    onChange({ ...show, scenes: show.scenes.filter((s) => s.id !== sceneId) })
    onClose()
  }

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
              {previewing ? '■ Stop' : '▶ Preview loop'}
            </button>
          </div>
        </div>
      </div>

      {scene.tracks.map((track, index) => (
        <div className="panel-section track" key={track.id}>
          <div className="track-head">
            <span className="panel-label">Track {index + 1}</span>
            <div className="track-actions">
              <button className="chip" title="Save as preset" onClick={() => saveAsPreset(track)}>
                Save preset
              </button>
              <button
                className="chip"
                onClick={() => updateScene({ tracks: scene.tracks.filter((t) => t.id !== track.id) })}
              >
                Remove
              </button>
            </div>
          </div>

          <select
            className="recording-select"
            value={track.target}
            onChange={(e) => updateTrack(track.id, { target: e.target.value as TrackTarget })}
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
                active={track.effect === def.type}
                onClick={() =>
                  updateTrack(track.id, { effect: def.type, params: defaultParams(def.type) })
                }
              />
            ))}
          </div>

          {EFFECTS.find((e) => e.type === track.effect)?.params.map((param) => (
            <label className="param-row" key={param.key}>
              <span>{param.label}</span>
              {param.type === 'color' ? (
                <input
                  type="color"
                  value={String(track.params[param.key] ?? param.default)}
                  onChange={(e) =>
                    updateTrack(track.id, { params: { ...track.params, [param.key]: e.target.value } })
                  }
                />
              ) : (
                <>
                  <input
                    type="range"
                    min={param.min}
                    max={param.max}
                    step={param.step}
                    value={Number(track.params[param.key] ?? param.default)}
                    onChange={(e) =>
                      updateTrack(track.id, {
                        params: { ...track.params, [param.key]: e.target.valueAsNumber },
                      })
                    }
                  />
                  <span className="param-value">
                    {Number(track.params[param.key] ?? param.default)}
                  </span>
                </>
              )}
            </label>
          ))}

          <div className="field-row">
            <label className="field">
              <span>Fade in (s)</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={track.fadeIn}
                onChange={(e) =>
                  updateTrack(track.id, { fadeIn: round1(Math.max(0, e.target.valueAsNumber || 0)) })
                }
              />
            </label>
            <label className="field">
              <span>Fade out (s)</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={track.fadeOut}
                onChange={(e) =>
                  updateTrack(track.id, { fadeOut: round1(Math.max(0, e.target.valueAsNumber || 0)) })
                }
              />
            </label>
          </div>
        </div>
      ))}

      <button className="button" onClick={() => addTrack()}>
        + Add track
      </button>

      <div className="panel-section">
        <span className="panel-label">Presets</span>
        {show.presets.length === 0 && (
          <span className="muted-note">Save a configured track to reuse it anywhere.</span>
        )}
        {show.presets.map((preset) => (
          <div className="preset-row" key={preset.id}>
            <input
              value={preset.name}
              onChange={(e) => updatePreset(preset.id, { name: e.target.value })}
            />
            <button className="chip" onClick={() => addTrack(preset)}>
              Use
            </button>
            <button className="chip" onClick={() => deletePreset(preset.id)}>
              ×
            </button>
          </div>
        ))}
      </div>

      <footer className="panel-footer">
        <button className="button danger" onClick={deleteScene}>
          Delete scene
        </button>
      </footer>
    </aside>
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
