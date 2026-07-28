// COMPOSE: the artist's intention, the music's structure, and the lighting
// vocabulary of Prodigy Stage, turned into a first composition.
//
// The division of labour this file exists to enforce:
//
//   the analysis knows WHEN     -- beats, bars, sections, energy
//   the operator knows WHAT FOR -- palette, mood, energy, movement, density
//   this file knows HOW         -- which look, at which speed, on which bar
//
// None of those three can do another's job. An analyser cannot know that the
// second half of Prodigy 12 is meant to feel like a cave; an operator should
// not have to type speed = 0.73; and neither of them should have to work out
// that a wave at 128 BPM advancing one cycle per bar is 0.53 cycles a second.
//
// Everything here is deterministic: the same intention composes the same show,
// every time. "Regenerate" does not roll dice behind the operator's back -- it
// asks for another take explicitly, by bumping the section's variant.

import type { SceneSpec, TrackSpec } from '@prodigy-stage/core'
import {
  DENSITIES,
  FAMILIES,
  MOODS,
  MOVEMENTS,
  PALETTES,
  type Intent,
  type LookFamily,
} from '@prodigy-stage/core/vocabulary'
import type { AudioAnalysis, AudioSection, SectionKind } from './audio.js'

export type { Intent } from '@prodigy-stage/core/vocabulary'

export interface ComposeSection {
  id: string
  name: string
  start: number
  end: number
  /** What the analysis called it. Kept as a hint, never as a decision. */
  kind: SectionKind
  intent: Intent
  /** Bumped by Regenerate: another take on the same intention. */
  variant: number
  /** One line about why this part looks like this, when a direction wrote it. */
  why?: string
}

export interface Marker {
  id: string
  name: string
  start: number
  end: number
}

export interface Composition {
  markers: Marker[]
  scenes: SceneSpec[]
}

/** The intention a section starts with, read off what the music is doing. */
export function defaultIntent(section: AudioSection): Intent {
  switch (section.kind) {
    case 'intro':
      return {
        palette: 'deep-blue',
        mood: 'mysterious',
        energy: 25,
        energyTo: null,
        movement: 'slow',
        density: 'minimal',
        families: ['atmospheric'],
      }
    case 'build':
      return {
        palette: 'purple-magenta',
        mood: 'rising',
        energy: 40,
        energyTo: 80,
        movement: 'medium',
        density: 'medium',
        families: ['movement'],
      }
    case 'drop':
      return {
        palette: 'red-black',
        mood: 'powerful',
        energy: 100,
        energyTo: null,
        movement: 'fast',
        density: 'high',
        families: ['movement', 'impact'],
      }
    case 'break':
      return {
        palette: 'blue-cyan',
        mood: 'dreamy',
        energy: 20,
        energyTo: null,
        movement: 'still',
        density: 'minimal',
        families: ['atmospheric', 'minimal'],
      }
    default:
      return {
        palette: 'amber-warm',
        mood: 'rising',
        energy: 60,
        energyTo: null,
        movement: 'medium',
        density: 'medium',
        families: ['movement'],
      }
  }
}

export function sectionsFromAnalysis(analysis: AudioAnalysis, newId: () => string): ComposeSection[] {
  const seen: Record<string, number> = {}
  const counts = analysis.sections.reduce<Record<string, number>>((accumulator, section) => {
    accumulator[section.kind] = (accumulator[section.kind] ?? 0) + 1
    return accumulator
  }, {})
  return analysis.sections.map((section) => {
    const rank = (seen[section.kind] = (seen[section.kind] ?? 0) + 1)
    const label = section.kind[0].toUpperCase() + section.kind.slice(1)
    return {
      id: newId(),
      name: counts[section.kind] > 1 ? `${label} ${rank}` : label,
      start: section.start,
      end: section.end,
      kind: section.kind,
      intent: defaultIntent(section),
      variant: 0,
    }
  })
}

// A small deterministic generator: the same section and variant always compose
// the same way. Creative tools that quietly change their mind are impossible
// to work with.
function seededRandom(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
}

function scaleColour(hex: string, factor: number): string {
  const value = hex.replace('#', '')
  const to = (index: number): string => {
    const channel = parseInt(value.slice(index * 2, index * 2 + 2), 16)
    return Math.max(0, Math.min(255, Math.round(channel * factor)))
      .toString(16)
      .padStart(2, '0')
  }
  return `#${to(0)}${to(1)}${to(2)}`
}

/** Energy is a feeling, not a level; this is where it becomes one. */
function brightness(energy: number): number {
  return 0.18 + (Math.max(0, Math.min(100, energy)) / 100) * 0.82
}

/**
 * The bar grid for a section. Where the analysis gave us a tempo and a phase,
 * changes land on bar lines and the section feels composed rather than timed;
 * where it did not -- an ambient intro, a breakdown -- there is no grid to
 * land on and the section is treated as one continuous gesture.
 */
function barGrid(source: AudioSection): { barSeconds: number; firstBar: number } | null {
  if (source.bpm === null || source.beatPhase === null) return null
  const barSeconds = (60 / source.bpm) * 4
  // Walk the phase back to the first bar at or before the section starts.
  const offset = source.beatPhase - source.start
  const firstBar = source.start + (((offset % barSeconds) + barSeconds) % barSeconds)
  return { barSeconds, firstBar }
}

