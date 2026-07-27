// PRODIGY STAGE server, Phases 1-4: passive Art-Net listener -> WebSocket
// bridge. Receives ArtDMX + ArtTimeCode on UDP 6454, keeps a 4x512 state,
// broadcasts a consolidated binary frame at ~40 fps plus a JSON stats message
// at 1 Hz, records/replays full runs. Emits NOTHING towards the rig (the
// replayer only feeds the local listener on 127.0.0.1).

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { ArtnetListener } from './listener.js'
import { loadPatch, patchPath } from './patch.js'
import { Recorder } from './recorder.js'
import { Replayer } from './replayer.js'
import { startWebServer, WEB_PORT } from './web.js'

const SHOW_UNIVERSES = [1, 2, 3, 4]
const BROADCAST_MS = 25 // ~40 fps target, Windows timers make it ~32 fps: within the 30-44 spec
const STATS_MS = 1000

const patch = loadPatch()
console.log('PRODIGY STAGE server -- Phase 4')
console.log(`patch: ${patch.fixtures.length} fixtures on show universes ${SHOW_UNIVERSES.join(', ')}`)

const dataDir = join(fileURLToPath(patchPath()), '..')
const showPath = join(dataDir, 'show.json')
const recordingsDir = join(dataDir, 'recordings')

const listener = new ArtnetListener(SHOW_UNIVERSES)
listener.start()

const recorder = new Recorder(recordingsDir)
listener.onRaw = (msg, at) => recorder.write(msg, at)
const replayer = new Replayer('127.0.0.1')

function readShow(): string {
  if (!existsSync(showPath)) return '{"markers":[]}\n'
  return readFileSync(showPath, 'utf8')
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
    const parsed = JSON.parse(raw) as { markers?: unknown }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.markers)) {
      throw new Error('invalid show shape')
    }
    writeFileSync(showPath, JSON.stringify(parsed, null, 2) + '\n')
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
    udp: { port: listener.port, listening: listener.listening, error: listener.lastError },
    perUniverse,
    otherPps: listener.otherPps,
    record: recorder.status(),
    replay: replayer.status(),
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
  listener.stop()
  wss.close()
  process.exit(0)
})
