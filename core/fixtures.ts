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

/**
 * What a family can actually do.
 *
 * The inspector shows controls for these and for nothing else, and a behaviour
 * is only offered to fixtures that declare what it needs. That is the whole
 * mechanism that keeps a warm-white panel from being handed a colour picker and
 * a fixture bolted to a wall from being offered Sweep.
 *
 * A capability is declared by the channel map, never by the model name: a
 * profile whose chart nobody has confirmed declares nothing, which is the
 * honest answer and the one that stops the interface inventing controls.
 */
export type Capability =
  | 'intensity'
  | 'color'
  | 'white'
  | 'amber'
  /** Colour temperature, whether by CTO fade or by a tunable white mix. */
  | 'colourTemp'
  | 'shutter'
  | 'strobe'
  | 'tilt'
  | 'pan'
  | 'zoom'
  | 'focus'
  | 'iris'
  | 'frost'
  | 'gobo'
  | 'prism'
  | 'framing'
  | 'pixels'
  | 'fog'
  | 'fan'

/** Function name -> 1-based channel inside the fixture's own footprint. */
export type ChannelMap = Record<string, number>

export interface FixtureProfile {
  /** The manufacturer's name. Correct, long, and beside the point when you are
   *  choosing what should turn blue -- so it lives in Advanced, not on screen. */
  name: string
  /** What the room calls this family: Tambora, Side Panels, Beams. Absent from
   *  every patch written before there was more than one model in the plot. */
  short?: string
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
  /**
   * The DMX value at and above which the shutter counts as open.
   *
   * Not a detail: the Tambora chart makes 0-3 a closed shutter, and the
   * Luxibel B Blinded1 chart makes 0-5 *open, no strobe*. One convention read
   * with the other's rule draws a blinder that is black at every level it is
   * actually running at. Defaults to the Tambora's 4, because that profile
   * predates this field.
   */
  shutterOpenFrom?: number
  /** What the light physically looks like coming out of the front. */
  optics?: Optics
  /**
   * What the machine physically does, from its datasheet.
   *
   * Not the same question as what we can *read* off the wire, and confusing the
   * two held the whole interface hostage. A B Panel 240WW dims -- the datasheet
   * says 16-bit dimming, 2700 K, no colour mixing -- and that is true whether or
   * not anyone has yet found which of its three channels is the dimmer. So:
   *
   *   standardMap  answers "can Stage decode what the console is sending it"
   *   has          answers "what can this machine do at all"
   *
   * The artistic side of the interface is built from `has`, so a panel offers
   * Intensity and never offers a colour picker. The Debug side is built from
   * `standardMap`, so a family whose chart nobody has confirmed still says so.
   * Neither one is allowed to invent the other.
   */
  has?: Capability[]
}

/**
 * The physical shape of the light, from the manufacturer's own datasheet.
 *
 * This is what stops every fixture being drawn as the same glowing rectangle. A
 * 240 W warm-white soft panel and a beam moving head are not the same object
 * with a different colour: one washes a wide soft field at 3000 K, the other
 * throws a hard column a few degrees across. The renderer reads these numbers
 * and nothing else -- so correcting a datasheet corrects the picture.
 */
export interface Optics {
  /** Free text from the datasheet: LED count, wattage, type. Shown in Advanced. */
  source?: string
  /** Degrees. A single figure for a fixed optic, the narrow end for a zoom. */
  beamAngleDeg?: number
  /** Degrees at the wide end of the zoom. Absent = the fixture does not zoom. */
  beamAngleWideDeg?: number
  /** Native colour temperature in kelvin, for a fixture with no colour mixing. */
  colourTemperatureK?: number
  /** True for a soft wide source, false for a hard column. Drives which shape
   *  the previz draws, because those two read completely differently in a room. */
  diffuse?: boolean
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
  /** 0-1 amber emitter, where there is one. Warm-white blinders drift amber as
   *  they dim, which is a large part of what makes them look like tungsten. */
  amber: number
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
    amber: 0,
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
  state.amber = 0
  state.tilt = null
  state.pan = null
  state.zoom = null
  state.fog = null
  return state
}

