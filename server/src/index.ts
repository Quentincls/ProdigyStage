// PRODIGY STAGE server: Art-Net listener -> WebSocket bridge (Phases 1-5),
// plus the Phase 6 man-in-the-middle output. Receives ArtDMX + ArtTimeCode on
// UDP 6454, keeps a 4x512 state, broadcasts a consolidated binary frame at
// ~40 fps plus a JSON stats message at 1 Hz, records/replays full runs.
//
// Transmission towards the rig lives entirely in output.ts and is OFF at
// boot, with no configured target: see the header of that file.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SceneSpec } from '@prodigy-stage/core'
import { WebSocket } from 'ws'
import { timecodeToSeconds } from './artnet.js'
import { analyseWav, type AudioAnalysis } from './audio.js'
import { ArtnetListener } from './listener.js'
import { ArtnetOutput, type OutputMode } from './output.js'
import { compose, sectionsFromAnalysis, type ComposeSection } from './compose.js'
import { ArtisticDirection } from './direction.js'
import { proposeShow } from './showFromAudio.js'
import { loadPatch, patchPath } from './patch.js'
import { Recorder } from './recorder.js'
import { Replayer } from './replayer.js'
import { startWebServer, WEB_PORT } from './web.js'

const SHOW_UNIVERSES = [1, 2, 3, 4]
const BROADCAST_MS = 25 // ~40 fps target, Windows timers make it ~32 fps: within the 30-44 spec
const STATS_MS = 1000

const patch = loadPatch()
console.log('PRODIGY STAGE server -- Phase 6')
console.log(`patch: ${patch.fixtures.length} fixtures on show universes ${SHOW_UNIVERSES.join(', ')}`)

const dataDir = join(fileURLToPath(patchPath()), '..')
const showPath = join(dataDir, 'show.json')
const outputConfigPath = join(dataDir, 'output.json')
const recordingsDir = join(dataDir, 'recordings')
const musicDir = join(dataDir, 'music')
const composePath = join(dataDir, 'compose.json')
const directionPath = join(dataDir, 'direction.json')

const listener = new ArtnetListener(SHOW_UNIVERSES)
listener.start()

const recorder = new Recorder(recordingsDir)
listener.onRaw = (msg, at) => recorder.write(msg, at)
const replayer = new Replayer('127.0.0.1')

function readShow(): string {
  if (!existsSync(showPath)) return '{"markers":[]}\n'
  return readFileSync(showPath, 'utf8')
}

// ----- Phase 6 output ------------------------------------------------------
// No output.json = no target = the install cannot reach a rig. Commissioning
// on site is exactly "write the rig's address into data/output.json".
function loadOutputConfig(): { targets: string[]; port: number } {
  if (!existsSync(outputConfigPath)) return { targets: [], port: 6454 }
  try {
    const raw = JSON.parse(readFileSync(outputConfigPath, 'utf8')) as {
      targets?: unknown
      port?: unknown
    }
    return {
      targets: Array.isArray(raw.targets) ? raw.targets.filter((t): t is string => typeof t === 'string') : [],
      port: typeof raw.port === 'number' ? raw.port : 6454,
    }
  } catch (error) {
    console.error(`output: ignoring unreadable output.json (${(error as Error).message})`)
    return { targets: [], port: 6454 }
  }
}

// Which build is running: the single most asked support question, and one
// nobody can answer from a screenshot.
const BUILD_VERSION = (() => {
  for (const candidate of ['../version.txt', '../../version.txt']) {
    const url = new URL(candidate, import.meta.url)
    if (existsSync(url)) return readFileSync(url, 'utf8').trim()
  }
  return 'development build'
})()

const output = new ArtnetOutput(loadOutputConfig(), patch)

