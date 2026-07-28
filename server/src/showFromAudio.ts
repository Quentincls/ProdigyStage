// Turning what the music does into a show you can edit.
//
// A warning that belongs at the top of this file, because it decides how the
// whole feature should be read: the analysis hears structure and tempo, and
// those are facts. Everything below -- which look belongs on a drop, which
// colour belongs on a breakdown -- is a convention this file invents. There is
// no objective relation between a sound and a colour. What the machine can do
// honestly is place the changes where the music actually changes, and move the
// light in time with it. The taste is the operator's, and the result is a
// draft laid out for them to argue with.
//
// What it does guarantee: every effect runs on the section's own tempo, so a
// wave advances one cycle per beat and a runner crosses the wall once per bar.
// That is the part that makes it feel like the lights heard the track.

import type { SceneSpec, TrackSpec } from '@prodigy-stage/core'
import type { AudioAnalysis, AudioSection, SectionKind } from './audio.js'

export interface Marker {
  id: string
  name: string
  start: number
  end: number
}

export interface ShowProposal {
  markers: Marker[]
  scenes: SceneSpec[]
}

// The colour convention, stated once and in one place so it can be argued
// with. Warm and bright where the track pushes, cold and dim where it opens
// up. Consecutive sections of the same kind rotate through their palette, so
// two drops in a row do not look like the same drop.
const PALETTE: Record<SectionKind, string[]> = {
  intro: ['#1e4bd8', '#2d6cff'],
  build: ['#ff8a2a', '#ffb340', '#ff6a1f'],
  drop: ['#ff2d2d', '#ff8a2a', '#e02dff', '#2dd4ff'],
  break: ['#2d6cff', '#6a4bff'],
  groove: ['#ffb340', '#ff8a2a', '#ffd36a'],
}

// Effect speeds are expressed in cycles per second, so a tempo turns into a
// speed by dividing: one cycle per beat is bpm/60, one per bar is bpm/240.
function beatSpeed(bpm: number | null, perBeat: number): number {
  if (bpm === null) return 0.08 // no beat: drift slowly rather than sit still
  return Math.round(((bpm / 60) * perBeat) * 100) / 100
}

function look(section: AudioSection, index: number): Omit<TrackSpec, 'id'> {
  const colour = PALETTE[section.kind][index % PALETTE[section.kind].length]
  const bpm = section.bpm

  switch (section.kind) {
    case 'intro':
      return {
        target: 'both',
        effect: 'gradient',
        params: { colorA: colour, colorB: '#050b1e', speed: beatSpeed(bpm, 1 / 8) },
        fadeIn: 3,
        fadeOut: 2,
      }
    case 'break':
      return {
        target: 'both',
        effect: 'gradient',
        params: { colorA: colour, colorB: '#04070f', speed: beatSpeed(bpm, 1 / 8) },
        fadeIn: 2.5,
        fadeOut: 2,
      }
    case 'build':
      // A wave, one cycle per beat, tightening as the section gets busier.
      return {
        target: 'both',
        effect: 'wave',
        params: {
          color: colour,
          speed: beatSpeed(bpm, 1),
          size: section.hitsPerSecond > 3 ? 5 : 3,
        },
        fadeIn: 1.2,
        fadeOut: 0.4,
      }
    case 'drop':
      // Runners crossing the wall once per bar: the most physical answer to a
      // kick pattern we can give with these fixtures.
      return {
        target: 'both',
        effect: 'chase',
        params: {
          color: colour,
          speed: beatSpeed(bpm, 1),
          count: section.bass > 0.75 ? 4 : 3,
        },
        fadeIn: 0.2,
        fadeOut: 0.3,
      }
    default:
      return {
        target: 'both',
        effect: 'wave',
        params: { color: colour, speed: beatSpeed(bpm, 1 / 2), size: 3 },
        fadeIn: 0.8,
        fadeOut: 0.8,
      }
  }
}

export function proposeShow(analysis: AudioAnalysis, newId: () => string): ShowProposal {
  const markers: Marker[] = []
  const scenes: SceneSpec[] = []
  const seen = {} as Record<SectionKind, number>
  const kindCounts = analysis.sections.reduce<Record<string, number>>((accumulator, section) => {
    accumulator[section.kind] = (accumulator[section.kind] ?? 0) + 1
    return accumulator
  }, {})

  for (const section of analysis.sections) {
    // Rank within its own kind, not position in the set: it is what makes the
    // second drop the second drop, both in its name and in its colour.
    const rank = (seen[section.kind] = (seen[section.kind] ?? 0) + 1)
    const label = capitalise(section.kind)
    const name = kindCounts[section.kind] > 1 ? `${label} ${rank}` : label
    markers.push({ id: newId(), name, start: section.start, end: section.end })
    scenes.push({
      id: newId(),
      name,
      start: section.start,
      end: section.end,
      tracks: [{ id: newId(), ...look(section, rank - 1) }],
    })
  }

  return { markers, scenes }
}

function capitalise(word: string): string {
  return word[0].toUpperCase() + word.slice(1)
}