/**
 * The most a family could expose. What it actually exposes is this list
 * filtered by what its channel map declares -- see capabilitiesOf. Two gates
 * rather than one, so a model whose chart turns out to be missing a function
 * loses the control rather than showing a dead one.
 */
export const CAPABILITIES: Record<FixtureKind, Capability[]> = {
  batten: ['intensity', 'color', 'white', 'amber', 'colourTemp', 'shutter', 'strobe', 'tilt', 'zoom', 'pixels'],
  movinghead: [
    'intensity',
    'color',
    'white',
    'colourTemp',
    'shutter',
    'strobe',
    'pan',
    'tilt',
    'zoom',
    'focus',
    'iris',
    'frost',
    'gobo',
    'prism',
    'framing',
  ],
  blinder: ['intensity', 'color', 'white', 'amber', 'colourTemp', 'shutter', 'strobe'],
  panel: ['intensity', 'white', 'amber', 'colourTemp', 'shutter', 'strobe'],
  fog: ['fog', 'fan'],
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

/** What a family is called when nobody wrote down what to call it. Wrong for a
 *  plot with two moving-head models in it -- which is why `short` exists -- but
 *  never a lie, and always shorter than the manufacturer's name. */
const FAMILY_NAME: Record<FixtureKind, string> = {
  batten: 'Battens',
  movinghead: 'Moving heads',
  blinder: 'Blinders',
  panel: 'Panels',
  fog: 'Haze',
  unknown: 'Unknown',
}

/**
 * The name to put in front of the operator.
 *
 * There is no light designer on this team, so "Clay Paky Tambora Batten" is
 * three words of packaging around the one word anybody says out loud. The short
 * name comes from the patch, because naming a family is a fact about this show
 * and not about this code; when the patch has none -- every install updated
 * from an older build -- the family label stands in.
 */
export function familyName(profile: FixtureProfile | undefined): string {
  if (!profile) return 'Unknown'
  const short = profile.short?.trim()
  if (short) return short
  return FAMILY_NAME[kindOf(profile)]
}

/**
 * What the fixture can do at all: the datasheet's list, plus anything the
 * channel map proves on top of it.
 *
 * This is what the artistic inspector and the behaviour picker are built from.
 * A family with no chart still has controls, because a panel dims whether or
 * not we can yet watch it dim -- and Stage does not transmit, so editing one
 * has never depended on being able to read one.
 */
export function physicalCapabilities(profile: FixtureProfile | undefined): Capability[] {
  if (!profile) return []
  const declared = profile.has ?? []
  const decoded = capabilitiesOf(profile)
  const all = new Set<Capability>([...declared, ...decoded])
  // Kept in the canonical order rather than in declaration order, so two
  // families never present the same controls in a different sequence.
  const order = CAPABILITIES[kindOf(profile)] ?? []
  const sorted = order.filter((capability) => all.has(capability))
  for (const capability of all) if (!sorted.includes(capability)) sorted.push(capability)
  return sorted
}

/**
 * What Stage can decode from the console for this profile.
 *
 * Chart-derived and nothing else: this is the honest answer to "do we
 * understand what this machine is being told", and it is what Debug reports.
 */
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
        return (
          (map.red !== undefined && map.green !== undefined && map.blue !== undefined) ||
          (map.cyan !== undefined && map.magenta !== undefined && map.yellow !== undefined)
        )
      case 'white':
        return map.white !== undefined
      case 'amber':
        return map.amber !== undefined
      case 'colourTemp':
        // Either a CTO fader or a documented native temperature the fixture
        // can be said to have. A blinder with neither says nothing about it.
        return map.cto !== undefined || map.colourTemp !== undefined
      case 'shutter':
      case 'strobe':
        return map.strobe !== undefined || map.shutter !== undefined
      case 'tilt':
        return map.tilt !== undefined && (profile.tiltRangeDeg ?? 0) > 0
      case 'pan':
        return map.pan !== undefined && (profile.panRangeDeg ?? 0) > 0
      case 'zoom':
        return map.zoom !== undefined
      case 'focus':
        return map.focus !== undefined
      case 'iris':
        return map.iris !== undefined
      case 'frost':
        return map.frost !== undefined
      case 'gobo':
        return map.gobo !== undefined
      case 'prism':
        return map.prism !== undefined
      case 'framing':
        return map.framing !== undefined
      case 'pixels':
        return (profile.pixels ?? 0) > 0 && profile.pixelStart !== undefined
      case 'fog':
        return map.fog !== undefined
      case 'fan':
        return map.fan !== undefined
      default:
        return false
    }
  })
}

