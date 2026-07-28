// Listening to the music, so the show can be proposed from it.
//
// Reads a WAV, finds where the track changes character, and how fast each of
// those parts runs. That is all this module claims to do: it hears structure
// and tempo. It has no opinion about colour, and no idea what the show is
// about -- turning its findings into scenes happens in showFromAudio.ts, and
// the result is a draft a human edits, never a finished show.
//
// Streaming on purpose: a mastered set is easily a gigabyte, and holding it in
// memory to analyse it would be a gigabyte we do not need. The file is read in
// chunks, downmixed and decimated on the way past, and only the per-frame
// features are kept -- about 5 MB for an hour of music.
//
// Pure TypeScript, no dependencies, same rule the effect engine lives under.

import { closeSync, openSync, readSync, statSync } from 'node:fs'

export type SectionKind = 'intro' | 'build' | 'drop' | 'break' | 'groove'

export interface AudioSection {
  start: number
  end: number
  kind: SectionKind
  /** Beats per minute inside this section, null where there is no steady beat. */
  bpm: number | null
  /** 0-1, relative to the loudest part of this track. */
  bass: number
  air: number
  level: number
  /** Low-band attacks per second: how busy the section is down there. */
  hitsPerSecond: number
  /**
   * When a beat lands, in seconds from the start of the file. A tempo without
   * a phase places nothing: it says how long a bar lasts but not where one
   * begins, and every change the composer writes has to land on one.
   */
  beatPhase: number | null
}

export interface AudioAnalysis {
  file: string
  seconds: number
  sampleRate: number
  channels: number
  bits: number
  bpm: number | null
  sections: AudioSection[]
  /**
   * Loudness down the whole track, 0-1, at a fixed count regardless of length.
   * This is the waveform Compose draws: enough shape to recognise the set by
   * eye, small enough to send as JSON.
   */
  peaks: number[]
  analysedInMs: number
}

export const PEAK_COUNT = 1200

// 1024 samples at ~22 kHz is a 46 ms window, hopping every 12 ms: fine enough
// to place a kick inside a beat, coarse enough to stay cheap.
const FFT_SIZE = 1024
const HOP = 256
const ANALYSIS_RATE = 22050

const BANDS = {
  low: [30, 130],
  mid: [200, 2000],
  high: [5000, 10000],
} as const
type BandName = keyof typeof BANDS

interface WavFormat {
  channels: number
  rate: number
  bits: number
  float: boolean
  dataStart: number
  dataSize: number
}

function readFormat(fd: number, size: number): WavFormat {
  const head = Buffer.alloc(Math.min(size, 64 * 1024))
  readSync(fd, head, 0, head.length, 0)
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file')
  }
  let pos = 12
  let format: Omit<WavFormat, 'dataStart' | 'dataSize'> | null = null
  while (pos + 8 <= head.length) {
    const id = head.toString('ascii', pos, pos + 4)
    const chunkSize = head.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      const tag = head.readUInt16LE(pos + 8)
      format = {
        channels: head.readUInt16LE(pos + 10),
        rate: head.readUInt32LE(pos + 12),
        bits: head.readUInt16LE(pos + 22),
        // 3 = IEEE float, 0xFFFE = extensible (the sub-format sits at +24).
        float: tag === 3 || (tag === 0xfffe && head.readUInt16LE(pos + 32) === 3),
      }
    }
    if (id === 'data') {
      if (!format) throw new Error('WAV data before format')
      // Some writers leave the size at 0 or 0xffffffff for streamed files.
      const declared = chunkSize
      const available = size - (pos + 8)
      return {
        ...format,
        dataStart: pos + 8,
        dataSize: declared > 0 && declared <= available ? declared : available,
      }
    }
    pos += 8 + chunkSize + (chunkSize % 2)
  }
  throw new Error('no data chunk found')
}

