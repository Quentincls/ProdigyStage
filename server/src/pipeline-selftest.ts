// Self-test for the console -> Tambora pipeline, as it stands before the rig
// is extended to the rest of the plot.
//
// This is a safety net, not a demonstration. Everything asserted here is a
// promise the Tambora path already keeps today, written down so that adding
// forty fixtures on universes 5-8 -- and the registry and adapters that come
// with them -- cannot quietly break it. Every expectation is derived from
// data/patch.json and from the official patch list, never from the code the
// test is checking, so a change to the code makes the test fail rather than
// agree with itself.
//
// What is pinned, in the order a byte travels:
//
//   1. the wire        -- ArtDMX parses, and Art-Net universe N-1 is show N
//   2. the addressing  -- where the patch says each of the 32 battens lives
//   3. the channel map -- which channel inside a batten is which function
//   4. the read path   -- a frame lands where the previz will look for it
//   5. the write path  -- mergeUniverse touches those channels and no others
//   6. silence         -- a universe nobody sends is never mistaken for data
//
// Runs in a loop on this machine: no rig, no console, no network.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SceneSpec } from '@prodigy-stage/core'
import {
  artnetUniverseToShow,
  buildArtDmxPacket,
  DMX_CHANNELS,
  parseArtDmx,
  showUniverseToArtnet,
} from './artnet.js'
import { ArtnetListener } from './listener.js'
import { mergeUniverse } from './output.js'
import { loadPatch, patchPath, type Fixture, type Patch } from './patch.js'

let checks = 0
function assert(condition: boolean, message: string): void {
  checks++
  if (!condition) {
    console.error(`pipeline selftest: FAIL -- ${message}`)
    process.exit(1)
  }
}

const patch: Patch = loadPatch()
// Read the file again, untyped: the server's FixtureType does not declare the
// tilt fields the UI's does -- one more thing the two sides know separately
// about the same JSON, and one more reason for a single fixture layer. Reading
// the raw document keeps this test out of that argument.
const raw = JSON.parse(readFileSync(fileURLToPath(patchPath()), 'utf8')) as {
  fixtureTypes: Record<string, Record<string, unknown> & { standardMap: Record<string, number> }>
}

// ----- 1. the wire ----------------------------------------------------------
// The console numbers its universes from 1 and Art-Net numbers ports from 0.
// Getting this backwards would show universe 2's colours on universe 1's
// battens -- plausible enough on screen to be believed.

for (const show of [1, 2, 3, 4, 5, 6, 7, 8]) {
  assert(showUniverseToArtnet(show) === show - 1, `show universe ${show} must be Art-Net ${show - 1}`)
  assert(artnetUniverseToShow(showUniverseToArtnet(show)) === show, `universe ${show} round trip`)
}

const probe = new Uint8Array(DMX_CHANNELS)
probe[0] = 11
probe[510] = 22
probe[511] = 33
const packet = parseArtDmx(buildArtDmxPacket(showUniverseToArtnet(3), 7, probe))
assert(packet !== null, 'a packet we built ourselves must parse')
assert(artnetUniverseToShow(packet!.artnetUniverse) === 3, 'the packet must arrive on show universe 3')
assert(packet!.length === DMX_CHANNELS, 'a full frame must carry 512 channels')
assert(packet!.data[0] === 11 && packet!.data[510] === 22 && packet!.data[511] === 33, 'the payload must survive the round trip')

// A spectator answers nothing and believes nothing it does not recognise.
assert(parseArtDmx(Buffer.alloc(4)) === null, 'a runt packet is not ArtDMX')
assert(parseArtDmx(Buffer.from('not art-net at all, just udp noise')) === null, 'foreign UDP is not ArtDMX')

// ----- 2. the addressing ----------------------------------------------------
// Straight from the PATCH LIJST (III_LIGHT_DOCU_LIGHT_BXL, p. 28): eight
// Standard blocks per universe, heads in order, left wall on universes 1-2 and
// right wall on 3-4. Written out rather than computed, so that regenerating
// the patch differently is a failure and not a new expectation.
const STANDARD_ADDRESSES = [1, 62, 123, 184, 245, 306, 367, 428]
const EXPECTED: Record<number, string[]> = {
  1: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'],
  2: ['L9', 'L10', 'L11', 'L12', 'L13', 'L14', 'L15', 'L16'],
  3: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'],
  4: ['R9', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'R16'],
}

