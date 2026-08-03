// Self-test of the Phase 6 output (`npm run test:output`). Proves, without a
// rig and without a console, the properties the on-site commissioning relies
// on: nothing is transmitted until explicitly armed, passthrough is byte-exact,
// a scene only repaints the walls it targets, and the crossfade is symmetric.

import { createSocket } from 'node:dgram'
import type { SceneSpec } from '@prodigy-stage/core'
import { parseArtDmx } from './artnet.js'
import { ArtnetOutput, crossfadeMix, mergeLayerUniverse, mergeUniverse } from './output.js'
import { defaultBehaviorParams } from '@prodigy-stage/core/behaviors'
import { isWritable } from '@prodigy-stage/core/fixtures'
import { layerMembers, type FixtureRef, type LightLayer } from '@prodigy-stage/core/layers'
import { loadPatch } from './patch.js'

const TEST_PORT = 6455 // never 6454: that would feed our own listener

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures++
    console.error(`FAIL ${label}${detail ? ` -- ${detail}` : ''}`)
  }
}

const patch = loadPatch()
const type = patch.fixtureTypes[patch.fixtures[0].type]
const S = type.standardMap
const map = {
  red: S.red - 1,
  green: S.green - 1,
  blue: S.blue - 1,
  white: S.white - 1,
  dimmer: S.dimmer - 1,
  dimmerFine: S.dimmerFine - 1,
  strobe: S.strobe - 1,
}

const leftWall = patch.fixtures
  .filter((f) => f.group === 'wall-left')
  .sort((a, b) => parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10))
const universe = leftWall[0].universe
const fixtures = leftWall
  .filter((f) => f.universe === universe)
  .map((fixture, index) => ({
    universe: fixture.universe,
    base: fixture.address - 1,
    group: fixture.group,
    wallPos: (index + 0.5) / leftWall.length,
    pixelIndex: index * type.pixels + Math.floor(type.pixels / 2),
  }))

const scene: SceneSpec = {
  id: 'test',
  name: 'Test scene',
  start: 10,
  end: 20,
  tracks: [
    {
      id: 't1',
      target: 'wall-left',
      effect: 'solid',
      params: { color: '#ff0000' },
      fadeIn: 0,
      fadeOut: 0,
    },
  ],
}

// 1. Crossfade shape: 0 outside, ramps over 0,5 s, 1 in the middle.
check('crossfade before the scene', crossfadeMix(scene, 9.9) === 0)
check('crossfade after the scene', crossfadeMix(scene, 20) === 0)
check('crossfade mid-scene', crossfadeMix(scene, 15) === 1)
check('crossfade in at 50%', Math.abs(crossfadeMix(scene, 10.25) - 0.5) < 1e-9)
check('crossfade out at 50%', Math.abs(crossfadeMix(scene, 19.75) - 0.5) < 1e-9)
check(
  'crossfade is symmetric',
  Math.abs(crossfadeMix(scene, 10.1) - crossfadeMix(scene, 19.9)) < 1e-9,
)

// 2. No scene, or a scene that is not active: the frame is untouched.
{
  const frame = new Uint8Array(512).fill(77)
  const before = Uint8Array.from(frame)
  check('no scene leaves the frame untouched', mergeUniverse(frame, fixtures, map, null, 15) === false)
  check('no scene, bytes identical', frame.every((v, i) => v === before[i]))
  mergeUniverse(frame, fixtures, map, scene, 5) // outside the scene window
  check('inactive scene, bytes identical', frame.every((v, i) => v === before[i]))
}

