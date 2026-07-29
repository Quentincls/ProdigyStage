import { existsSync, readFileSync } from 'node:fs'

export interface FixtureType {
  name: string
  /** What the room calls this family. See core/fixtures.ts familyName(). */
  short?: string
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

// The rig as this build understands it, shipped alongside the install's own
// patch. Updating never overwrites data/patch.json -- that file carries the
// operator's placements -- but a build that knows about more of the plot has
// to be able to say so.
const REFERENCE_CANDIDATES = ['../../data/patch.reference.json', '../data/patch.reference.json']

function referencePath(): URL | null {
  for (const candidate of REFERENCE_CANDIDATES) {
    const url = new URL(candidate, import.meta.url)
    if (existsSync(url)) return url
  }
  return null
}

/**
 * The installed patch, plus anything the shipped reference knows about and it
 * does not.
 *
 * Purely additive, and purely in memory: a fixture that already exists is
 * never touched, whatever the reference says about it, because the operator
 * may have moved it in Placement mode and that is the more recent truth. The
 * file on disk is not rewritten either -- it changes only when someone saves
 * from the interface.
 *
 * "Additive" reaches inside a fixture type as well as beside it. A build that
 * learns something new about a model it already ships -- what the room calls
 * it, or one day the channel chart nobody had -- would otherwise be unable to
 * say so on any machine that has been running since before it knew, because
 * updating deliberately never overwrites data/. So a key the installed profile
 * does not have is filled in from the reference, and a key it does have is
 * left exactly as it is.
 */
export function loadPatch(): Patch {
  const patch = JSON.parse(readFileSync(patchPath(), 'utf8')) as Patch
  const url = referencePath()
  if (!url) return patch
  let reference: Patch
  try {
    reference = JSON.parse(readFileSync(url, 'utf8')) as Patch
  } catch (error) {
    console.error(`patch: ignoring unreadable patch.reference.json (${(error as Error).message})`)
    return patch
  }

  const merged = mergePatch(patch, reference)
  if (merged.added > 0) {
    console.log(
      `patch: ${merged.added} fixtures added from the lighting documentation (${merged.families.join(', ')}). ` +
        'Existing fixtures and their placements were left alone.',
    )
  }
  return merged.patch
}

/**
 * The merge itself, as a function of its inputs so it can be tested against a
 * patch older than the build -- which is the only case that matters and the
 * only one that never happens on a developer's machine.
 */
export function mergePatch(
  patch: Patch,
  reference: Patch,
): { patch: Patch; added: number; families: string[] } {
  for (const [id, type] of Object.entries(reference.fixtureTypes)) {
    const installed = patch.fixtureTypes[id]
    if (!installed) {
      patch.fixtureTypes[id] = type
      continue
    }
    const fields = installed as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(type)) {
      if (fields[key] === undefined) fields[key] = value
    }
  }

  const known = new Set(patch.fixtures.map((fixture) => fixture.id))
  const added = reference.fixtures.filter((fixture) => !known.has(fixture.id))
  patch.fixtures = [...patch.fixtures, ...added]
  const families = [...new Set(added.map((fixture) => reference.fixtureTypes[fixture.type]?.name ?? fixture.type))]
  return { patch, added: added.length, families }
}