function sampleAt(buf: Buffer, offset: number, bits: number, float: boolean): number {
  if (float) return buf.readFloatLE(offset)
  if (bits === 16) return buf.readInt16LE(offset) / 32768
  if (bits === 24) {
    const v = buf.readUInt8(offset) | (buf.readUInt8(offset + 1) << 8) | (buf.readInt8(offset + 2) << 16)
    return v / 8388608
  }
  if (bits === 32) return buf.readInt32LE(offset) / 2147483648
  if (bits === 8) return (buf.readUInt8(offset) - 128) / 128
  throw new Error(`unsupported bit depth: ${bits}`)
}

// Iterative radix-2 FFT, in place.
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const wr = Math.cos(angle)
    const wi = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]
        const ui = im[i + k]
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ur + vr
        im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr
        im[i + k + len / 2] = ui - vi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

interface Features {
  fps: number
  frames: number
  energy: Record<BandName, Float32Array>
  flux: Record<BandName, Float32Array>
  rms: Float32Array
}

/** One pass over the file: downmix, decimate, and keep only the features. */
function extractFeatures(path: string, format: WavFormat): Features {
  const { channels, rate, bits, float, dataStart, dataSize } = format
  const bytesPerSample = bits / 8
  const frameBytes = bytesPerSample * channels
  const decimate = Math.max(1, Math.round(rate / ANALYSIS_RATE))
  const analysisRate = rate / decimate
  const fps = analysisRate / HOP

  const totalFrames = Math.floor(dataSize / frameBytes)
  const estimated = Math.ceil(totalFrames / decimate / HOP) + 2
  const energy = {
    low: new Float32Array(estimated),
    mid: new Float32Array(estimated),
    high: new Float32Array(estimated),
  }
  const flux = {
    low: new Float32Array(estimated),
    mid: new Float32Array(estimated),
    high: new Float32Array(estimated),
  }
  const rms = new Float32Array(estimated)

  const window = new Float64Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))
  }
  const binHz = analysisRate / FFT_SIZE
  const bandRange = {} as Record<BandName, [number, number]>
  for (const name of Object.keys(BANDS) as BandName[]) {
    const [lo, hi] = BANDS[name]
    bandRange[name] = [
      Math.max(1, Math.round(lo / binHz)),
      Math.min(FFT_SIZE / 2 - 1, Math.round(hi / binHz)),
    ]
  }

  // Sliding window of decimated mono samples.
  const ring = new Float64Array(FFT_SIZE)
  let ringFill = 0
  const re = new Float64Array(FFT_SIZE)
  const im = new Float64Array(FFT_SIZE)
  const mag = new Float64Array(FFT_SIZE / 2)
  const previous = new Float64Array(FFT_SIZE / 2)
  let outFrame = 0

  const fd = openSync(path, 'r')
  const CHUNK = 1 << 20
  const buf = Buffer.alloc(CHUNK + frameBytes)
  let filePos = dataStart
  let carry = 0 // bytes of a partial audio frame kept from the previous chunk
  let decimateCounter = 0
  const end = dataStart + dataSize

  try {
    while (filePos < end) {
      const want = Math.min(CHUNK, end - filePos)
      const read = readSync(fd, buf, carry, want, filePos)
      if (read <= 0) break
      filePos += read
      const usable = carry + read
      let offset = 0
      while (offset + frameBytes <= usable) {
        if (decimateCounter === 0) {
          let sum = 0
          for (let c = 0; c < channels; c++) {
            sum += sampleAt(buf, offset + c * bytesPerSample, bits, float)
          }
          const value = sum / channels
          // Shift the ring by one and append. FFT_SIZE is small; a memmove per
          // sample would dominate, so the ring is only compacted per hop.
          ring[ringFill++] = value
          if (ringFill === FFT_SIZE) {
            let sum2 = 0
            for (let i = 0; i < FFT_SIZE; i++) {
              const s = ring[i]
              sum2 += s * s
              re[i] = s * window[i]
              im[i] = 0
            }
            fft(re, im)
            for (let k = 0; k < FFT_SIZE / 2; k++) mag[k] = Math.hypot(re[k], im[k])
            if (outFrame < estimated) {
              rms[outFrame] = Math.sqrt(sum2 / FFT_SIZE)
              for (const name of Object.keys(BANDS) as BandName[]) {
                const [a, b] = bandRange[name]
                let e = 0
                let f = 0
                for (let k = a; k <= b; k++) {
                  e += mag[k]
                  const d = mag[k] - previous[k]
                  if (d > 0) f += d
                }
                const width = b - a + 1
                energy[name][outFrame] = e / width
                flux[name][outFrame] = f / width
              }
              outFrame++
            }
            previous.set(mag)
            // Keep the overlap: drop HOP samples from the front.
            ring.copyWithin(0, HOP)
            ringFill = FFT_SIZE - HOP
          }
        }
        decimateCounter = (decimateCounter + 1) % decimate
        offset += frameBytes
      }
      carry = usable - offset
      if (carry > 0) buf.copy(buf, 0, offset, usable)
    }
  } finally {
    closeSync(fd)
  }

  return { fps, frames: outFrame, energy, flux, rms }
}

