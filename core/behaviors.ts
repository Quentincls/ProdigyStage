// What a light is asked to do, said once, for every kind of light in the room.
//
// core/fixtures.ts reads DMX and answers "what is this fixture doing". This
// file answers the other direction: "what do we want it to do". Between the two
// sits the same vocabulary -- a level, a colour, an angle -- and never a
// channel number.
//
//     behaviour + parameters + (which fixture, when)  ->  FixtureIntent
//
// A behaviour is an artistic idea, not a hardware feature: Sweep, Converge,
// Hit, Wave. Each one declares the capabilities a fixture must actually have
// for it to mean anything, and the interface only ever offers a behaviour to a
// fixture that can perform it. Offering Orbit to a panel bolted to a wall, or
// an RGB gradient to a warm-white blinder, is how a tool starts lying about the
// rig it is driving.
//
// Pure, deterministic against show time, zero dependencies -- same contract as
// effects.ts, and for the same reason: the server has to be able to evaluate
// the identical thing the previz drew.

import type { Capability } from './fixtures.js'
import { hexToRgb, type ParamDef, type ParamValue, type Rgb } from './effects.js'

/**
 * What Stage wants one fixture to be doing at one instant.
 *
 * Everything is normalised. `null` means "this behaviour has no opinion about
 * that", which is not the same as zero: a Wave says nothing about where a
 * moving head points, and a fixture the layer does not mention keeps doing
 * whatever the console is telling it.
 */
export interface FixtureIntent {
  intensity: number
  r: number
  g: number
  b: number
  /** Flashes per second. 0 is steady, which is not the same as dark. */
  strobeHz: number
  /** Radians, absolute, in the fixture's own frame. */
  pan: number | null
  tilt: number | null
  /** 0 = narrowest the fixture goes, 1 = widest. */
  zoom: number | null
  fog: number | null
}

export function blankIntent(): FixtureIntent {
  return { intensity: 0, r: 0, g: 0, b: 0, strobeHz: 0, pan: null, tilt: null, zoom: null, fog: null }
}

export function resetIntent(intent: FixtureIntent): FixtureIntent {
  intent.intensity = 0
  intent.r = 0
  intent.g = 0
  intent.b = 0
  intent.strobeHz = 0
  intent.pan = null
  intent.tilt = null
  intent.zoom = null
  intent.fog = null
  return intent
}

export type BehaviorType =
  | 'static'
  | 'pulse'
  | 'strobe'
  | 'wave'
  | 'chase'
  | 'sparkle'
  | 'hit'
  | 'sweep'
  | 'converge'
  | 'fan'
  | 'haze'

export interface BehaviorDef {
  type: BehaviorType
  label: string
  /** One line, in the operator's language, shown next to the name. */
  hint: string
  /** Every capability a fixture must have for this to be worth offering. */
  requires: Capability[]
  params: ParamDef[]
}

/**
 * Where a fixture sits inside the group a behaviour is driving.
 *
 * `pos` is 0-1 across the group in stage order, which is what makes a Wave
 * travel and a Fan spread. It is the group's own geometry, not the room's: a
 * behaviour must not need to know where the room is.
 */
export interface BehaviorContext {
  index: number
  count: number
  pos: number
  /** Seconds since the layer started. */
  time: number
}

const COLOUR: ParamDef = { key: 'color', label: 'Colour', type: 'color', default: '#ff8a2a' }
const LEVEL: ParamDef = { key: 'level', label: 'Intensity', type: 'range', min: 0, max: 1, step: 0.01, default: 1 }
const SPEED: ParamDef = { key: 'speed', label: 'Speed', type: 'range', min: -3, max: 3, step: 0.05, default: 1 }

