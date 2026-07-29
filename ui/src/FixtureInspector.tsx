// What the selected lights are, and what they are doing right now.
//
// Two readings of the same selection, and the order between them is the whole
// point. On top: the name you selected it by, what it is made of, and what it
// is doing -- nothing here is a number an operator would have to be taught.
// Underneath, folded away: the manufacturer's name, the universe, the channel,
// the raw bytes. All of that is true and none of it is what you came for, so it
// waits behind one click and stays there until something is wrong.
//
// The inspector builds itself from what a fixture can actually do -- the
// capabilities its profile declares -- rather than from a universal list of
// every parameter in the rig. A panel that dims and has white shows two rows;
// a moving head shows the ones it has. A family whose chart is not in the
// lighting document shows none of them and says so, because drawing controls
// for channels nobody has confirmed is how a previz starts lying.

import { useEffect, useState } from 'react'
import {
  blankState,
  capabilitiesOf,
  familyName,
  kindOf,
  litColour,
  readFixture,
  type Capability,
} from '../../core/fixtures'
import { feed } from './feed'
import { families, selectionName } from './lightGroups'
import type { Fixture, Patch } from './patch'
import { countRender } from './perf'

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
}: {
  patch: Patch
  selection: string[]
  onSelect: (ids: string[]) => void
  onClose: () => void
}) {
  countRender('Inspector')
  const [advanced, setAdvanced] = useState(false)
  // The console is a moving target, so this reads it on a timer rather than
  // through React state: nothing here should make the previz re-render.
  const [, tick] = useState(0)
  useEffect(() => {
    // Fast enough to read as live, slow enough that the viewport keeps the
    // frame budget. This panel is never the thing you are watching.
    const id = setInterval(() => tick((n) => n + 1), 200)
    return () => clearInterval(id)
  }, [])

  const chosen = patch.fixtures.filter((fixture) => selection.includes(fixture.id))
  if (chosen.length === 0) return null

  const first = chosen[0]
  const profile = patch.fixtureTypes[first.type]
  const parts = families(patch, chosen)
  const sameModel = parts.length === 1
  const capabilities = sameModel ? capabilitiesOf(profile) : []
  const readable = sameModel && profile?.standardMap !== undefined
  // A selection made by clicking a name keeps that name; one made by clicking
  // lights in the room is counted instead, because it has no other name.
  const title =
    selectionName(patch, selection) ?? (chosen.length === 1 ? first.id : `${chosen.length} lights`)
  // The second line says whichever of the two facts the first one did not: what
  // they are, or how many. Never both, and never the title again -- a header
  // that repeats itself is a header nobody reads the second line of.
  const count = `${chosen.length} lights`
  const family = sameModel ? familyName(profile) : null
  const subtitle = family && family !== title ? family : count !== title ? count : null

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

      {/* What the selection is made of -- and the way back down into it. A
          click keeps one family and drops the rest, which is how you get from
          "stage left" to "the panels on stage left" without a fixture tree. */}
      {chosen.length > 1 && (
        <section className="ins-section">
          <span className="ins-label">Includes</span>
          <div className="fixture-list">
            {parts.map((family) => (
              <button
                key={family.type}
                className="family-row"
                onClick={() => onSelect(family.ids)}
                title={parts.length > 1 ? `Keep only the ${family.label}` : 'Already the whole selection'}
              >
                <span className="family-row-name">{family.label}</span>
                <span className="family-row-count">{family.ids.length}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {readable && capabilities.length > 0 && (
        <section className="ins-section">
          <span className="ins-label">Doing now</span>
          <LiveState patch={patch} fixtures={chosen} capabilities={capabilities} />
        </section>
      )}

      {!readable && (
        <p className="direction-why">
          {sameModel
            ? 'The channel chart for this model is not in the lighting document, so Stage cannot say what it is doing. Open Advanced to see the raw values the console is sending it — move one fader and watch which number moves.'
            : 'Several families at once. Pick one above to see what it is doing.'}
        </p>
      )}

      <button className="ins-disclosure" onClick={() => setAdvanced(!advanced)}>
        <span className={`ins-caret ${advanced ? 'open' : ''}`}>›</span>
        Advanced
      </button>

      {advanced && (
        <div className="ins-advanced">
          <section className="ins-section">
            <span className="ins-label">Models</span>
            {parts.map((family) => {
              const type = patch.fixtureTypes[family.type]
              return (
                <div className="ins-fact" key={family.type}>
                  <span className="ins-fact-key">{type?.name ?? family.type}</span>
                  <span className="ins-fact-value">
                    {KIND_LABEL[kindOf(type ?? { name: '', footprint: 0 })] ?? 'Unknown'} ·{' '}
                    {type?.footprint ?? 0} ch
                    {type?.standardMap === undefined && ' · chart unknown'}
                  </span>
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
              {chosen.length > 12 && (
                <span className="muted-note">and {chosen.length - 12} more</span>
              )}
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

/** The selection's normalised state, averaged when several are chosen: this is
 *  the level the operator thinks in, never a byte. */
function LiveState({
  patch,
  fixtures,
  capabilities,
}: {
  patch: Patch
  fixtures: Fixture[]
  capabilities: Capability[]
}) {
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
    return <span className="muted-note">Nothing is sending this universe.</span>
  }
  const swatch = `rgb(${Math.round((r / live) * 255)}, ${Math.round((g / live) * 255)}, ${Math.round((b / live) * 255)})`

  return (
    <>
      {capabilities.includes('intensity') && (
        <div className="param">
          <span className="param-label">Intensity</span>
          <div className="live-bar">
            <div className="live-bar-fill" style={{ width: `${Math.round((intensity / live) * 100)}%` }} />
          </div>
          <span className="param-value">{Math.round((intensity / live) * 100)}%</span>
        </div>
      )}
      {capabilities.includes('color') && (
        <div className="param">
          <span className="param-label">Colour</span>
          <span className="live-swatch" style={{ background: swatch }} />
          <span className="param-value" />
        </div>
      )}
      {capabilities.includes('tilt') && tilts > 0 && (
        <div className="param">
          <span className="param-label">Tilt</span>
          <div className="live-bar">
            <div
              className="live-bar-fill centred"
              style={{
                left: `${50 + Math.min(50, Math.max(-50, (tilt / tilts / 110) * 50))}%`,
              }}
            />
          </div>
          <span className="param-value">{Math.round(tilt / tilts)}°</span>
        </div>
      )}
    </>
  )
}

function RawChannels({ patch, fixture }: { patch: Patch; fixture: Fixture }) {
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