/**
 * How a fixture should be drawn, which is a question about its optics and not
 * about its model name.
 *
 *   bar   -- a line of emitters, lighting a strip below it
 *   wash  -- a wide soft field: a panel, a cyc light, anything diffuse
 *   flare -- wide, hard and blinding, pointed at the audience
 *   beam  -- a column you can see in the air, aimed somewhere
 *   fog   -- no light at all, a volume of haze
 *
 * Drawing all five the same way was the single biggest thing wrong with the
 * viewport: a 240 W soft panel and a beam moving head appeared as the same
 * small glowing rectangle, so the plot told you where things were and nothing
 * about what they would do.
 */
export type BeamShape = 'bar' | 'wash' | 'flare' | 'beam' | 'fog' | 'none'

export function beamShape(profile: FixtureProfile | undefined): BeamShape {
  if (!profile) return 'none'
  switch (kindOf(profile)) {
    case 'batten':
      return 'bar'
    case 'panel':
      return 'wash'
    case 'blinder':
      return 'flare'
    case 'movinghead':
      return 'beam'
    case 'fog':
      return 'fog'
    default:
      return 'none'
  }
}

/**
 * The cone angle to draw, in degrees, for a fixture at a given zoom.
 *
 * Straight from the datasheet: a fixture with one optic has one angle, a zoom
 * fixture interpolates between its two ends. `zoom` is 0-1 as the fixture
 * reports it, or null when it has none. Returns null when the documentation
 * does not give an angle -- and a fixture with no documented angle is drawn
 * without a beam rather than with a guessed one.
 */
export function beamAngleDeg(profile: FixtureProfile | undefined, zoom: number | null): number | null {
  const optics = profile?.optics
  if (!optics || optics.beamAngleDeg === undefined) return null
  const narrow = optics.beamAngleDeg
  const wide = optics.beamAngleWideDeg
  if (wide === undefined || zoom === null) return narrow
  return narrow + (wide - narrow) * Math.max(0, Math.min(1, zoom))
}

/**
 * The colour a fixture emits when it has no colour mixing to ask about.
 *
 * A warm-white panel is not white: at 3000 K it is visibly amber next to a
 * 6500 K LED, and a previz that draws both as #ffffff loses the one distinction
 * an operator actually uses when balancing a stage. Planckian approximation,
 * good enough between 1500 K and 15000 K.
 */
