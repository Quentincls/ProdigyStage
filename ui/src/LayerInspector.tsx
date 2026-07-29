// A light layer, and what is inside it.
//
// Two panels, one component, because they are two depths of the same thing.
// Selecting the layer shows what it drives; selecting one of its families shows
// how that family behaves. The viewport follows both -- pick the layer and its
// whole reach lights up, pick Beams inside it and only the beams do.
//
// This is the third corner of the rule the application now keeps: the timeline
// says WHEN, the viewport says WHAT and WHERE, and this says HOW. Selecting
// anything here replaces the selection everywhere else, so the three can never
// be showing three different things.

import { useMemo } from 'react'
import {
  behaviorsFor,
  defaultBehaviorParams,
  paramsFor,
  type BehaviorType,
} from '../../core/behaviors'
import type { ParamValue } from '../../core/effects'
import { familyName, physicalCapabilities, type Capability } from '../../core/fixtures'
import { partMatches, type FixtureRef, type LayerPart, type LightLayer } from '../../core/layers'
import { behaviorDef } from '../../core/behaviors'
import { countRender } from './perf'
import type { Patch } from './patch'
import type { ShowFile } from './show'
import { formatTime, TimeInput } from './TimeInput'

export function LayerInspector({
  show,
  patch,
  layerId,
  partId,
  onChange,
  onSelectPart,
  onClose,
}: {
  show: ShowFile
  patch: Patch
  layerId: string
  partId: string | null
  onChange: (show: ShowFile) => void
  onSelectPart: (partId: string | null) => void
  onClose: () => void
}) {
  countRender('LayerInspector')
  const layer = (show.layers ?? []).find((each) => each.id === layerId)
  const refs = useMemo<FixtureRef[]>(
    () => patch.fixtures.map((f) => ({ id: f.id, type: f.type, group: f.group })),
    [patch],
  )
  if (!layer) return null
  const part = partId ? layer.parts.find((each) => each.id === partId) : null

  function updateLayer(update: Partial<LightLayer>): void {
    onChange({
      ...show,
      layers: (show.layers ?? []).map((each) => (each.id === layerId ? { ...each, ...update } : each)),
    })
  }

  function updatePart(id: string, update: Partial<LayerPart>): void {
    updateLayer({
      parts: layer!.parts.map((each) => (each.id === id ? { ...each, ...update } : each)),
    })
  }

  function removeLayer(): void {
    if (!window.confirm(`Delete “${layer!.name}”?`)) return
    onChange({ ...show, layers: (show.layers ?? []).filter((each) => each.id !== layerId) })
    onClose()
  }

  function removePart(id: string): void {
    if (layer!.parts.length <= 1) {
      removeLayer()
      return
    }
    updateLayer({ parts: layer!.parts.filter((each) => each.id !== id) })
    onSelectPart(null)
  }

  // ----- one family inside the layer ---------------------------------------
  if (part) {
    const members = refs.filter((fixture) => partMatches(part, fixture))
    const capabilities = commonCapabilities(patch, members.map((m) => m.type))
    const available = behaviorsFor(capabilities)
    const def = available.find((each) => each.type === part.behavior)
    const params = def ? paramsFor(def, capabilities) : []

    return (
      <aside className="inspector">
        <header className="ins-head">
          <h2 className="ins-title-static">{partLabel(part, patch)}</h2>
          <button className="ins-close" title="Back to the layer" onClick={() => onSelectPart(null)}>
            ×
          </button>
        </header>
        <div className="ins-when">
          <span className="compose-when-value">
            {members.length} light{members.length === 1 ? '' : 's'}
          </span>
          <span className="ins-duration">in {layer.name}</span>
        </div>

        <section className="ins-section">
          <span className="ins-label">Behaviour</span>
          <div className="behavior-picker">
            {available.map((each) => (
              <button
                key={each.type}
                className={`behavior-chip ${part.behavior === each.type ? 'on' : ''}`}
                title={each.hint}
                onClick={() =>
                  updatePart(part.id, { behavior: each.type, params: defaultBehaviorParams(each.type) })
                }
              >
                {each.label}
              </button>
            ))}
          </div>
        </section>

        {params.length > 0 && (
          <section className="ins-section">
            <span className="ins-label">How</span>
            {params.map((param) => (
              <ParamRow
                key={param.key}
                param={param}
                value={part.params[param.key] ?? param.default}
                onChange={(value) =>
                  updatePart(part.id, { params: { ...part.params, [param.key]: value } })
                }
              />
            ))}
          </section>
        )}

        <section className="ins-section">
          <span className="ins-label">Fades</span>
          <ParamRow
            param={{ key: 'fadeIn', label: 'In', type: 'range', min: 0, max: 5, step: 0.1, default: 0.4 }}
            value={part.fadeIn}
            onChange={(value) => updatePart(part.id, { fadeIn: Number(value) })}
          />
          <ParamRow
            param={{ key: 'fadeOut', label: 'Out', type: 'range', min: 0, max: 5, step: 0.1, default: 0.4 }}
            value={part.fadeOut}
            onChange={(value) => updatePart(part.id, { fadeOut: Number(value) })}
          />
        </section>

        <button className="ins-button danger" onClick={() => removePart(part.id)}>
          Remove from this layer
        </button>
      </aside>
    )
  }

  // ----- the layer itself ---------------------------------------------------
  return (
    <aside className="inspector">
      <header className="ins-head">
        <input
          className="ins-title"
          value={layer.name}
          onChange={(event) => updateLayer({ name: event.target.value })}
        />
        <button className="ins-close" title="Clear the selection" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="ins-when">
        <span className="compose-when-value">{formatTime(layer.start)}</span>
        <span className="ins-when-sep">→</span>
        <TimeInput
          value={layer.end}
          onCommit={(end: number) => updateLayer({ end: Math.max(layer.start + 0.5, end) })}
        />
        <span className="ins-duration">{formatDuration(layer.end - layer.start)}</span>
      </div>

      {/* What this layer drives, one row per family. Clicking a row is how you
          get inside it -- and how a fixture that is an exception gets a row of
          its own without every fixture getting one. */}
      <section className="ins-section">
        <span className="ins-label">Drives</span>
        <div className="fixture-list">
          {layer.parts.map((each) => {
            const members = refs.filter((fixture) => partMatches(each, fixture))
            return (
              <button key={each.id} className="family-row" onClick={() => onSelectPart(each.id)}>
                <span className="family-row-name">{partLabel(each, patch)}</span>
                <span className="family-row-count">
                  {behaviorDef(each.behavior)?.label ?? each.behavior} · {members.length}
                </span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="ins-section">
        <span className="ins-label">Starts</span>
        <TimeInput value={layer.start} onCommit={(start: number) => updateLayer({ start: Math.max(0, start) })} />
      </section>

      <button className="ins-button danger" onClick={removeLayer}>
        Delete this layer
      </button>
    </aside>
  )
}

function commonCapabilities(patch: Patch, types: string[]): Capability[] {
  let common: Capability[] | null = null
  for (const type of [...new Set(types)]) {
    const capabilities = physicalCapabilities(patch.fixtureTypes[type])
    common = common === null ? capabilities : common.filter((each) => capabilities.includes(each))
  }
  return common ?? []
}

function partLabel(part: LayerPart, patch: Patch): string {
  if (part.target.kind === 'fixture') return part.target.key
  if (part.target.kind === 'family') {
    return familyName(patch.fixtureTypes[part.target.key])
  }
  return part.target.key.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function ParamRow({
  param,
  value,
  onChange,
}: {
  param: { key: string; label: string; type: 'color' | 'range'; min?: number; max?: number; step?: number; default: ParamValue }
  value: ParamValue
  onChange: (value: ParamValue) => void
}) {
  if (param.type === 'color') {
    return (
      <div className="param">
        <span className="param-label">{param.label}</span>
        <input
          className="param-color"
          type="color"
          value={typeof value === 'string' ? value : '#ffffff'}
          onChange={(event) => onChange(event.target.value)}
        />
        <span className="param-value" />
      </div>
    )
  }
  const numeric = typeof value === 'number' ? value : 0
  return (
    <div className="param">
      <span className="param-label">{param.label}</span>
      <input
        type="range"
        min={param.min ?? 0}
        max={param.max ?? 1}
        step={param.step ?? 0.01}
        value={numeric}
        onChange={(event) => onChange(event.target.valueAsNumber)}
      />
      <span className="param-value">
        {param.min === 0 && param.max === 1 ? `${Math.round(numeric * 100)}%` : Math.round(numeric * 100) / 100}
      </span>
    </div>
  )
}

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`
}

export type { BehaviorType }
