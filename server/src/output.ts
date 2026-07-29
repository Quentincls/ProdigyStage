// PHASE 6 -- THE ONLY MODULE THAT EVER TRANSMITS TOWARDS THE RIG.
//
// Man-in-the-middle: the console feeds this software, this software feeds the
// rig. Safe by construction, in this order:
//
//   1. Boots in 'off'. The UDP socket is not even created.
//   2. Ships with NO target (data/output.json absent = targets []). An
//      un-commissioned install physically cannot reach a rig, whatever the
//      operator clicks.
//   3. A target that would loop back into our own listener is rejected.
//   4. 'spectator' forwards the console byte-for-byte; only 'armed'
//      substitutes our scenes; 'blackout' forces zeros.
//   5. A 250 ms input watchdog stops emission when the console link dies, so
//      a dead console can never leave the rig frozen on our last frame.
//
// Latency: we emit on receipt (not on a timer), so passthrough costs one
// merge pass -- measured and exposed as passthroughUs.

import { createSocket, type Socket } from 'node:dgram'
import { activeScene, renderScenePixel, type SceneSpec } from '@prodigy-stage/core'
import { ARTNET_PORT, buildArtDmxPacket, DMX_CHANNELS, showUniverseToArtnet } from './artnet.js'
import type { Patch } from './patch.js'

export type OutputMode = 'off' | 'spectator' | 'armed' | 'blackout'

// Console -> scene blend at a scene's edges (brief: 0,5 s).
const CROSSFADE_S = 0.5
// No console frame for this long = the link is dead; stop emitting.
const WATCHDOG_MS = 250
// Blackout must hold the rig dark even if the console stopped talking.
const BLACKOUT_KEEPALIVE_MS = 40

export interface OutputConfig {
  targets: string[]
  port: number
}

export interface OutputStatus {
  mode: OutputMode
  targets: string[]
  port: number
  framesSent: number
  pps: number
  passthroughUs: number
  maxPassthroughUs: number
  watchdogTripped: boolean
  activeSceneName: string | null
  lastError: string | null
}

// One emitting fixture: where it lives in the DMX buffer and where it sits
// along its wall (same convention as the previz, so screen and rig agree).
interface OutFixture {
  universe: number
  base: number // 0-based address
  group: string
  wallPos: number
  pixelIndex: number // for deterministic per-fixture effects (sparkle)
}

// Channel offsets inside a fixture's footprint, 0-based, resolved from the
// patch personality. Everything is optional: a personality that does not
// declare a channel simply never has it written.
interface OutMap {
  red: number | null
  green: number | null
  blue: number | null
  white: number | null
  dimmer: number | null
  dimmerFine: number | null
  strobe: number | null
}

function offset(map: Record<string, number>, key: string): number | null {
  return map[key] !== undefined ? map[key] - 1 : null
}

// Blend a console value towards a target value. mix 0 = console untouched.
function blend(consoleValue: number, target: number, mix: number): number {
  return Math.max(0, Math.min(255, Math.round(consoleValue + (target - consoleValue) * mix)))
}

// How much a scene owns the output right now: 0 = console, 1 = fully ours.
export function crossfadeMix(scene: SceneSpec, showTime: number): number {
  if (showTime < scene.start || showTime >= scene.end) return 0
  const into = showTime - scene.start
  const left = scene.end - showTime
  const ramp = Math.min(CROSSFADE_S, (scene.end - scene.start) / 2)
  if (ramp <= 0) return 1
  return Math.max(0, Math.min(1, Math.min(into / ramp, left / ramp)))
}

