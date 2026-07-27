import type { EffectType, ParamValue, SceneSpec, TrackTarget } from '../../core/effects'
import { apiUrl } from './config'

export interface Marker {
  id: string
  name: string
  start: number // seconds
  end: number
}

export interface PresetSpec {
  id: string
  name: string
  target: TrackTarget
  effect: EffectType
  params: Record<string, ParamValue>
  fadeIn: number
  fadeOut: number
}

export interface ShowFile {
  markers: Marker[]
  scenes: SceneSpec[]
  presets: PresetSpec[]
}

export interface RecordingInfo {
  file: string
  sizeBytes: number
  modifiedAt: number
  durationMs: number | null
}

export async function fetchShow(): Promise<ShowFile> {
  const response = await fetch(apiUrl('/api/show'))
  if (!response.ok) throw new Error(`show fetch failed (${response.status})`)
  const data = (await response.json()) as Partial<ShowFile>
  return { markers: data.markers ?? [], scenes: data.scenes ?? [], presets: data.presets ?? [] }
}

export async function saveShow(show: ShowFile): Promise<void> {
  const response = await fetch(apiUrl('/api/show'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(show),
  })
  if (!response.ok) throw new Error(`show save failed (${response.status})`)
}

export async function fetchRecordings(): Promise<RecordingInfo[]> {
  const response = await fetch(apiUrl('/api/recordings'))
  if (!response.ok) return []
  return (await response.json()) as RecordingInfo[]
}

export async function controlRecord(action: 'start' | 'stop'): Promise<void> {
  await fetch(apiUrl('/api/record'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
}

export async function controlReplay(action: 'start' | 'stop', file?: string): Promise<void> {
  await fetch(apiUrl('/api/replay'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, file }),
  })
}

// Phase 6: the only call that can make this software transmit. Throws with
// the server's reason so the UI can show it instead of failing silently.
export async function controlOutput(action: 'mode' | 'targets', value: unknown): Promise<void> {
  const response = await fetch(apiUrl('/api/output'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, value }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? 'output request failed')
  }
}