// Scenes are cached: the merge runs on every console frame, it must never
// touch the disk. Invalidated whenever the editor saves.
let scenesCache: SceneSpec[] | null = null
function scenes(): SceneSpec[] {
  if (scenesCache) return scenesCache
  try {
    const parsed = JSON.parse(readShow()) as { scenes?: SceneSpec[] }
    scenesCache = Array.isArray(parsed.scenes) ? parsed.scenes : []
  } catch {
    scenesCache = []
  }
  return scenesCache
}

output.getScenes = scenes
output.getShowTime = () =>
  listener.isTimecodeActive() && listener.timecode ? timecodeToSeconds(listener.timecode) : null
listener.onFrame = (universe, data, at) => output.onConsoleFrame(universe, data, at)

console.log(
  output.status().targets.length === 0
    ? 'output: no target configured -- this install cannot transmit (data/output.json)'
    : `output: targets ${output.status().targets.join(', ')} (mode off until armed)`,
)

// ----- Phase 7: the music ---------------------------------------------------
// Analysing a mastered set takes seconds, not milliseconds, and the answer for
// a given file never changes -- so it is computed once and kept.
const analysisCache = new Map<string, AudioAnalysis>()

/** What Compose is working on: a track, what was heard in it, and the intent
 *  the operator has put on each part. Never the show -- that is Edit's. */
interface ComposeDraft {
  file: string
  analysis: AudioAnalysis
  sections: ComposeSection[]
  /** What the operator said the show is about, in their own words. */
  brief?: string
  /** The one-sentence journey a direction answered with. */
  arc?: string
}

// Optional, and inert without a key: see the header of direction.ts.
const direction = new ArtisticDirection(directionPath)

function musicFile(name: string): string | null {
  const safe = basename(name)
  if (!/\.(wav|wave)$/i.test(safe)) return null
  const path = join(musicDir, safe)
  return existsSync(path) ? path : null
}

// Created at boot rather than on demand: "drop the show's audio in data/music"
// is useless advice when data/music does not exist, and the one person who
// needs it is standing in a venue looking for a folder that was never made.
if (!existsSync(musicDir)) {
  mkdirSync(musicDir, { recursive: true })
}
console.log(`music: put the show's audio (WAV) in ${musicDir}`)

function listMusic(): unknown {
  if (!existsSync(musicDir)) return { dir: musicDir, files: [] }
  const files = readdirSync(musicDir)
    .filter((file) => /\.(wav|wave)$/i.test(file))
    .map((file) => {
      const stats = statSync(join(musicDir, file))
      return {
        file,
        sizeBytes: stats.size,
        modifiedAt: stats.mtimeMs,
        analysed: analysisCache.has(file),
      }
    })
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
  return { dir: musicDir, files }
}