export function kelvinToRgb(kelvin: number, out: [number, number, number]): [number, number, number] {
  const t = Math.max(1000, Math.min(40000, kelvin)) / 100
  let r: number
  let g: number
  let b: number
  if (t <= 66) {
    r = 255
    g = 99.4708025861 * Math.log(t) - 161.1195681661
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307
  } else {
    r = 329.698727446 * (t - 60) ** -0.1332047592
    g = 288.1221695283 * (t - 60) ** -0.0755148492
    b = 255
  }
  out[0] = Math.max(0, Math.min(1, r / 255))
  out[1] = Math.max(0, Math.min(1, g / 255))
  out[2] = Math.max(0, Math.min(1, b / 255))
  return out
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

  // Shutter. Where the closed band sits is a per-chart fact -- see
  // shutterOpenFrom. Flashes are not simulated; a strobing fixture reads as
  // lit, which is what the eye sees across a bar.
  const shutter = map.strobe ?? map.shutter
  const openFrom = profile.shutterOpenFrom ?? 4
  out.lit = shutter === undefined ? true : (dmx[base + shutter - 1] ?? 0) >= openFrom

  if (map.red !== undefined) out.r = (dmx[base + map.red - 1] ?? 0) / 255
  if (map.green !== undefined) out.g = (dmx[base + map.green - 1] ?? 0) / 255
  if (map.blue !== undefined) out.b = (dmx[base + map.blue - 1] ?? 0) / 255
  // Subtractive mixing, for the fixtures that filter a white lamp instead of
  // adding emitters. A Sharpy X Frame at CMY 0/0/0 is white, not black -- read
  // as RGB it would come out black at exactly the moment it is brightest.
  if (map.cyan !== undefined && map.magenta !== undefined && map.yellow !== undefined) {
    out.r = 1 - (dmx[base + map.cyan - 1] ?? 0) / 255
    out.g = 1 - (dmx[base + map.magenta - 1] ?? 0) / 255
    out.b = 1 - (dmx[base + map.yellow - 1] ?? 0) / 255
  }
  if (map.white !== undefined) out.white = (dmx[base + map.white - 1] ?? 0) / 255
  if (map.amber !== undefined) out.amber = (dmx[base + map.amber - 1] ?? 0) / 255

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
  const a = state.amber
  // Amber is not white: it lands around 255/126/0, which is what gives a
  // warm-white blinder its tungsten look as it comes up.
  out[0] = Math.min(1, state.r + w + a) * state.intensity
  out[1] = Math.min(1, state.g + w + a * 0.49) * state.intensity
  out[2] = Math.min(1, state.b + w) * state.intensity
  return out
}

// ----- writing ---------------------------------------------------------------
//
// The mirror of readFixture, and it lives here for the same reason: this file
// is the one place that knows what a DMX channel means, and it has to know it
// in both directions or the two will drift.
//
// One rule does all the safety work. **A profile with no channel map writes
// nothing.** Not "writes zeros", not "writes what we guessed" -- nothing at
// all, and it says so by returning false. So the families whose charts nobody
// has confirmed cannot be transmitted to even by accident: there is no address
// to write to. That is not a check someone has to remember to add, it is the
// absence of data doing its job.

/** What a caller wants a fixture to do. Structural on purpose -- FixtureIntent
 *  from behaviors.ts satisfies it, without this file importing that one. */
export interface WriteValues {
  intensity: number
  r: number
  g: number
  b: number
  pan: number | null
  tilt: number | null
  zoom: number | null
  fog: number | null
}

function put(dmx: Uint8Array, at: number, target: number, mix: number): void {
  const current = dmx[at] ?? 0
  dmx[at] = Math.max(0, Math.min(255, Math.round(current + (target - current) * mix)))
}

/** A 16-bit pair written from a 0-1 value, honouring the crossfade. */
function put16(dmx: Uint8Array, coarse: number, fine: number | null, value: number, mix: number): void {
  const raw = Math.max(0, Math.min(65535, Math.round(value * 65535)))
  put(dmx, coarse, raw >> 8, mix)
  if (fine !== null) put(dmx, fine, raw & 255, mix)
}

/**
 * Write one fixture's share of a DMX frame, in place, over whatever the console
 * put there.
 *
 * `mix` is ownership: 0 leaves the console's frame untouched, 1 replaces it.
 * Anything between is the crossfade at a layer's edges.
 *
 * Only channels the profile actually declares are touched. Everything else --
 * gobos, prisms, framing, the fixture's own macros -- is left exactly as the
 * console sent it, so taking over a colour never resets a moving head's blades.
 *
 * Returns false when nothing could be written, which is the honest answer for
 * a family whose chart is not confirmed.
 */
