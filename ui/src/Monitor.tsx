// DMX monitor: one card per universe with a 512-channel heatmap and the 8
// Tambora pixel bars in true RGB. Canvases are drawn imperatively from the
// feed's mutable buffers in a single requestAnimationFrame loop.

import { useEffect, useMemo, useRef } from 'react'
import { feed } from './feed'
import type { Fixture, Patch } from './patch'

const HEAT_COLS = 32
const HEAT_ROWS = 16
const CELL = 10 // heatmap logical cell size in px
const BAR_CELL_W = 17
const BAR_CELL_H = 14
const BAR_GAP = 7
const BAR_LABEL_W = 30

interface UniverseView {
  universe: number
  fixtures: Fixture[]
  label: string
}

export default function Monitor({ patch }: { patch: Patch }) {
  const views = useMemo(() => buildViews(patch), [patch])
  return (
    <div className="monitor">
      {views.map((view) => (
        <UniverseCard key={view.universe} view={view} patch={patch} />
      ))}
    </div>
  )
}

function buildViews(patch: Patch): UniverseView[] {
  const universes = [...new Set(patch.fixtures.map((f) => f.universe))].sort((a, b) => a - b)
  return universes.map((universe) => {
    const fixtures = patch.fixtures
      .filter((f) => f.universe === universe)
      .sort((a, b) => a.address - b.address)
    return {
      universe,
      fixtures,
      label: `${fixtures[0]?.id}–${fixtures[fixtures.length - 1]?.id}`,
    }
  })
}

function UniverseCard({ view, patch }: { view: UniverseView; patch: Patch }) {
  const heatRef = useRef<HTMLCanvasElement>(null)
  const barsRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  const barsHeight = view.fixtures.length * (BAR_CELL_H + BAR_GAP) - BAR_GAP
  const barsWidth = BAR_LABEL_W + 16 * BAR_CELL_W

  useEffect(() => {
    const heatCanvas = heatRef.current!
    const barsCanvas = barsRef.current!
    const heatCtx = heatCanvas.getContext('2d')!
    const barsCtx = barsCanvas.getContext('2d')!
    const cellCanvas = document.createElement('canvas')
    cellCanvas.width = HEAT_COLS
    cellCanvas.height = HEAT_ROWS
    const cellCtx = cellCanvas.getContext('2d')!
    const image = cellCtx.createImageData(HEAT_COLS, HEAT_ROWS)
    const type = patch.fixtureTypes[view.fixtures[0]?.type ?? '']

    let lastVersion = -1
    let lastActive: boolean | null = null
    let raf = 0

    const draw = () => {
      raf = requestAnimationFrame(draw)
      const buffer = feed.universes.get(view.universe)
      const active = feed.active.get(view.universe) ?? false

      if (active !== lastActive && overlayRef.current) {
        overlayRef.current.dataset.active = String(active)
        lastActive = active
      }
      if (!buffer || feed.version === lastVersion) return
      lastVersion = feed.version

      // Heatmap 32x16, channel 1 top-left, row-major.
      for (let c = 0; c < 512; c++) {
        const v = buffer[c]
        const o = c * 4
        image.data[o] = 22 + (v * 0.35 * (255 - 22)) / 255
        image.data[o + 1] = 24 + (v * 0.55 * (255 - 24)) / 255
        image.data[o + 2] = 29 + (v * (255 - 29)) / 255
        image.data[o + 3] = 255
      }
      cellCtx.putImageData(image, 0, 0)
      heatCtx.imageSmoothingEnabled = false
      heatCtx.drawImage(cellCanvas, 0, 0, heatCanvas.width, heatCanvas.height)

      // Pixel bars show what each fixture displays. With the validated
      // console flow that is the fixture-wide RGB (ch 1-3); the raw pixel
      // zone stays visible in the heatmap above. Legacy dimmer x pixel
      // personalities keep the old rendering.
      barsCtx.clearRect(0, 0, barsCanvas.width, barsCanvas.height)
      barsCtx.font = '10px Inter, sans-serif'
      barsCtx.textBaseline = 'middle'
      const map = type?.standardMap
      const globalRgb = map && map.red !== undefined && map.green !== undefined && map.blue !== undefined
      view.fixtures.forEach((fixture, row) => {
        const y = row * (BAR_CELL_H + BAR_GAP)
        const base = fixture.address - 1
        const dimmer = !globalRgb && map ? buffer[base + (map.dimmer ?? 1) - 1] / 255 : 1
        barsCtx.fillStyle = '#8a8f98'
        barsCtx.fillText(fixture.id, 0, y + BAR_CELL_H / 2 + 1)
        for (let p = 0; p < (type?.pixels ?? 16); p++) {
          if (globalRgb && map) {
            barsCtx.fillStyle = `rgb(${buffer[base + map.red - 1]},${buffer[base + map.green - 1]},${buffer[base + map.blue - 1]})`
          } else {
            const o = base + (type?.pixelStart ?? 14) - 1 + p * 3
            barsCtx.fillStyle = `rgb(${buffer[o] * dimmer},${buffer[o + 1] * dimmer},${buffer[o + 2] * dimmer})`
          }
          barsCtx.fillRect(BAR_LABEL_W + p * BAR_CELL_W, y, BAR_CELL_W - 2, BAR_CELL_H)
        }
      })
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [view, patch])

  return (
    <section className="universe-card">
      <header className="universe-header">
        <h2>
          Universe {view.universe} <span className="universe-range">{view.label}</span>
        </h2>
        <UniversePps universe={view.universe} />
      </header>
      <div className="universe-body" ref={overlayRef} data-active="false">
        <canvas
          ref={heatRef}
          className="heatmap"
          width={HEAT_COLS * CELL}
          height={HEAT_ROWS * CELL}
        />
        <canvas ref={barsRef} className="bars" width={barsWidth} height={barsHeight} />
        <div className="no-signal">NO SIGNAL</div>
      </div>
    </section>
  )
}

function UniversePps({ universe }: { universe: number }) {
  // Rendered from the 1 Hz stats snapshot via App's re-render; read directly.
  const stat = feed.stats?.perUniverse[String(universe)]
  return <span className="pps">{stat ? `${stat.pps} pkt/s` : '—'}</span>
}
