// What the selected lights are, and what to make them do.
//
// Three readings of the same selection, and the order between them is the whole
// point.
//
//   what it is      the name you selected it by, and what it is made of
//   what to do      controls, built from what these fixtures can actually do
//   what it is      the manufacturer, the universe, the channel, the raw bytes
//                   -- true, necessary, and folded away until something is wrong
//
// The controls are generated, never written per model. A fixture declares its
// capabilities and this panel shows one row per capability the whole selection
// shares; a behaviour is offered only when every selected fixture can perform
// it. That is what stops a warm-white panel being handed a colour picker, and a
// fixture bolted to a wall being offered Sweep.
//
// Two things it will not do, and both are deliberate. It will not show a
// control for a capability nobody has confirmed -- an invented control is a
// promise the rig cannot keep. And it will not send anything: turning a slider
// lights the previz and nothing else, until the operator makes a light layer
// out of it.

import { useEffect, useMemo, useState } from 'react'
import {
  behaviorsFor,
  defaultBehaviorParams,
  paramsFor,
  type BehaviorType,
} from '../../core/behaviors'
import type { ParamValue } from '../../core/effects'
import {
  blankState,
  capabilitiesOf,
  familyName,
  kindOf,
  litColour,
  physicalCapabilities,
  readFixture,
  type Capability,
} from '../../core/fixtures'
import { clearPreview, setPreview } from './editor'
import { feed } from './feed'
import { families, selectionName } from './lightGroups'
import { countRender } from './perf'
import type { Fixture, Patch } from './patch'

const KIND_LABEL: Record<string, string> = {
  batten: 'Batten',
  movinghead: 'Moving head',
  blinder: 'Blinder',
  panel: 'Panel',
  fog: 'Haze',
  unknown: 'Unknown',
}

