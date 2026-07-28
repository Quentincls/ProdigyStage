// The artistic direction: a language model reading the shape of a track and
// saying what each part of the show should feel like.
//
// What it is allowed to decide -- and what it is not -- is the whole point of
// this file. The analysis owns WHEN: bars, beats, where the music changes. The
// composer owns HOW: which effect, at which speed, on which bar line. This
// owns only WHAT FOR: a palette, a mood, an energy, a movement, a density, a
// name. It never sees a bar, never writes a scene, and never touches the show.
//
// That division is not tidiness. It is what keeps the promise Regenerate
// depends on: the same intention still composes the same show, every time,
// because nothing between the intention and the cue has an opinion.
//
// Everything the model may answer is constrained by a JSON schema built from
// the vocabulary in /core rather than typed out again here -- add a palette
// and it can be used the same day. What comes back is still checked before it
// is believed: a model is a colleague with taste, not a source of valid data
// structures.
//
// It is optional, always. No key configured -- an install in a venue with no
// internet, which is the normal case on a show day -- and Compose falls back to
// the rules it has always used. Nothing downstream can tell the difference.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import {
  DENSITIES,
  FAMILIES,
  MOODS,
  MOVEMENTS,
  PALETTES,
  type Intent,
  type LookFamily,
} from '@prodigy-stage/core/vocabulary'
import type { AudioAnalysis, AudioSection } from './audio.js'
import { defaultIntent, type ComposeSection } from './compose.js'

const MODEL = 'claude-opus-5'
const MAX_TOKENS = 16_000

export interface DirectionStatus {
  configured: boolean
  source: 'environment' | 'file' | null
  model: string
}

export interface DirectionResult {
  /** One sentence about the show as a whole, shown above the sections. */
  arc: string
  sections: ComposeSection[]
}

// ----- what the model is allowed to answer -----------------------------------
// Generated from the vocabulary, so the schema and the composer can never
// disagree about which words exist.
//
// Only the keywords in SCHEMA_KEYWORDS may appear here. The API accepts the
// structural half of JSON Schema and rejects the counting half outright --
// `minimum` on an integer is a 400, not a warning -- so a range is said in the
// description and enforced by applyDirection() below, which had to clamp it
// anyway. `assertSchemaIsSendable` walks this object at every start-up so the
// rule cannot quietly come back.
const SCHEMA_KEYWORDS = new Set([
  'type',
  'properties',
  'items',
  'required',
  'additionalProperties',
  'enum',
  'description',
])

const SCHEMA = {
  type: 'object',
  properties: {
    arc: {
      type: 'string',
      description: 'One sentence describing the journey the whole show takes.',
    },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'The number of the part, as given.' },
          name: {
            type: 'string',
            description: 'Two or three words naming this part in the show. English, no punctuation.',
          },
          why: { type: 'string', description: 'One short sentence for the operator.' },
          palette: { type: 'string', enum: Object.keys(PALETTES) },
          mood: { type: 'string', enum: Object.keys(MOODS) },
          energy: {
            type: 'integer',
            description: 'How the part starts, from 0 to 100, in steps of five.',
          },
          energyEnd: {
            type: 'integer',
            description:
              'How the part ends, from 0 to 100, in steps of five. Equal to energy for a part ' +
              'that holds; higher for one that climbs, lower for one that falls away.',
          },
          movement: { type: 'string', enum: Object.keys(MOVEMENTS) },
          density: { type: 'string', enum: Object.keys(DENSITIES) },
          families: {
            type: 'array',
            items: { type: 'string', enum: Object.keys(FAMILIES) },
            description: 'One to three, in order of importance.',
          },
        },
        required: [
          'index',
          'name',
          'why',
          'palette',
          'mood',
          'energy',
          'energyEnd',
          'movement',
          'density',
          'families',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['arc', 'sections'],
  additionalProperties: false,
} as const

/**
 * Refuse to send a schema the API will refuse to read. This exists because it
 * already happened: `minimum` and `maximum` looked harmless, went out to a
 * real key for the first time in a venue, and came back as a 400 that meant
 * nothing to the person reading it. A schema is data, so it can be checked
 * like data -- here, at start-up, rather than in front of an operator.
 */