export function writeFixture(
  profile: FixtureProfile | undefined,
  values: WriteValues,
  dmx: Uint8Array,
  base: number,
  mix: number,
): boolean {
  const map = profile?.standardMap
  if (!profile || !map || mix <= 0) return false
  const at = (key: string): number | null => (map[key] !== undefined ? base + map[key] - 1 : null)

  let wrote = false

  // Intensity goes to the fixture's own dimmer rather than into the colour.
  // A desk dims with the dimmer, and a blinder that has nothing but a dimmer
  // is then driven by exactly the same code as a batten that has both.
  const dimmer = at('dimmer')
  if (dimmer !== null) {
    put16(dmx, dimmer, at('dimmerFine'), Math.max(0, Math.min(1, values.intensity)), mix)
    wrote = true
  }

  // Colour, additive or subtractive, whichever this machine actually has.
  const red = at('red')
  const green = at('green')
  const blue = at('blue')
  if (red !== null && green !== null && blue !== null) {
    put(dmx, red, values.r * 255, mix)
    put(dmx, green, values.g * 255, mix)
    put(dmx, blue, values.b * 255, mix)
    // White would wash the colour out, so it fades away with the crossfade.
    const white = at('white')
    if (white !== null) put(dmx, white, 0, mix)
    wrote = true
  } else {
    const cyan = at('cyan')
    const magenta = at('magenta')
    const yellow = at('yellow')
    if (cyan !== null && magenta !== null && yellow !== null) {
      // Subtractive: the filter is what the colour is NOT.
      put(dmx, cyan, (1 - values.r) * 255, mix)
      put(dmx, magenta, (1 - values.g) * 255, mix)
      put(dmx, yellow, (1 - values.b) * 255, mix)
      wrote = true
    }
  }

  // The shutter has to be open or nothing above matters. 255 is "open" on
  // every chart in this plot -- the Tambora's 252-255 band and the Blinded1's
  // 250-255 band both are -- but a hardware strobe rate is NOT driven from
  // here: the value bands differ per chart and inventing one would make a
  // fixture flash at a rate nobody asked for.
  const shutter = at('strobe') ?? at('shutter')
  if (shutter !== null) {
    put(dmx, shutter, 255, mix)
    wrote = true
  }

  // Movement, only where the travel is documented. A profile that declares a
  // pan channel but no range is a profile that cannot be aimed, and guessing
  // the range would swing a head somewhere nobody chose.
  const pan = at('pan')
  if (pan !== null && values.pan !== null && (profile.panRangeDeg ?? 0) > 0) {
    const span = ((profile.panRangeDeg as number) * Math.PI) / 180
    const normalised = (profile.panInvert ? -values.pan : values.pan) / span + 0.5
    put16(dmx, pan, at('panFine'), Math.max(0, Math.min(1, normalised)), mix)
    wrote = true
  }
  const tilt = at('tilt')
  if (tilt !== null && values.tilt !== null && (profile.tiltRangeDeg ?? 0) > 0) {
    const span = ((profile.tiltRangeDeg as number) * Math.PI) / 180
    const normalised = (profile.tiltInvert ? -values.tilt : values.tilt) / span + 0.5
    put16(dmx, tilt, at('tiltFine'), Math.max(0, Math.min(1, normalised)), mix)
    wrote = true
  }

  const zoom = at('zoom')
  if (zoom !== null && values.zoom !== null) {
    put(dmx, zoom, Math.max(0, Math.min(1, values.zoom)) * 255, mix)
    wrote = true
  }

  const fog = at('fog')
  if (fog !== null && values.fog !== null) {
    put(dmx, fog, Math.max(0, Math.min(1, values.fog)) * 255, mix)
    wrote = true
  }

  return wrote
}

/** Whether Stage could transmit to this family at all. The Live output panel
 *  shows this, so nobody has to discover it by arming and watching. */
export function isWritable(profile: FixtureProfile | undefined): boolean {
  return profile?.standardMap !== undefined
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
