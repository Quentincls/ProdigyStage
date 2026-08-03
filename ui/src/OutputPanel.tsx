// Phase 6 tool: the control that lets this software drive the real lights.
// Deliberately slow to arm (press and hold), instant to stop. Plain words
// only -- no DMX vocabulary, per the product rules.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { feed, type OutputMode } from './feed'
import { targetsPointingAtTheConsole, unroutableTargets } from './net'
import { controlOutput } from './show'

const HOLD_MS = 1000

// Press-and-hold: going live on real fixtures is never one careless click.
function HoldButton({ label, onComplete }: { label: string; onComplete: () => void }) {
  const [progress, setProgress] = useState(0)
  const raf = useRef(0)
  const startedAt = useRef(0)

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  function tick(): void {
    const elapsed = performance.now() - startedAt.current
    const ratio = Math.min(1, elapsed / HOLD_MS)
    setProgress(ratio)
    if (ratio >= 1) {
      setProgress(0)
      onComplete()
      return
    }
    raf.current = requestAnimationFrame(tick)
  }

  function start(event: React.PointerEvent): void {
    event.currentTarget.setPointerCapture(event.pointerId)
    startedAt.current = performance.now()
    raf.current = requestAnimationFrame(tick)
  }

  function cancel(): void {
    cancelAnimationFrame(raf.current)
    setProgress(0)
  }

  return (
    <button
      className="button hold-button"
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
    >
      <span className="hold-fill" style={{ width: `${progress * 100}%` }} />
      <span className="hold-label">{progress > 0 ? 'Keep holding…' : label}</span>
    </button>
  )
}

