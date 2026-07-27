// Art-Net test generator (brief section 3): emits animated patterns on show
// universes 1-4 towards 127.0.0.1:6454 at 40 fps, so the previz can be built
// and demoed without MagicQ. Data-driven from data/patch.json: every Tambora
// gets its Standard dimmer at full and its 16 RGB pixels animated as a
// position along its wall.
//
//   npm run fake-show          (from the repo root)
//   FAKE_SHOW_TARGET=x.x.x.x   optional override of the destination IP

import { createSocket } from 'node:dgram'
import {
  ARTNET_PORT,
  buildArtDmxPacket,
  buildArtTimeCodePacket,
  DMX_CHANNELS,
  showUniverseToArtnet,
} from './artnet.js'
import { loadPatch } from './patch.js'

const TARGET = process.env.FAKE_SHOW_TARGET ?? '127.0.0.1'
const FPS = 40
const PATTERN_SECONDS = 12

const patch = loadPatch()
const tamboraType = patch.fixtureTypes['tambora-std-pixel']
const UNIVERSES = [1, 2, 3, 4]

// Every pixel of every fixture, with its normalized position (0-1) along its wall.
interface PixelSlot {
  universe: number
  channel: number // 0-based index of the R channel in the universe buffer
  wallPos: number
}

const pixelSlots: PixelSlot[] = []
const dimmerSlots: { universe: number; channel: number }[] = []

for (const group of patch.groups) {
  const wall = patch.fixtures
    .filter((f) => f.group === group)
    .sort((a, b) => parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10))
  const wallPixels = wall.length * tamboraType.pixels
  wall.forEach((fixture, fixtureIndex) => {
    dimmerSlots.push({
      universe: fixture.universe,
      channel: fixture.address - 1 + (tamboraType.standardMap.dimmer - 1),
    })
    for (let p = 0; p < tamboraType.pixels; p++) {
      pixelSlots.push({
        universe: fixture.universe,
        channel: fixture.address - 1 + (tamboraType.pixelStart - 1) + p * 3,
        wallPos: (fixtureIndex * tamboraType.pixels + p + 0.5) / wallPixels,
      })
    }
  })
}

type Rgb = [number, number, number]
type Pattern = { name: string; at: (wallPos: number, t: number) => Rgb }

function frac(n: number): number {
  return ((n % 1) + 1) % 1
}

function hsvToRgb(h: number, s: number, v: number): Rgb {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  const [r, g, b] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][i % 6]
  return [r * 255, g * 255, b * 255]
}

const patterns: Pattern[] = [
  {
    name: 'rainbow',
    at: (pos, t) => hsvToRgb(frac(pos - t * 0.12), 1, 1),
  },
  {
    name: 'amber wave',
    at: (pos, t) => {
      const i = 0.5 + 0.5 * Math.sin(2 * Math.PI * (pos * 3 - t * 0.6))
      return [255 * i, 150 * i, 40 * i]
    },
  },
  {
    name: 'chase',
    at: (pos, t) => {
      let b = 0
      for (let j = 0; j < 4; j++) {
        const center = frac(t * 0.25 + j / 4)
        const d = Math.min(Math.abs(pos - center), 1 - Math.abs(pos - center))
        b = Math.max(b, Math.exp(-d * d * 2000))
      }
      return [180 * b, 220 * b, 255 * b]
    },
  },
]

const socket = createSocket('udp4')
const buffers = new Map<number, Uint8Array>(UNIVERSES.map((u) => [u, new Uint8Array(DMX_CHANNELS)]))
const sequences = new Map<number, number>(UNIVERSES.map((u) => [u, 1]))
const sentThisSecond = new Map<number, number>(UNIVERSES.map((u) => [u, 0]))

const startedAt = Date.now()
let currentPatternName = ''

function tick() {
  const t = (Date.now() - startedAt) / 1000
  const pattern = patterns[Math.floor(t / PATTERN_SECONDS) % patterns.length]
  currentPatternName = pattern.name

  for (const buf of buffers.values()) buf.fill(0)
  for (const slot of dimmerSlots) buffers.get(slot.universe)![slot.channel] = 255
  for (const slot of pixelSlots) {
    const [r, g, b] = pattern.at(slot.wallPos, t)
    const buf = buffers.get(slot.universe)!
    buf[slot.channel] = r
    buf[slot.channel + 1] = g
    buf[slot.channel + 2] = b
  }

  for (const universe of UNIVERSES) {
    const seq = sequences.get(universe)!
    sequences.set(universe, seq >= 255 ? 1 : seq + 1)
    const packet = buildArtDmxPacket(showUniverseToArtnet(universe), seq, buffers.get(universe)!)
    socket.send(packet, ARTNET_PORT, TARGET)
    sentThisSecond.set(universe, sentThisSecond.get(universe)! + 1)
  }

  sendTimecode(t)
}

// Art-Net timecode at 25 fps, looping like a 10-minute show.
const TC_FPS = 25
const TC_LOOP_SECONDS = 600
let lastTcFrame = -1

function sendTimecode(t: number): void {
  const showTime = t % TC_LOOP_SECONDS
  const frameIndex = Math.floor(showTime * TC_FPS)
  if (frameIndex === lastTcFrame) return
  lastTcFrame = frameIndex
  const seconds = Math.floor(showTime)
  socket.send(
    buildArtTimeCodePacket({
      frames: frameIndex % TC_FPS,
      seconds: seconds % 60,
      minutes: Math.floor(seconds / 60) % 60,
      hours: Math.floor(seconds / 3600),
      fpsType: 1, // 25 fps
    }),
    ARTNET_PORT,
    TARGET,
  )
}

console.log(`fake-show: emitting universes 1-4 to ${TARGET}:${ARTNET_PORT} at ${FPS} fps`)
console.log(`fake-show: ${patch.fixtures.length} fixtures, ${pixelSlots.length} pixels, patterns: ${patterns.map((p) => p.name).join(' / ')}`)

// Drift-compensated scheduler: Windows timers only have ~15.6 ms granularity,
// so a plain setInterval(25) would run at ~30 fps. We catch up (max 2 frames
// per wake-up) to hold a 40 fps average; per-frame jitter remains ~15 ms.
const FRAME_MS = 1000 / FPS
let nextFrameAt = Date.now()
let stopped = false

function schedule() {
  if (stopped) return
  const now = Date.now()
  let catchUp = 0
  while (now >= nextFrameAt && catchUp < 2) {
    tick()
    nextFrameAt += FRAME_MS
    catchUp++
  }
  if (now >= nextFrameAt) nextFrameAt = now // too far behind: drop frames, do not spiral
  setTimeout(schedule, Math.max(1, nextFrameAt - Date.now()))
}
schedule()

const statsInterval = setInterval(() => {
  const stats = UNIVERSES.map((u) => `u${u} ${sentThisSecond.get(u)} pkt/s`).join(' | ')
  console.log(`fake-show: ${stats} | pattern: ${currentPatternName}`)
  for (const u of UNIVERSES) sentThisSecond.set(u, 0)
}, 1000)

process.on('SIGINT', () => {
  stopped = true
  clearInterval(statsInterval)
  socket.close()
  console.log('fake-show: stopped')
  process.exit(0)
})
