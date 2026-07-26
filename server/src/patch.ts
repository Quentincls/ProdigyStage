import { existsSync, readFileSync } from 'node:fs'

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

// Two layouts share this code: the repo (server/src or server/dist ->
// ../../data) and the distributed package (LumenStage/server -> ../data).
const PATCH_CANDIDATES = ['../../data/patch.json', '../data/patch.json']

export function patchPath(): URL {
  for (const candidate of PATCH_CANDIDATES) {
    const url = new URL(candidate, import.meta.url)
    if (existsSync(url)) return url
  }
  throw new Error('data/patch.json not found (run: npm run generate-patch)')
}

export function loadPatch(): Patch {
  return JSON.parse(readFileSync(patchPath(), 'utf8')) as Patch
}
