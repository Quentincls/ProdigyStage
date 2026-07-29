// What a light is doing, said once, for every kind of light in the room.
//
// Until now there was one model in the plot and the arithmetic that turns its
// DMX channels into a colour lived inline in the previz -- and, separately, in
// the server's output merge. That works for one family and stops working at
// two: the previz would grow a branch per model, the output another, and the
// two would drift the first time a channel map changed.
//
// So this file owns the translation, and nothing else does:
//
//     raw DMX bytes  ->  readFixture()  ->  FixtureState
//
// Above that line nobody says "channel 7". The previz asks a fixture how
// bright it is; the inspector asks what colour it is; neither knows a Tambora
// from a Perseo. Below it, one small adapter per family, each of which does
// nothing but read bytes.
//
// Two rules this file exists to keep:
//
//   1. **A fixture whose chart we do not have reads as `known: false`, never
//      as zeroes.** The lighting document gives addresses and modes; it does
//      not give the channel layout inside each mode. Inventing one would draw
//      a rig doing something it is not, which is worse than drawing nothing.
//   2. **Silence is not data.** A universe nobody is sending arrives full of
//      zeroes, and zero is a real DMX value. Callers pass `live: false` and
//      get a state that says so.
//
// Pure, allocation-free on the hot path (the previz calls this 32+ times a
// frame at 60 fps), and zero dependencies -- same contract as effects.ts.

export type FixtureKind = 'batten' | 'movinghead' | 'blinder' | 'panel' | 'fog' | 'unknown'

/** What a family can actually do. The inspector shows controls for these and
 *  for nothing else, which is what keeps it from becoming a channel list. */
export type Capability =
  | 'intensity'
  | 'color'
  | 'white'
  | 'shutter'
  | 'strobe'
  | 'tilt'
  | 'pan'
  | 'zoom'
  | 'pixels'
  | 'fog'

/** Function name -> 1-based channel inside the fixture's own footprint. */
export type ChannelMap = Record<string, number>

export interface FixtureProfile {
  name: string
  /** Which adapter reads it. Absent means nobody can, and that is a state. */
  kind?: FixtureKind
  footprint: number
  /** null / absent = the chart for this mode is not documented yet. */
  standardMap?: ChannelMap
  pixels?: number
  pixelOrder?: string
  pixelStart?: number
  /** Full mechanical travel in degrees. Absent = the fixture does not move. */
  tiltRangeDeg?: number
  tiltInvert?: boolean
  panRangeDeg?: number
  panInvert?: boolean
}

/**
 * Normalised state. Everything is 0-1 or radians -- never a DMX byte, never a
 * channel number. `null` means "this fixture has no such thing", which is not
 * the same as zero.
 */
export interface FixtureState {
  /** false when we cannot read this fixture: no chart, or nothing is sending. */
  known: boolean
  /** false when the shutter is closed: black whatever the colour says. */
  lit: boolean
  /** 0-1 master level, already through the 16-bit dimmer where there is one. */
  intensity: number
  /** 0-1 each, the emitters' own colour before the dimmer is applied. */
  r: number
  g: number
  b: number
  /** 0-1 white emitter, where there is one. */
  white: number
  /** Radians from level, positive one way, null when the fixture cannot tilt. */
  tilt: number | null
  pan: number | null
  /** 0-1, null when the fixture has no zoom. */
  zoom: number | null
  /** 0-1 fog output, null when the fixture is not a hazer. */
  fog: number | null
}

export function blankState(): FixtureState {
  return {
    known: false,
    lit: false,
    intensity: 0,
    r: 0,
    g: 0,
    b: 0,
    white: 0,
    tilt: null,
    pan: null,
    zoom: null,
    fog: null,
  }
}

function reset(state: FixtureState): FixtureState {
  state.known = false
  state.lit = false
  state.intensity = 0
  state.r = 0
  state.g = 0
  state.b = 0
  state.white = 0
  state.tilt = null
  state.pan = null
  state.zoom = null
  state.fog = null
  return state
}