// Pure merge: console frame in, emitted frame out. Exported for the self-test.
// `out` is written in place and must already hold the console frame.
export function mergeUniverse(
  out: Uint8Array,
  fixtures: OutFixture[],
  map: OutMap,
  scene: SceneSpec | null,
  showTime: number,
): boolean {
  if (!scene) return false
  const mix = crossfadeMix(scene, showTime)
  if (mix <= 0) return false
  let touched = false
  for (const fixture of fixtures) {
    const color = renderScenePixel(scene, fixture.group, fixture.wallPos, fixture.pixelIndex, showTime)
    if (!color) continue // no track covers this wall: console stays visible
    touched = true
    const base = fixture.base
    if (map.red !== null) out[base + map.red] = blend(out[base + map.red], color[0], mix)
    if (map.green !== null) out[base + map.green] = blend(out[base + map.green], color[1], mix)
    if (map.blue !== null) out[base + map.blue] = blend(out[base + map.blue], color[2], mix)
    // White would wash our colour out, so it fades away with the crossfade.
    if (map.white !== null) out[base + map.white] = blend(out[base + map.white], 0, mix)
    // Our scenes carry their own level in the RGB, so the fixture's master
    // dimmer opens up: a console blackout must not hide the scene we placed.
    if (map.dimmer !== null) out[base + map.dimmer] = blend(out[base + map.dimmer], 255, mix)
    if (map.dimmerFine !== null) out[base + map.dimmerFine] = blend(out[base + map.dimmerFine], 255, mix)
    // Shutter: a closed shutter would swallow the whole scene.
    if (map.strobe !== null) out[base + map.strobe] = 255
    // Tilt and zoom are deliberately left untouched: the console keeps
    // driving the movement, our scene only repaints it.
  }
  return touched
}

export class ArtnetOutput {
  private socket: Socket | null = null
  private mode: OutputMode = 'off'
  private fixtures = new Map<number, OutFixture[]>()
  private map: OutMap = {
    red: null,
    green: null,
    blue: null,
    white: null,
    dimmer: null,
    dimmerFine: null,
    strobe: null,
  }
  private buffers = new Map<number, Uint8Array>()
  private sequences = new Map<number, number>()
  private lastConsoleAt = 0
  private framesSent = 0
  private sentThisSecond = 0
  private pps = 0
  private passthroughUs = 0
  private maxPassthroughUs = 0
  private activeSceneName: string | null = null
  private lastError: string | null = null
  private blackoutTimer: NodeJS.Timeout | null = null
  private statsTimer: NodeJS.Timeout | null = null

  // Scenes and show time are pulled at emit time so the editor stays live.
  getScenes: () => SceneSpec[] = () => []
  getShowTime: () => number | null = () => null

  constructor(
    private config: OutputConfig,
    patch: Patch,
    private listenPort = ARTNET_PORT,
  ) {
    this.applyPatch(patch)
    this.statsTimer = setInterval(() => {
      this.pps = this.sentThisSecond
      this.sentThisSecond = 0
    }, 1000)
  }

