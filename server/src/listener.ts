// Passive Art-Net listener: binds UDP 6454, parses ArtDMX, keeps one 512-byte
// state buffer per show universe plus reception stats. Emits nothing.

import { createSocket, type Socket } from 'node:dgram'
import { ARTNET_PORT, artnetUniverseToShow, DMX_CHANNELS, parseArtDmx } from './artnet.js'

const ACTIVE_WINDOW_MS = 2000

export interface UniverseStats {
  pps: number
  from: string | null
  lastPacketAt: number
  totalPackets: number
}

export class ArtnetListener {
  readonly universes: number[]
  readonly port = ARTNET_PORT
  listening = false
  lastError: string | null = null
  otherPps = 0

  private socket: Socket | null = null
  private buffers = new Map<number, Uint8Array>()
  private stats = new Map<number, UniverseStats>()
  private counters = new Map<number, number>()
  private otherCounter = 0
  private statsInterval: NodeJS.Timeout | null = null

  constructor(universes: number[]) {
    this.universes = universes
    for (const u of universes) {
      this.buffers.set(u, new Uint8Array(DMX_CHANNELS))
      this.stats.set(u, { pps: 0, from: null, lastPacketAt: 0, totalPackets: 0 })
      this.counters.set(u, 0)
    }
  }

  start(): void {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket

    socket.on('message', (msg, rinfo) => {
      const packet = parseArtDmx(msg)
      if (!packet) return
      const universe = artnetUniverseToShow(packet.artnetUniverse)
      const buffer = this.buffers.get(universe)
      if (!buffer) {
        this.otherCounter++
        return
      }
      buffer.set(packet.data.subarray(0, DMX_CHANNELS))
      const stats = this.stats.get(universe)!
      stats.from = rinfo.address
      stats.lastPacketAt = Date.now()
      stats.totalPackets++
      this.counters.set(universe, this.counters.get(universe)! + 1)
    })

    socket.on('error', (err) => {
      this.listening = false
      this.lastError = err.message
      console.error(`artnet: UDP socket error: ${err.message}`)
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        console.error(
          'artnet: port 6454 is already in use (another Art-Net app on this machine?). ' +
            'The UI will show "not listening".',
        )
      }
      socket.close()
    })

    socket.bind(this.port, () => {
      this.listening = true
      console.log(`artnet: listening on UDP 0.0.0.0:${this.port} (show universes ${this.universes.join(', ')})`)
    })

    this.statsInterval = setInterval(() => {
      for (const u of this.universes) {
        this.stats.get(u)!.pps = this.counters.get(u)!
        this.counters.set(u, 0)
      }
      this.otherPps = this.otherCounter
      this.otherCounter = 0
    }, 1000)
  }

  stop(): void {
    if (this.statsInterval) clearInterval(this.statsInterval)
    this.socket?.close()
    this.listening = false
  }

  getBuffer(universe: number): Uint8Array {
    return this.buffers.get(universe)!
  }

  getStats(universe: number): UniverseStats {
    return this.stats.get(universe)!
  }

  isActive(universe: number): boolean {
    return Date.now() - this.stats.get(universe)!.lastPacketAt < ACTIVE_WINDOW_MS
  }
}