/** What each family exposes, for the inspector to build itself from. */
export const CAPABILITIES: Record<FixtureKind, Capability[]> = {
  batten: ['intensity', 'color', 'white', 'shutter', 'strobe', 'tilt', 'zoom', 'pixels'],
  movinghead: ['intensity', 'color', 'shutter', 'strobe', 'pan', 'tilt', 'zoom'],
  blinder: ['intensity', 'color', 'strobe'],
  panel: ['intensity', 'white'],
  fog: ['fog'],
  unknown: [],
}

/**
 * Which family a profile belongs to.
 *
 * `kind` was added when the plot grew past one model, so every patch written
 * before that has none -- including the one sitting in every install right
 * now, because updating the software deliberately never touches `data/`. A
 * profile with a pixel zone is a batten whether or not anyone said so, and
 * inferring that here is the difference between an old patch still working and
 * an old patch drawing an empty room.
 */
export function kindOf(profile: FixtureProfile): FixtureKind {
  if (profile.kind) return profile.kind
  if ((profile.pixels ?? 0) > 0 && profile.pixelStart !== undefined) return 'batten'
  return 'unknown'
}

export function capabilitiesOf(profile: FixtureProfile): Capability[] {
  const kind = kindOf(profile)
  if (!profile.standardMap || kind === 'unknown') return []
  const declared = CAPABILITIES[kind] ?? []
  const map = profile.standardMap
  return declared.filter((capability) => {
    switch (capability) {
      case 'intensity':
        return map.dimmer !== undefined
      case 'color':
        return map.red !== undefined && map.green !== undefined && map.blue !== undefined
      case 'white':
        return map.white !== undefined
      case 'shutter':
      case 'strobe':
        return map.strobe !== undefined || map.shutter !== undefined
      case 'tilt':
        return map.tilt !== undefined && (profile.tiltRangeDeg ?? 0) > 0
      case 'pan':
        return map.pan !== undefined && (profile.panRangeDeg ?? 0) > 0
      case 'zoom':
        return map.zoom !== undefined
      case 'pixels':
        return (profile.pixels ?? 0) > 0 && profile.pixelStart !== undefined
      case 'fog':
        return map.fog !== undefined
      default:
        return false
    }
  })
}

// ----- reading ---------------------------------------------------------------

/** 8- or 16-bit value at a function, as 0-1. Missing channel -> fallback. */
function level(
  dmx: Uint8Array,
  base: number,
  map: ChannelMap,
  coarse: string,
  fine: string | null,
  fallback: number,
): number {
  const c = map[coarse]
  if (c === undefined) return fallback
  const hi = dmx[base + c - 1] ?? 0
  if (fine !== null) {
    const f = map[fine]
    if (f !== undefined) return (hi * 256 + (dmx[base + f - 1] ?? 0)) / 65535
  }
  return hi / 255
}

/** A 16-bit mechanical axis as radians either side of centre. */
function axis(
  dmx: Uint8Array,
  base: number,
  map: ChannelMap,
  coarse: string,
  fine: string,
  rangeDeg: number | undefined,
  invert: boolean | undefined,
): number | null {
  const c = map[coarse]
  if (c === undefined || !rangeDeg) return null
  const hi = dmx[base + c - 1] ?? 0
  const f = map[fine]
  // A coarse-only fixture still spans the full range: 255 must reach the end
  // of the travel, so the byte is scaled by 257 rather than shifted by 256.
  const raw = f !== undefined ? hi * 256 + (dmx[base + f - 1] ?? 0) : hi * 257
  const radians = (raw / 65535 - 0.5) * ((rangeDeg * Math.PI) / 180)
  return invert ? -radians : radians
}

/**
 * Read one fixture out of its universe's DMX buffer.
 *
 * `base` is 0-based (patch address minus one). `live` says whether anything is
 * actually sending this universe -- pass false and the state comes back
 * unknown rather than black, because a rig that is switched off is not a rig
 * that is dark.
 *
 * `out` is written in place and returned: the previz calls this for every
 * fixture of every frame and must not allocate.
 */
