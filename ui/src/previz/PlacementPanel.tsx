// Placement mode: pick a fixture (in the 3D view or in the list below) or a
// whole wall, move it with numeric fields, save to patch.json on the server.
// No DMX concept anywhere -- positions and orientation only.

import { useMemo, useState } from 'react'
import type { Fixture, Patch } from '../patch'

interface PlacementPanelProps {
  patch: Patch
  selection: string[]
  dirty: boolean
  onSelect: (ids: string[]) => void
  onChange: (patch: Patch) => void
  onSave: () => Promise<void>
  onRevert: () => void
}

const AXES = ['X', 'Y', 'Z'] as const

export default function PlacementPanel({
  patch,
  selection,
  dirty,
  onSelect,
  onChange,
  onSave,
  onRevert,
}: PlacementPanelProps) {
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  const selectedFixtures = useMemo(
    () => patch.fixtures.filter((f) => selection.includes(f.id)),
    [patch, selection],
  )
  const single = selectedFixtures.length === 1 ? selectedFixtures[0] : null

  const centroid: [number, number, number] = useMemo(() => {
    if (selectedFixtures.length === 0) return [0, 0, 0]
    const sum = [0, 0, 0]
    for (const fixture of selectedFixtures) {
      sum[0] += fixture.position[0]
      sum[1] += fixture.position[1]
      sum[2] += fixture.position[2]
    }
    return [
      round(sum[0] / selectedFixtures.length),
      round(sum[1] / selectedFixtures.length),
      round(sum[2] / selectedFixtures.length),
    ]
  }, [selectedFixtures])

  function updateFixtures(mutate: (fixture: Fixture) => Fixture): void {
    onChange({
      ...patch,
      fixtures: patch.fixtures.map((f) => (selection.includes(f.id) ? mutate(f) : f)),
    })
  }

  function setPositionAxis(axis: number, value: number): void {
    if (Number.isNaN(value)) return
    const delta = value - centroid[axis]
    updateFixtures((fixture) => {
      const position = [...fixture.position] as [number, number, number]
      position[axis] = round(position[axis] + delta)
      return { ...fixture, position }
    })
  }

  function setRotationY(value: number): void {
    if (Number.isNaN(value)) return
    updateFixtures((fixture) => ({
      ...fixture,
      rotation: [fixture.rotation[0], round(value), fixture.rotation[2]],
    }))
  }

  async function handleSave(): Promise<void> {
    setSaveState('saving')
    try {
      await onSave()
      setSaveState('saved')
      setTimeout(() => setSaveState('idle'), 1500)
    } catch {
      setSaveState('error')
    }
  }

  return (
    <aside className="panel">
      <header className="panel-header">
        <h2>Placement</h2>
        <span className="muted">pick a batten in 3D or below</span>
      </header>

      <div className="panel-section">
        <span className="panel-label">Walls</span>
        <div className="chip-row">
          {patch.groups.map((group) => {
            const ids = patch.fixtures.filter((f) => f.group === group).map((f) => f.id)
            const active = ids.length > 0 && ids.every((id) => selection.includes(id))
            return (
              <button
                key={group}
                className={`chip ${active ? 'active' : ''}`}
                onClick={() => onSelect(active ? [] : ids)}
              >
                {group}
              </button>
            )
          })}
        </div>
      </div>

      <div className="panel-section">
        <span className="panel-label">Fixtures</span>
        <div className="fixture-grid">
          {patch.fixtures.map((fixture) => (
            <button
              key={fixture.id}
              className={`chip ${selection.includes(fixture.id) ? 'active' : ''}`}
              onClick={() => onSelect(selection.length === 1 && selection[0] === fixture.id ? [] : [fixture.id])}
            >
              {fixture.id}
            </button>
          ))}
        </div>
      </div>

      {selectedFixtures.length > 0 && (
        <div className="panel-section">
          <span className="panel-label">
            {single ? `${single.id} — position (m)` : `${selectedFixtures.length} fixtures — move together (m)`}
          </span>
          <div className="field-row">
            {AXES.map((axis, index) => (
              <label key={axis} className="field">
                <span>{axis}</span>
                <input
                  type="number"
                  step={0.1}
                  value={centroid[index]}
                  onChange={(e) => setPositionAxis(index, e.target.valueAsNumber)}
                />
              </label>
            ))}
          </div>
          {single && (
            <div className="field-row">
              <label className="field">
                <span>Rotation Y (deg)</span>
                <input
                  type="number"
                  step={5}
                  value={single.rotation[1]}
                  onChange={(e) => setRotationY(e.target.valueAsNumber)}
                />
              </label>
            </div>
          )}
        </div>
      )}

      <footer className="panel-footer">
        <button className="button primary" disabled={!dirty || saveState === 'saving'} onClick={() => void handleSave()}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Save to patch'}
        </button>
        <button className="button" disabled={!dirty} onClick={onRevert}>
          Revert
        </button>
        {saveState === 'error' && <span className="error-text">Save failed — server offline?</span>}
      </footer>
    </aside>
  )
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