// 3. Full override: our colour, dimmer opened, shutter opened, tilt untouched.
{
  const frame = new Uint8Array(512)
  const first = fixtures[0].base
  frame[first + map.red] = 9
  frame[first + map.green] = 9
  frame[first + map.blue] = 9
  frame[first + map.dimmer] = 0 // console blackout under our scene
  frame[first + (S.tilt - 1)] = 200 // console keeps driving the movement
  const touched = mergeUniverse(frame, fixtures, map, scene, 15)
  check('active scene reports a merge', touched)
  check('red is ours', frame[first + map.red] === 255, `got ${frame[first + map.red]}`)
  check('green is ours', frame[first + map.green] === 0)
  check('blue is ours', frame[first + map.blue] === 0)
  check('white faded away', frame[first + map.white] === 0)
  check('dimmer opened', frame[first + map.dimmer] === 255)
  check('shutter opened', frame[first + map.strobe] === 255)
  check('tilt left to the console', frame[first + (S.tilt - 1)] === 200)
}

// 4. Half crossfade sits between the console value and ours.
{
  const frame = new Uint8Array(512)
  const first = fixtures[0].base
  frame[first + map.red] = 0
  mergeUniverse(frame, fixtures, map, scene, 10.25)
  const value = frame[first + map.red]
  check('crossfade blends towards our colour', value > 100 && value < 160, `got ${value}`)
}

// 5. A track that targets one wall never writes to the other.
{
  const rightWall = patch.fixtures.filter((f) => f.group === 'wall-right')
  const rightFixtures = rightWall.map((fixture, index) => ({
    universe: fixture.universe,
    base: fixture.address - 1,
    group: fixture.group,
    wallPos: (index + 0.5) / rightWall.length,
    pixelIndex: index * type.pixels,
  }))
  const frame = new Uint8Array(512).fill(42)
  const before = Uint8Array.from(frame)
  const touched = mergeUniverse(frame, rightFixtures, map, scene, 15)
  check('wall-left scene does not touch wall-right', touched === false)
  check('wall-right bytes identical', frame.every((v, i) => v === before[i]))
}

// 6. Safety: no target = cannot be armed, and a loopback target on our own
//    listening port is refused (it would feed our own listener).
{
  const idle = new ArtnetOutput({ targets: [], port: TEST_PORT }, patch)
  check('boots in off', idle.status().mode === 'off')
  let threw = false
  try {
    idle.setMode('armed')
  } catch {
    threw = true
  }
  check('arming without a target throws', threw)
  check('still off after the refused arm', idle.status().mode === 'off')

  let loopThrew = false
  const guard = new ArtnetOutput({ targets: [], port: 6454 }, patch, 6454)
  try {
    guard.setTargets(['127.0.0.1'])
  } catch {
    loopThrew = true
  }
  check('loopback on our own port is refused', loopThrew)
  idle.stop()
  guard.stop()
}

// 7. End to end over real UDP: off transmits nothing, spectator is byte-exact,
//    armed repaints only the targeted wall.
const received: Buffer[] = []
const sink = createSocket({ type: 'udp4', reuseAddr: true })
sink.on('message', (msg) => received.push(Buffer.from(msg)))

await new Promise<void>((resolve) => sink.bind(TEST_PORT, '127.0.0.1', resolve))

const output = new ArtnetOutput({ targets: ['127.0.0.1'], port: TEST_PORT }, patch)
output.getScenes = () => [scene]
let showTime = 15
output.getShowTime = () => showTime

