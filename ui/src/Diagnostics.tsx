// One screen that answers "what is actually going on" in text you can paste
// into a message. Built for the venue: when something misbehaves there,
// nobody can describe it accurately, and a screenshot loses half of it.
//
// Read-only. It reports state, it never changes any.

import { useEffect, useState, useSyncExternalStore } from 'react'
import { previzStats } from './previz/PrevizScene'
import { feed } from './feed'
import type { Patch } from './patch'
import type { ShowFile } from './show'
import { formatTime, pad } from './TimeInput'

export default function Diagnostics({
  patch,
  show,
  onClose,
}: {
  patch: Patch | null
  show: ShowFile | null
  onClose: () => void
}) {
  const { connected, stats } = useSyncExternalStore(feed.subscribe, feed.getSnapshot)
  const [report, setReport] = useState('')
  const [copied, setCopied] = useState(false)

  // The timecode lives outside React, so the report is rebuilt on a timer
  // rather than on render.
  useEffect(() => {
    const build = (): void => setReport(buildReport(patch, show, connected, stats))
    build()
    const id = setInterval(build, 1000)
    return () => clearInterval(id)
  }, [patch, show, connected, stats])

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(report)
    } catch {
      // Clipboard can be refused; the text is selectable either way.
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <aside className="panel panel-wide">
      <header className="panel-header scene-header">
        <div className="scene-identity">
          <h2>Diagnostics</h2>
          <span className="muted-note">What the software sees right now.</span>
        </div>
        <button className="icon-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      {/* Read the state at a glance; the text below is what gets sent. */}
      <div className="diag-rows">
        {checks(stats, connected).map((row) => (
          <div className={`diag-row ${row.level}`} key={row.label}>
            <span className={`dot ${row.level}`} />
            <span className="diag-row-label">{row.label}</span>
            <span className="diag-row-value">{row.value}</span>
          </div>
        ))}
      </div>

      <button className="button block primary" onClick={() => void copy()}>
        {copied ? 'Copied — paste it in a message' : 'Copy the full report'}
      </button>

      <details className="diag-details">
        <summary>What will be copied</summary>
        <textarea className="diag-text" readOnly value={report} spellCheck={false} />
      </details>
    </aside>
  )
}

// The four questions that decide whether tonight works, each answered in a
// phrase and a colour rather than buried in the dump.
function checks(
  stats: ReturnType<typeof feed.getSnapshot>['stats'],
  connected: boolean,
): { label: string; value: string; level: 'ok' | 'idle' | 'down' | 'live' }[] {
  const rows: { label: string; value: string; level: 'ok' | 'idle' | 'down' | 'live' }[] = []

  rows.push(
    connected
      ? { label: 'Software', value: stats?.version ?? 'running', level: 'ok' }
      : { label: 'Software', value: 'not talking to its own server', level: 'down' },
  )

  const pps = stats ? Object.values(stats.perUniverse).reduce((sum, u) => sum + u.pps, 0) : 0
  const from = stats ? Object.values(stats.perUniverse).find((u) => u.from)?.from : null
  rows.push(
    !stats?.udp.listening
      ? { label: 'Console', value: 'Art-Net port unavailable', level: 'down' }
      : pps > 0
        ? { label: 'Console', value: `${pps} frames/s from ${from ?? 'the network'}`, level: 'ok' }
        : { label: 'Console', value: 'nothing arriving', level: 'down' },
  )

  const tc = feed.timecode
  rows.push(
    tc.receiving
      ? { label: 'Timecode', value: `running at ${tc.fps} fps`, level: 'ok' }
      : { label: 'Timecode', value: 'not received — scenes cannot fire', level: 'idle' },
  )

  const out = stats?.output
  rows.push(
    !out || out.mode === 'off'
      ? { label: 'Lights', value: 'nothing is sent', level: 'idle' }
      : out.watchdogTripped
        ? { label: 'Lights', value: 'on hold — no console signal', level: 'idle' }
        : out.mode === 'spectator'
          ? { label: 'Lights', value: 'console passing through', level: 'ok' }
          : out.mode === 'blackout'
            ? { label: 'Lights', value: 'BLACKOUT — forced off', level: 'live' }
            : { label: 'Lights', value: `LIVE${out.activeSceneName ? ` — ${out.activeSceneName}` : ''}`, level: 'live' },
  )

  return rows
}

