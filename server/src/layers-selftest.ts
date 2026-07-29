// Self-test for the artistic layer: behaviours and light layers.
//
// Two things this exists to pin, and both of them are promises the interface
// makes to the operator rather than internal invariants:
//
//   1. **A behaviour is only ever offered to a fixture that can perform it.**
//      The whole capability system is one filter, and if that filter is wrong
//      the interface starts promising movement to a panel bolted to a wall.
//   2. **The most specific target wins.** That single rule is the entire
//      override mechanism -- a named fixture beats its group, which beats its
//      family -- and it is what lets one layer say "the beams sweep, except
//      that one".
//
// Plus determinism, because /core is evaluated in two places that never talk to
// each other: the previz draws it and the server would send it.

import {
  behaviorsFor,
  defaultBehaviorParams,
  paramsFor,
  renderBehavior,
  BEHAVIORS,
  blankIntent,
  type BehaviorType,
} from '@prodigy-stage/core/behaviors'
import type { Capability } from '@prodigy-stage/core/fixtures'
import {
  activeLayer,
  layerMembers,
  partFor,
  renderLayerIntent,
  type FixtureRef,
  type LightLayer,
} from '@prodigy-stage/core/layers'

let checks = 0
function assert(condition: boolean, message: string): void {
  checks++
  if (!condition) {
    console.error(`layers selftest: FAIL -- ${message}`)
    process.exit(1)
  }
}
function close(a: number, b: number, tolerance: number, message: string): void {
  assert(Math.abs(a - b) <= tolerance, `${message} (got ${a}, expected ${b})`)
}

// ----- 1. capabilities gate the behaviours ----------------------------------
// Written from the real plot: a warm-white panel dims and nothing else, a beam
// moving head moves, a hazer only fogs.

const PANEL: Capability[] = ['intensity']
const BEAM: Capability[] = ['intensity', 'pan', 'tilt', 'zoom']
const BATTEN: Capability[] = ['intensity', 'color', 'white', 'colourTemp', 'strobe', 'tilt', 'zoom', 'pixels']
const HAZER: Capability[] = ['fog']

const panelBehaviors = behaviorsFor(PANEL).map((def) => def.type)
assert(panelBehaviors.includes('static'), 'a panel can hold a level')
assert(panelBehaviors.includes('wave'), 'a row of panels can carry a wave')
assert(!panelBehaviors.includes('sweep'), 'a panel bolted to a wall must never be offered Sweep')
assert(!panelBehaviors.includes('converge'), 'nor Converge')
assert(!panelBehaviors.includes('strobe'), 'nor Strobe, with no strobe channel documented')
assert(!panelBehaviors.includes('haze'), 'nor Haze')

const beamBehaviors = behaviorsFor(BEAM).map((def) => def.type)
assert(beamBehaviors.includes('sweep'), 'a moving head sweeps')
assert(beamBehaviors.includes('converge') && beamBehaviors.includes('fan'), 'and converges and fans')
assert(!beamBehaviors.includes('haze'), 'a moving head is not a hazer')

const hazerBehaviors = behaviorsFor(HAZER).map((def) => def.type)
assert(hazerBehaviors.length === 1 && hazerBehaviors[0] === 'haze', 'a hazer does one thing')

// The colour picker is the case that started this: it must not appear over a
// selection that cannot show a colour.
const staticDef = BEHAVIORS.find((def) => def.type === 'static')!
const panelParams = paramsFor(staticDef, PANEL).map((param) => param.key)
assert(!panelParams.includes('color'), 'no colour picker over a fixed warm-white panel')
assert(panelParams.includes('level'), 'but it still has an intensity')
const battenParams = paramsFor(staticDef, BATTEN).map((param) => param.key)
assert(battenParams.includes('color'), 'a batten that mixes RGBW does get one')

// A mixed selection gets the intersection, never the union.
const mixed = BATTEN.filter((capability) => PANEL.includes(capability))
const mixedBehaviors = behaviorsFor(mixed).map((def) => def.type)
assert(mixedBehaviors.includes('static'), 'battens and panels can both hold a level')
assert(!mixedBehaviors.includes('strobe'), 'and must not be offered what only half of them can do')

// ----- 2. behaviours are deterministic and bounded ---------------------------
const intent = blankIntent()
for (const def of BEHAVIORS) {
  const params = defaultBehaviorParams(def.type)
  for (const time of [0, 0.37, 1.5, 7.25]) {
    const a = { ...renderBehavior(def.type, params, { index: 1, count: 4, pos: 0.33, time }, intent) }
    const b = { ...renderBehavior(def.type, params, { index: 1, count: 4, pos: 0.33, time }, intent) }
    assert(
      JSON.stringify(a) === JSON.stringify(b),
      `${def.type} must give the same answer twice at t=${time}`,
    )
    assert(a.intensity >= 0 && a.intensity <= 1, `${def.type} intensity stays in 0-1 at t=${time}`)
    for (const channel of ['r', 'g', 'b'] as const) {
      assert(a[channel] >= 0 && a[channel] <= 1, `${def.type} ${channel} stays in 0-1 at t=${time}`)
    }
  }
  assert(renderBehavior(def.type, params, { index: 0, count: 1, pos: 0, time: 0 }, intent) === intent,
    `${def.type} must write in place rather than allocate`)
}