assert(patch.fixtures.length === 32, `the plot has 32 Tambora, the patch has ${patch.fixtures.length}`)
for (const [universe, ids] of Object.entries(EXPECTED)) {
  const onUniverse = patch.fixtures
    .filter((fixture) => fixture.universe === Number(universe))
    .sort((a, b) => a.address - b.address)
  assert(
    onUniverse.map((fixture) => fixture.id).join(',') === ids.join(','),
    `universe ${universe} must carry ${ids.join(',')} in address order, got ${onUniverse.map((f) => f.id).join(',')}`,
  )
  assert(
    onUniverse.map((fixture) => fixture.address).join(',') === STANDARD_ADDRESSES.join(','),
    `universe ${universe} must be addressed ${STANDARD_ADDRESSES.join('/')}`,
  )
}

// The left wall is one continuous line and so is the right: the effect engine
// normalises a pixel's position along its wall, so a fixture in the wrong
// group would light at the wrong end of the room.
assert(patch.groups.join(',') === 'wall-left,wall-right', `groups are ${patch.groups.join(',')}`)
for (const fixture of patch.fixtures) {
  const expected = fixture.id.startsWith('L') ? 'wall-left' : 'wall-right'
  assert(fixture.group === expected, `${fixture.id} must be in ${expected}`)
}

// ----- 3. the channel map ---------------------------------------------------
// Tambora Batten "Standard RGB", 61 channels. Identified from the official
// chart and confirmed against the venue recording of 2026-07-27 -- the first
// guess (dimmer on 1, strobe on 2) was wrong, which is exactly why it is
// written down here.
const TAMBORA_CHART: Record<string, number> = {
  red: 1,
  green: 2,
  blue: 3,
  white: 4,
  cto: 5,
  strobe: 6,
  dimmer: 7,
  dimmerFine: 8,
  tilt: 9,
  tiltFine: 10,
  zoom: 11,
  function: 12,
  reset: 13,
}
const type = raw.fixtureTypes['tambora-std-pixel']
assert(type !== undefined, 'the patch must declare the tambora-std-pixel type')
const pixelStart = type.pixelStart as number
const pixels = type.pixels as number
const footprint = type.footprint as number
const tiltRangeDeg = type.tiltRangeDeg as number
for (const [name, channel] of Object.entries(TAMBORA_CHART)) {
  assert(type.standardMap[name] === channel, `${name} must be channel ${channel}, patch says ${type.standardMap[name]}`)
}
assert(pixelStart === 14, 'the pixel zone starts at channel 14')
assert(pixels === 16, 'a Tambora Batten has 16 pixels')
assert(footprint === 61, 'Standard RGB is 61 channels')
assert(tiltRangeDeg === 220, 'the yoke travels 220 degrees')

// 61 channels each, eight per universe: they must fit, and never overlap.
for (const universe of [1, 2, 3, 4]) {
  const blocks = patch.fixtures
    .filter((fixture) => fixture.universe === universe)
    .map((fixture) => [fixture.address, fixture.address + footprint - 1])
    .sort((a, b) => a[0] - b[0])
  assert(blocks[blocks.length - 1][1] <= DMX_CHANNELS, `universe ${universe} overflows 512 channels`)
  for (let i = 1; i < blocks.length; i++) {
    assert(blocks[i][0] > blocks[i - 1][1], `universe ${universe}: blocks ${i - 1} and ${i} overlap`)
  }
}

// ----- 4. the read path -----------------------------------------------------
// One batten, values on every function the previz reads, straight through the
// wire and back out at the absolute channels the patch implies. This is the
// arithmetic every reader of a frame performs -- `address - 1 + channel - 1`
// -- and the one an adapter layer will have to keep performing exactly.
const target = patch.fixtures.find((fixture) => fixture.id === 'L5')!
assert(target.universe === 1 && target.address === 245, 'L5 sits at universe 1, channel 245')

const abs = (fixture: Fixture, key: string): number => fixture.address - 1 + TAMBORA_CHART[key] - 1
const frame = new Uint8Array(DMX_CHANNELS)
const written: Record<string, number> = {
  red: 200,
  green: 40,
  blue: 10,
  white: 128,
  strobe: 255,
  dimmer: 180,
  dimmerFine: 64,
  tilt: 128,
  tiltFine: 0,
}
for (const [key, value] of Object.entries(written)) frame[abs(target, key)] = value
// The pixel zone too: channel 14 is pixel 1 red, three channels per pixel.
const pixelBase = target.address - 1 + pixelStart - 1
frame[pixelBase] = 90
frame[pixelBase + 1] = 91
frame[pixelBase + 2] = 92

const flown = parseArtDmx(buildArtDmxPacket(showUniverseToArtnet(target.universe), 0, frame))!
const received = new Uint8Array(DMX_CHANNELS)
received.set(flown.data)
for (const [key, value] of Object.entries(written)) {
  assert(received[abs(target, key)] === value, `L5 ${key} must read back ${value}`)
}
assert(received[pixelBase] === 90 && received[pixelBase + 2] === 92, 'L5 pixel 1 must read back')
// And nothing landed on its neighbours.
const neighbour = patch.fixtures.find((fixture) => fixture.id === 'L6')!
assert(received[abs(neighbour, 'red')] === 0, 'writing L5 must not touch L6')
assert(received[abs(neighbour, 'dimmer')] === 0, 'writing L5 must not touch L6')