export const BEHAVIORS: BehaviorDef[] = [
  {
    type: 'static',
    label: 'Static',
    hint: 'Holds one level and one colour',
    requires: ['intensity'],
    params: [COLOUR, LEVEL],
  },
  {
    type: 'pulse',
    label: 'Pulse',
    hint: 'Breathes in and out',
    requires: ['intensity'],
    params: [COLOUR, LEVEL, SPEED, { key: 'depth', label: 'Depth', type: 'range', min: 0, max: 1, step: 0.05, default: 0.7 }],
  },
  {
    type: 'strobe',
    label: 'Strobe',
    hint: 'Hard flashes',
    requires: ['intensity', 'strobe'],
    params: [COLOUR, LEVEL, { key: 'rate', label: 'Rate', type: 'range', min: 1, max: 20, step: 0.5, default: 8 }],
  },
  {
    type: 'wave',
    label: 'Wave',
    hint: 'A swell travelling along the group',
    requires: ['intensity'],
    params: [COLOUR, LEVEL, SPEED, { key: 'size', label: 'Size', type: 'range', min: 0.5, max: 8, step: 0.5, default: 3 }],
  },
  {
    type: 'chase',
    label: 'Chase',
    hint: 'Runners crossing the group',
    requires: ['intensity'],
    params: [COLOUR, LEVEL, SPEED, { key: 'count', label: 'Runners', type: 'range', min: 1, max: 8, step: 1, default: 2 }],
  },
  {
    type: 'sparkle',
    label: 'Sparkle',
    hint: 'Random single hits',
    requires: ['intensity'],
    params: [COLOUR, LEVEL, { key: 'density', label: 'Density', type: 'range', min: 0.05, max: 1, step: 0.05, default: 0.3 }, SPEED],
  },
  {
    type: 'hit',
    label: 'Hit',
    hint: 'Stab and decay — what a blinder is for',
    requires: ['intensity'],
    params: [COLOUR, LEVEL, { key: 'decay', label: 'Decay', type: 'range', min: 0.05, max: 3, step: 0.05, default: 0.5 }, SPEED],
  },
  {
    type: 'sweep',
    label: 'Sweep',
    hint: 'Travels across the room',
    requires: ['intensity', 'pan'],
    params: [
      COLOUR,
      LEVEL,
      SPEED,
      { key: 'width', label: 'Width', type: 'range', min: 0, max: 1, step: 0.05, default: 0.5 },
    ],
  },
  {
    type: 'converge',
    label: 'Converge',
    hint: 'Every head on the same point',
    requires: ['intensity', 'tilt'],
    params: [
      COLOUR,
      LEVEL,
      { key: 'aimX', label: 'Target across', type: 'range', min: -1, max: 1, step: 0.02, default: 0 },
      { key: 'aimY', label: 'Target depth', type: 'range', min: -1, max: 1, step: 0.02, default: 0 },
    ],
  },
  {
    type: 'fan',
    label: 'Fan',
    hint: 'Opens out from the centre',
    requires: ['intensity', 'tilt'],
    params: [
      COLOUR,
      LEVEL,
      { key: 'spread', label: 'Spread', type: 'range', min: 0, max: 1, step: 0.02, default: 0.5 },
      { key: 'aimY', label: 'Target depth', type: 'range', min: -1, max: 1, step: 0.02, default: 0 },
    ],
  },
  {
    type: 'haze',
    label: 'Haze',
    hint: 'Fog output',
    requires: ['fog'],
    params: [{ key: 'level', label: 'Output', type: 'range', min: 0, max: 1, step: 0.05, default: 0.4 }],
  },
]

/**
 * Parameters that only mean something on a fixture with the matching
 * capability.
 *
 * Behaviours are shared across families -- Static is Static whether it is
 * driving a batten or a warm-white panel -- so the behaviour carries every
 * parameter it could ever need and this drops the ones the selection cannot
 * honour. A colour picker over sixteen fixed-CCT panels is the interface
 * promising something the rig physically cannot do.
 */
export const PARAM_REQUIRES: Record<string, Capability> = {
  color: 'color',
  rate: 'strobe',
  spread: 'pan',
  aimX: 'pan',
  aimY: 'tilt',
}

/** A behaviour's parameters, minus anything this selection cannot perform. */
export function paramsFor(def: BehaviorDef, capabilities: Capability[]): ParamDef[] {
  const has = new Set(capabilities)
  return def.params.filter((param) => {
    const needed = PARAM_REQUIRES[param.key]
    return needed === undefined || has.has(needed)
  })
}

export function behaviorDef(type: string): BehaviorDef | undefined {
  return BEHAVIORS.find((def) => def.type === type)
}

export function defaultBehaviorParams(type: string): Record<string, ParamValue> {
  const params: Record<string, ParamValue> = {}
  for (const param of behaviorDef(type)?.params ?? []) params[param.key] = param.default
  return params
}

/**
 * The behaviours a set of fixtures can all actually perform.
 *
 * The intersection, not the union: a layer part drives every fixture it
 * targets, so offering Sweep to a selection that is half moving heads and half
 * panels would promise a movement half of them cannot make.
 */
export function behaviorsFor(capabilities: Capability[]): BehaviorDef[] {
  const has = new Set(capabilities)
  return BEHAVIORS.filter((def) => def.requires.every((capability) => has.has(capability)))
}

// ----- evaluation ------------------------------------------------------------

function num(params: Record<string, ParamValue>, key: string, fallback: number): number {
  const value = params[key]
  return typeof value === 'number' && !Number.isNaN(value) ? value : fallback
}

function colour(params: Record<string, ParamValue>, key: string, fallback: string): Rgb {
  const value = params[key]
  return hexToRgb(typeof value === 'string' ? value : fallback)
}

function frac(n: number): number {
  return ((n % 1) + 1) % 1
}

