// Self-test for the shared fixture layer (core/fixtures.ts).
//
// Its whole job is to prove that moving the DMX arithmetic out of the previz
// changed nothing. The expected numbers below were computed by hand from the
// formula the previz has used since the channel map was confirmed against the
// venue recording -- not by running the new code and writing down what it said,
// which would only prove the new code agrees with itself.
//
// The formula, for the record:
//
//     intensity = (dimmer * 256 + dimmerFine) / 65535
//     lit       = strobe > 3
//     colour    = min(1, emitter/255 + white/255) * intensity
//     tilt      = ((tilt * 256 + tiltFine) / 65535 - 0.5) * range
//
// Plus the two rules that are the reason this layer exists at all: a fixture
// with no chart, and a universe nobody is sending, both read as unknown rather
// than as a fixture sitting at zero.

import {
  blankState,
  capabilitiesOf,
  kindOf,
  litColour,
  readFixture,
  readPixel,
  type FixtureProfile,
} from '@prodigy-stage/core/fixtures'
import { DMX_CHANNELS } from './artnet.js'

let checks = 0
function assert(condition: boolean, message: string): void {
  checks++
  if (!condition) {
    console.error(`fixtures selftest: FAIL -- ${message}`)
    process.exit(1)
  }
}
function close(a: number, b: number, tolerance: number, message: string): void {
  assert(Math.abs(a - b) <= tolerance, `${message} (got ${a}, expected ${b})`)
}

const TAMBORA: FixtureProfile = {
  name: 'Clay Paky Tambora Batten',
  kind: 'batten',
  footprint: 61,
  pixels: 16,
  pixelStart: 14,
  tiltRangeDeg: 220,
  tiltInvert: false,
  standardMap: {
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
  },
}

const dmx = new Uint8Array(DMX_CHANNELS)
const base = 244 // L5 sits at address 245
const at = (channel: number): number => base + channel - 1

// ----- a lit fixture, read the way the previz always has ---------------------
dmx[at(1)] = 204 // red   204/255 = 0.8
dmx[at(2)] = 51 //  green  51/255 = 0.2
dmx[at(3)] = 0
dmx[at(4)] = 26 //  white  26/255 ~ 0.102
dmx[at(6)] = 255 // shutter open
dmx[at(7)] = 128 // dimmer: 128*256 / 65535
dmx[at(8)] = 0
dmx[at(9)] = 128 // tilt, dead centre
dmx[at(10)] = 0
dmx[at(11)] = 64 // zoom 64/255 ~ 0.251

const state = readFixture(TAMBORA, dmx, base, true)
assert(state.known, 'a charted fixture on a live universe must be known')
assert(state.lit, 'shutter at 255 is open')
close(state.intensity, 32768 / 65535, 1e-9, 'intensity is the 16-bit dimmer')
close(state.r, 0.8, 1e-6, 'red is the raw emitter, before the dimmer')
close(state.g, 0.2, 1e-6, 'green is the raw emitter')
close(state.b, 0, 1e-9, 'blue is off')
close(state.white, 26 / 255, 1e-9, 'white is its own channel')
close(state.tilt!, 0, 0.0002, 'tilt 128/0 is level')
close(state.zoom!, 64 / 255, 1e-9, 'zoom is 8-bit')
assert(state.pan === null, 'a Tambora does not pan')
assert(state.fog === null, 'a Tambora is not a hazer')

// The colour the eye sees: emitters plus white, through the dimmer.
const colour: [number, number, number] = [0, 0, 0]
litColour(state, colour)
close(colour[0], Math.min(1, 0.8 + 26 / 255) * (32768 / 65535), 1e-9, 'lit red')
close(colour[1], Math.min(1, 0.2 + 26 / 255) * (32768 / 65535), 1e-9, 'lit green')
close(colour[2], Math.min(1, 0 + 26 / 255) * (32768 / 65535), 1e-9, 'lit blue is the white emitter alone')

// ----- the shutter wins over everything -------------------------------------
dmx[at(6)] = 3 // still inside the closed band
const shut = readFixture(TAMBORA, dmx, base, true)
assert(shut.known, 'a closed fixture is still a fixture we can read')
assert(!shut.lit, 'shutter at 3 is closed')
close(shut.intensity, 32768 / 65535, 1e-9, 'a closed shutter does not move the dimmer')
litColour(shut, colour)
assert(colour[0] === 0 && colour[1] === 0 && colour[2] === 0, 'a closed shutter is black')
dmx[at(6)] = 255

// ----- the ends of the tilt travel ------------------------------------------
dmx[at(9)] = 0
dmx[at(10)] = 0
close(readFixture(TAMBORA, dmx, base, true).tilt!, (-0.5 * 220 * Math.PI) / 180, 1e-9, 'DMX 0 is one end of the travel')
dmx[at(9)] = 255
dmx[at(10)] = 255
close(readFixture(TAMBORA, dmx, base, true).tilt!, (0.5 * 220 * Math.PI) / 180, 1e-9, 'DMX 65535 is the other end')
// Inverting the yoke mirrors it and nothing else.
const inverted = readFixture({ ...TAMBORA, tiltInvert: true }, dmx, base, true)
close(inverted.tilt!, (-0.5 * 220 * Math.PI) / 180, 1e-9, 'tiltInvert mirrors the angle')
dmx[at(9)] = 128
dmx[at(10)] = 0