const consoleFrame = new Uint8Array(512)
for (const fixture of fixtures) {
  consoleFrame[fixture.base + map.red] = 30
  consoleFrame[fixture.base + map.green] = 60
  consoleFrame[fixture.base + map.blue] = 90
  consoleFrame[fixture.base + map.dimmer] = 255
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

// 7a. off: nothing must leave the machine.
output.onConsoleFrame(universe, consoleFrame, process.hrtime.bigint())
await settle()
check('off transmits nothing', received.length === 0, `got ${received.length} packets`)

// 7b. spectator: byte-exact passthrough.
output.setMode('spectator')
received.length = 0
output.onConsoleFrame(universe, consoleFrame, process.hrtime.bigint())
await settle()
check('spectator transmits one packet', received.length === 1, `got ${received.length}`)
{
  const packet = parseArtDmx(received[0])
  check('passthrough is a valid ArtDMX', packet !== null)
  check(
    'passthrough is byte-exact',
    packet !== null && consoleFrame.every((v, i) => packet.data[i] === v),
  )
}

// 7c. armed, mid-scene: our colour on the targeted wall.
output.setMode('armed')
received.length = 0
output.onConsoleFrame(universe, consoleFrame, process.hrtime.bigint())
await settle()
{
  const packet = parseArtDmx(received[0])
  const first = fixtures[0].base
  check('armed transmits', packet !== null)
  check('armed applies the scene colour', packet !== null && packet.data[first + map.red] === 255)
  check('armed reports the scene name', output.status().activeSceneName === 'Test scene')
  check('console frame was not mutated', consoleFrame[first + map.red] === 30)
}

// 7d. armed, outside any scene: back to byte-exact passthrough.
received.length = 0
showTime = 100
output.onConsoleFrame(universe, consoleFrame, process.hrtime.bigint())
await settle()
{
  const packet = parseArtDmx(received[0])
  check(
    'armed outside a scene is byte-exact',
    packet !== null && consoleFrame.every((v, i) => packet.data[i] === v),
  )
}

// 7e. passthrough latency stays far under the 5 ms budget.
{
  const worst = output.status().maxPassthroughUs
  check('passthrough under 5 ms', worst < 5000, `worst ${worst} us`)
  console.log(`output selftest: worst passthrough ${worst} us`)
}

// 7f. blackout forces zeros even though the console is sending colour.
output.setMode('blackout')
received.length = 0
await settle()
{
  const packet = received.length > 0 ? parseArtDmx(received[received.length - 1]) : null
  check('blackout keeps transmitting without console input', packet !== null)
  check('blackout is all zeros', packet !== null && packet.data.every((v) => v === 0))
}

// 7g. watchdog trips after 250 ms of console silence.
output.setMode('spectator')
output.onConsoleFrame(universe, consoleFrame, process.hrtime.bigint())
check('watchdog clear right after a frame', output.watchdogTripped() === false)
await new Promise((resolve) => setTimeout(resolve, 300))
check('watchdog trips after 250 ms of silence', output.watchdogTripped() === true)

// 7h. back to off: transmission stops immediately.
output.setMode('off')
received.length = 0
output.onConsoleFrame(universe, consoleFrame, process.hrtime.bigint())
await settle()
check('off again transmits nothing', received.length === 0)

output.stop()
sink.close()

if (failures > 0) {
  console.error(`output selftest: ${failures} FAILURES`)
  process.exit(1)
}
// ----- light layers on the wire ---------------------------------------------
// The output learned to drive families beyond the two walls. Everything below
// exists because that widened what this software can transmit to, and the one
// property that keeps it safe is not a check anyone has to remember: a family
// with no channel map has no address to write to, so it cannot be reached.

{
  const refs: FixtureRef[] = patch.fixtures.map((f) => ({ id: f.id, type: f.type, group: f.group }))
  const targetsFor = (universeWanted: number) =>
    patch.fixtures
      .filter((f) => f.universe === universeWanted && isWritable(patch.fixtureTypes[f.type]))
      .map((f) => ({
        ref: { id: f.id, type: f.type, group: f.group },
        profile: patch.fixtureTypes[f.type],
        base: f.address - 1,
      }))

  const part = (id: string, kind: 'family' | 'group' | 'fixture', key: string, behavior = 'static') => ({
    id,
    target: { kind, key } as const,
    behavior: behavior as 'static',
    params: { ...defaultBehaviorParams(behavior), level: 1, color: '#ff0000' },
    fadeIn: 0,
    fadeOut: 0,
  })

  // --- a family we CAN drive: the blinders, universe 5, dimmer on channel 1.
  const blinderLayer: LightLayer = {
    id: 'L', name: 'Hit', start: 10, end: 20,
    parts: [part('p', 'family', 'blinded1-4ch')],
  }
  const blinderMembers = layerMembers(blinderLayer, refs)
  const frame = new Uint8Array(512)
  const touched = mergeLayerUniverse(frame, targetsFor(5), blinderLayer, blinderMembers, 15)
  check('a layer drives a family whose chart is confirmed', touched)
  const b1 = patch.fixtures.find((f) => f.id === 'B1')!
  check(
    'the blinder dimmer is opened',
    frame[b1.address - 1] === 255,
    `got ${frame[b1.address - 1]} at channel ${b1.address}`,
  )
  check(
    'and its 16-bit fine channel with it',
    frame[b1.address] === 255,
    `got ${frame[b1.address]}`,
  )
  // Channel 4 is the dimmer-speed control channel: not ours, never touched.
  check('a channel the profile does not declare is left to the console', frame[b1.address + 2] === 0)

  // --- a family we CANNOT drive: not one byte, however loudly the layer asks.
  for (const [family, type] of [['Side Panels', 'bpanel-3ch'], ['Beams', 'perseo-ex']] as const) {
    const layer: LightLayer = {
      id: 'X', name: 'Ask', start: 10, end: 20,
      parts: [part('q', 'family', type)],
    }
    for (const u of [5, 6, 7, 8]) {
      const buffer = new Uint8Array(512)
      const untouched = new Uint8Array(buffer)
      mergeLayerUniverse(buffer, targetsFor(u), layer, layerMembers(layer, refs), 15)
      check(
        `${family}: a layer cannot transmit to a family with no channel map (universe ${u})`,
        buffer.every((byte, i) => byte === untouched[i]),
      )
    }
  }

  // --- the console keeps everything the layer does not name.
  const mixed = new Uint8Array(512).fill(77)
  const keep = new Uint8Array(mixed)
  mergeLayerUniverse(mixed, targetsFor(5), blinderLayer, blinderMembers, 15)
  const xl = patch.fixtures.find((f) => f.id === 'XL')!
  check(
    'an X-Frame no part names keeps the console frame byte for byte',
    mixed.slice(xl.address - 1, xl.address - 1 + 43).every((byte) => byte === keep[0]),
  )

  // --- subtractive colour: an X-Frame asked for red filters cyan, not red.
  const xLayer: LightLayer = {
    id: 'C', name: 'Red', start: 10, end: 20,
    parts: [part('r', 'family', 'xframe-43ch')],
  }
  const cmy = new Uint8Array(512)
  mergeLayerUniverse(cmy, targetsFor(5), xLayer, layerMembers(xLayer, refs), 15)
  const base = xl.address - 1
  check('red on a CMY fixture means no cyan', cmy[base] === 0, `cyan ${cmy[base]}`)
  check('and full magenta and yellow', cmy[base + 1] === 255 && cmy[base + 2] === 255)
  // Framing blades, gobos and prisms are the console's business, not ours.
  check('framing blades are never written', cmy[base + 25] === 0 && cmy[base + 32] === 0)
  check('gobos and prisms are never written', cmy[base + 13] === 0 && cmy[base + 16] === 0)

  // --- the crossfade owns the edges, exactly as it does for scenes.
  const edge = new Uint8Array(512).fill(100)
  mergeLayerUniverse(edge, targetsFor(5), blinderLayer, blinderMembers, 10)
  check('at the very start a layer owns nothing', edge.every((byte) => byte === 100))
  const late = new Uint8Array(512).fill(100)
  mergeLayerUniverse(late, targetsFor(5), blinderLayer, blinderMembers, 20)
  check('and nothing at the very end', late.every((byte) => byte === 100))

  // --- outside its own time, a layer is not there at all.
  const outside = new Uint8Array(512).fill(9)
  check(
    'a layer that is not running writes nothing',
    !mergeLayerUniverse(outside, targetsFor(5), blinderLayer, blinderMembers, 5) &&
      outside.every((byte) => byte === 9),
  )
}

console.log(
  'output selftest: OK (safety, passthrough fidelity, scene merge, layer merge, watchdog)',
)