/** Deterministic integer hash, stable across engines. Same one effects.ts uses. */
function hash(n: number): number {
  let x = n | 0
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  x = x ^ (x >>> 16)
  return Math.abs(x)
}

/**
 * One behaviour, one fixture, one instant.
 *
 * Written into `out` and returned: this runs for every fixture of every frame
 * and must not allocate. Deterministic in `context.time` -- the same second
 * always produces the same picture, which is what lets the server and the
 * previz agree without talking to each other.
 */
export function renderBehavior(
  type: BehaviorType,
  params: Record<string, ParamValue>,
  context: BehaviorContext,
  out: FixtureIntent = blankIntent(),
): FixtureIntent {
  resetIntent(out)
  const level = num(params, 'level', 1)
  const t = context.time

  // Colour first: every luminous behaviour carries one, and a fixture with no
  // colour capability simply ignores it downstream.
  if (type !== 'haze') {
    const c = colour(params, 'color', '#ff8a2a')
    out.r = c[0] / 255
    out.g = c[1] / 255
    out.b = c[2] / 255
  }

  switch (type) {
    case 'static':
      out.intensity = level
      break

    case 'pulse': {
      const speed = num(params, 'speed', 1)
      const depth = num(params, 'depth', 0.7)
      // Sine on [0,1], so depth 1 reaches black and depth 0 never moves.
      const swing = (Math.sin(t * speed * Math.PI * 2) + 1) / 2
      out.intensity = level * (1 - depth + depth * swing)
      break
    }

    case 'strobe': {
      const rate = num(params, 'rate', 8)
      // The flash is real in the previz -- an operator judging a strobe needs
      // to see it -- and the rate travels to the fixture as well, so a machine
      // with a strobe channel does it in hardware rather than by dimming.
      out.intensity = frac(t * rate) < 0.4 ? level : 0
      out.strobeHz = rate
      break
    }

    case 'wave': {
      const speed = num(params, 'speed', 1)
      const size = num(params, 'size', 3)
      const phase = context.pos * size - t * speed
      out.intensity = level * Math.max(0, Math.sin(phase * Math.PI * 2)) ** 2
      break
    }

    case 'chase': {
      const speed = num(params, 'speed', 1)
      const runners = Math.max(1, Math.round(num(params, 'count', 2)))
      const head = frac(t * speed)
      let best = 0
      for (let i = 0; i < runners; i++) {
        const at = frac(head + i / runners)
        // Distance around the ring, so a runner leaving one end arrives at the
        // other without a jump.
        const d = Math.min(Math.abs(context.pos - at), 1 - Math.abs(context.pos - at))
        best = Math.max(best, Math.max(0, 1 - d * runners * 3))
      }
      out.intensity = level * best
      break
    }

    case 'sparkle': {
      const density = num(params, 'density', 0.3)
      const speed = num(params, 'speed', 4)
      const cell = Math.floor(t * speed)
      const h = hash(context.index * 7919 + cell * 104729)
      out.intensity = (h % 1000) / 1000 < density ? level * (1 - frac(t * speed)) : 0
      break
    }

    case 'hit': {
      const decay = num(params, 'decay', 0.5)
      const speed = num(params, 'speed', 1)
      // One stab per beat, decaying. Speed 0 is a single hit at the top.
      const since = speed === 0 ? t : frac(t * speed) / Math.max(0.0001, speed)
      out.intensity = level * Math.max(0, 1 - since / decay)
      break
    }

    case 'sweep': {
      const speed = num(params, 'speed', 1)
      const width = num(params, 'width', 0.5)
      out.intensity = level
      // A triangle rather than a sine, so the travel is even and only the ends
      // slow down -- which is what a sweep looks like in a room.
      const swing = Math.abs(frac(t * speed * 0.5) * 2 - 1) * 2 - 1
      out.pan = swing * width * Math.PI * 0.5
      out.tilt = 0
      break
    }

    case 'converge': {
      const aimX = num(params, 'aimX', 0)
      const aimY = num(params, 'aimY', 0)
      out.intensity = level
      // Every head on the same point: the same angle for all of them, which is
      // only true because the aim is expressed in the room and turned into
      // per-fixture angles by the caller that knows where each one hangs.
      out.pan = aimX * Math.PI * 0.5
      out.tilt = aimY * Math.PI * 0.4
      break
    }

    case 'fan': {
      const spread = num(params, 'spread', 0.5)
      const aimY = num(params, 'aimY', 0)
      out.intensity = level
      // -1 to 1 across the group, so the middle head stays put and the outer
      // ones open symmetrically.
      const across = context.count > 1 ? (context.index / (context.count - 1)) * 2 - 1 : 0
      out.pan = across * spread * Math.PI * 0.5
      out.tilt = aimY * Math.PI * 0.4
      break
    }

    case 'haze':
      out.fog = level
      out.intensity = 0
      break
  }

  return out
}
