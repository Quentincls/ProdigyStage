// Generates data/patch.json for the MVP rig (universes 1-4, 32x Tambora Batten).
//
// Source of truth: official patch list "PATCH LIJST" in III_LIGHT_DOCU_LIGHT_BXL_PDF
// (pages 28-29), verified 2026-07-26:
//   Standard mode (13ch) at 001/062/123/184/245/306/367/428 on each universe,
//   PixelRGB mode (48ch) always at Standard address + 13.
//   Universe 1: heads 1-8 (L1-L8) - Universe 2: heads 9-16 (L9-L16)
//   Universe 3: heads 101-108 (R1-R8) - Universe 4: heads 109-116 (R9-R16)
//
// Positions follow the LICHTPLAN (page 5): each wall is a CONTINUOUS line of
// 16 battens laid end to end (~16 m per wall), flanking the tribune, at height.
// Exact placement will be refined in the placement UI (Phase 3).
//
// Coordinate system (documented in docs/architecture.md):
//   +X along the room length, x=0 at the middle of the batten walls,
//      stage/arch side at negative X (L1/R1 are the stage-side battens).
//   +Y up (height above floor).
//   +Z from the left wall towards the right wall (left z=-6, right z=+6).
//   rotation is Euler degrees [rx, ry, rz]; ry=0 faces +Z (left wall faces the
//   tribune), ry=180 faces -Z (right wall faces the tribune).

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('../data/patch.json', import.meta.url))
mkdirSync(dirname(OUT), { recursive: true })

const STD_ADDRESSES = [1, 62, 123, 184, 245, 306, 367, 428]
const BATTEN_PITCH = 1.0 // m, battens are contiguous on the light plan
const WALL_HEIGHT = 6 // m
const WALL_HALF_GAP = 6 // m, walls are 12 m apart
const WALL_LENGTH = 16 * BATTEN_PITCH

const fixtures = []
for (const side of ['L', 'R']) {
  for (let i = 1; i <= 16; i++) {
    const universe = side === 'L' ? (i <= 8 ? 1 : 2) : (i <= 8 ? 3 : 4)
    fixtures.push({
      id: `${side}${i}`,
      type: 'tambora-std-pixel',
      head: side === 'L' ? i : 100 + i,
      universe,
      address: STD_ADDRESSES[(i - 1) % 8],
      position: [
        round(-WALL_LENGTH / 2 + (i - 0.5) * BATTEN_PITCH),
        WALL_HEIGHT,
        side === 'L' ? -WALL_HALF_GAP : WALL_HALF_GAP,
      ],
      rotation: [0, side === 'L' ? 0 : 180, 0],
      group: side === 'L' ? 'wall-left' : 'wall-right',
    })
  }
}

function round(n) {
  return Math.round(n * 1000) / 1000
}