export function FixtureInspector({
  patch,
  selection,
  onSelect,
  onClose,
  onCommit,
  playhead,
}: {
  patch: Patch
  selection: string[]
  onSelect: (ids: string[]) => void
  onClose: () => void
  onCommit: (behavior: BehaviorType, params: Record<string, ParamValue>) => void
  playhead: number | null
}) {
  countRender('Inspector')
  const [advanced, setAdvanced] = useState(false)
  const [behavior, setBehavior] = useState<BehaviorType>('static')
  const [params, setParams] = useState<Record<string, ParamValue>>(() => defaultBehaviorParams('static'))
  const [designing, setDesigning] = useState(false)

  const chosen = useMemo(
    () => patch.fixtures.filter((fixture) => selection.includes(fixture.id)),
    [patch, selection],
  )
  const parts = useMemo(() => families(patch, chosen), [patch, chosen])
  const first = chosen[0]
  const profile = first ? patch.fixtureTypes[first.type] : undefined
  const sameModel = parts.length === 1

  // What every selected fixture can do. The intersection, not the union: a
  // control that only half the selection understands is a control that does
  // half of what it says.
  const capabilities = useMemo(() => commonCapabilities(patch, chosen), [patch, chosen])
  const available = useMemo(() => behaviorsFor(capabilities), [capabilities])

  // A selection change ends the design: the controls belonged to what was
  // selected, and silently carrying them onto something else would apply a
  // colour to a family that cannot show it.
  useEffect(() => {
    setDesigning(false)
    clearPreview()
  }, [selection])

  useEffect(() => () => clearPreview(), [])

  // Anything the operator touches goes straight to the previz and nowhere else.
  function design(nextBehavior: BehaviorType, nextParams: Record<string, ParamValue>): void {
    setBehavior(nextBehavior)
    setParams(nextParams)
    setDesigning(true)
    setPreview(selection, nextBehavior, nextParams)
  }

  function setParam(key: string, value: ParamValue): void {
    design(behavior, { ...params, [key]: value })
  }

  function chooseBehavior(next: BehaviorType): void {
    design(next, defaultBehaviorParams(next))
  }

  if (chosen.length === 0) return null

  const title = selectionName(patch, selection) ?? (chosen.length === 1 ? first.id : `${chosen.length} lights`)
  const count = `${chosen.length} lights`
  const family = sameModel ? familyName(profile) : null
  const subtitle = family && family !== title ? family : count !== title ? count : null
  const chosenDef = available.find((def) => def.type === behavior)
  const behaviorParams = chosenDef ? paramsFor(chosenDef, capabilities) : []

  return (
    <aside className="inspector">
      <header className="ins-head">
        <h2 className="ins-title-static">{title}</h2>
        <button className="ins-close" title="Clear the selection" onClick={onClose}>
          ×
        </button>
      </header>
      {subtitle && (
        <div className="ins-when">
          <span className="compose-when-value">{subtitle}</span>
        </div>
      )}

      {/* What the selection is made of -- and the way down into it. A click
          keeps one family and drops the rest, which is how you get from "stage
          left" to "the panels on stage left" without a permanent fixture tree. */}
      {chosen.length > 1 && (
        <section className="ins-section">
          <span className="ins-label">Includes</span>
          <div className="fixture-list">
            {parts.map((part) => (
              <button
                key={part.type}
                className="family-row"
                onClick={() => onSelect(part.ids)}
                title={parts.length > 1 ? `Keep only the ${part.label}` : 'Already the whole selection'}
              >
                <span className="family-row-name">{part.label}</span>
                <span className="family-row-count">{part.ids.length}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {capabilities.length === 0 ? (
        <p className="direction-why">
          {sameModel
            ? 'Nothing is documented about what this model can do, so Stage will not offer controls it cannot stand behind. Its raw values are under Advanced — move one fader on the console and watch which number moves.'
            : 'These families have nothing in common that Stage can drive. Pick one above.'}
        </p>
      ) : (
        <>
          <section className="ins-section">
            <span className="ins-label">Behaviour</span>
            <div className="behavior-picker">
              {available.map((def) => (
                <button
                  key={def.type}
                  className={`behavior-chip ${designing && behavior === def.type ? 'on' : ''}`}
                  title={def.hint}
                  onClick={() => chooseBehavior(def.type)}
                >
                  {def.label}
                </button>
              ))}
            </div>
          </section>

          {designing && behaviorParams.length > 0 && (
            <section className="ins-section">
              <span className="ins-label">How</span>
              {behaviorParams.map((param) => (
                <ParamRow
                  key={param.key}
                  label={param.label}
                  type={param.type}
                  min={param.min}
                  max={param.max}
                  step={param.step}
                  value={params[param.key] ?? param.default}
                  onChange={(value) => setParam(param.key, value)}
                />
              ))}
            </section>
          )}

          {designing && (
            <button className="primary-button ins-commit" onClick={() => onCommit(behavior, params)}>
              Add to timeline{playhead !== null ? ` at ${formatClock(playhead)}` : ''}
            </button>
          )}

          {/* What these fixtures can do that Stage is not driving yet. Said
              plainly rather than shown as dead controls. */}
          <Capabilities capabilities={capabilities} />
        </>
      )}

      {!designing && (
        <section className="ins-section">
          <span className="ins-label">Doing now</span>
          <LiveState patch={patch} fixtures={chosen} />
        </section>
      )}

      <button className="ins-disclosure" onClick={() => setAdvanced(!advanced)}>
        <span className={`ins-caret ${advanced ? 'open' : ''}`}>›</span>
        Advanced
      </button>

      {advanced && (
        <div className="ins-advanced">
          <section className="ins-section">
            <span className="ins-label">Models</span>
            {parts.map((part) => {
              const type = patch.fixtureTypes[part.type]
              const decoded = type ? capabilitiesOf(type) : []
              return (
                <div key={part.type}>
                  <div className="ins-fact">
                    <span className="ins-fact-key">{type?.name ?? part.type}</span>
                    <span className="ins-fact-value">
                      {KIND_LABEL[kindOf(type ?? { name: '', footprint: 0 })] ?? 'Unknown'} ·{' '}
                      {type?.footprint ?? 0} ch
                    </span>
                  </div>
                  <div className="ins-fact">
                    <span className="ins-fact-key">Stage can read</span>
                    <span className="ins-fact-value">
                      {decoded.length > 0 ? decoded.join(', ') : 'nothing — channel chart unconfirmed'}
                    </span>
                  </div>
                  {type?.optics && (
                    <div className="ins-fact">
                      <span className="ins-fact-key">Optics</span>
                      <span className="ins-fact-value">
                        {[
                          type.optics.beamAngleDeg !== undefined &&
                            `${type.optics.beamAngleDeg}${type.optics.beamAngleWideDeg !== undefined ? `–${type.optics.beamAngleWideDeg}` : ''}°`,
                          type.optics.colourTemperatureK !== undefined && `${type.optics.colourTemperatureK} K`,
                        ]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
          </section>

          <section className="ins-section">
            <div className="ins-section-head">
              <span className="ins-label">Addresses</span>
              {chosen.length > 1 && (
                <button className="ins-link" onClick={() => onSelect([first.id])}>
                  Just this one
                </button>
              )}
            </div>
            <div className="fixture-list">
              {chosen.slice(0, 12).map((fixture) => (
                <button
                  key={fixture.id}
                  className="fixture-row"
                  onClick={() => onSelect([fixture.id])}
                  title="Show only this one"
                >
                  <span className="fixture-row-id">{fixture.id}</span>
                  <span className="fixture-row-where">
                    universe {fixture.universe} · channel {fixture.address}
                  </span>
                </button>
              ))}
              {chosen.length > 12 && <span className="muted-note">and {chosen.length - 12} more</span>}
            </div>
          </section>

          {/* Every byte of one fixture's footprint, as the console is sending
              them. The tool for filling in a chart nobody wrote down, and the
              only reason a channel number appears anywhere in this panel. */}
          <section className="ins-section">
            <span className="ins-label">Raw values — {first.id}</span>
            <RawChannels patch={patch} fixture={first} />
          </section>
        </div>
      )}
    </aside>
  )
}

/**
 * What every fixture in the selection can do.
 *
 * The intersection. A mixed selection of battens and panels can be dimmed --
 * both dim -- and cannot be given a gradient, because half of them are one
 * warm-white emitter. Which is exactly what the operator would expect, and
 * exactly what a union would get wrong.
 */
function commonCapabilities(patch: Patch, chosen: Fixture[]): Capability[] {
  if (chosen.length === 0) return []
  const types = [...new Set(chosen.map((fixture) => fixture.type))]
  let common: Capability[] | null = null
  for (const type of types) {
    const capabilities = physicalCapabilities(patch.fixtureTypes[type])
    common = common === null ? capabilities : common.filter((each) => capabilities.includes(each))
  }
  return common ?? []
}

/** Named plainly rather than shown as controls that do not exist yet. */
function Capabilities({ capabilities }: { capabilities: Capability[] }) {
  const driven = new Set(['intensity', 'color', 'strobe', 'pan', 'tilt', 'fog'])
  const rest = capabilities.filter((capability) => !driven.has(capability))
  if (rest.length === 0) return null
  return (
    <div className="ins-fact">
      <span className="ins-fact-key">Also has</span>
      <span className="ins-fact-value">{rest.join(', ')}</span>
    </div>
  )
}

function ParamRow({
  label,
  type,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string
  type: 'color' | 'range'
  min?: number
  max?: number
  step?: number
  value: ParamValue
  onChange: (value: ParamValue) => void
}) {
  if (type === 'color') {
    return (
      <div className="param">
        <span className="param-label">{label}</span>
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
      <span className="param-label">{label}</span>
      <input
        type="range"
        min={min ?? 0}
        max={max ?? 1}
        step={step ?? 0.01}
        value={numeric}
        onChange={(event) => onChange(event.target.valueAsNumber)}
      />
      <span className="param-value">{formatParam(numeric, min, max)}</span>
    </div>
  )
}

function formatParam(value: number, min?: number, max?: number): string {
  if (min === 0 && max === 1) return `${Math.round(value * 100)}%`
  return String(Math.round(value * 100) / 100)
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`
}

/** The selection's normalised state, averaged: the level the operator thinks
 *  in, never a byte. Read on a timer so nothing here re-renders the previz. */
function LiveState({ patch, fixtures }: { patch: Patch; fixtures: Fixture[] }) {
  const [, tick] = useState(0)
  useEffect(() => {
    // Fast enough to read as live, slow enough that the viewport keeps the
    // frame budget. This panel is never the thing you are watching.
    const id = setInterval(() => tick((n) => n + 1), 200)
    return () => clearInterval(id)
  }, [])

  const colour: [number, number, number] = [0, 0, 0]
  const scratch = blankState()
  let intensity = 0
  let tilt = 0
  let tilts = 0
  let r = 0
  let g = 0
  let b = 0
  let live = 0
  for (const fixture of fixtures) {
    const state = readFixture(
      patch.fixtureTypes[fixture.type],
      feed.universes.get(fixture.universe) ?? null,
      fixture.address - 1,
      feed.active.get(fixture.universe) === true,
      scratch,
    )
    if (!state.known) continue
    live++
    intensity += state.lit ? state.intensity : 0
    litColour(state, colour)
    r += colour[0]
    g += colour[1]
    b += colour[2]
    if (state.tilt !== null) {
      tilt += (state.tilt * 180) / Math.PI
      tilts++
    }
  }
  if (live === 0) {
    return <span className="muted-note">Stage cannot read what the console is sending these.</span>
  }
  const swatch = `rgb(${Math.round((r / live) * 255)}, ${Math.round((g / live) * 255)}, ${Math.round((b / live) * 255)})`

  return (
    <>
      <div className="param">
        <span className="param-label">Intensity</span>
        <div className="live-bar">
          <div className="live-bar-fill" style={{ width: `${Math.round((intensity / live) * 100)}%` }} />
        </div>
        <span className="param-value">{Math.round((intensity / live) * 100)}%</span>
      </div>
      <div className="param">
        <span className="param-label">Colour</span>
        <span className="live-swatch" style={{ background: swatch }} />
        <span className="param-value" />
      </div>
      {tilts > 0 && (
        <div className="param">
          <span className="param-label">Tilt</span>
          <div className="live-bar">
            <div
              className="live-bar-fill centred"
              style={{ left: `${50 + Math.min(50, Math.max(-50, (tilt / tilts / 110) * 50))}%` }}
            />
          </div>
          <span className="param-value">{Math.round(tilt / tilts)}°</span>
        </div>
      )}
    </>
  )
}

function RawChannels({ patch, fixture }: { patch: Patch; fixture: Fixture }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 200)
    return () => clearInterval(id)
  }, [])

  const profile = patch.fixtureTypes[fixture.type]
  const buffer = feed.universes.get(fixture.universe)
  const live = buffer !== undefined && feed.active.get(fixture.universe) === true
  if (!live) return <span className="muted-note">Nothing is sending universe {fixture.universe}.</span>

  const base = fixture.address - 1
  const channels = Array.from({ length: profile?.footprint ?? 0 }, (_, index) => ({
    number: index + 1,
    value: buffer![base + index] ?? 0,
  }))
  return (
    <div className="raw-grid">
      {channels.map((channel) => (
        <div key={channel.number} className={`raw-cell ${channel.value > 0 ? 'on' : ''}`}>
          <span className="raw-ch">{channel.number}</span>
          <span className="raw-value">{channel.value}</span>
        </div>
      ))}
    </div>
  )
}