/**
 * How loud an attack has to be to count as one, anywhere in this track.
 *
 * Every threshold below is relative to a local average, which is right in
 * music and catastrophic in silence: in a quiet passage the local average is
 * near zero, so noise clears it and the analyser hears a beat that is not
 * there. This is the floor that stops that -- a fraction of the track's own
 * loud attacks, so it scales with the master without caring about it.
 */
function onsetFloor(flux: Float32Array, frames: number): number {
  const sample: number[] = []
  const stride = Math.max(1, Math.floor(frames / 20000))
  for (let f = 0; f < frames; f += stride) sample.push(flux[f])
  sample.sort((a, b) => a - b)
  const p90 = sample[Math.floor(sample.length * 0.9)] ?? 0
  return p90 * 0.35
}

/** Tempo by autocorrelation of the low-band flux, refined to sub-bin. */
function tempoOf(
  flux: Float32Array,
  fps: number,
  from: number,
  to: number,
  floor: number,
): number | null {
  const span = to - from
  if (span < fps * 8) return null // under 8 seconds there is nothing to lock onto

  // No attacks worth the name means no tempo, however periodic the noise is.
  let peak = 0
  for (let f = from; f < to; f++) if (flux[f] > peak) peak = flux[f]
  if (peak < floor) return null
  const minLag = Math.round((fps * 60) / 180)
  const maxLag = Math.round((fps * 60) / 70)
  if (maxLag + 1 >= span) return null
  const ac = new Float64Array(maxLag + 2)
  let best = minLag
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    for (let f = from; f + lag < to; f++) sum += flux[f] * flux[f + lag]
    ac[lag] = sum / (to - from - lag)
    if (ac[lag] > ac[best]) best = lag
  }
  // A whole-bin error is about 1% of the tempo, which is a beat every 100 --
  // far too much over a set. Parabolic interpolation brings it under 0.1%.
  const y0 = ac[best - 1] ?? 0
  const y1 = ac[best]
  const y2 = ac[best + 1] ?? 0
  const denominator = y0 - 2 * y1 + y2
  const delta = denominator === 0 ? 0 : (0.5 * (y0 - y2)) / denominator
  const bpm = (60 * fps) / (best + delta)

  // A flat autocorrelation means no beat, not a slow one: without this an
  // ambient passage confidently reports a tempo nobody can hear.
  let mean = 0
  for (let lag = minLag; lag <= maxLag; lag++) mean += ac[lag]
  mean /= maxLag - minLag + 1
  if (mean <= 0 || y1 < mean * 1.25) return null

  return Number.isFinite(bpm) ? Math.round(bpm * 100) / 100 : null
}