// Fan opens symmetrically: the outer heads go opposite ways, the middle stays.
const fanLeft = { ...renderBehavior('fan', { ...defaultBehaviorParams('fan'), spread: 1 }, { index: 0, count: 3, pos: 0, time: 0 }, intent) }
const fanMid = { ...renderBehavior('fan', { ...defaultBehaviorParams('fan'), spread: 1 }, { index: 1, count: 3, pos: 0.5, time: 0 }, intent) }
const fanRight = { ...renderBehavior('fan', { ...defaultBehaviorParams('fan'), spread: 1 }, { index: 2, count: 3, pos: 1, time: 0 }, intent) }
close(fanMid.pan ?? 99, 0, 1e-9, 'the middle head of a fan stays put')
assert((fanLeft.pan ?? 0) < 0 && (fanRight.pan ?? 0) > 0, 'and the outer two open opposite ways')
close((fanLeft.pan ?? 0) + (fanRight.pan ?? 0), 0, 1e-9, 'symmetrically')

// Converge points every head the same way, which is the whole difference.
const c1 = { ...renderBehavior('converge', defaultBehaviorParams('converge'), { index: 0, count: 4, pos: 0, time: 0 }, intent) }
const c2 = { ...renderBehavior('converge', defaultBehaviorParams('converge'), { index: 3, count: 4, pos: 1, time: 0 }, intent) }
assert(c1.pan === c2.pan && c1.tilt === c2.tilt, 'every head of a Converge takes the same angle')

// Haze is not light.
const haze = { ...renderBehavior('haze', defaultBehaviorParams('haze'), { index: 0, count: 1, pos: 0, time: 0 }, intent) }
assert(haze.intensity === 0 && (haze.fog ?? 0) > 0, 'a hazer outputs fog and no light')

// ----- 3. the most specific target wins -------------------------------------
// This is the override mechanism, and there is no other one.

const RIG: FixtureRef[] = [
  { id: 'PB1', type: 'perseo-ex', group: 'beams' },
  { id: 'PB2', type: 'perseo-ex', group: 'beams' },
  { id: 'PB3', type: 'perseo-ex', group: 'beams' },
  { id: 'PB4', type: 'perseo-ex', group: 'beams' },
  { id: 'L1', type: 'tambora-std-pixel', group: 'wall-left' },
  { id: 'L2', type: 'tambora-std-pixel', group: 'wall-left' },
]

function part(id: string, kind: 'family' | 'group' | 'fixture', key: string, behavior: BehaviorType) {
  return { id, target: { kind, key }, behavior, params: defaultBehaviorParams(behavior), fadeIn: 0, fadeOut: 0 }
}

const layer: LightLayer = {
  id: 'layer-1',
  name: 'Red impact',
  start: 10,
  end: 20,
  parts: [
    part('p-family', 'family', 'perseo-ex', 'sweep'),
    part('p-fixture', 'fixture', 'PB3', 'static'),
    part('p-wall', 'group', 'wall-left', 'wave'),
  ],
}

assert(partFor(layer, RIG[0])!.id === 'p-family', 'a beam with no exception follows its family')
assert(partFor(layer, RIG[2])!.id === 'p-fixture', 'PB3 is an exception and follows its own part')
assert(partFor(layer, RIG[4])!.id === 'p-wall', 'a batten follows its group')

// A group beats a family, and a fixture beats both.
const layered: LightLayer = {
  ...layer,
  parts: [
    part('a', 'family', 'tambora-std-pixel', 'static'),
    part('b', 'group', 'wall-left', 'wave'),
    part('c', 'fixture', 'L2', 'chase'),
  ],
}
assert(partFor(layered, RIG[4])!.id === 'b', 'group beats family')
assert(partFor(layered, RIG[5])!.id === 'c', 'fixture beats group')

// Membership follows the same rule: the exception is not counted among the
// fixtures its family part is driving, or a Wave would travel along a group
// that has a hole in it.
const members = layerMembers(layer, RIG)
assert(members.get('p-family')!.join(',') === 'PB1,PB2,PB4', 'PB3 is not a member of the family part')
assert(members.get('p-fixture')!.join(',') === 'PB3', 'it is a member of its own')

// ----- 4. layers in time -----------------------------------------------------
assert(activeLayer([layer], 9.9) === null, 'a layer has not started before its start')
assert(activeLayer([layer], 10) === layer, 'it starts at its start')
assert(activeLayer([layer], 20) === null, 'and ends at its end')

const early: LightLayer = { ...layer, id: 'early', start: 0, end: 30 }
assert(activeLayer([early, layer], 15) === layer, 'later layers win on overlap, as scenes do')

assert(
  renderLayerIntent(layer, RIG[0], members, 5, intent) === null,
  'a layer that is not running asks nothing of anyone',
)
assert(
  renderLayerIntent(layer, { id: 'SM1', type: 'captaind-1ch', group: 'smoke' }, members, 15, intent) === null,
  'and a fixture no part mentions is left to the console',
)

// Fades scale the intensity and nothing else.
const fading: LightLayer = {
  ...layer,
  parts: [{ ...part('f', 'family', 'perseo-ex', 'static'), fadeIn: 2, fadeOut: 2 }],
}
const fadeMembers = layerMembers(fading, RIG)
const half = { ...renderLayerIntent(fading, RIG[0], fadeMembers, 11, intent)! }
const full = { ...renderLayerIntent(fading, RIG[0], fadeMembers, 15, intent)! }
close(half.intensity, full.intensity * 0.5, 1e-9, 'one second into a two-second fade is half up')
assert(half.r === full.r, 'and the colour does not fade with it')

console.log(
  `layers selftest: OK (${checks} checks -- capabilities gate behaviours, specificity gates overrides, determinism)`,
)
