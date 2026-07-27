// Self-test of the Phase 6 output (`npm run test:output`). Proves, without a
// rig and without a console, the properties the on-site commissioning relies
// on: nothing is transmitted until explicitly armed, passthrough is byte-exact,
// a scene only repaints the walls it targets, and the crossfade is symmetric.

import { createSocket } from 'node:dgram'
import type { SceneSpec } from '@prodigy-stage/core'
import { parseArtDmx } from './artnet.js'
import { ArtnetOutput, crossfadeMix, mergeUniverse } from './output.js'
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
console.log('output selftest: OK (safety, passthrough fidelity, scene merge, watchdog)')