const patch = {
  fixtureTypes: {
    'tambora-std-pixel': {
      name: 'Clay Paky Tambora Batten',
      // What the room calls them. The manufacturer's name is the truth on the
      // invoice; this is the word the operator says, and the only one the
      // artistic side of the interface shows.
      short: 'Tambora',
      // Which adapter in core/fixtures.ts reads it. A profile without a kind
      // reads as unknown -- the honest answer for a model nobody has charted.
      kind: 'batten',
      footprint: 61,
      pixels: 16,
      pixelOrder: 'RGB',
      // Tambora Batten "Standard RGB" 61ch mode. Base block validated against
      // BOTH the official DMX chart (08.2021, via the QLC+ definition) and the
      // venue recording of 2026-07-27: dimmer 7/8 toggled 0->255->0 at the
      // session bounds, tilt 9/10 swept continuously (motorized tilt FX).
      // The per-pixel zone (14-61) is left parked by the console programming.
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
      pixelStart: 14,
      // Cross-checked 2026-07-29 against the QLC+ community definition of the
      // Tambora Batten (resources/fixtures/Clay_Paky/Clay-Paky-Tambora-Batten.qxf),
      // which lists "Standard RGBW" as exactly these thirteen channels in this
      // order and "RGB" as the 48-channel pixel block -- 13 + 48 = 61, the
      // footprint our console is configured for. Independent of our own venue
      // recording, and it agrees with it channel for channel.
      optics: {
        source: '16 x 40 W RGBW LED cells, 640 W, 9934 lm',
        beamAngleDeg: 4,
        beamAngleWideDeg: 35,
        diffuse: false,
      },
      has: ['intensity', 'color', 'white', 'colourTemp', 'strobe', 'tilt', 'zoom', 'pixels'],
      tiltRangeDeg: 220, // TiltMax from the fixture data
      // Which way the yoke turns is not in any chart -- it is a physical
      // fact of the install. Flip this on site if the previz mirrors the room.
      tiltInvert: false,
    },

    // ----- the rest of the plot, universes 5-8 ------------------------------
    // Addresses, universes, modes and counts are copied from the PATCH LIJST
    // (III_LIGHT_DOCU_LIGHT_BXL, pp. 28-29). The channel layout *inside* each
    // mode is not in that document, and is not guessed here: a profile with no
    // standardMap reads as `known: false` in core/fixtures.ts -- registered,
    // addressed, and honestly unreadable. Fill one in when its chart is
    // confirmed, from the manufacturer or from the Debug view against the real
    // console, and that family comes alive with no other change.

    'blinded1-4ch': {
      name: 'Luxibel B Blinded1',
      short: 'Blinders',
      kind: 'blinder',
      footprint: 4, // "4 Channel" in the patch list
      // B BLINDED1 is not B BLINDED. The 1-lite has three modes (1/2/4) and a
      // single 110 W warm-white-plus-amber engine; the 2-lite has five modes
      // and its 4-channel mode is two separate 16-bit dimmers. Patching one
      // chart onto the other gives a fixture that never strobes and dims on the
      // wrong channels. Source: the Luxibel-branded GDTF for "B Blinded1"
      // (FixtureTypeID 3DB3CBC1-9468-4F14-9102-B8823B82FEB3, rev 2021-10-22),
      // corroborated by Luxibel's own product copy -- "8/16 bit dimmer mode,
      // adjustable strobe speed with random function". Luxibel's own PDF chart
      // was not reachable, so this is a good source and not the primary one.
      standardMap: { dimmer: 1, dimmerFine: 2, strobe: 3, function: 4 },
      // And this is why shutterOpenFrom exists: on this chart 0-5 is OPEN with
      // no strobe. Read with the Tambora's rule the blinder would be black at
      // every level it actually runs at.
      shutterOpenFrom: 0,
      optics: {
        source: '1 x 110 W warm white + amber LED engine, 125 W',
        beamAngleDeg: 50,
        // 2700 K nominal, dropping towards ~1200 K as it dims: the amber
        // emitters are mixed by the fixture itself, not addressable over DMX.
        colourTemperatureK: 2700,
        diffuse: true,
      },
      // No colour capability: there is no colour, amber or CTO channel in any
      // of this model's three modes. The tungsten drift is the fixture's own.
      has: ['intensity', 'strobe'],
    },
    'perseo-ex': {
      name: 'Ayrton Perseo Beam',
      short: 'Beams',
      kind: 'movinghead',
      // Mode "Ex". 42 is the address step in the patch list (41, 83, 125, 167),
      // which is the footprint whatever the chart turns out to say.
      footprint: 42,
      // NO CHANNEL MAP, deliberately. Ayrton's own charts were unreachable and
      // no GDTF or community definition of the Perseo *Beam* exists that we
      // could find -- the one Ayrton GDTF in the open library is the plain
      // Perseo, whose Extended mode is 58 channels, not 42. So Stage decodes
      // nothing from the console for these four fixtures and says so in Debug.
      // Fill this in on site: open Debug, move one fader, watch which number
      // moves. That is a ten-minute job with the desk in the room and pure
      // guesswork without it.
      optics: {
        // The one figure published consistently everywhere, including in the
        // product's own name: a 2 to 42 degree zoom. Enough to draw the beam
        // at the right width without pretending to decode it.
        source: '450 W LED',
        beamAngleDeg: 2,
        beamAngleWideDeg: 42,
        diffuse: false,
      },
      // What a beam moving head is, not what a chart told us: it dims, it pans,
      // it tilts, it zooms. Colour is NOT declared -- whether this model mixes
      // CMY or carries a fixed wheel was never established, and a colour picker
      // that might do nothing is worse than no colour picker.
      has: ['intensity', 'pan', 'tilt', 'zoom'],
    },
    'xframe-43ch': {
      name: 'Clay Paky Sharpy X Frame',
      short: 'X-Frame',
      kind: 'movinghead',
      footprint: 43,
      // The QLC+ community definition has exactly one mode for this fixture and
      // it is 43 channels -- our footprint, with nothing to disambiguate.
      // Transcribed from resources/fixtures/Clay_Paky/Clay-Paky-Sharpy-X-Frame.qxf.
      // Claypaky's own documents were unreachable, so this is corroborating
      // rather than primary: treat it as good until someone opens the manual.
      //
      // Subtractive: CMY filters over a 550 W discharge lamp, plus a linear CTO
      // and a 14-colour wheel. Nothing here is an RGB emitter.
      standardMap: {
        cyan: 1,
        magenta: 2,
        yellow: 3,
        cto: 4,
        colourFunction: 5,
        colourWheel: 6,
        strobe: 7,
        dimmer: 8,
        dimmerFine: 9,
        iris: 10,
        goboStatic: 11,
        animationWheel: 12,
        animationRotation: 13,
        gobo: 14,
        goboRotation: 15,
        goboRotationFine: 16,
        prism: 17,
        prismRotation: 18,
        prism8: 19,
        prism8Rotation: 20,
        frost: 21,
        zoom: 22,
        focus: 23,
        focusFine: 24,
        beamMode: 25,
        framing: 26,
        framing1Swivel: 27,
        framing2: 28,
        framing2Swivel: 29,
        framing3: 30,
        framing3Swivel: 31,
        framing4: 32,
        framing4Swivel: 33,
        framingRotation: 34,
        framingMacro: 35,
        framingMacroSpeed: 36,
        pan: 37,
        panFine: 38,
        tilt: 39,
        tiltFine: 40,
        function: 41,
        reset: 42,
        lamp: 43,
      },
      panRangeDeg: 540,
      tiltRangeDeg: 270,
      optics: {
        source: '550 W discharge, ~8000 K, 18800 lm',
        // A hybrid with two envelopes: 3-52 in spot mode, 2-29 in beam mode,
        // selected on channel 25. The wider pair is drawn, since the mode
        // channel is not decoded into the picture.
        beamAngleDeg: 3,
        beamAngleWideDeg: 52,
        colourTemperatureK: 8000,
        diffuse: false,
      },
    },
    'bpanel-3ch': {
      name: 'Luxibel B Panel 240WW',
      short: 'Side Panels',
      kind: 'panel',
      // Three channels for a warm-white panel: dimmer plus two more, and which
      // two is exactly the kind of thing worth being wrong about. The mode is
      // certain -- Luxibel offer 1, 2 and 3 channel modes and only one of them
      // is three wide -- but the chart itself was not reachable, so nothing is
      // decoded and Debug says so.
      footprint: 3,
      optics: {
        source: '240 warm-white SMD LEDs, CRI 95.8',
        // A soft light, and the number that makes it look like one: 160
        // degrees. This is the figure that stops it being drawn as a small
        // bright dot, which is what it looked like before.
        beamAngleDeg: 160,
        colourTemperatureK: 2700,
        diffuse: true,
      },
      // Warm white only. Luxibel sell the cold-white B PANEL240CW and the
      // tunable B PANEL180TW/360TW as separate products, so the WW suffix is a
      // fixed source: no colour picker, ever. It dims -- the datasheet says
      // 16-bit dimming -- and that is all we can stand behind.
      has: ['intensity'],
    },
    'captaind-1ch': {
      name: 'Smoke Factory Captain D',
      short: 'Smoke',
      kind: 'fog',
      footprint: 1,
      // The one case where a map is not a guess: a one-channel hazer has one
      // channel, and it is the output level. The manufacturer's own documents
      // were not reachable either, but there is nothing here to get wrong.
      standardMap: { fog: 1 },
      has: ['fog'],
    },
  },
  fixtures,
  // The walls, and only the walls. This list is what the effect engine targets
  // and what the Phase 6 output iterates, so a family that is not in it cannot
  // be painted by a scene or written to by this software -- which is the right
  // default for every family whose chart we do not have yet.
  groups: ['wall-left', 'wall-right'],
}

