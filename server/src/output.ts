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
//   5. An input watchdog stops emission when the console link dies, so a dead
//      console can never leave the rig frozen on our last frame.
//
// Latency: we emit on receipt, so passthrough costs one merge pass -- measured
// and exposed as passthroughUs. While armed we ALSO emit on our own clock, for
// the reason spelled out at ARMED_REFRESH_MS.

import { createSocket, type Socket } from 'node:dgram'
import { activeScene, renderScenePixel, type SceneSpec } from '@prodigy-stage/core'
import { blankIntent } from '@prodigy-stage/core/behaviors'
import { isWritable, writeFixture, type FixtureProfile } from '@prodigy-stage/core/fixtures'
import {
  activeLayer,
  layerMembers,
  renderLayerIntent,
  type FixtureRef,
  type LightLayer,
} from '@prodigy-stage/core/layers'
import { ARTNET_PORT, buildArtDmxPacket, DMX_CHANNELS, showUniverseToArtnet } from './artnet.js'
import type { Patch } from './patch.js'

export type OutputMode = 'off' | 'spectator' | 'armed' | 'blackout'

// Console -> scene blend at a scene's edges (brief: 0,5 s).
const CROSSFADE_S = 0.5
// No console frame for this long = the link is dead; stop emitting.
//
// This was 250 ms, which assumed the console streams continuously. It does
// not. A console sends when it has something to say: sitting on a static look,
// a ChamSys drops to about one refresh per second per universe, and Art-Net
// only asks a controller to re-send unchanged data every 4 s. So on site, with
// a perfectly healthy link, the panel spent most of every second announcing
// "no console signal". The threshold has to be read against the idle refresh
// guarantee, not against the rate a moving look happens to produce.
const WATCHDOG_MS = 5000
// Blackout must hold the rig dark even if the console stopped talking.
const BLACKOUT_KEEPALIVE_MS = 40
// While armed, refresh the rig on our own clock instead of only when a console
// frame arrives.
//
// Same root cause as the watchdog, with worse consequences: emitting only on
// receipt sampled OUR OWN animations at the console's rate. During a static
// look that is one frame per second -- so a scene that sparkles, chases or
// strobes would have crawled onto the rig at 1 fps while the previz showed it
// running at 60. The previz was not lying about the scene; the wire was.
//
// 25 ms is 40 Hz, just under the 44 Hz ceiling Art-Net sets. Console frames
// and this clock share one budget per universe (see lastSentAt), so a console
// running at full rate does not get doubled.
const ARMED_REFRESH_MS = 25

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
  /** Which families this install could transmit to, and how many of each. The
   *  panel shows it so nobody discovers the answer by arming and watching. */
  writableFamilies: { name: string; count: number }[]
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

/**
 * A fixture a light layer can actually drive.
 *
 * "Actually" is the whole word. A fixture lands in this list only if its
 * profile carries a channel map -- which is why the B Panels and the Perseo
 * Beams cannot be transmitted to even when a layer names them: there is no
 * address to write. Nothing checks for them by name; the absence of a chart
 * does the work, and the day someone fills one in they start being driven with
 * no other change.
 */
interface WriteTarget {
  ref: FixtureRef
  profile: FixtureProfile
  base: number
}

/** How much a layer owns the output right now: 0 = console, 1 = fully ours. */
export function layerMix(layer: LightLayer, showTime: number): number {
  if (showTime < layer.start || showTime >= layer.end) return 0
  const into = showTime - layer.start
  const left = layer.end - showTime
  const ramp = Math.min(CROSSFADE_S, (layer.end - layer.start) / 2)
  if (ramp <= 0) return 1
  return Math.max(0, Math.min(1, Math.min(into / ramp, left / ramp)))
}

/**
 * Pure merge for a light layer: console frame in, emitted frame out.
 *
 * Runs after the scene merge, so a layer wins over a scene on the same
 * fixture. That is the same priority the previz uses, which is what keeps the
 * screen and the room showing the same thing.
 *
 * Exported for the self-test.
 */