/**
 * Where the beats actually land, given how fast they come.
 *
 * Tempo alone is half an answer: it says a beat every 0.47 s without saying
 * which 0.47 s. This tries every offset within one beat and keeps the one that
 * lands on the most energy -- the phase a person taps when they join in.
 */
function beatPhaseOf(
  flux: Float32Array,
  fps: number,
  from: number,
  to: number,
  bpm: number,
): number | null {
  const period = (fps * 60) / bpm
  if (!Number.isFinite(period) || period < 2 || to - from < period * 4) return null
  const steps = Math.max(8, Math.round(period))
  let bestOffset = 0
  let bestScore = -1
  for (let step = 0; step < steps; step++) {
    const offset = (step / steps) * period
    let score = 0
    for (let beat = 0; ; beat++) {
      const frame = Math.round(from + offset + beat * period)
      if (frame >= to) break
      score += flux[frame]
    }
    if (score > bestScore) {
      bestScore = score
      bestOffset = offset
    }
  }
  return (from + bestOffset) / fps
}

/** Attacks in a band: a peak that clears both the local mean and the floor. */
function countOnsets(
  flux: Float32Array,
  fps: number,
  from: number,
  to: number,
  floor: number,
): number {
  const w = Math.round(fps * 0.4)
  let count = 0
  let lastAt = -1e9
  for (let f = Math.max(from, w); f < to - 1; f++) {
    if (flux[f] < floor) continue
    let sum = 0
    for (let k = f - w; k < f; k++) sum += flux[k]
    const mean = sum / w
    if (
      flux[f] > mean * 1.9 &&
      flux[f] >= flux[f - 1] &&
      flux[f] > flux[f + 1] &&
      f - lastAt > fps * 0.12
    ) {
      count++
      lastAt = f
    }
  }
  return count
}

