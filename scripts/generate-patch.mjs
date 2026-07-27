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
      tiltRangeDeg: 220, // TiltMax from the fixture data; direction to calibrate on venue video
    },
  },
  fixtures,
  groups: ['wall-left', 'wall-right'],
}

writeFileSync(OUT, JSON.stringify(patch, null, 2) + '\n')
console.log(`Wrote ${OUT}: ${fixtures.length} fixtures, universes 1-4`)
