import type { FixtureKind } from '../../core/fixtures'
import { apiUrl } from './config'

export interface FixtureType {
  /** The manufacturer's. Shown in Advanced, and nowhere else. */
  name: string
  /** What the room calls the family: Tambora, Side Panels, Beams. */
  short?: string
  /** Which adapter in core/fixtures.ts reads it. Absent = nobody can. */
  kind?: FixtureKind
  footprint: number
  pixels: number
  pixelOrder: string
  standardMap: Record<string, number>
  pixelStart: number
  // Full mechanical tilt travel in degrees (DMX 0 -> one end, 65535 -> the
  // other). Absent or 0 = fixture does not tilt.
  tiltRangeDeg?: number
  // Which way the yoke turns. No DMX chart states this -- it is a fact of
  // the physical install, so it is calibrated on site rather than guessed.
  tiltInvert?: boolean
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

// Retries until the server is reachable (it may start after the UI in dev).
export async function fetchPatch(): Promise<Patch> {
  for (;;) {
    try {
      const response = await fetch(apiUrl('/api/patch'))
      if (response.ok) return (await response.json()) as Patch
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

export async function savePatch(patch: Patch): Promise<void> {
  const response = await fetch(apiUrl('/api/patch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`save failed (${response.status}) ${detail}`)
  }
}
