// Self-test for the music analysis (Phase 7), in the shape the rest of the
// project uses: build a signal whose answer is known, then check the analyser
// finds it. No audio file is needed and nothing is left behind.
//
// The two assertions that matter are the ones that were wrong first time
// round: a passage with no beat must report no tempo, and near-silence must
// report no attacks. Both were reported confidently before the analyser
// learned about absolute levels, and both would have placed scenes on music
// that is not there.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyseWav } from './audio.js'
import { proposeShow } from './showFromAudio.js'

const SR = 44100
const BPM = 128
const BEAT = 60 / BPM
const DURATION = 210

// The structure the analyser is expected to rediscover.
const INTRO_END = 32
const BUILD_END = 64
const DROP_END = 140
const BREAK_END = 170

function synthesise(): Buffer {
  const total = SR * DURATION
  const mono = new Float32Array(total)

  const kick = (at: number): void => {
    for (let i = 0; i < 0.28 * SR; i++) {
      const t = i / SR
      const frequency = 120 * Math.exp(-t * 30) + 45
      const sample = Math.sin(2 * Math.PI * frequency * t) * Math.exp(-t * 22) * 0.9
      const index = ((at * SR) | 0) + i
      if (index < total) mono[index] += sample
    }
  }
  const hat = (at: number, gain: number): void => {
    for (let i = 0; i < 0.05 * SR; i++) {
      const index = ((at * SR) | 0) + i
      // Deterministic noise: a test that changes its mind between runs is not
      // a test.
      const noise = Math.sin(i * 12.9898) * 43758.5453
      if (index < total) mono[index] += (noise - Math.floor(noise) - 0.5) * 2 * Math.exp(-(i / SR) * 90) * gain
    }
  }
  const bass = (at: number, duration: number, frequency: number): void => {
    for (let i = 0; i < duration * SR; i++) {
      const t = i / SR
      const index = ((at * SR) | 0) + i
      if (index < total) {
        mono[index] += Math.sin(2 * Math.PI * frequency * t) * Math.min(1, t * 40) * Math.exp(-t * 2) * 0.4
      }
    }
  }
  const pad = (at: number, duration: number, gain: number): void => {
    for (let i = 0; i < duration * SR; i++) {
      const t = i / SR
      const index = ((at * SR) | 0) + i
      if (index < total) {
        mono[index] += (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277 * t)) * gain * 0.5
      }
    }
  }

  pad(0, INTRO_END, 0.16)
  for (let b = 0; b * BEAT < INTRO_END; b++) if (b % 4 === 2) hat(b * BEAT, 0.1)
  for (let b = Math.ceil(INTRO_END / BEAT); b * BEAT < BUILD_END; b++) {
    kick(b * BEAT)
    hat(b * BEAT + BEAT / 2, 0.14)
  }
  for (let b = Math.ceil(BUILD_END / BEAT); b * BEAT < DROP_END; b++) {
    kick(b * BEAT)
    hat(b * BEAT + BEAT / 2, 0.22)
    bass(b * BEAT, BEAT * 0.9, b % 2 === 0 ? 55 : 73)
  }
  pad(DROP_END, BREAK_END - DROP_END, 0.2)
  for (let b = Math.ceil(BREAK_END / BEAT); b * BEAT < DURATION; b++) {
    kick(b * BEAT)
    hat(b * BEAT + BEAT / 2, 0.24)
    bass(b * BEAT, BEAT * 0.9, b % 2 === 0 ? 55 : 82)
  }

  const out = Buffer.alloc(44 + total * 4)
  out.write('RIFF', 0)
  out.writeUInt32LE(36 + total * 4, 4)
  out.write('WAVE', 8)
  out.write('fmt ', 12)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(2, 22)
  out.writeUInt32LE(SR, 24)
  out.writeUInt32LE(SR * 4, 28)
  out.writeUInt16LE(4, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(total * 4, 40)
  for (let i = 0; i < total; i++) {
    const value = (Math.max(-1, Math.min(1, mono[i])) * 32767) | 0
    out.writeInt16LE(value, 44 + i * 4)
    out.writeInt16LE(value, 44 + i * 4 + 2)
  }
  return out
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`audio selftest FAILED: ${message}`)
    process.exit(1)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'lumenstage-audio-'))
const path = join(dir, 'selftest.wav')
try {
  writeFileSync(path, synthesise())
  const analysis = analyseWav(path)

  assert(Math.abs(analysis.seconds - DURATION) < 1, `duration ${analysis.seconds} != ${DURATION}`)
  assert(analysis.sections.length === 5, `expected 5 sections, got ${analysis.sections.length}`)

  const expected = [0, INTRO_END, BUILD_END, DROP_END, BREAK_END]
  for (const [index, section] of analysis.sections.entries()) {
    assert(
      Math.abs(section.start - expected[index]) <= 3,
      `section ${index} starts at ${section.start}s, expected ${expected[index]}s`,
    )
  }

  const kinds = analysis.sections.map((s) => s.kind)
  assert(
    kinds.join(',') === 'intro,build,drop,break,drop',
    `kinds read as ${kinds.join(',')}`,
  )

  // Tempo where there is a beat, and none where there is not: a pad is
  // periodic too, and an analyser that reports its "tempo" will place scenes
  // in time with music nobody can hear.
  assert(analysis.sections[0].bpm === null, 'the intro has no beat but reported a tempo')
  assert(analysis.sections[3].bpm === null, 'the breakdown has no beat but reported a tempo')
  assert(analysis.sections[0].hitsPerSecond === 0, 'attacks counted in the near-silent intro')
  assert(analysis.sections[3].hitsPerSecond === 0, 'attacks counted in the breakdown')
  for (const index of [1, 2, 4]) {
    const bpm = analysis.sections[index].bpm
    assert(bpm !== null && Math.abs(bpm - BPM) < 1, `section ${index} reported ${bpm} BPM, expected ${BPM}`)
  }

  // The proposal: one section and one scene each, in order, never overlapping,
  // and every effect running on its own part's tempo.
  let counter = 0
  const proposal = proposeShow(analysis, () => `id-${counter++}`)
  assert(proposal.markers.length === 5 && proposal.scenes.length === 5, 'proposal is not five and five')
  for (let i = 1; i < proposal.scenes.length; i++) {
    assert(
      proposal.scenes[i].start >= proposal.scenes[i - 1].end,
      `scene ${i} overlaps the one before it`,
    )
  }
  const drop = proposal.scenes[2].tracks[0]
  assert(drop.effect === 'chase', `the drop got "${drop.effect}" instead of a chase`)
  assert(
    Math.abs(Number(drop.params.speed) - BPM / 60) < 0.05,
    `the drop runs at ${String(drop.params.speed)} rather than one pass per beat`,
  )
  const ids = new Set(proposal.scenes.flatMap((s) => [s.id, ...s.tracks.map((t) => t.id)]))
  assert(ids.size === 10, 'the proposal reused an id')

  console.log(
    `audio selftest: OK (${analysis.sections.length} sections found at the right seconds, ` +
      `${analysis.bpm} BPM, ${analysis.analysedInMs} ms for ${DURATION}s)`,
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
