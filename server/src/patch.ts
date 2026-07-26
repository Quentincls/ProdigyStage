import { readFileSync } from 'node:fs'

export interface FixtureType {
  name: string
  footprint: number
  pixels: number
  pixelOrder: string
  standardMap: Record<string, number>
  pixelStart: number
}

export interface Fixture {
  id: string
  type: string
  head: number
  universe: number
  address: number
  position: [number, number, number]
  rotation: [number, number, number]
  group: string
}

export interface Patch {
  fixtureTypes: Record<string, FixtureType>
  fixtures: Fixture[]
  groups: string[]
}

// Same relative depth from server/src (dev via tsx) and server/dist (built).
const PATCH_URL = new URL('../../data/patch.json', import.meta.url)

export function loadPatch(): Patch {
  return JSON.parse(readFileSync(PATCH_URL, 'utf8')) as Patch
}
