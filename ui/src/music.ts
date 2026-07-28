// The music, playing alongside the show.
//
// The timeline already has one time authority -- effectiveShowTime -- and this
// deliberately does not become a second one. The audio element never drives
// anything: it watches the show's time and follows it, correcting itself when
// it drifts. Which means scrubbing the playhead scrubs the track, pausing
// pauses it, and jumping to a section jumps the music with it, without a line
// of synchronisation logic anywhere else in the application.

import { apiUrl } from './config'
import { effectiveShowTime, transportState } from './editor'
import { feed } from './feed'

const VOLUME_KEY = 'lumenstage.musicVolume'
const FILE_KEY = 'lumenstage.musicFile'
// Below this the ear hears nothing; above it, a correction is less jarring
// than the drift. Seeking an audio element is not free, so it is not done on
// every frame.
const DRIFT_S = 0.22

export interface MusicFile {
  file: string
  sizeBytes: number
  modifiedAt: number
  analysed: boolean
}

export interface AudioSection {
  start: number
  end: number
  kind: 'intro' | 'build' | 'drop' | 'break' | 'groove'
  bpm: number | null
  bass: number
  air: number
  level: number
  hitsPerSecond: number
}

export interface AudioAnalysis {
  file: string
  seconds: number
  sampleRate: number
  channels: number
  bits: number
  bpm: number | null
  sections: AudioSection[]
  analysedInMs: number
}

export async function listMusic(): Promise<{ dir: string; files: MusicFile[] }> {
  const response = await fetch(apiUrl('/api/music'))
  if (!response.ok) throw new Error('could not list the music folder')
  return (await response.json()) as { dir: string; files: MusicFile[] }
}

async function post<T>(action: string, file?: string): Promise<T> {
  const response = await fetch(apiUrl('/api/music'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, file }),
  })
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? 'the analysis failed')
  return body
}

export function analyseMusic(file: string): Promise<AudioAnalysis> {
  return post<AudioAnalysis>('analyse', file)
}

export function proposeFromMusic(
  file: string,
): Promise<{ analysis: AudioAnalysis; proposal: { markers: unknown[]; scenes: unknown[] } }> {
  return post('propose', file)
}

class Player {
  private el: HTMLAudioElement | null = null
  private raf = 0
  file: string | null = null
  duration = 0
  ready = false
  error: string | null = null
  private listeners = new Set<() => void>()

  volume = readVolume()
  muted = false

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }

  getSnapshot = (): string =>
    `${this.file}|${this.ready}|${this.duration}|${this.volume}|${this.muted}|${this.error}`

  load(file: string | null): void {
    this.stop()
    this.file = file
    this.ready = false
    this.error = null
    this.duration = 0
    try {
      if (file) localStorage.setItem(FILE_KEY, file)
      else localStorage.removeItem(FILE_KEY)
    } catch {
      // Storage refused: the choice simply will not be remembered.
    }
    if (!file) {
      this.changed()
      return
    }

    const el = new Audio(apiUrl(`/music/${encodeURIComponent(file)}`))
    el.preload = 'auto'
    el.volume = this.muted ? 0 : this.volume
    // Attached, though it draws nothing: a detached element plays perfectly
    // well and is invisible to every debugging tool, which is a bad trade when
    // the question is "is the audio actually where the playhead is".
    el.hidden = true
    document.body.append(el)
    el.addEventListener('loadedmetadata', () => {
      this.duration = el.duration
      this.ready = true
      this.changed()
    })
    el.addEventListener('error', () => {
      this.error = 'this file could not be played'
      this.changed()
    })
    this.el = el
    this.changed()
    this.follow()
  }

  setVolume(volume: number): void {
    this.volume = volume
    if (this.el) this.el.volume = this.muted ? 0 : volume
    try {
      localStorage.setItem(VOLUME_KEY, String(volume))
    } catch {
      // ignored
    }
    this.changed()
  }

  toggleMute(): void {
    this.muted = !this.muted
    if (this.el) this.el.volume = this.muted ? 0 : this.volume
    this.changed()
  }

  stop(): void {
    cancelAnimationFrame(this.raf)
    this.raf = 0
    if (this.el) {
      this.el.pause()
      this.el.src = ''
      this.el.remove()
      this.el = null
    }
  }

  // The whole of the synchronisation: read the show's time, put the audio
  // there if it has wandered, and let it run.
  private follow = (): void => {
    this.raf = requestAnimationFrame(this.follow)
    const el = this.el
    if (!el || !this.ready) return

    const live = feed.timecode.receiving ? feed.timecode.total : null
    const showTime = effectiveShowTime(live)
    const state = transportState()

    if (showTime === null || showTime < 0 || showTime > el.duration) {
      if (!el.paused) el.pause()
      return
    }

    // Parked means parked: the track sits on the frame the playhead is on.
    if (state === 'paused') {
      if (!el.paused) el.pause()
      if (Math.abs(el.currentTime - showTime) > 0.05) el.currentTime = showTime
      return
    }

    if (Math.abs(el.currentTime - showTime) > DRIFT_S) el.currentTime = showTime
    if (el.paused) {
      // Autoplay can be refused until the page has been interacted with; the
      // panel's own buttons are that interaction, so this normally succeeds.
      void el.play().catch(() => {
        this.error = 'the browser blocked playback — press play again'
        this.changed()
      })
    }
  }
}

export const player = new Player()

export function rememberedFile(): string | null {
  try {
    return localStorage.getItem(FILE_KEY)
  } catch {
    return null
  }
}

function readVolume(): number {
  try {
    // The raw string is checked first on purpose: Number(null) is 0, and 0 is a
    // legitimate volume, so converting first would read "never set" as "muted".
    const raw = localStorage.getItem(VOLUME_KEY)
    if (raw !== null && raw !== '') {
      const stored = Number(raw)
      if (Number.isFinite(stored) && stored >= 0 && stored <= 1) return stored
    }
  } catch {
    // Storage unavailable: the default is fine.
  }
  return 0.8
}
