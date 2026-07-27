// Records the raw Art-Net stream (DMX + timecode) to a gzipped frame file so
// a full show run can be replayed later without the console.
// Frame format inside the gzip: [u32le deltaMs][u16le length][packet bytes].

import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGzip, type Gzip } from 'node:zlib'

export interface RecorderStatus {
  recording: boolean
  file: string | null
  seconds: number
  frames: number
}

export class Recorder {
  private gzip: Gzip | null = null
  private startedAt = 0
  private frames = 0
  private filePath: string | null = null
  private fileName: string | null = null

  constructor(private directory: string) {}

  start(): string {
    if (this.gzip) throw new Error('already recording')
    mkdirSync(this.directory, { recursive: true })
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace('T', '-')
      .slice(0, 15)
    this.fileName = `run-${stamp}.artrec`
    this.filePath = join(this.directory, this.fileName)
    const out = createWriteStream(this.filePath)
    this.gzip = createGzip({ level: 6 })
    this.gzip.pipe(out)
    this.startedAt = Date.now()
    this.frames = 0
    console.log(`recorder: recording to ${this.filePath}`)
    return this.fileName
  }

  write(msg: Buffer, at: number): void {
    if (!this.gzip) return
    const header = Buffer.alloc(6)
    header.writeUInt32LE(Math.max(0, at - this.startedAt), 0)
    header.writeUInt16LE(msg.length, 4)
    this.gzip.write(header)
    this.gzip.write(msg)
    this.frames++
  }

  stop(): void {
    if (!this.gzip) return
    const durationMs = Date.now() - this.startedAt
    this.gzip.end()
    this.gzip = null
    if (this.filePath) {
      writeFileSync(
        this.filePath.replace(/\.artrec$/, '.json'),
        JSON.stringify({ durationMs, frames: this.frames, recordedAt: this.startedAt }, null, 2) + '\n',
      )
    }
    console.log(
      `recorder: stopped after ${Math.round(durationMs / 1000)} s, ${this.frames} packets`,
    )
    this.fileName = null
    this.filePath = null
  }

  status(): RecorderStatus {
    return {
      recording: this.gzip !== null,
      file: this.fileName,
      seconds: this.gzip ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      frames: this.frames,
    }
  }
}
