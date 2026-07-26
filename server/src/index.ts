// PRODIGY STAGE server, Phase 1: passive Art-Net listener -> WebSocket bridge.
// Receives ArtDMX on UDP 6454, keeps a 4x512 state, broadcasts a consolidated
// binary frame at ~40 fps plus a JSON stats message at 1 Hz. Emits NOTHING on
// the Art-Net side.

import { readFileSync } from 'node:fs'
import { WebSocket } from 'ws'
import { ArtnetListener } from './listener.js'
import { loadPatch, patchPath } from './patch.js'
import { startWebServer, WEB_PORT } from './web.js'

const SHOW_UNIVERSES = [1, 2, 3, 4]
const BROADCAST_MS = 25 // ~40 fps target, Windows timers make it ~32 fps: within the 30-44 spec
const STATS_MS = 1000

const patch = loadPatch()
console.log('PRODIGY STAGE server -- Phase 1')
console.log(`patch: ${patch.fixtures.length} fixtures on show universes ${SHOW_UNIVERSES.join(', ')}`)

const listener = new ArtnetListener(SHOW_UNIVERSES)
listener.start()

const { wss } = startWebServer({
  port: WEB_PORT,
  // Re-read on every request so a hand-edited patch.json is picked up on reload.
  patchJson: () => readFileSync(patchPath(), 'utf8'),
  openBrowser: process.env.LUMENSTAGE_OPEN === '1',
})

// Binary state frame: [0x01, universeCount, then per universe: universe id,
// active flag, 512 bytes of DMX].
const frame = Buffer.alloc(2 + SHOW_UNIVERSES.length * (2 + 512))

function encodeFrame(): Buffer {
  frame[0] = 0x01
  frame[1] = SHOW_UNIVERSES.length
  let offset = 2
  for (const universe of SHOW_UNIVERSES) {
    frame[offset++] = universe
    frame[offset++] = listener.isActive(universe) ? 1 : 0
    frame.set(listener.getBuffer(universe), offset)
    offset += 512
  }
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
  listener.stop()
  wss.close()
  process.exit(0)
})
