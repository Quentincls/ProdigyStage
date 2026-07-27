// Replays a .artrec recording by re-emitting its packets to UDP 6454 with the
// original timing. Streaming with backpressure so an hour-long run never sits
// fully in memory.

import { createReadStream, type ReadStream } from 'node:fs'
import { createSocket, type Socket } from 'node:dgram'
import { createGunzip, type Gunzip } from 'node:zlib'
import { ARTNET_PORT } from './artnet.js'

const QUEUE_HIGH = 4000
const QUEUE_LOW = 1000

interface Frame {
  at: number
  data: Buffer
}

export interface ReplayerStatus {
  replaying: boolean
  file: string | null
  seconds: number
}

export class Replayer {
  private socket: Socket | null = null
  private stream: ReadStream | null = null
  private gunzip: Gunzip | null = null
  private pending: Buffer = Buffer.alloc(0)
  private queue: Frame[] = []
  private streamEnded = false
  private startedAt = 0
  private timer: NodeJS.Timeout | null = null
  private fileName: string | null = null
  onEnd: (() => void) | null = null

  constructor(private target = '127.0.0.1') {}

  start(filePath: string, fileName: string): void {
    if (this.timer) throw new Error('already replaying')
    this.fileName = fileName
    this.socket = createSocket('udp4')
    this.stream = createReadStream(filePath)
    this.gunzip = createGunzip()
    this.stream.pipe(this.gunzip)
    this.pending = Buffer.alloc(0)
    this.queue = []
    this.streamEnded = false
    this.startedAt = Date.now()

    this.gunzip.on('data', (chunk: Buffer) => {
      this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
      this.extractFrames()
      if (this.queue.length > QUEUE_HIGH) this.gunzip?.pause()
    })
    this.gunzip.on('end', () => {
      this.streamEnded = true
    })
    this.gunzip.on('error', (error) => {
      console.error(`replayer: read error: ${error.message}`)
      this.stop()
    })

    this.timer = setInterval(() => this.pump(), 10)
    console.log(`replayer: playing ${fileName} -> ${this.target}:${ARTNET_PORT}`)
  }

  private extractFrames(): void {
    let offset = 0
    while (this.pending.length - offset >= 6) {
      const length = this.pending.readUInt16LE(offset + 4)
      if (this.pending.length - offset < 6 + length) break
      this.queue.push({
        at: this.pending.readUInt32LE(offset),
        data: this.pending.subarray(offset + 6, offset + 6 + length),
      })
      offset += 6 + length
    }
    if (offset > 0) this.pending = this.pending.subarray(offset)
  }

  private pump(): void {
    const elapsed = Date.now() - this.startedAt
    while (this.queue.length > 0 && this.queue[0].at <= elapsed) {
      const frame = this.queue.shift()!
      this.socket?.send(frame.data, ARTNET_PORT, this.target)
    }
    if (this.queue.length < QUEUE_LOW && !this.streamEnded) this.gunzip?.resume()
    if (this.streamEnded && this.queue.length === 0) {
      console.log('replayer: end of recording')
      this.stop()
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.stream?.destroy()
    this.gunzip?.destroy()
    this.socket?.close()
    this.stream = null
    this.gunzip = null
    this.socket = null
    this.fileName = null
    this.onEnd?.()
  }

  status(): ReplayerStatus {
    return {
      replaying: this.timer !== null,
      file: this.fileName,
      seconds: this.timer ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
    }
  }
}