const { wss } = startWebServer({
  port: WEB_PORT,
  // Re-read on every request so a hand-edited patch.json is picked up on reload.
  readPatch: () => readFileSync(patchPath(), 'utf8'),
  writePatch: (raw) => {
    const parsed = JSON.parse(raw) as { fixtureTypes?: unknown; fixtures?: unknown }
    if (!parsed || typeof parsed !== 'object' || !parsed.fixtureTypes || !Array.isArray(parsed.fixtures)) {
      throw new Error('invalid patch shape')
    }
    writeFileSync(patchPath(), JSON.stringify(parsed, null, 2) + '\n')
  },
  readShow,
  writeShow: (raw) => {
    const parsed = JSON.parse(raw) as { markers?: unknown; scenes?: unknown; presets?: unknown }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray(parsed.markers) ||
      (parsed.scenes !== undefined && !Array.isArray(parsed.scenes)) ||
      (parsed.presets !== undefined && !Array.isArray(parsed.presets))
    ) {
      throw new Error('invalid show shape')
    }
    writeFileSync(showPath, JSON.stringify(parsed, null, 2) + '\n')
    scenesCache = null
  },
  controlOutput: (action, value) => {
    if (action === 'mode') return output.setMode(value as OutputMode)
    if (action === 'targets') {
      const targets = Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : []
      const status = output.setTargets(targets)
      writeFileSync(
        outputConfigPath,
        JSON.stringify({ targets: status.targets, port: status.port }, null, 2) + '\n',
      )
      return status
    }
    if (action === 'status') return output.status()
    throw new Error(`unknown output action: ${action}`)
  },
  listRecordings: () => {
    if (!existsSync(recordingsDir)) return []
    return readdirSync(recordingsDir)
      .filter((file) => file.endsWith('.artrec'))
      .map((file) => {
        const stats = statSync(join(recordingsDir, file))
        const metaPath = join(recordingsDir, file.replace(/\.artrec$/, '.json'))
        let durationMs: number | null = null
        if (existsSync(metaPath)) {
          try {
            durationMs = (JSON.parse(readFileSync(metaPath, 'utf8')) as { durationMs?: number }).durationMs ?? null
          } catch {
            // ignore broken sidecar
          }
        }
        return { file, sizeBytes: stats.size, modifiedAt: stats.mtimeMs, durationMs }
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
  },
  listMusic,
  musicPath: musicFile,
  readCompose: () => (existsSync(composePath) ? readFileSync(composePath, 'utf8') : 'null'),
  controlCompose: (action, payload) => {
    if (action === 'analyse') {
      const file = (payload as { file?: string } | undefined)?.file
      if (!file) throw new Error('missing file')
      const path = musicFile(file)
      if (!path) throw new Error(`not a readable WAV in data/music: ${file}`)
      const name = basename(file)
      let analysis = analysisCache.get(name)
      if (!analysis) {
        console.log(`compose: analysing ${name}…`)
        analysis = analyseWav(path)
        analysisCache.set(name, analysis)
      }
      const draft = {
        file: name,
        analysis,
        sections: sectionsFromAnalysis(analysis, () => randomUUID()),
      }
      writeFileSync(composePath, JSON.stringify(draft, null, 2) + '\n')
      return draft
    }
    if (action === 'save') {
      const draft = payload as ComposeDraft
      if (!draft || !Array.isArray(draft.sections)) throw new Error('invalid draft')
      writeFileSync(composePath, JSON.stringify(draft, null, 2) + '\n')
      return { ok: true }
    }
    if (action === 'generate') {
      const draft = payload as ComposeDraft
      if (!draft || !draft.analysis || !Array.isArray(draft.sections)) {
        throw new Error('invalid draft')
      }
      writeFileSync(composePath, JSON.stringify(draft, null, 2) + '\n')
      return compose(draft.analysis, draft.sections, () => randomUUID())
    }
    // The artistic direction. It answers with intentions and names only: the
    // composition itself is still made here, deterministically, from what
    // comes back -- so a direction changes what the show feels like and
    // nothing about how it is built.
    if (action === 'direction') return direction.status()
    if (action === 'directionKey') {
      const key = (payload as { key?: string } | undefined)?.key
      if (typeof key !== 'string') throw new Error('missing key')
      return direction.setKey(key)
    }
    if (action === 'direct') {
      const { draft, brief } = (payload ?? {}) as { draft?: ComposeDraft; brief?: string }
      if (!draft || !draft.analysis || !Array.isArray(draft.sections)) {
        throw new Error('invalid draft')
      }
      const written = brief ?? draft.brief ?? ''
      return direction.propose(draft.analysis, draft.sections, written).then((result) => {
        const directed: ComposeDraft = {
          ...draft,
          brief: written,
          arc: result.arc,
          sections: result.sections,
        }
        writeFileSync(composePath, JSON.stringify(directed, null, 2) + '\n')
        return directed
      })
    }
    if (action === 'clear') {
      if (existsSync(composePath)) writeFileSync(composePath, 'null\n')
      return { ok: true }
    }
    throw new Error(`unknown compose action: ${action}`)
  },
  controlMusic: (action, file) => {
    if (action === 'list') return listMusic()
    if (!file) throw new Error('missing file')
    const path = musicFile(file)
    if (!path) throw new Error(`not a readable WAV in data/music: ${file}`)
    const name = basename(file)
    if (action === 'analyse' || action === 'propose') {
      let analysis = analysisCache.get(name)
      if (!analysis) {
        console.log(`music: analysing ${name}…`)
        analysis = analyseWav(path)
        analysisCache.set(name, analysis)
        console.log(
          `music: ${name} -> ${analysis.sections.length} sections, ${analysis.bpm ?? '?'} BPM, ${analysis.analysedInMs} ms`,
        )
      }
      if (action === 'analyse') return analysis
      // The proposal is handed back, never written: applying it is the
      // operator's decision, and it goes through the one show-writing path.
      return { analysis, proposal: proposeShow(analysis, () => randomUUID()) }
    }
    if (action === 'forget') {
      analysisCache.delete(name)
      return { ok: true }
    }
    throw new Error(`unknown music action: ${action}`)
  },
  controlRecord: (action) => {
    if (action === 'start') recorder.start()
    else if (action === 'stop') recorder.stop()
    else throw new Error(`unknown record action: ${action}`)
    return recorder.status()
  },
  controlReplay: (action, file) => {
    if (action === 'start') {
      if (!file) throw new Error('missing file')
      const safe = basename(file)
      const path = join(recordingsDir, safe)
      if (!existsSync(path)) throw new Error(`recording not found: ${safe}`)
      if (replayer.status().replaying) replayer.stop()
      replayer.start(path, safe)
    } else if (action === 'stop') {
      replayer.stop()
    } else {
      throw new Error(`unknown replay action: ${action}`)
    }
    return replayer.status()
  },
  openBrowser: process.env.LUMENSTAGE_OPEN === '1',
})

// Binary state frame v2: [0x02, universeCount, per universe: universe id,
// active flag, 512 bytes of DMX, then timecode: receiving, hours, minutes,
// seconds, frames, fpsType].
const frame = Buffer.alloc(2 + SHOW_UNIVERSES.length * (2 + 512) + 6)

function encodeFrame(): Buffer {
  frame[0] = 0x02
  frame[1] = SHOW_UNIVERSES.length
  let offset = 2
  for (const universe of SHOW_UNIVERSES) {
    frame[offset++] = universe
    frame[offset++] = listener.isActive(universe) ? 1 : 0
    frame.set(listener.getBuffer(universe), offset)
    offset += 512
  }
  const timecode = listener.timecode
  frame[offset++] = listener.isTimecodeActive() && timecode ? 1 : 0
  frame[offset++] = timecode?.hours ?? 0
  frame[offset++] = timecode?.minutes ?? 0
  frame[offset++] = timecode?.seconds ?? 0
  frame[offset++] = timecode?.frames ?? 0
  frame[offset++] = timecode?.fpsType ?? 1
  return frame
}

function encodeStats(): string {
  const perUniverse: Record<string, { pps: number; from: string | null }> = {}
  for (const universe of SHOW_UNIVERSES) {
    const stats = listener.getStats(universe)
    perUniverse[universe] = { pps: stats.pps, from: stats.from }
  }
  return JSON.stringify({
    type: 'stats',
    version: BUILD_VERSION,
    udp: { port: listener.port, listening: listener.listening, error: listener.lastError },
    perUniverse,
    otherPps: listener.otherPps,
    record: recorder.status(),
    replay: replayer.status(),
    output: output.status(),
  })
}

function broadcast(payload: Buffer | string): void {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 1_000_000) {
      client.send(payload)
    }
  }
}

setInterval(() => {
  if (wss.clients.size > 0) broadcast(encodeFrame())
}, BROADCAST_MS)

setInterval(() => {
  if (wss.clients.size > 0) broadcast(encodeStats())
}, STATS_MS)

wss.on('connection', (client) => {
  client.send(encodeStats())
})

process.on('SIGINT', () => {
  recorder.stop()
  replayer.stop()
  output.stop()
  listener.stop()
  wss.close()
  process.exit(0)
})