// The 16-bit pair the previz turns into an angle, and the halves it is made
// of: coarse 128 / fine 0 is dead centre of the travel, which is level.
const coarse = received[abs(target, 'tilt')]
const fine = received[abs(target, 'tiltFine')]
const angle = ((coarse * 256 + fine) / 65535 - 0.5) * tiltRangeDeg
assert(Math.abs(angle) < 0.5, `tilt 128/0 must read as level, got ${angle.toFixed(2)} degrees`)

// ----- 5. the write path ----------------------------------------------------
// Phase 6 repaints a batten by writing its colour, opening its dimmer and its
// shutter -- and by leaving tilt and zoom alone, because the console owns the
// movement. That last part is a promise about channels NOT written, which is
// the kind that rots silently, so it is asserted rather than trusted.
const scene: SceneSpec = {
  id: 'test',
  name: 'test',
  start: 0,
  end: 100,
  tracks: [{ id: 't', target: 'both', effect: 'solid', params: { color: '#ff0000' }, fadeIn: 0, fadeOut: 0 }],
}
const before = new Uint8Array(DMX_CHANNELS)
for (const fixture of patch.fixtures.filter((f) => f.universe === 1)) {
  before[abs(fixture, 'tilt')] = 200
  before[abs(fixture, 'tiltFine')] = 100
  before[abs(fixture, 'zoom')] = 55
}
const after = new Uint8Array(before)
const map = {
  red: TAMBORA_CHART.red - 1,
  green: TAMBORA_CHART.green - 1,
  blue: TAMBORA_CHART.blue - 1,
  white: TAMBORA_CHART.white - 1,
  dimmer: TAMBORA_CHART.dimmer - 1,
  dimmerFine: TAMBORA_CHART.dimmerFine - 1,
  strobe: TAMBORA_CHART.strobe - 1,
}
const wall = patch.fixtures.filter((f) => f.group === 'wall-left').sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
const outFixtures = wall
  .filter((f) => f.universe === 1)
  .map((fixture) => ({
    universe: fixture.universe,
    base: fixture.address - 1,
    group: fixture.group,
    wallPos: (wall.indexOf(fixture) + 0.5) / wall.length,
    pixelIndex: wall.indexOf(fixture) * pixels + Math.floor(pixels / 2),
  }))
const touched = mergeUniverse(after, outFixtures, map, scene, 50)
assert(touched, 'a solid scene over the whole wall must touch universe 1')

for (const fixture of patch.fixtures.filter((f) => f.universe === 1)) {
  assert(after[abs(fixture, 'red')] === 255, `${fixture.id} must be painted red`)
  assert(after[abs(fixture, 'green')] === 0, `${fixture.id} green must be off`)
  assert(after[abs(fixture, 'white')] === 0, `${fixture.id} white must fade out of the way`)
  assert(after[abs(fixture, 'dimmer')] === 255, `${fixture.id} dimmer must open`)
  assert(after[abs(fixture, 'strobe')] === 255, `${fixture.id} shutter must open`)
  // The console keeps the movement. Nothing here may steer a fixture.
  assert(after[abs(fixture, 'tilt')] === 200, `${fixture.id} tilt must be left to the console`)
  assert(after[abs(fixture, 'tiltFine')] === 100, `${fixture.id} tilt fine must be left to the console`)
  assert(after[abs(fixture, 'zoom')] === 55, `${fixture.id} zoom must be left to the console`)
}
// And no scene means no writing at all, whatever else is going on.
const untouched = new Uint8Array(before)
assert(!mergeUniverse(untouched, outFixtures, map, null, 50), 'no scene must touch nothing')
assert(untouched.every((byte, i) => byte === before[i]), 'no scene must leave the frame byte-identical')

// ----- 6. silence -----------------------------------------------------------
// A universe nobody is sending arrives as a buffer of zeros, and zero is a
// real DMX value: one end of the tilt travel, a closed shutter, black. Anything
// reading a frame must be able to tell "nothing is being sent" from "everything
// is at zero", or it will confidently draw a rig that is switched off.
const listener = new ArtnetListener([1, 2, 3, 4])
for (const universe of [1, 2, 3, 4]) {
  assert(!listener.isActive(universe), `universe ${universe} must be inactive before a single packet`)
  assert(listener.getBuffer(universe).every((byte) => byte === 0), `universe ${universe} starts at zero`)
}
assert(!listener.isTimecodeActive(), 'timecode must be inactive before a single packet')

console.log(`pipeline selftest: OK (${checks} checks -- wire, addressing, channel map, read, write, silence)`)