function composeSection(
  section: ComposeSection,
  source: AudioSection | undefined,
  newId: () => string,
): SceneSpec[] {
  const { intent } = section
  const random = seededRandom(`${section.id}:${section.variant}`)
  const palette = PALETTES[intent.palette].colours
  const mood = MOODS[intent.mood]
  const movement = MOVEMENTS[intent.movement]
  const density = DENSITIES[intent.density]
  const families = intent.families.length > 0 ? intent.families : (['atmospheric'] as LookFamily[])
  const effects = [...new Set(families.flatMap((family) => FAMILIES[family].effects))]

  const grid = source ? barGrid(source) : null
  const duration = section.end - section.start

  // Cut the section into blocks on bar lines. Without a grid the whole section
  // is one block: there is nothing musical to cut on.
  const cuts: number[] = [section.start]
  if (grid) {
    const blockSeconds = grid.barSeconds * density.barsPerBlock
    let t = grid.firstBar
    while (t + blockSeconds < section.end - 1) {
      t += blockSeconds
      if (t - cuts[cuts.length - 1] > 2) cuts.push(round1(t))
    }
    // A block left with a sliver of a bar is a cue nobody asked for: fold the
    // runt back into the one before it rather than flash something for a
    // second and a half.
    const tail = section.end - cuts[cuts.length - 1]
    if (cuts.length > 1 && tail < blockSeconds * 0.5) cuts.pop()
  }
  cuts.push(section.end)

  const scenes: SceneSpec[] = []
  for (let block = 0; block < cuts.length - 1; block++) {
    const start = cuts[block]
    const end = cuts[block + 1]
    if (end - start < 0.5) continue

    // Energy ramps across the section, so a build actually builds.
    const through = duration > 0 ? (start - section.start) / duration : 0
    const energy =
      intent.energyTo === null
        ? intent.energy
        : intent.energy + (intent.energyTo - intent.energy) * through
    const factor = brightness(energy)

    const effect = effects[Math.floor(random() * effects.length) % effects.length]
    // Only the first two colours of a palette lead. The third is the deep end
    // of it -- the "black" in Red / Black -- and a section that spends a whole
    // block there reads as a hole in the show rather than as a colour.
    const leads = palette.slice(0, 2)
    const colour = scaleColour(leads[block % leads.length], factor)
    const second = scaleColour(palette[palette.length - 1], factor * 0.75)

    // Cycles per second, from bars per cycle: this is the line that makes the
    // light move with the music instead of near it.
    const cyclesPerSecond = grid ? 1 / (grid.barSeconds * movement.barsPerCycle) : 0.05

    let params: Record<string, string | number>
    switch (effect) {
      case 'solid':
        params = { color: colour }
        break
      case 'gradient':
        params = { colorA: colour, colorB: second, speed: round2(cyclesPerSecond) }
        break
      case 'wave':
        params = {
          color: colour,
          speed: round2(cyclesPerSecond * 4),
          size: intent.density === 'high' ? 5 : intent.density === 'minimal' ? 1 : 3,
        }
        break
      case 'chase':
        params = {
          color: colour,
          // chase completes a pass in 4/speed seconds.
          speed: round2(4 * cyclesPerSecond),
          count: intent.density === 'high' ? 4 : intent.density === 'low' ? 2 : 3,
        }
        break
      case 'sparkle':
        params = {
          color: colour,
          // Flashes on the eighth: the fastest thing that still reads as rhythm.
          speed: round2(grid ? 8 / grid.barSeconds : 4),
          density: intent.density === 'high' ? 0.45 : 0.25,
        }
        break
      default:
        params = { color: colour }
    }

    const isFirst = block === 0
    const isLast = block === cuts.length - 2
    const track: TrackSpec = {
      id: newId(),
      target: 'both',
      effect,
      params,
      // Only the section's own edges get its mood's fades; inside it, blocks
      // hand over quickly or the section reads as a series of separate cues.
      fadeIn: isFirst ? mood.fadeIn : 0.25,
      fadeOut: isLast ? mood.fadeOut : 0.25,
    }

    scenes.push({
      id: newId(),
      name: cuts.length > 2 ? `${section.name} ${block + 1}` : section.name,
      start: round1(start),
      end: round1(end),
      tracks: [track],
    })
  }

  return scenes
}

export function compose(
  analysis: AudioAnalysis,
  sections: ComposeSection[],
  newId: () => string,
): Composition {
  const markers: Marker[] = []
  const scenes: SceneSpec[] = []
  for (const section of sections) {
    // Match by overlap rather than by index: the operator can have moved,
    // split or merged the boundaries since the analysis ran.
    const source = analysis.sections.find(
      (candidate) => candidate.start < section.end && candidate.end > section.start,
    )
    markers.push({
      id: newId(),
      name: section.name,
      start: round1(section.start),
      end: round1(section.end),
    })
    scenes.push(...composeSection(section, source, newId))
  }
  return { markers, scenes }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