export function assertSchemaIsSendable(node: unknown, path = 'schema'): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertSchemaIsSendable(item, `${path}[${index}]`))
    return
  }
  if (node === null || typeof node !== 'object') return
  for (const [keyword, value] of Object.entries(node)) {
    // Inside `properties` the keys are field names, not keywords.
    if (path.endsWith('.properties')) {
      assertSchemaIsSendable(value, `${path}.${keyword}`)
      continue
    }
    if (!SCHEMA_KEYWORDS.has(keyword)) {
      throw new Error(
        `direction: ${path}.${keyword} is not a keyword the API accepts in an output schema ` +
          `(allowed: ${[...SCHEMA_KEYWORDS].join(', ')})`,
      )
    }
    if (keyword !== 'enum' && keyword !== 'required' && keyword !== 'description') {
      assertSchemaIsSendable(value, `${path}.${keyword}`)
    }
  }
}

assertSchemaIsSendable(SCHEMA)

// ----- the brief the model works from ----------------------------------------

function vocabularyBrief(): string {
  const lines: string[] = []
  lines.push('PALETTES')
  for (const [id, palette] of Object.entries(PALETTES)) {
    lines.push(`  ${id} -- ${palette.label} (${palette.colours.join(' ')})`)
  }
  lines.push('')
  lines.push('MOODS (how the part arrives and how it leaves)')
  for (const [id, mood] of Object.entries(MOODS)) {
    lines.push(`  ${id} -- ${mood.label}: bleeds in over ${mood.fadeIn}s, out over ${mood.fadeOut}s`)
  }
  lines.push('')
  lines.push('MOVEMENT (how long light takes to cross the wall)')
  for (const [id, movement] of Object.entries(MOVEMENTS)) {
    lines.push(`  ${id} -- ${movement.label}: one pass every ${movement.barsPerCycle} bars`)
  }
  lines.push('')
  lines.push('DENSITY (how often the room becomes something else)')
  for (const [id, density] of Object.entries(DENSITIES)) {
    lines.push(`  ${id} -- ${density.label}: a new look every ${density.barsPerBlock} bars`)
  }
  lines.push('')
  lines.push('LOOKS (pick one to three; the show is built from these)')
  for (const [id, family] of Object.entries(FAMILIES)) {
    lines.push(`  ${id} -- ${family.label}: ${family.note.toLowerCase()}`)
  }
  return lines.join('\n')
}

function systemPrompt(): string {
  return `You are the lighting designer for a live show, writing the first pass of it.

THE RIG
Thirty-two LED battens making a backdrop: sixteen in a wall stage left,
sixteen stage right, each one a vertical strip of pixels. You control colour
and brightness, nothing else. There are no beams to swing and no fixtures that
turn -- "movement" here means light travelling across the wall, and that is the
only kind there is. Design for a wall of colour, not for a stage full of moving
heads.

WHAT YOU DECIDE
You are given the structure of a track exactly as the software heard it: where
each part starts and ends, how fast it runs, how loud and how bassy and how
bright it is compared to the rest of the track. You give each part an
intention, in the fixed vocabulary below.

You never decide timing. Where the parts begin and end is already settled, and
the software turns your intentions into cues on the bar lines by itself. You do
not write seconds, speeds, or effects.

THE VOCABULARY

${vocabularyBrief()}

HOW TO USE IT WELL
- A show is a journey, not a playlist. Two parts in a row must not feel the
  same; if consecutive parts would take the same palette, one of them is wrong.
- Keep the loudest palettes for the loudest moments. If every drop is red, no
  drop is.
- The operator's brief outranks the numbers. A place, a story, or a colour they
  already have in mind is the strongest signal in the whole request; follow it,
  and let the analysis tell you where it changes rather than what it should be.
- When there is no brief, write the show yourself. Read what this set is
  actually doing -- where it opens up, where it holds back, where it arrives --
  decide what it is about, and commit to that reading for the whole track. An
  absent brief is permission to invent, not an instruction to play safe: the
  answer must still be one show with a shape, never a part-by-part reaction to
  the numbers.
- Energy is a feeling, not a level meter: a quiet passage can be the most
  intense thing in the set.
- Set energyEnd equal to energy for a part that holds. Set it higher for a part
  that climbs into the next one, lower for one that falls away.
- Density is how often the room is allowed to become something else. A long
  ambient passage cut into thirty pieces is not ambient.
- Name each part for what it is in the show, not for what the analyser called
  it: two or three words, English, no punctuation, no numbering. "Cave",
  "First light", "Red world". These names are what the operator reads on the
  timeline all night, and they are how they will find the moment they are
  looking for.
- why: one short plain sentence, written to the operator. Not a defence of your
  choices.

Answer for every part you are given, once each, in order.`
}