// ----- silence is not data --------------------------------------------------
// The bug this rule comes from: a universe nobody was sending arrived full of
// zeroes, zero on the tilt channel is one end of 220 degrees of travel, and
// every batten in the previz was aimed at the back wall with the console off.
const dark = readFixture(TAMBORA, dmx, base, false)
assert(!dark.known, 'a universe nobody is sending must read as unknown')
assert(dark.tilt === null, 'an unknown fixture has no angle, not an angle of zero')
assert(!dark.lit, 'an unknown fixture is not lit')
const nothing = readFixture(TAMBORA, null, base, true)
assert(!nothing.known, 'no buffer at all must read as unknown')

// ----- a fixture whose chart we do not have ---------------------------------
// Addresses and modes come from the lighting document; the channel layout
// inside a mode does not. Registered and unreadable is the honest state, and
// it must never be confused with a fixture that is simply dark.
const UNDOCUMENTED: FixtureProfile = { name: 'Ayrton Perseo Beam', kind: 'movinghead', footprint: 42 }
const blind = readFixture(UNDOCUMENTED, dmx, 40, true)
assert(!blind.known, 'a profile with no channel map must read as unknown')
assert(capabilitiesOf(UNDOCUMENTED).length === 0, 'an uncharted profile advertises no controls')

// ----- a patch written before `kind` existed ---------------------------------
// Updating the software never touches data/, so every install is still running
// the patch it was shipped with -- and that patch has no `kind`, because the
// field did not exist yet. Requiring it turned every batten into a fixture the
// previz did not recognise, which emptied the rig, which crashed the page. An
// old patch has to keep working, and this is where that is decided.
const LEGACY: FixtureProfile = {
  name: 'Clay Paky Tambora Batten',
  footprint: 61,
  pixels: 16,
  pixelStart: 14,
  tiltRangeDeg: 220,
  standardMap: TAMBORA.standardMap,
}
assert(LEGACY.kind === undefined, 'the legacy profile must have no kind, that is the point')
assert(kindOf(LEGACY) === 'batten', 'a profile with a pixel zone is a batten whether or not it says so')
assert(kindOf({ name: 'x', footprint: 1 }) === 'unknown', 'a profile with nothing to go on is unknown')
assert(kindOf({ name: 'x', footprint: 1, kind: 'fog' }) === 'fog', 'a declared kind wins')
const legacyState = readFixture(LEGACY, dmx, base, true)
assert(legacyState.known, 'a legacy Tambora must still be readable')
close(legacyState.intensity, 32768 / 65535, 1e-9, 'a legacy Tambora reads the same dimmer')
assert(capabilitiesOf(LEGACY).includes('tilt'), 'a legacy Tambora still tilts')

// ----- capabilities are read off the chart, not assumed ----------------------
const tamboraCaps = capabilitiesOf(TAMBORA)
for (const capability of ['intensity', 'color', 'white', 'shutter', 'tilt', 'zoom', 'pixels']) {
  assert(tamboraCaps.includes(capability as never), `a Tambora must expose ${capability}`)
}
assert(!tamboraCaps.includes('pan'), 'a Tambora must not expose pan')
assert(!tamboraCaps.includes('fog'), 'a Tambora must not expose fog')

// A dimmer-and-white panel exposes exactly that, whatever its family declares.
const PANEL: FixtureProfile = {
  name: 'Luxibel B Panel 240WW',
  kind: 'panel',
  footprint: 3,
  standardMap: { dimmer: 1, white: 2 },
}
const panelCaps = capabilitiesOf(PANEL)
assert(panelCaps.includes('intensity') && panelCaps.includes('white'), 'a panel dims and has white')
assert(!panelCaps.includes('color'), 'a panel with no RGB must not offer colour')
assert(!panelCaps.includes('tilt'), 'a panel does not move')

// ----- the pixel zone --------------------------------------------------------
dmx[at(14)] = 255
dmx[at(15)] = 128
dmx[at(16)] = 0
const pixel: [number, number, number] = [0, 0, 0]
readPixel(TAMBORA, dmx, base, 0, true, pixel)
close(pixel[0], 1, 1e-9, 'pixel 1 red')
close(pixel[1], 128 / 255, 1e-9, 'pixel 1 green')
close(pixel[2], 0, 1e-9, 'pixel 1 blue')
readPixel(TAMBORA, dmx, base, 1, true, pixel)
assert(pixel[0] === 0, 'pixel 2 is untouched')
readPixel(TAMBORA, dmx, base, 0, false, pixel)
assert(pixel[0] === 0, 'a silent universe has no pixels either')

// ----- no allocation on the hot path -----------------------------------------
// 32 fixtures at 60 fps is two thousand reads a second, and it is about to be
// seventy fixtures. The reusable-state form must genuinely reuse it.
const reused = blankState()
assert(readFixture(TAMBORA, dmx, base, true, reused) === reused, 'readFixture must write in place')

console.log(`fixtures selftest: OK (${checks} checks -- Tambora arithmetic preserved, unknown stays unknown)`)