export function readFixture(
  profile: FixtureProfile,
  dmx: Uint8Array | null,
  base: number,
  live: boolean,
  out: FixtureState = blankState(),
): FixtureState {
  reset(out)
  const map = profile.standardMap
  // No chart for this mode, or nothing on the wire: both are "we do not know",
  // and neither may be reported as a fixture sitting at zero.
  if (!map || !dmx || !live) return out

  switch (kindOf(profile)) {
    case 'batten':
    case 'movinghead':
    case 'blinder':
    case 'panel':
      readLuminaire(profile, map, dmx, base, out)
      break
    case 'fog':
      out.known = true
      out.fog = level(dmx, base, map, 'fog', null, 0)
      out.lit = out.fog > 0
      break
    default:
      // Registered, addressed, and unreadable: exactly what we want to show
      // for a family whose chart has not been filled in yet.
      break
  }
  return out
}

/**
 * The shape almost every luminaire in this plot shares: colour emitters, a
 * master dimmer, a shutter, and optionally a yoke and a zoom. Written once
 * rather than once per family, because a Blinded1 and a Perseo differ in which
 * of these channels exist, not in what they mean.
 *
 * This is the arithmetic the previz has always used for the Tambora, moved
 * here unchanged -- see pipeline-selftest and fixtures-selftest.
 */
function readLuminaire(
  profile: FixtureProfile,
  map: ChannelMap,
  dmx: Uint8Array,
  base: number,
  out: FixtureState,
): void {
  out.known = true
  out.intensity = level(dmx, base, map, 'dimmer', 'dimmerFine', 1)

  // Shutter: on the Tambora chart 0-3 is a closed shutter and everything above
  // is open or strobing. Flashes are not simulated; a strobing fixture reads
  // as lit, which is what the eye sees across a bar.
  const shutter = map.strobe ?? map.shutter
  out.lit = shutter === undefined ? true : (dmx[base + shutter - 1] ?? 0) > 3

  if (map.red !== undefined) out.r = (dmx[base + map.red - 1] ?? 0) / 255
  if (map.green !== undefined) out.g = (dmx[base + map.green - 1] ?? 0) / 255
  if (map.blue !== undefined) out.b = (dmx[base + map.blue - 1] ?? 0) / 255
  if (map.white !== undefined) out.white = (dmx[base + map.white - 1] ?? 0) / 255

  out.tilt = axis(dmx, base, map, 'tilt', 'tiltFine', profile.tiltRangeDeg, profile.tiltInvert)
  out.pan = axis(dmx, base, map, 'pan', 'panFine', profile.panRangeDeg, profile.panInvert)
  if (map.zoom !== undefined) out.zoom = (dmx[base + map.zoom - 1] ?? 0) / 255
}

/**
 * The colour a fixture actually shows, 0-1 per channel: emitters plus white,
 * through the dimmer, and black when the shutter is shut. Every renderer wants
 * this and none of them should derive it themselves.
 */
export function litColour(state: FixtureState, out: [number, number, number]): [number, number, number] {
  if (!state.known || !state.lit) {
    out[0] = 0
    out[1] = 0
    out[2] = 0
    return out
  }
  const w = state.white
  out[0] = Math.min(1, state.r + w) * state.intensity
  out[1] = Math.min(1, state.g + w) * state.intensity
  out[2] = Math.min(1, state.b + w) * state.intensity
  return out
}

/** One pixel of a fixture that has a pixel zone, 0-1 per channel. */
export function readPixel(
  profile: FixtureProfile,
  dmx: Uint8Array | null,
  base: number,
  index: number,
  live: boolean,
  out: [number, number, number],
): [number, number, number] {
  out[0] = 0
  out[1] = 0
  out[2] = 0
  if (!dmx || !live || profile.pixelStart === undefined) return out
  const at = base + profile.pixelStart - 1 + index * 3
  out[0] = (dmx[at] ?? 0) / 255
  out[1] = (dmx[at + 1] ?? 0) / 255
  out[2] = (dmx[at + 2] ?? 0) / 255
  return out
}