  applyPatch(patch: Patch): void {
    this.fixtures.clear()
    this.buffers.clear()
    // Only the walls, and only the model they are made of. This used to read
    // the first fixture's type and apply its channel map to the whole rig,
    // which was correct while the rig was one model and would put a Tambora's
    // channel numbers on a moving head now that it is not. Nothing outside
    // patch.groups can be written to by this software, which is the right
    // default for every family whose chart nobody has confirmed.
    const walls = patch.fixtures.filter((fixture) => patch.groups.includes(fixture.group))
    const type = patch.fixtureTypes[walls[0]?.type ?? '']
    const pixels = type?.pixels ?? 16
    const standard = type?.standardMap ?? {}
    this.map = {
      red: offset(standard, 'red'),
      green: offset(standard, 'green'),
      blue: offset(standard, 'blue'),
      white: offset(standard, 'white'),
      dimmer: offset(standard, 'dimmer'),
      dimmerFine: offset(standard, 'dimmerFine'),
      strobe: offset(standard, 'strobe'),
    }

    for (const group of patch.groups) {
      const wall = walls
        .filter((f) => f.group === group && f.type === walls[0]?.type)
        .sort((a, b) => parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10))
      wall.forEach((fixture, index) => {
        const list = this.fixtures.get(fixture.universe) ?? []
        list.push({
          universe: fixture.universe,
          base: fixture.address - 1,
          group: fixture.group,
          // Fixture centre, same normalization the previz uses per pixel.
          wallPos: (index + 0.5) / wall.length,
          pixelIndex: index * pixels + Math.floor(pixels / 2),
        })
        this.fixtures.set(fixture.universe, list)
        if (!this.buffers.has(fixture.universe)) {
          this.buffers.set(fixture.universe, new Uint8Array(DMX_CHANNELS))
        }
      })
    }
  }

  setMode(mode: OutputMode): OutputStatus {
    if (mode !== 'off' && this.config.targets.length === 0) {
      throw new Error('no output target configured (data/output.json)')
    }
    if (mode === this.mode) return this.status()

    if (mode === 'off') {
      this.closeSocket()
    } else {
      this.openSocket()
    }
    this.mode = mode
    this.maxPassthroughUs = 0

    if (this.blackoutTimer) {
      clearInterval(this.blackoutTimer)
      this.blackoutTimer = null
    }
    if (mode === 'blackout') {
      this.blackoutTimer = setInterval(() => this.sendBlackout(), BLACKOUT_KEEPALIVE_MS)
      this.sendBlackout()
    }
    console.log(`output: mode -> ${mode}${mode === 'off' ? '' : ` (targets ${this.config.targets.join(', ')})`}`)
    return this.status()
  }

  setTargets(targets: string[]): OutputStatus {
    for (const target of targets) {
      if (isLoopback(target) && this.config.port === this.listenPort) {
        throw new Error(`target ${target}:${this.config.port} would loop back into our own listener`)
      }
    }
    this.config.targets = targets
    if (targets.length === 0 && this.mode !== 'off') this.setMode('off')
    return this.status()
  }

  // Called for every console ArtDMX on a show universe. `at` is the hrtime
  // nanosecond stamp taken the moment the packet was received.
  onConsoleFrame(universe: number, data: Uint8Array, at: bigint): void {
    this.lastConsoleAt = Date.now()
    if (this.mode === 'off' || this.mode === 'blackout') return
    const out = this.buffers.get(universe)
    if (!out) return

    out.set(data.subarray(0, DMX_CHANNELS))

    if (this.mode === 'armed') {
      const showTime = this.getShowTime()
      const scene = showTime !== null ? activeScene(this.getScenes(), showTime) : null
      this.activeSceneName = scene ? scene.name : null
      if (scene) {
        mergeUniverse(out, this.fixtures.get(universe) ?? [], this.map, scene, showTime!)
      }
    } else {
      this.activeSceneName = null
    }

    this.send(universe, out)
    const elapsed = Number(process.hrtime.bigint() - at) / 1000
    this.passthroughUs = elapsed
    if (elapsed > this.maxPassthroughUs) this.maxPassthroughUs = elapsed
  }

  private sendBlackout(): void {
    if (this.mode !== 'blackout') return
    for (const [universe, buffer] of this.buffers) {
      buffer.fill(0)
      this.send(universe, buffer)
    }
  }

  private send(universe: number, data: Uint8Array): void {
    const socket = this.socket
    if (!socket) return
    const sequence = (this.sequences.get(universe) ?? 0) % 255 + 1
    this.sequences.set(universe, sequence)
    const packet = buildArtDmxPacket(showUniverseToArtnet(universe), sequence, data)
    for (const target of this.config.targets) {
      socket.send(packet, this.config.port, target, (error) => {
        if (error) this.lastError = error.message
      })
    }
    this.framesSent++
    this.sentThisSecond++
  }

  private openSocket(): void {
    if (this.socket) return
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    socket.on('error', (error) => {
      this.lastError = error.message
      console.error(`output: socket error: ${error.message}`)
    })
    socket.bind(() => {
      if (this.config.targets.some(isBroadcast)) {
        try {
          socket.setBroadcast(true)
        } catch (error) {
          this.lastError = (error as Error).message
        }
      }
    })
    this.socket = socket
    this.lastError = null
  }

  private closeSocket(): void {
    this.socket?.close()
    this.socket = null
  }

  watchdogTripped(): boolean {
    return this.mode !== 'off' && Date.now() - this.lastConsoleAt > WATCHDOG_MS
  }

  status(): OutputStatus {
    return {
      mode: this.mode,
      targets: [...this.config.targets],
      port: this.config.port,
      framesSent: this.framesSent,
      pps: this.pps,
      passthroughUs: Math.round(this.passthroughUs),
      maxPassthroughUs: Math.round(this.maxPassthroughUs),
      watchdogTripped: this.watchdogTripped(),
      activeSceneName: this.activeSceneName,
      lastError: this.lastError,
    }
  }

  stop(): void {
    if (this.blackoutTimer) clearInterval(this.blackoutTimer)
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.closeSocket()
    this.mode = 'off'
  }
}

function isLoopback(target: string): boolean {
  return target === 'localhost' || target.startsWith('127.')
}

function isBroadcast(target: string): boolean {
  return target === '255.255.255.255' || target.endsWith('.255')
}