export function analyseWav(path: string): AudioAnalysis {
  const started = Date.now()
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  let format: WavFormat
  try {
    format = readFormat(fd, size)
  } finally {
    closeSync(fd)
  }

  const { fps, frames, energy, flux, rms } = extractFeatures(path, format)
  const seconds = frames / fps

  // ----- structure ---------------------------------------------------------
  // One feature vector per second, then a novelty curve: how different is the
  // music just after this point from the music just before it. Peaks in that
  // curve are where the track turns.
  const perSecond = Math.max(1, Math.round(fps))
  const buckets = Math.floor(frames / perSecond)
  const feature: number[][] = []
  for (let s = 0; s < buckets; s++) {
    let lo = 0
    let mid = 0
    let hi = 0
    let level = 0
    for (let f = s * perSecond; f < (s + 1) * perSecond; f++) {
      lo += energy.low[f]
      mid += energy.mid[f]
      hi += energy.high[f]
      level += rms[f]
    }
    feature.push([lo / perSecond, mid / perSecond, hi / perSecond, level / perSecond])
  }
  for (let d = 0; d < 4; d++) {
    let max = 0
    for (const v of feature) max = Math.max(max, v[d])
    if (max > 0) for (const v of feature) v[d] /= max
  }

  const half = 8 // compare eight seconds either side
  const novelty = new Float32Array(buckets)
  for (let s = half; s < buckets - half; s++) {
    const before = [0, 0, 0, 0]
    const after = [0, 0, 0, 0]
    for (let k = 1; k <= half; k++) {
      for (let d = 0; d < 4; d++) {
        before[d] += feature[s - k][d]
        after[d] += feature[s + k][d]
      }
    }
    let distance = 0
    for (let d = 0; d < 4; d++) distance += ((after[d] - before[d]) / half) ** 2
    novelty[s] = Math.sqrt(distance)
  }
  let noveltyMax = 0
  for (const n of novelty) noveltyMax = Math.max(noveltyMax, n)

  const bounds = [0]
  for (let s = half; s < buckets - half; s++) {
    if (
      novelty[s] > noveltyMax * 0.32 &&
      novelty[s] >= novelty[s - 1] &&
      novelty[s] > novelty[s + 1] &&
      // Nothing shorter than 12 s: below that it is a fill, not a section.
      s - bounds[bounds.length - 1] >= 12
    ) {
      bounds.push(s)
    }
  }
  if (buckets - bounds[bounds.length - 1] < 12 && bounds.length > 1) bounds.pop()
  bounds.push(buckets)

  // ----- describe each section --------------------------------------------
  const floor = onsetFloor(flux.low, frames)
  const sections: AudioSection[] = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i]
    const b = bounds[i + 1]
    let bass = 0
    let air = 0
    let level = 0
    for (let s = a; s < b; s++) {
      bass += feature[s][0]
      air += feature[s][2]
      level += feature[s][3]
    }
    const span = b - a
    const fromFrame = a * perSecond
    const toFrame = Math.min(frames, b * perSecond)
    const hits = countOnsets(flux.low, fps, fromFrame, toFrame, floor)
    // Tempo is only asked for where something is actually hitting. A pad has
    // periodicity too, and autocorrelation will happily report a tempo for it
    // -- one that no one in the room could clap along to.
    const beaten = hits / span > 0.5
    const bpm = beaten ? tempoOf(flux.low, fps, fromFrame, toFrame, floor) : null
    sections.push({
      start: a,
      end: b,
      kind: 'groove',
      bpm,
      beatPhase: bpm === null ? null : beatPhaseOf(flux.low, fps, fromFrame, toFrame, bpm),
      bass: round2(bass / span),
      air: round2(air / span),
      level: round2(level / span),
      hitsPerSecond: round2(hits / span),
    })
  }

  // Naming is a judgement, and it is stated as one: these are the words a
  // lighting operator would use looking at an energy curve, nothing more.
  for (const [index, section] of sections.entries()) {
    const previous = sections[index - 1]
    const next = sections[index + 1]
    if (section.bass < 0.22 && section.level < 0.55) {
      section.kind = index === 0 ? 'intro' : 'break'
    } else if (section.hitsPerSecond > 1.2 && section.bass > 0.5) {
      section.kind = 'drop'
    } else if (next && next.level > section.level * 1.25 && section.bass < 0.6) {
      section.kind = 'build'
    } else if (previous && previous.kind === 'break' && section.level > previous.level) {
      section.kind = 'build'
    } else {
      section.kind = 'groove'
    }
  }

  // The set's overall tempo, from its busiest half: an hour of music has no
  // single tempo, but one number is still worth showing.
  const loud = [...sections].sort((x, y) => y.level - x.level)
  const overall = loud.find((s) => s.bpm !== null)?.bpm ?? null

  // The waveform, at a fixed width: the loudest frame in each slice, so short
  // hits survive the downsampling instead of averaging away.
  const peaks: number[] = []
  let loudest = 0
  for (let i = 0; i < PEAK_COUNT; i++) {
    const a = Math.floor((i / PEAK_COUNT) * frames)
    const b = Math.max(a + 1, Math.floor(((i + 1) / PEAK_COUNT) * frames))
    let peak = 0
    for (let f = a; f < b && f < frames; f++) if (rms[f] > peak) peak = rms[f]
    peaks.push(peak)
    if (peak > loudest) loudest = peak
  }
  for (let i = 0; i < peaks.length; i++) {
    peaks[i] = loudest > 0 ? Math.round((peaks[i] / loudest) * 1000) / 1000 : 0
  }

  return {
    file: path.split(/[\\/]/).pop() ?? path,
    seconds: Math.round(seconds * 10) / 10,
    sampleRate: format.rate,
    channels: format.channels,
    bits: format.bits,
    bpm: overall,
    sections,
    peaks,
    analysedInMs: Date.now() - started,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