// ----- positions of the rest of the plot -------------------------------------
// Read off the LICHTPLAN (p. 5) by locating each symbol on a 300 dpi render,
// then mapped into the coordinate system the two walls already define: along
// the room, one batten pitch is one unit; across it, the two walls are 12 units
// apart. Not a survey -- heights especially are unknown, the plan being a top
// view -- so these are a starting point to be corrected in Placement mode,
// which writes this same file.
const HEIGHT_UNKNOWN = 6 // hung with the walls until someone measures

function add(id, type, universe, address, group, position, head) {
  fixtures.push({
    id,
    type,
    head,
    universe,
    address,
    position,
    rotation: [0, 0, 0],
    group,
  })
}

// 16 Luxibel B Panel 240WW: eight a side, inside the walls, under the tribune.
const PANEL_X = [-7.5, -5.3, -3.3, -1.0, 1.4, 3.3, 5.4, 7.4]
PANEL_X.forEach((x, i) => {
  add(`PL${i + 1}`, 'bpanel-3ch', 6, 1 + i * 10, 'panel-left', [x, 2, -4.8], 301 + i)
  add(`PR${i + 1}`, 'bpanel-3ch', 7, 1 + i * 10, 'panel-right', [x, 2, 4.8], 401 + i)
})

// 2 Clay Paky Sharpy X Frame, stage end, just outside each wall.
add('XL', 'xframe-43ch', 5, 401, 'xframe', [-7.5, HEIGHT_UNKNOWN, -6.8], 501)
add('XR', 'xframe-43ch', 5, 451, 'xframe', [-7.5, HEIGHT_UNKNOWN, 6.8], 502)