export function mergeLayerUniverse(
  out: Uint8Array,
  targets: WriteTarget[],
  layer: LightLayer | null,
  members: Map<string, string[]>,
  showTime: number,
): boolean {
  if (!layer) return false
  const mix = layerMix(layer, showTime)
  if (mix <= 0) return false
  let touched = false
  for (const target of targets) {
    const intent = renderLayerIntent(layer, target.ref, members, showTime, scratchIntent)
    if (!intent) continue // no part of this layer names it: console stays visible
    if (writeFixture(target.profile, intent, out, target.base, mix)) touched = true
  }
  return touched
}

const scratchIntent = blankIntent()

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
  // Everything a light layer could drive, by universe. Built once from the
  // patch: a fixture is here only if its profile has a channel map.
  private writable = new Map<number, WriteTarget[]>()
  /** Which families a layer can reach, for the Live output panel to show. */
  private writableFamilies: { name: string; count: number }[] = []
  private allRefs: FixtureRef[] = []
  private membersVersion = -1
  private members = new Map<string, Map<string, string[]>>()
  private buffers = new Map<number, Uint8Array>()
  // The console's last frame, per universe, untouched.
  //
  // Kept apart from `buffers` (which holds what we emitted) because a merge is
  // a blend towards the console frame, not an idempotent overwrite: re-merging
  // on top of an already-merged buffer would walk a half-faded scene up to full
  // every refresh, and the 0,5 s crossfade would collapse into a cut. Every
  // emission is rendered from this, so the hundredth refresh of a frame is
  // identical to the first.
  private raw = new Map<number, Uint8Array>()
  private sequences = new Map<number, number>()
  private lastSentAt = new Map<number, number>()
  private lastConsoleAt = 0
  private framesSent = 0
  private sentThisSecond = 0
  private pps = 0
  private passthroughUs = 0
  private maxPassthroughUs = 0
  private activeSceneName: string | null = null
  private lastError: string | null = null
  private blackoutTimer: NodeJS.Timeout | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  private statsTimer: NodeJS.Timeout | null = null

  // Scenes, layers and show time are pulled at emit time so the editor stays
  // live: what the operator changes on screen is what goes out on the next
  // console frame, with no restart and no apply button.
  getScenes: () => SceneSpec[] = () => []
  getLayers: () => LightLayer[] = () => []
  /** Bumped by the caller whenever the show file changes, so the layer
   *  membership map is rebuilt then rather than on every console frame. */
  getEditorVersion: () => number = () => 0
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

    // ----- what a light layer can drive -------------------------------------
    // Wider than the walls, because a layer is meant to reach the whole rig --
    // but only as wide as the documentation goes. A fixture whose profile has
    // no channel map is not in this list and therefore cannot be transmitted
    // to, whatever a layer says about it. That is the same rule the previz
    // uses to refuse to draw it lit, enforced by the same missing data.
    this.writable.clear()
    this.allRefs = patch.fixtures.map((fixture) => ({
      id: fixture.id,
      type: fixture.type,
      group: fixture.group,
    }))
    this.membersVersion = -1
    const families = new Map<string, number>()
    for (const fixture of patch.fixtures) {
      const profile = patch.fixtureTypes[fixture.type] as FixtureProfile | undefined
      if (!profile || !isWritable(profile)) continue
      const list = this.writable.get(fixture.universe) ?? []
      list.push({
        ref: { id: fixture.id, type: fixture.type, group: fixture.group },
        profile,
        base: fixture.address - 1,
      })
      this.writable.set(fixture.universe, list)
      if (!this.buffers.has(fixture.universe)) {
        this.buffers.set(fixture.universe, new Uint8Array(DMX_CHANNELS))
      }
      const label = profile.short ?? profile.name
      families.set(label, (families.get(label) ?? 0) + 1)
    }
    this.writableFamilies = [...families].map(([name, count]) => ({ name, count }))
  }

  /** Membership per layer part, rebuilt only when the layers change. */
  private membersFor(layers: LightLayer[], version: number): Map<string, Map<string, string[]>> {
    if (version !== this.membersVersion) {
      this.membersVersion = version
      this.members = new Map()
      for (const layer of layers) this.members.set(layer.id, layerMembers(layer, this.allRefs))
    }
    return this.members
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

    // The refresh clock exists only while our own scenes are on the rig.
    // Spectator stays strictly reactive: one console frame in, one frame out,
    // byte for byte, which is the property that makes passthrough auditable.
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    if (mode === 'armed') {
      this.refreshTimer = setInterval(() => this.refresh(), ARMED_REFRESH_MS)
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

    // Every universe the console sends is remembered, including the ones we
    // have no fixtures on and the ones whose charts nobody has confirmed.
    //
    // This is not an optimisation detail, it is what "man in the middle" means.
    // Buffers used to exist only for universes carrying fixtures we knew about,
    // and a universe with no buffer was dropped on the floor -- so the moment
    // the console was routed through this software, the sixteen B Panels on
    // universes 6 and 7 stopped receiving anything at all. Passing a frame we
    // do not understand straight through is the whole job.
    let raw = this.raw.get(universe)
    if (!raw) {
      raw = new Uint8Array(DMX_CHANNELS)
      this.raw.set(universe, raw)
    }
    raw.set(data.subarray(0, DMX_CHANNELS))

    this.emit(universe)
    const elapsed = Number(process.hrtime.bigint() - at) / 1000
    this.passthroughUs = elapsed
    if (elapsed > this.maxPassthroughUs) this.maxPassthroughUs = elapsed
  }

  // Render one universe from the console's last frame and put it on the wire.
  // Called both on receipt and from the armed refresh clock; the two are the
  // same operation, which is why re-rendering has to be free of side effects on
  // the console frame it starts from.
  private emit(universe: number): void {
    const raw = this.raw.get(universe)
    if (!raw) return
    let out = this.buffers.get(universe)
    if (!out) {
      out = new Uint8Array(DMX_CHANNELS)
      this.buffers.set(universe, out)
    }
    out.set(raw)

    if (this.mode === 'armed') {
      const showTime = this.getShowTime()
      const scene = showTime !== null ? activeScene(this.getScenes(), showTime) : null
      if (scene) {
        mergeUniverse(out, this.fixtures.get(universe) ?? [], this.map, scene, showTime!)
      }

      // Light layers, after the scenes, so a layer wins on a fixture both
      // mention -- the same priority the previz uses, which is what keeps the
      // screen and the room showing the same thing.
      const layers = this.getLayers()
      const layer = showTime !== null ? activeLayer(layers, showTime) : null
      if (layer) {
        mergeLayerUniverse(
          out,
          this.writable.get(universe) ?? [],
          layer,
          this.membersFor(layers, this.getEditorVersion()).get(layer.id) ?? new Map(),
          showTime!,
        )
      }
      this.activeSceneName = layer ? layer.name : scene ? scene.name : null
    } else {
      this.activeSceneName = null
    }

    this.send(universe, out)
    this.lastSentAt.set(universe, Date.now())
  }

  // The armed clock. Re-emits any universe the console has not refreshed for
  // us recently, so our animations run at their own speed rather than at the
  // console's. Deliberately does nothing when the link is dead: the watchdog's
  // whole promise is that a silent console cannot leave the rig frozen on our
  // last frame, and a refresh clock is exactly how that promise gets broken.
  private refresh(): void {
    if (this.mode !== 'armed' || this.watchdogTripped()) return
    const now = Date.now()
    for (const universe of this.raw.keys()) {
      if (now - (this.lastSentAt.get(universe) ?? 0) < ARMED_REFRESH_MS) continue
      this.emit(universe)
    }
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

  /** `now` is injectable so the self-test can reach the dead-link case without
   *  sleeping for the whole watchdog window. */
  watchdogTripped(now = Date.now()): boolean {
    return this.mode !== 'off' && now - this.lastConsoleAt > WATCHDOG_MS
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
      writableFamilies: this.writableFamilies,
    }
  }

  stop(): void {
    if (this.blackoutTimer) clearInterval(this.blackoutTimer)
    if (this.refreshTimer) clearInterval(this.refreshTimer)
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
