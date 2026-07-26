// WebSocket client for the server's consolidated state. DMX buffers are kept
// in mutable typed arrays read by the canvas render loop (no React state at
// 40 fps); connection status and stats go through a tiny external store so
// React re-renders at 1 Hz only.

import { wsUrl } from './config'

export interface UniverseStat {
  pps: number
  from: string | null
}

export interface FeedStats {
  udp: { port: number; listening: boolean; error: string | null }
  perUniverse: Record<string, UniverseStat>
  otherPps: number
}

const DMX_CHANNELS = 512

class Feed {
  universes = new Map<number, Uint8Array>()
  active = new Map<number, boolean>()
  version = 0 // incremented on every DMX frame; polled by the canvas loop

  connected = false
  stats: FeedStats | null = null

  private listeners = new Set<() => void>()
  private snapshot: { connected: boolean; stats: FeedStats | null } = {
    connected: false,
    stats: null,
  }
  private started = false
  private ws: WebSocket | null = null
  private lastMessageAt = 0

  start(): void {
    if (this.started) return
    this.started = true
    this.connect()

    // Resilience to laptop sleep: the socket can die without a close event.
    // The server talks at least once per second, so a silent connection is a
    // dead one -- force a close to trigger the reconnect path.
    setInterval(() => {
      if (this.connected && Date.now() - this.lastMessageAt > 5000) {
        this.ws?.close()
      }
    }, 2000)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.connected && Date.now() - this.lastMessageAt > 5000) {
        this.ws?.close()
      }
    })
  }

  private connect(): void {
    const ws = new WebSocket(wsUrl())
    this.ws = ws
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      this.connected = true
      this.lastMessageAt = Date.now()
      this.notify()
    }

    ws.onmessage = (event) => {
      this.lastMessageAt = Date.now()
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data)
        if (message.type === 'stats') {
          this.stats = message as FeedStats
          this.notify()
        }
        return
      }
      const view = new Uint8Array(event.data as ArrayBuffer)
      if (view[0] !== 0x01) return
      const count = view[1]
      let offset = 2
      for (let i = 0; i < count; i++) {
        const universe = view[offset++]
        this.active.set(universe, view[offset++] === 1)
        let buffer = this.universes.get(universe)
        if (!buffer) {
          buffer = new Uint8Array(DMX_CHANNELS)
          this.universes.set(universe, buffer)
        }
        buffer.set(view.subarray(offset, offset + DMX_CHANNELS))
        offset += DMX_CHANNELS
      }
      this.version++
    }

    ws.onclose = () => {
      this.connected = false
      this.notify()
      setTimeout(() => this.connect(), 1000)
    }

    ws.onerror = () => ws.close()
  }

  // useSyncExternalStore contract
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.snapshot

  private notify(): void {
    this.snapshot = { connected: this.connected, stats: this.stats }
    for (const listener of this.listeners) listener()
  }
}

export const feed = new Feed()
