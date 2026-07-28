// COMPOSE's state: a track, what was heard in it, what the operator wants each
// part to feel like, and the composition that falls out of those three.
//
// It is deliberately not the show. Nothing here touches show.json until Send to
// Edit is pressed -- Compose proposes, Edit owns the result. Until then the
// draft lives in data/compose.json and the composition exists only to be
// previewed.
//
// A mutable store read by the canvas at 60 fps, like `editor`: React is told
// when the shape changes, and left alone the rest of the time.

import type { SceneSpec } from '../../core/effects'
import type { Intent, LookFamily } from '../../core/vocabulary'
import { editor } from './editor'
import { player } from './music'
import type { Marker } from './show'

export type SectionKind = 'intro' | 'build' | 'drop' | 'break' | 'groove'

export interface AudioSection {
  start: number
  end: number
  kind: SectionKind
  bpm: number | null
  beatPhase: number | null
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
  peaks: number[]
  analysedInMs: number
}

export interface ComposeSection {
  id: string
  name: string
  start: number
  end: number
  kind: SectionKind
  intent: Intent
  variant: number
}

export interface ComposeDraft {
  file: string
  analysis: AudioAnalysis
  sections: ComposeSection[]
}

export interface Composition {
  markers: Marker[]
  scenes: SceneSpec[]
}

async function post<T>(action: string, payload?: unknown): Promise<T> {
  const response = await fetch('/api/compose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload }),
  })
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? 'the request failed')
  return body
}

class ComposeStore {
  draft: ComposeDraft | null = null
  composition: Composition | null = null
  selectedId: string | null = null
  busy: '' | 'analysing' | 'composing' = ''
  error: string | null = null
  private listeners = new Set<() => void>()
  private version = 0
  private saveTimer: number | null = null

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): number => this.version

  private changed(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }

  get selected(): ComposeSection | null {
    return this.draft?.sections.find((section) => section.id === this.selectedId) ?? null
  }

  async load(): Promise<void> {
    try {
      const response = await fetch('/api/compose')
      const draft = (await response.json()) as ComposeDraft | null
      if (draft && draft.analysis) {
        this.draft = draft
        this.selectedId = draft.sections[0]?.id ?? null
        // The draft carries which track it is about, so reopening Compose
        // brings the music back with it rather than leaving a silent timeline.
        if (player.file !== draft.file) player.load(draft.file)
        this.changed()
        await this.generate()
      }
    } catch {
      // No draft yet is the normal first-run state, not an error.
    }
  }

  async analyse(file: string): Promise<void> {
    this.busy = 'analysing'
    this.error = null
    this.changed()
    try {
      if (player.file !== file) player.load(file)
      this.draft = await post<ComposeDraft>('analyse', { file })
      this.selectedId = this.draft.sections[0]?.id ?? null
      this.busy = ''
      this.changed()
      await this.generate()
    } catch (error) {
      this.error = (error as Error).message
      this.busy = ''
      this.changed()
    }
  }

  /**
   * Compose everything from the current intentions. Deterministic, and fast
   * enough to run on every change -- which is what makes changing a palette
   * feel like turning a knob rather than filing a request.
   */
  async generate(): Promise<void> {
    if (!this.draft) return
    this.busy = 'composing'
    this.changed()
    try {
      this.composition = await post<Composition>('generate', this.draft)
      this.error = null
      this.preview()
    } catch (error) {
      this.error = (error as Error).message
    }
    this.busy = ''
    this.changed()
  }

  private queueGenerate(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => void this.generate(), 220)
  }

  /** The previz renders the composition, not the show, while Compose is open. */
  preview(): void {
    if (!this.composition) return
    editor.scenes = this.composition.scenes
    editor.version++
  }

  select(id: string | null): void {
    this.selectedId = id
    this.changed()
  }

  update(id: string, patch: Partial<Omit<ComposeSection, 'intent'>> & { intent?: Partial<Intent> }): void {
    if (!this.draft) return
    this.draft = {
      ...this.draft,
      sections: this.draft.sections.map((section) =>
        section.id === id
          ? { ...section, ...patch, intent: { ...section.intent, ...(patch.intent ?? {}) } }
          : section,
      ),
    }
    this.changed()
    this.queueGenerate()
  }

  toggleFamily(id: string, family: LookFamily): void {
    const section = this.draft?.sections.find((s) => s.id === id)
    if (!section) return
    const families = section.intent.families.includes(family)
      ? section.intent.families.filter((f) => f !== family)
      : [...section.intent.families, family]
    // Never leave a section with nothing to compose from.
    this.update(id, { intent: { families: families.length > 0 ? families : [family] } })
  }

  /** Another take on the same intention. */
  regenerate(id: string): void {
    const section = this.draft?.sections.find((s) => s.id === id)
    if (!section) return
    this.update(id, { variant: section.variant + 1 })
  }

  /** Move the line between two sections. The two neighbours share the change. */
  moveBoundary(index: number, seconds: number): void {
    if (!this.draft || index <= 0 || index >= this.draft.sections.length) return
    const sections = [...this.draft.sections]
    const before = sections[index - 1]
    const after = sections[index]
    const min = before.start + 2
    const max = after.end - 2
    const at = Math.round(Math.max(min, Math.min(max, seconds)) * 10) / 10
    sections[index - 1] = { ...before, end: at }
    sections[index] = { ...after, start: at }
    this.draft = { ...this.draft, sections }
    this.changed()
    this.queueGenerate()
  }

  splitAt(seconds: number): void {
    if (!this.draft) return
    const index = this.draft.sections.findIndex((s) => seconds > s.start + 2 && seconds < s.end - 2)
    if (index < 0) return
    const section = this.draft.sections[index]
    const at = Math.round(seconds * 10) / 10
    const sections = [...this.draft.sections]
    sections.splice(
      index,
      1,
      { ...section, end: at },
      {
        ...section,
        id: crypto.randomUUID(),
        name: `${section.name} b`,
        start: at,
        intent: { ...section.intent, families: [...section.intent.families] },
      },
    )
    this.draft = { ...this.draft, sections }
    this.selectedId = sections[index + 1].id
    this.changed()
    this.queueGenerate()
  }

  mergeWithNext(id: string): void {
    if (!this.draft) return
    const index = this.draft.sections.findIndex((s) => s.id === id)
    if (index < 0 || index >= this.draft.sections.length - 1) return
    const sections = [...this.draft.sections]
    const merged = { ...sections[index], end: sections[index + 1].end }
    sections.splice(index, 2, merged)
    this.draft = { ...this.draft, sections }
    this.selectedId = merged.id
    this.changed()
    this.queueGenerate()
  }

  clear(): void {
    this.draft = null
    this.composition = null
    this.selectedId = null
    this.changed()
    void post('clear')
  }
}

export const composeStore = new ComposeStore()