function buildReport(
  patch: Patch | null,
  show: ShowFile | null,
  connected: boolean,
  stats: ReturnType<typeof feed.getSnapshot>['stats'],
): string {
  const lines: string[] = []
  const now = new Date()
  lines.push('LumenStage diagnostics')
  lines.push(`Local time    ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`)
  lines.push(`Build         ${stats?.version ?? 'unknown'}`)
  lines.push(`Server link   ${connected ? 'connected' : 'NOT CONNECTED'}`)
  lines.push('')

  lines.push('-- Coming from the console --')
  if (!stats) {
    lines.push('no data from the server yet')
  } else {
    lines.push(
      `Art-Net port  ${stats.udp.port} ${stats.udp.listening ? 'listening' : 'NOT LISTENING'}` +
        (stats.udp.error ? ` (${stats.udp.error})` : ''),
    )
    let total = 0
    for (const [universe, u] of Object.entries(stats.perUniverse)) {
      total += u.pps
      lines.push(
        `Universe ${universe}    ${String(u.pps).padStart(3)} frames/s   from ${u.from ?? '—'}`,
      )
    }
    lines.push(`Total         ${total} frames/s`)
    if (stats.otherPps > 0) {
      lines.push(`Other universes on the network: ${stats.otherPps} frames/s (ignored)`)
    }
  }

  const tc = feed.timecode
  lines.push(
    `Timecode      ${
      tc.receiving
        ? `${pad(tc.hours)}:${pad(tc.minutes)}:${pad(tc.seconds)}:${pad(tc.frames)} at ${tc.fps} fps`
        : 'NOT RECEIVING — scenes cannot fire without it'
    }`,
  )
  lines.push('')

  lines.push('-- Going to the lights --')
  const out = stats?.output
  if (!out) {
    lines.push('no output state')
  } else {
    lines.push(`Mode          ${out.mode}${out.mode === 'off' ? ' (nothing is sent)' : ''}`)
    lines.push(
      `Target        ${out.targets.length ? `${out.targets.join(', ')}:${out.port}` : 'NONE — cannot send'}`,
    )
    lines.push(`Sent          ${out.framesSent} frames total, ${out.pps} frames/s now`)
    lines.push(
      `Delay         ${(out.passthroughUs / 1000).toFixed(2)} ms (worst ${(out.maxPassthroughUs / 1000).toFixed(2)} ms)`,
    )
    if (out.watchdogTripped) lines.push('WATCHDOG       tripped — no console signal, output on hold')
    if (out.activeSceneName) lines.push(`Playing        ${out.activeSceneName}`)
    if (out.lastError) lines.push(`Last error     ${out.lastError}`)
  }
  lines.push('')

  // The viewport's own cost, measured in the render loop. This is the section
  // to read first when someone says it stutters: fps is what they feel, cpuMs
  // is how much of it is our JavaScript rather than their graphics card.
  lines.push('-- Viewport --')
  const perf = window.__perfSample?.()
  lines.push(`Frame rate    ${Math.round(previzStats.fps)} fps`)
  lines.push(`Our work      ${previzStats.cpuMs.toFixed(2)} ms per frame`)
  if (perf) {
    // What the frame is made of. The two halves are the whole diagnosis: if
    // our work is small and the frame is still long, the cost is pixels.
    lines.push(`Drawing       ${perf.drawMsPerFrame.toFixed(2)} ms per frame`)
    lines.push(
      `Frame         ${perf.gauges.drawCalls} draw calls, ${perf.gauges.triangles} triangles, ` +
        `${perf.gauges.instances} instances in ${perf.gauges.meshes} meshes`,
    )
    lines.push(
      `Scene         ${perf.gauges.lights} real lights, ${perf.gauges.shadowCasters} casting shadows, ` +
        `${perf.gauges.materials} materials, ${perf.gauges.textures} textures`,
    )
    lines.push(
      `Resolution    ${(perf.gauges.devicePixels / 1e6).toFixed(2)} Mpx at ratio ${perf.gauges.pixelRatio}`,
    )
    lines.push(`Rebuilds      ${perf.gauges.patchRebuilds} since start (expected: 1, plus one per patch edit)`)
    const loops = Object.entries(perf.loops)
      .map(([name, l]) => `${name} ${l.fps}/s at ${l.msPerFrame} ms`)
      .join(', ')
    lines.push(`Loops         ${loops || 'none'}`)
    const renders = Object.entries(perf.rendersPerSecond)
      .filter(([, n]) => n > 0)
      .map(([name, n]) => `${name} ${n}`)
      .join(', ')
    lines.push(`React         ${perf.totalRendersPerSecond} renders/s (${renders || 'none'})`)
    lines.push(
      `Console feed  ${perf.dmxFramesPerSecond} frames/s, ${perf.kilobytesPerSecond} KB/s, ` +
        `${perf.parseUsPerFrame} us to read each`,
    )
    lines.push(`Fixture reads ${perf.fixtureReadsPerSecond}/s`)
    if (perf.gauges.heapBytes > 0) {
      lines.push(
        `Memory        ${(perf.gauges.heapBytes / 1e6).toFixed(1)} MB, ` +
          `${perf.heapGrowthKbPerSecond > 0 ? '+' : ''}${perf.heapGrowthKbPerSecond} KB/s`,
      )
    }
  }
  lines.push('')

  lines.push('-- Show --')
  lines.push(`Fixtures      ${patch?.fixtures.length ?? 0}`)
  lines.push(`Scenes        ${show?.scenes.length ?? 0}`)
  for (const scene of show?.scenes ?? []) {
    const look = scene.tracks[0]
    lines.push(
      `  ${formatTime(scene.start)}–${formatTime(scene.end)}  ${scene.name}` +
        (look ? `  [${look.effect} on ${look.target}]` : '  [no look]'),
    )
  }
  lines.push(`Sections      ${show?.markers.length ?? 0}`)
  for (const marker of show?.markers ?? []) {
    lines.push(`  ${formatTime(marker.start)}–${formatTime(marker.end)}  ${marker.name}`)
  }

  if (stats?.record.recording) {
    lines.push('')
    lines.push(`RECORDING     ${stats.record.file} — ${stats.record.seconds}s, ${stats.record.frames} packets`)
  }

  return lines.join('\n')
}
