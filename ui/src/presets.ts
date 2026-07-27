// Built-in look library. A fresh install used to show no presets at all --
// the editor opened on a blank slate and you had to know what "gradient,
// speed 0.2" would look like. These ship with the app so the first move is
// always "pick a look you like", not "configure an effect".
//
// User-saved presets live in show.json and are shown alongside these.

import type { PresetSpec } from './show'

export const BUILTIN_PRESETS: PresetSpec[] = [
  {
    id: 'builtin-warm',
    name: 'Warm wash',
    target: 'both',
    effect: 'solid',
    params: { color: '#ff9d3d' },
    fadeIn: 0.5,
    fadeOut: 0.5,
  },
  {
    id: 'builtin-cold',
    name: 'Cold wash',
    target: 'both',
    effect: 'solid',
    params: { color: '#9fd4ff' },
    fadeIn: 0.5,
    fadeOut: 0.5,
  },
  {
    id: 'builtin-red',
    name: 'Deep red',
    target: 'both',
    effect: 'solid',
    params: { color: '#ff1e2d' },
    fadeIn: 0.5,
    fadeOut: 0.5,
  },
  {
    id: 'builtin-magenta',
    name: 'Magenta',
    target: 'both',
    effect: 'solid',
    params: { color: '#ff2d9e' },
    fadeIn: 0.5,
    fadeOut: 0.5,
  },
  {
    id: 'builtin-sunset',
    name: 'Sunset',
    target: 'both',
    effect: 'gradient',
    params: { colorA: '#ff5a1f', colorB: '#ff2d78', speed: 0.12 },
    fadeIn: 1,
    fadeOut: 1,
  },
  {
    id: 'builtin-ocean',
    name: 'Ocean',
    target: 'both',
    effect: 'gradient',
    params: { colorA: '#0a5cff', colorB: '#00e0c6', speed: 0.2 },
    fadeIn: 1,
    fadeOut: 1,
  },
  {
    id: 'builtin-slow-wave',
    name: 'Slow wave',
    target: 'both',
    effect: 'wave',
    params: { color: '#ffb340', speed: 0.35, size: 2 },
    fadeIn: 1,
    fadeOut: 1,
  },
  {
    id: 'builtin-pulse',
    name: 'Pulse',
    target: 'both',
    effect: 'wave',
    params: { color: '#c9e4ff', speed: 1.6, size: 1 },
    fadeIn: 0.5,
    fadeOut: 0.5,
  },
  {
    id: 'builtin-runner',
    name: 'Runner',
    target: 'both',
    effect: 'chase',
    params: { color: '#b4dcff', speed: 1, count: 2 },
    fadeIn: 0.5,
    fadeOut: 0.5,
  },
  {
    id: 'builtin-chase-four',
    name: 'Four runners',
    target: 'both',
    effect: 'chase',
    params: { color: '#ffd166', speed: 1.8, count: 4 },
    fadeIn: 0.5,
    fadeOut: 0.5,
  },
  {
    id: 'builtin-sparkle',
    name: 'Sparkle',
    target: 'both',
    effect: 'sparkle',
    params: { color: '#ffffff', density: 0.25, speed: 5 },
    fadeIn: 0.5,
    fadeOut: 0.5,
  },
  {
    id: 'builtin-fireflies',
    name: 'Fireflies',
    target: 'both',
    effect: 'sparkle',
    params: { color: '#ffcf6b', density: 0.12, speed: 2 },
    fadeIn: 1,
    fadeOut: 1,
  },
]

export function isBuiltinPreset(id: string): boolean {
  return id.startsWith('builtin-')
}