// 10 Luxibel B Blinded1, upstage, two rows with a gap in the middle for the
// stage structure. Addresses run 1, 5, 9 ... 37 in the order the plan reads.
const BLINDERS = [
  [-12.3, -3.3],
  [-12.3, -2.0],
  [-12.3, 2.0],
  [-12.3, 3.7],
  [-11.1, -5.3],
  [-11.1, -3.7],
  [-11.1, -2.0],
  [-11.1, 2.1],
  [-11.1, 3.7],
  [-11.1, 5.3],
]
BLINDERS.forEach(([x, z], i) => {
  add(`B${i + 1}`, 'blinded1-4ch', 5, 1 + i * 4, 'blinders', [x, HEIGHT_UNKNOWN, z], 201 + i)
})

// 4 Ayrton Perseo Beam on the arch, in a shallow V.
const PERSEO = [
  [-15.2, -2.8],
  [-15.8, -1.2],
  [-15.8, 2.1],
  [-15.2, 3.7],
]
PERSEO.forEach(([x, z], i) => {
  add(`PB${i + 1}`, 'perseo-ex', 5, 41 + i * 42, 'beams', [x, 8, z], 601 + i)
})

// 6 Smoke Factory Captain D: two on the stage, four under the tribune. The
// plan does not place them; these are plausible, not measured.
add('SM1', 'captaind-1ch', 5, 501, 'smoke', [-13, 0.5, -5], 701)
add('SM2', 'captaind-1ch', 5, 502, 'smoke', [-13, 0.5, 5], 702)
add('SM3', 'captaind-1ch', 8, 1, 'smoke', [-4, 0.5, -6.5], 703)
add('SM4', 'captaind-1ch', 8, 2, 'smoke', [-4, 0.5, 6.5], 704)
add('SM5', 'captaind-1ch', 8, 3, 'smoke', [4, 0.5, -6.5], 705)
add('SM6', 'captaind-1ch', 8, 4, 'smoke', [4, 0.5, 6.5], 706)

writeFileSync(OUT, JSON.stringify(patch, null, 2) + '\n')
const universes = [...new Set(fixtures.map((f) => f.universe))].sort((a, b) => a - b)
console.log(`Wrote ${OUT}: ${fixtures.length} fixtures, universes ${universes.join(', ')}`)
for (const [id, type] of Object.entries(patch.fixtureTypes)) {
  const count = fixtures.filter((f) => f.type === id).length
  console.log(`  ${String(count).padStart(3)} x ${type.name}${type.standardMap ? '' : '  (channel map unknown)'}`)
}