function trackBrief(
  analysis: AudioAnalysis,
  sections: ComposeSection[],
  brief: string,
): string {
  // Loudness relative to the track's own peak: an RMS figure means nothing on
  // its own, and "68% of the loudest thing in this set" means everything.
  const peak = (pick: (section: AudioSection) => number): number =>
    Math.max(0.001, ...analysis.sections.map(pick))
  const loudest = peak((section) => section.level)
  const bassiest = peak((section) => section.bass)
  const brightest = peak((section) => section.air)

  const rows = sections.map((section, index) => {
    const source = analysis.sections.find(
      (candidate) => candidate.start < section.end && candidate.end > section.start,
    )
    const cells = [
      String(index + 1).padStart(2, '0'),
      `${clock(section.start)}-${clock(section.end)}`,
      `${Math.round(section.end - section.start)}s`.padStart(5),
      (source?.kind ?? section.kind).padEnd(7),
      source?.bpm === null || source === undefined ? 'no beat' : `${Math.round(source.bpm)} BPM`,
      `loud ${percent(source?.level ?? 0, loudest)}`,
      `bass ${percent(source?.bass ?? 0, bassiest)}`,
      `air ${percent(source?.air ?? 0, brightest)}`,
      `hits ${(source?.hitsPerSecond ?? 0).toFixed(1)}/s`,
    ]
    return cells.join('  ')
  })

  return `THE SHOW
${brief.trim() || 'No brief given. Read the music and decide what the show is about.'}

THE TRACK
${analysis.file} -- ${clock(analysis.seconds)} long, ${
    analysis.bpm === null ? 'no overall tempo found' : `${Math.round(analysis.bpm)} BPM overall`
  }, ${sections.length} parts.

Loudness, bass and air are given as a share of the loudest, bassiest and
brightest moment of this track, so they can be compared with each other.

${rows.join('\n')}`
}

// ----- believing the answer --------------------------------------------------

/**
 * Merge a proposal into the sections it was asked about. Nothing here trusts
 * anything: a missing part keeps the intention it had, an unknown word falls
 * back to the rule-based default, and the operator's boundaries are never
 * moved. The model can be wrong in every field and the draft stays valid.
 *
 * Pure, and deliberately separate from the request: this is the half worth
 * testing, and it is tested without a network.
 */
export function applyDirection(
  sections: ComposeSection[],
  analysis: AudioAnalysis,
  proposal: unknown,
): DirectionResult {
  const answer = (proposal ?? {}) as { arc?: unknown; sections?: unknown }
  const items = Array.isArray(answer.sections) ? (answer.sections as Record<string, unknown>[]) : []

  const directed = sections.map((section, index) => {
    // By index first, by position second: a model that renumbers is still
    // answering about the parts it was given, in the order it was given them.
    const item =
      items.find((candidate) => Number(candidate.index) === index + 1) ?? items[index] ?? null
    if (!item) return section

    const source = analysis.sections.find(
      (candidate) => candidate.start < section.end && candidate.end > section.start,
    )
    const fallback = source ? defaultIntent(source) : section.intent

    const energy = number(item.energy, fallback.energy)
    const energyEnd = number(item.energyEnd, energy)
    const intent: Intent = {
      palette: pick(item.palette, PALETTES, fallback.palette),
      mood: pick(item.mood, MOODS, fallback.mood),
      energy,
      // Equal ends mean a part that holds; only a real climb or fall becomes a
      // ramp, or every section would draw a pointless slope.
      energyTo: Math.abs(energyEnd - energy) < 3 ? null : energyEnd,
      movement: pick(item.movement, MOVEMENTS, fallback.movement),
      density: pick(item.density, DENSITIES, fallback.density),
      families: families(item.families, fallback.families),
    }

    return {
      ...section,
      name: text(item.name, 28) || section.name,
      why: text(item.why, 160) || undefined,
      intent,
      // A new intention is a new starting point: the variants the operator had
      // asked for were takes on a proposal that no longer exists.
      variant: 0,
    }
  })

  return { arc: text(answer.arc, 240), sections: directed }
}

function pick<T extends string>(value: unknown, table: Record<string, unknown>, fallback: T): T {
  return typeof value === 'string' && value in table ? (value as T) : fallback
}