export default function OutputPanel({ onClose }: { onClose: () => void }) {
  const { stats } = useSyncExternalStore(feed.subscribe, feed.getSnapshot)
  const [error, setError] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [targetDraft, setTargetDraft] = useState('')

  const output = stats?.output
  const mode: OutputMode = output?.mode ?? 'off'
  const configured = (output?.targets.length ?? 0) > 0
  const loopedBack = targetsPointingAtTheConsole(stats)
  const unroutable = unroutableTargets(stats)
  const consoleAddress = stats
    ? (Object.values(stats.perUniverse).find((universe) => universe.from)?.from ?? null)
    : null
  const ourAddresses = (stats?.network ?? []).map((entry) => entry.address).join(', ')
  // What is typed versus what is actually in effect, compared the same way
  // saveTargets() splits it, so "Saved" never lies about whitespace.
  const unsaved =
    output !== undefined &&
    targetDraft
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join(',') !== output.targets.join(',')

  useEffect(() => {
    if (output && targetDraft === '') setTargetDraft(output.targets.join(', '))
    // Only seeds the field once, the user types freely afterwards.
  }, [output])

  async function go(next: OutputMode): Promise<void> {
    setError(null)
    try {
      await controlOutput('mode', next)
    } catch (failure) {
      setError((failure as Error).message)
    }
  }

  async function saveTargets(): Promise<void> {
    setError(null)
    const targets = targetDraft
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
    try {
      await controlOutput('targets', targets)
    } catch (failure) {
      setError((failure as Error).message)
    }
  }

  const stateText: Record<OutputMode, string> = {
    off: 'Not connected to the lights. Nothing leaves this computer.',
    spectator: 'Connected. The console passes through untouched.',
    armed: 'LIVE — your scenes are playing on the lights.',
    blackout: 'BLACKOUT — all lights are forced off.',
  }

  return (
    <aside className="panel">
      <header className="panel-header scene-header">
        <div>
          <h2>Live output</h2>
          <span className="muted-note">Let your scenes play on the real lights.</span>
        </div>
        <button className="button" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="panel-section">
        <div className={`output-state ${mode}`}>{stateText[mode]}</div>
        {output?.watchdogTripped && mode !== 'off' && (
          <div className="output-warning">
            No signal from the console. Output is on hold until it comes back.
          </div>
        )}
        {loopedBack.length > 0 && (
          <div className="output-warning">
            {loopedBack.join(', ')} is the console, not the lights. Everything sent there goes
            back to the desk it came from and the lights never hear it. Ask the lighting operator
            for the address of the lighting network box, and change it under Advanced below.
          </div>
        )}
        {unroutable.length > 0 && (
          <div className="output-warning">
            {unroutable.join(', ')} is not on a network this computer belongs to
            {ourAddresses ? ` (this computer is ${ourAddresses})` : ''}. The frames are built and
            then dropped before they reach the cable. Either the address is wrong, or this
            computer needs an address on the lighting network — ask the lighting operator.
          </div>
        )}
        {output?.lastError && mode !== 'off' && (
          <div className="output-warning">The network refused the last frame: {output.lastError}</div>
        )}
        {error && <div className="output-warning">{error}</div>}
      </div>

      {!configured && (
        <div className="panel-section">
          <span className="muted-note">
            This computer is not wired to the lights yet. Set it up with the lighting operator
            under Advanced below — until then, nothing can be sent.
          </span>
        </div>
      )}

      {/* What arming would actually reach. Said before anyone arms, because
          the alternative is discovering it by watching a family not move and
          wondering whether the cable is out. A family is absent from this list
          when its channel chart is not confirmed -- there is no address to
          write to, so it cannot be driven however a layer names it. */}
      {configured && (output?.writableFamilies?.length ?? 0) > 0 && (
        <div className="panel-section">
          <span className="ins-label">Stage can drive</span>
          {output!.writableFamilies!.map((family) => (
            <div className="ins-fact" key={family.name}>
              <span className="ins-fact-key">{family.name}</span>
              <span className="ins-fact-value">{family.count}</span>
            </div>
          ))}
          <span className="muted-note">
            Any family missing from this list has no confirmed channel chart, and is never
            written to — the console keeps it.
          </span>
        </div>
      )}

      {configured && (
        <div className="panel-section">
          {mode === 'off' && (
            <button className="button primary" onClick={() => void go('spectator')}>
              Connect to the lights
            </button>
          )}
          {mode === 'spectator' && (
            <>
              <HoldButton label="Hold to go live" onComplete={() => void go('armed')} />
              <button className="button" onClick={() => void go('off')}>
                Disconnect
              </button>
            </>
          )}
          {mode === 'armed' && (
            <button className="button" onClick={() => void go('spectator')}>
              Stop playing my scenes
            </button>
          )}
          {mode === 'blackout' && (
            <button className="button primary" onClick={() => void go('spectator')}>
              Give the lights back to the console
            </button>
          )}
          {mode !== 'off' && mode !== 'blackout' && (
            <button className="button blackout" onClick={() => void go('blackout')}>
              BLACKOUT
            </button>
          )}
        </div>
      )}

      <div className="panel-section">
        <button className="ghost-button" onClick={() => setAdvanced(!advanced)}>
          {advanced ? '▾' : '▸'} Advanced
        </button>
        {advanced && (
          <>
            <span className="panel-label">Lighting network address</span>
            <span className="muted-note">
              Ask the lighting operator. Leave empty and this computer can never send anything.
              {consoleAddress && ` The console talks to us from ${consoleAddress}, so that is the
              one address this is never meant to be.`}
            </span>
            {/* Enter saves. A field with a small separate button, no reaction
                to Enter and no sign of whether it took is a field people leave
                thinking they changed something -- and the only symptom is a rig
                that does not light. */}
            <div className="preset-row">
              <input
                className="text-input"
                value={targetDraft}
                placeholder="e.g. 2.0.0.10"
                onChange={(event) => setTargetDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveTargets()
                }}
              />
              <button
                className={unsaved ? 'chip primary' : 'chip'}
                onClick={() => void saveTargets()}
                disabled={!unsaved}
              >
                {unsaved ? 'Save' : 'Saved'}
              </button>
            </div>
            {unsaved && (
              <span className="output-warning">
                Not saved yet. This computer is still sending to{' '}
                {output?.targets.length ? output.targets.join(', ') : 'nothing'}.
              </span>
            )}
            {output && (
              <span className="muted-note">
                {output.pps} frames/s out · delay {(output.passthroughUs / 1000).toFixed(2)} ms
                (worst {(output.maxPassthroughUs / 1000).toFixed(2)} ms)
                {output.activeSceneName ? ` · playing “${output.activeSceneName}”` : ''}
              </span>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
