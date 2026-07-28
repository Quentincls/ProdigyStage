// The words Compose thinks in.
//
// This is the vocabulary an operator uses to say what a part of the show
// should feel like -- palette, mood, energy, movement, density, look family --
// and the numbers each of those words turns into. It lives in /core because
// both sides need it and neither owns it: the server composes with it, and the
// interface offers it. A colour table copied into two files is a colour table
// that will disagree with itself by Friday.
//
// Nothing here renders anything. It is the dictionary, not the engine.

import type { EffectType } from './effects.js'

export type PaletteId =
  | 'blue-cyan'
  | 'deep-blue'
  | 'red-black'
  | 'white-gold'
  | 'purple-magenta'
  | 'amber-warm'
  | 'toxic-green'
  | 'mono-white'

export type MoodId = 'mysterious' | 'rising' | 'powerful' | 'dreamy' | 'euphoric' | 'raw'
export type MovementId = 'still' | 'slow' | 'medium' | 'fast' | 'epic'
export type DensityId = 'minimal' | 'low' | 'medium' | 'high'
export type LookFamily = 'atmospheric' | 'movement' | 'impact' | 'minimal'

export interface Intent {
  palette: PaletteId
  mood: MoodId
  /** 0-100. Where the section starts, in feel rather than in candela. */
  energy: number
  /** Set for a section that climbs or falls across its length. */
  energyTo: number | null
  movement: MovementId
  density: DensityId
  families: LookFamily[]
}

/**
 * Two or three colours each: the first is the section's voice, the rest are
 * what it turns towards. Named after what they feel like, because that is the
 * level Compose works at.
 */
export const PALETTES: Record<PaletteId, { label: string; colours: string[] }> = {
  'blue-cyan': { label: 'Blue / Cyan', colours: ['#1f5cff', '#19d3ff', '#0a2a6b'] },
  'deep-blue': { label: 'Deep blue', colours: ['#1230a8', '#2b1a9c', '#050b28'] },
  'red-black': { label: 'Red / Black', colours: ['#ff1f1f', '#8c0d12', '#2a0306'] },
  'white-gold': { label: 'White / Gold', colours: ['#fff6e2', '#ffc245', '#ff8a1f'] },
  'purple-magenta': { label: 'Purple / Magenta', colours: ['#8b2dff', '#ff2dc4', '#3d0b6b'] },
  'amber-warm': { label: 'Amber', colours: ['#ff9426', '#ffbe5c', '#b34a05'] },
  'toxic-green': { label: 'Toxic green', colours: ['#5cff2d', '#0bd97a', '#0a3d1c'] },
  'mono-white': { label: 'White', colours: ['#ffffff', '#cfd8e6', '#8fa0b8'] },
}

/**
 * Mood is mostly how a section arrives and how it leaves: a mysterious passage
 * bleeds in over several seconds, a raw one cuts in a frame.
 */
export const MOODS: Record<MoodId, { label: string; fadeIn: number; fadeOut: number }> = {
  mysterious: { label: 'Mysterious', fadeIn: 3.5, fadeOut: 2.5 },
  dreamy: { label: 'Dreamy', fadeIn: 3, fadeOut: 3 },
  rising: { label: 'Rising', fadeIn: 1.5, fadeOut: 0.5 },
  powerful: { label: 'Powerful', fadeIn: 0.2, fadeOut: 0.4 },
  raw: { label: 'Raw', fadeIn: 0.05, fadeOut: 0.15 },
  euphoric: { label: 'Euphoric', fadeIn: 0.6, fadeOut: 1.2 },
}

/** Movement, in bars per cycle: how long the light takes to cross the room. */
export const MOVEMENTS: Record<MovementId, { label: string; barsPerCycle: number }> = {
  still: { label: 'Still', barsPerCycle: 16 },
  slow: { label: 'Slow', barsPerCycle: 4 },
  medium: { label: 'Medium', barsPerCycle: 2 },
  fast: { label: 'Fast', barsPerCycle: 1 },
  epic: { label: 'Epic', barsPerCycle: 0.5 },
}

/**
 * Density, in bars per change: how often the room is allowed to become
 * something else. This is the control that decides whether a section is one
 * held gesture or a sequence of them.
 */
export const DENSITIES: Record<DensityId, { label: string; barsPerBlock: number }> = {
  minimal: { label: 'Minimal', barsPerBlock: 64 },
  low: { label: 'Low', barsPerBlock: 32 },
  medium: { label: 'Medium', barsPerBlock: 16 },
  high: { label: 'High', barsPerBlock: 8 },
}

/** Which of the engine's effects each family is allowed to reach for. */
export const FAMILIES: Record<LookFamily, { label: string; note: string; effects: EffectType[] }> = {
  atmospheric: {
    label: 'Atmospheric',
    note: 'Washes and slow gradients',
    effects: ['gradient', 'solid'],
  },
  movement: {
    label: 'Movement',
    note: 'Waves and runners crossing the walls',
    effects: ['wave', 'chase'],
  },
  impact: {
    label: 'Impact',
    note: 'Hits and sparkle on the beat',
    effects: ['sparkle', 'chase'],
  },
  minimal: {
    label: 'Minimal',
    note: 'One colour, held',
    effects: ['solid'],
  },
}