function families(value: unknown, fallback: LookFamily[]): LookFamily[] {
  if (!Array.isArray(value)) return fallback
  const kept = value.filter((item): item is LookFamily => typeof item === 'string' && item in FAMILIES)
  const unique = [...new Set(kept)]
  // Never leave a section with nothing to compose from.
  return unique.length > 0 ? unique : fallback
}

/** An energy, clamped and snapped to the step the sliders move in -- so every
 *  level a direction proposes is one the operator could have set by hand. */
function number(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.min(100, Math.round(parsed / 5) * 5))
}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  const cleaned = value.replace(/\s+/g, ' ').trim()
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1).trimEnd()}…` : cleaned
}

// ----- the request -----------------------------------------------------------

export class ArtisticDirection {
  constructor(private readonly configPath: string) {}

  /**
   * An environment variable wins, because a machine that has one was set up by
   * someone who meant it. The file is for the install in the venue, where
   * there is no shell and no one to type into it.
   */
  private key(): { key: string; source: 'environment' | 'file' } | null {
    const fromEnvironment = process.env.ANTHROPIC_API_KEY?.trim()
    if (fromEnvironment) return { key: fromEnvironment, source: 'environment' }
    if (!existsSync(this.configPath)) return null
    try {
      const raw = JSON.parse(readFileSync(this.configPath, 'utf8')) as { apiKey?: unknown }
      const key = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
      return key ? { key, source: 'file' } : null
    } catch (error) {
      console.error(`direction: ignoring unreadable direction.json (${(error as Error).message})`)
      return null
    }
  }

  status(): DirectionStatus {
    const found = this.key()
    return { configured: found !== null, source: found?.source ?? null, model: MODEL }
  }

  /** Written where output.json lives: this install's own configuration. */
  setKey(key: string): DirectionStatus {
    const trimmed = key.trim()
    if (trimmed && !/^sk-/.test(trimmed)) {
      throw new Error('that does not look like an API key -- they start with sk-')
    }
    writeFileSync(this.configPath, JSON.stringify({ apiKey: trimmed }, null, 2) + '\n')
    return this.status()
  }

  async propose(
    analysis: AudioAnalysis,
    sections: ComposeSection[],
    brief: string,
  ): Promise<DirectionResult> {
    const found = this.key()
    if (!found) {
      throw new Error(
        'no API key for the artistic direction -- add one in Compose, or set ANTHROPIC_API_KEY',
      )
    }
    if (sections.length === 0) throw new Error('there is nothing to give a direction to')

    const client = new Anthropic({ apiKey: found.key, maxRetries: 1 })
    const started = Date.now()
    let message: Anthropic.Message
    try {
      // Streamed: the answer covers every part of a forty-five minute set and
      // is thought about first, which is long enough that a single request can
      // sit past a proxy's patience.
      message = await client.messages
        .stream({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          thinking: { type: 'adaptive' },
          system: systemPrompt(),
          messages: [{ role: 'user', content: trackBrief(analysis, sections, brief) }],
          output_config: { format: { type: 'json_schema', schema: SCHEMA } },
        })
        .finalMessage()
    } catch (error) {
      throw new Error(explain(error))
    }

    if (message.stop_reason === 'refusal') {
      throw new Error('the model declined to answer this one -- try rewording the brief')
    }
    if (message.stop_reason === 'max_tokens') {
      throw new Error('the answer was cut off -- try again with fewer parts')
    }

    const block = message.content.find((candidate) => candidate.type === 'text')
    if (!block || block.type !== 'text') throw new Error('the model answered with nothing')
    let parsed: unknown
    try {
      parsed = JSON.parse(block.text)
    } catch {
      throw new Error('the model answered with something that is not a direction')
    }

    const result = applyDirection(sections, analysis, parsed)
    console.log(
      `direction: ${result.sections.length} parts in ${Math.round((Date.now() - started) / 100) / 10}s ` +
        `(${message.usage.input_tokens} in, ${message.usage.output_tokens} out)`,
    )
    return result
  }
}

/** The SDK's typed errors, said in a sentence an operator can act on. */
function explain(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return 'that API key was refused -- check it and save it again'
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'the account is rate limited right now -- wait a moment and ask again'
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return 'no answer from the network -- this machine may be offline'
  }
  if (error instanceof Anthropic.APIError) {
    return `the direction request failed (${error.status}): ${error.message}`
  }
  return (error as Error).message
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function percent(value: number, of: number): string {
  return `${String(Math.round((value / of) * 100)).padStart(3)}%`
}
