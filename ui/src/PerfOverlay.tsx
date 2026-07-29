// The frame, measured, in the corner of the room it is drawing.
//
// Not part of the interface: Shift+P, and it is gone again. It exists because
// "it stutters" and "it is fluid" are the only two things anyone can report
// from a venue, and the difference between a slow graphics card, a slow
// network and a slow render loop is four numbers that nobody can see.
//
// Read the two lines at the top first. `ours` is the JavaScript this software
// runs before the graphics card is asked for anything; `draw` is everything
// after. If ours is small and the frame is still long, no amount of code
// tidying will help -- the cost is pixels, and the switches at the bottom say
// which pixels.
//
// The switches change what is drawn, on purpose, for as long as you hold them.
// They are a measuring instrument, not a quality setting: nothing here is
// remembered, and reloading puts everything back.

import { useEffect, useState } from 'react'
import { PerfSampler, type PerfSample } from './perf'
import { previzDebug } from './previz/PrevizScene'

export default function PerfOverlay({ onClose }: { onClose: () => void }) {
  const [sample, setSample] = useState<PerfSample | null>(null)
  // Its own sampler, so opening this never disturbs the one Diagnostics uses.
  const [, force] = useState(0)

  useEffect(() => {
    const sampler = new PerfSampler()
    const id = setInterval(() => setSample(sampler.sample()), 1000)
    return () => clearInterval(id)
  }, [])

  if (!sample) return <div className="perf-overlay">measuring…</div>
  const g = sample.gauges
  const loops = Object.entries(sample.loops)
  const renders = Object.entries(sample.rendersPerSecond).filter(([, n]) => n > 0)

  return (
    <div className="perf-overlay">
      <div className="perf-head">
        <b>{sample.fps} fps</b>
        <button className="perf-close" onClick={onClose} title="Shift+P">
          ×
        </button>
      </div>
      <Row label="ours" value={`${sample.cpuMsPerFrame} ms`} />
      <Row label="draw" value={`${sample.drawMsPerFrame} ms`} />
      <span className="perf-rule" />
      <Row label="draw calls" value={String(g.drawCalls)} />
      <Row label="triangles" value={String(g.triangles)} />
      <Row label="instances" value={`${g.instances} in ${g.meshes}`} />
      <Row label="lights" value={`${g.lights} (${g.shadowCasters} shadow)`} />
      <Row label="materials" value={`${g.materials} · ${g.textures} tex`} />
      <Row label="pixels" value={`${(g.devicePixels / 1e6).toFixed(2)} M @ ${g.pixelRatio}x`} />
      <Row label="rebuilds" value={String(g.patchRebuilds)} />
      <span className="perf-rule" />
      {loops.map(([name, loop]) => (
        <Row key={name} label={name} value={`${loop.fps}/s · ${loop.msPerFrame} ms`} />
      ))}
      <Row label="react" value={`${sample.totalRendersPerSecond}/s`} />
      {renders.length > 0 && (
        <div className="perf-note">{renders.map(([n, v]) => `${n} ${v}`).join(' · ')}</div>
      )}
      <span className="perf-rule" />
      <Row label="console" value={`${sample.dmxFramesPerSecond}/s · ${sample.kilobytesPerSecond} KB/s`} />
      <Row label="parse" value={`${sample.parseUsPerFrame} µs`} />
      <Row label="fixture reads" value={`${sample.fixtureReadsPerSecond}/s`} />
      {g.heapBytes > 0 && (
        <Row
          label="memory"
          value={`${(g.heapBytes / 1e6).toFixed(0)} MB · ${sample.heapGrowthKbPerSecond > 0 ? '+' : ''}${sample.heapGrowthKbPerSecond} KB/s`}
        />
      )}
      <span className="perf-rule" />
      <div className="perf-note">Switch one off and watch the frame rate. Reload puts it back.</div>
      <Toggle
        label="bloom"
        on={previzDebug.bloom}
        onChange={(on) => {
          previzDebug.bloom = on
          force((n) => n + 1)
        }}
      />
      <Toggle
        label="haze"
        on={previzDebug.haze}
        onChange={(on) => {
          previzDebug.haze = on
          force((n) => n + 1)
        }}
      />
      <div className="perf-slider">
        <span>bloom res</span>
        <input
          type="range"
          min={0.25}
          max={1}
          step={0.25}
          defaultValue={previzDebug.bloomScale}
          onChange={(event) => {
            previzDebug.bloomScale = event.target.valueAsNumber
            force((n) => n + 1)
          }}
        />
        <span className="perf-value">{previzDebug.bloomScale}x</span>
      </div>
      <div className="perf-slider">
        <span>resolution</span>
        <input
          type="range"
          min={0.25}
          max={1}
          step={0.25}
          defaultValue={previzDebug.resolutionScale}
          onChange={(event) => {
            previzDebug.resolutionScale = event.target.valueAsNumber
            force((n) => n + 1)
          }}
        />
        <span className="perf-value">{previzDebug.resolutionScale}x</span>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="perf-row">
      <span className="perf-label">{label}</span>
      <span className="perf-value">{value}</span>
    </div>
  )
}

function Toggle({
  label,
  on,
  onChange,
}: {
  label: string
  on: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <button className={`perf-toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <span className="perf-label">{label}</span>
      <span className="perf-value">{on ? 'on' : 'OFF'}</span>
    </button>
  )
}
