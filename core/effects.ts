// Shared pixel-map effect engine (brief Phase 5A). Pure TypeScript, zero
// dependencies, fully deterministic against the timecode: the same instant
// always renders the same colors. Runs in the browser (previz, 60 fps) and in
// Node (server output in Phase 6) -- keep it free of DOM and Node APIs.
//
// An effect maps (normalized position along the wall, pixel index, time in
// seconds) to an RGB color. Effects have at most 4 parameters (brief).

export type Rgb = [number, number, number]

export type EffectType = 'solid' | 'gradient' | 'wave' | 'chase' | 'sparkle'

export type ParamValue = number | string

export interface ParamDef {
  key: string
  label: string
  type: 'color' | 'range'
  min?: number
  max?: number
  step?: number
  default: ParamValue
}

export interface EffectDef {
  type: EffectType
  label: string
  params: ParamDef[]
}

export const EFFECTS: EffectDef[] = [
  {
    type: 'solid',
    label: 'Solid',
    params: [{ key: 'color', label: 'Color', type: 'color', default: '#ff8a2a' }],
  },
  {
    type: 'gradient',
    label: 'Gradient',
    params: [
      { key: 'colorA', label: 'Color A', type: 'color', default: '#ff2d78' },
      { key: 'colorB', label: 'Color B', type: 'color', default: '#2d8cff' },
      { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 2, step: 0.05, default: 0.2 },
    ],
  },
  {
    type: 'wave',
    label: 'Wave',
    params: [
      { key: 'color', label: 'Color', type: 'color', default: '#ffb340' },
      { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 3, step: 0.05, default: 0.6 },
      { key: 'size', label: 'Size', type: 'range', min: 0.5, max: 8, step: 0.5, default: 3 },
    ],
  },
  {
    type: 'chase',
    label: 'Chase',
    params: [
      { key: 'color', label: 'Color', type: 'color', default: '#b4dcff' },
      { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'count', label: 'Runners', type: 'range', min: 1, max: 8, step: 1, default: 3 },
    ],
  },
  {
    type: 'sparkle',
    label: 'Sparkle',
    params: [
      { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { key: 'density', label: 'Density', type: 'range', min: 0.05, max: 1, step: 0.05, default: 0.3 },
      { key: 'speed', label: 'Speed', type: 'range', min: 0.5, max: 12, step: 0.5, default: 4 },
    ],
  },
]

export function effectDef(type: string): EffectDef | undefined {
  return EFFECTS.find((def) => def.type === type)
}

export function defaultParams(type: string): Record<string, ParamValue> {
  const def = effectDef(type)
  const params: Record<string, ParamValue> = {}
  for (const param of def?.params ?? []) params[param.key] = param.default
  return params
}

// ---------------------------------------------------------------------------

const hexCache = new Map<string, Rgb>()

export function hexToRgb(hex: string): Rgb {
  let rgb = hexCache.get(hex)
  if (!rgb) {
    const n = parseInt(hex.replace('#', ''), 16)
    rgb = Number.isNaN(n) ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    hexCache.set(hex, rgb)
  }
  return rgb
}

function frac(n: number): number {
  return ((n % 1) + 1) % 1
}

function num(params: Record<string, ParamValue>, key: string, fallback: number): number {
  const value = params[key]
  return typeof value === 'number' && !Number.isNaN(value) ? value : fallback
}

function col(params: Record<string, ParamValue>, key: string, fallback: string): Rgb {
  const value = params[key]
  return hexToRgb(typeof value === 'string' ? value : fallback)
}

// Deterministic integer hash (xorshift-style), stable across JS engines.
function hash(n: number): number {
  let x = n | 0
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  x = x ^ (x >>> 16)
  return x >>> 0
}

export function renderEffect(
  type: string,
  params: Record<string, ParamValue>,
  pos: number,
  pixelIndex: number,
  t: number,
): Rgb {
  switch (type) {
    case 'solid': {
      return col(params, 'color', '#ff8a2a')
    }
    case 'gradient': {
      const a = col(params, 'colorA', '#ff2d78')
      const b = col(params, 'colorB', '#2d8cff')
      const speed = num(params, 'speed', 0.2)
      // Ping-pong mix so the gradient sweeps back and forth when animated.
      const m = 1 - Math.abs(2 * frac(pos + t * speed) - 1)
      return [a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m, a[2] + (b[2] - a[2]) * m]
    }
    case 'wave': {
      const c = col(params, 'color', '#ffb340')
      const speed = num(params, 'speed', 0.6)
      const size = num(params, 'size', 3)
      const i = 0.5 + 0.5 * Math.sin(2 * Math.PI * (pos * size - t * speed))
      return [c[0] * i, c[1] * i, c[2] * i]
    }
    case 'chase': {
      const c = col(params, 'color', '#b4dcff')
      const speed = num(params, 'speed', 1)
      const count = Math.max(1, Math.round(num(params, 'count', 3)))
      let b = 0
      for (let j = 0; j < count; j++) {
        const center = frac((t * speed) / 4 + j / count)
        const d = Math.min(Math.abs(pos - center), 1 - Math.abs(pos - center))
        b = Math.max(b, Math.exp(-d * d * 2000))
      }
      return [c[0] * b, c[1] * b, c[2] * b]
    }
    case 'sparkle': {
      const c = col(params, 'color', '#ffffff')
      const density = num(params, 'density', 0.3)
      const speed = num(params, 'speed', 4)
      const cell = Math.floor(t * speed)
      const h = hash(pixelIndex * 7919 + cell * 104729)
      if ((h % 1000) / 1000 >= density) return [0, 0, 0]
      const fade = 1 - frac(t * speed)
      return [c[0] * fade, c[1] * fade, c[2] * fade]
    }
    default:
      return [0, 0, 0]
  }
}

// ----- scenes --------------------------------------------------------------

export type TrackTarget = 'wall-left' | 'wall-right' | 'both'

export interface TrackSpec {
  id: string
  target: TrackTarget
  effect: EffectType
  params: Record<string, ParamValue>
  fadeIn: number // seconds
  fadeOut: number
}

export interface SceneSpec {
  id: string
  name: string
  start: number // seconds of show timecode
  end: number
  tracks: TrackSpec[]
}

export function sceneActiveAt(scene: SceneSpec, showTime: number): boolean {
  return showTime >= scene.start && showTime < scene.end
}

export function trackAmplitude(track: TrackSpec, scene: SceneSpec, showTime: number): number {
  const into = showTime - scene.start
  const left = scene.end - showTime
  let amplitude = 1
  if (track.fadeIn > 0) amplitude = Math.min(amplitude, into / track.fadeIn)
  if (track.fadeOut > 0) amplitude = Math.min(amplitude, left / track.fadeOut)
  return Math.max(0, Math.min(1, amplitude))
}

function targetMatches(target: TrackTarget, group: string): boolean {
  return target === 'both' || target === group
}

// Returns the color a scene gives to a pixel, or null when no track of the
// scene covers this pixel's group (the console feed stays visible there).
// Time is deterministic: everything derives from the show timecode.
export function renderScenePixel(
  scene: SceneSpec,
  group: string,
  pos: number,
  pixelIndex: number,
  showTime: number,
): Rgb | null {
  if (!sceneActiveAt(scene, showTime)) return null
  const sceneTime = showTime - scene.start
  // Last matching track wins (top-most in the UI list).
  for (let i = scene.tracks.length - 1; i >= 0; i--) {
    const track = scene.tracks[i]
    if (!targetMatches(track.target, group)) continue
    const amplitude = trackAmplitude(track, scene, showTime)
    if (amplitude <= 0) return [0, 0, 0]
    const [r, g, b] = renderEffect(track.effect, track.params, pos, pixelIndex, sceneTime)
    return [r * amplitude, g * amplitude, b * amplitude]
  }
  return null
}

export function activeScene(scenes: SceneSpec[], showTime: number): SceneSpec | null {
  // Later scenes in the list win on overlap.
  for (let i = scenes.length - 1; i >= 0; i--) {
    if (sceneActiveAt(scenes[i], showTime)) return scenes[i]
  }
  return null
}
