// Counters, so a performance question can be answered instead of argued about.
//
// Every field here is a plain mutable number written on the hot path and read
// once a second. Nothing in this file may allocate, subscribe, or cause a
// render: an instrument that changes what it measures is worse than no
// instrument, and a profiler that re-renders React sixty times a second would
// be measuring itself.
//
// Two kinds of number live here, and the difference matters when reading a
// report from another machine:
//
//   * hardware-independent -- draw calls, triangles, React renders, fixture
//     reads, bytes on the socket, real Three.js lights. Same on every machine,
//     so they can be compared between a laptop and a container.
//   * hardware-dependent -- fps, frame time, milliseconds of anything. Only
//     meaningful next to another measurement taken on the same machine.

export interface PerfCounters {
  /** Renders per component since boot, by component name. */
  renders: Record<string, number>
  /** Every animation loop in the application, not just the viewport's: frames
   *  drawn and milliseconds spent, by name. Three canvases can be redrawing at
   *  sixty hertz on the same GPU while only one of them is being looked at. */
  loops: Record<string, { frames: number; ms: number }>
  /** requestAnimationFrame ticks of the previz loop. */
  frames: number
  /** Our own JS in the loop, summed, before the GPU is asked for anything. */
  cpuMs: number
  /** Time inside composer.render(), summed. Includes the driver's own work. */
  drawMs: number
  /** readFixture() calls: the DMX-to-normalised-state conversions. */
  fixtureReads: number
  /** DMX frames taken off the socket. */
  dmxFrames: number
  /** Bytes taken off the socket. */
  wsBytes: number
  /** Time spent turning those bytes into universe buffers, summed. */
  parseMs: number

  // --- last-value gauges, overwritten rather than accumulated ---------------
  /** Draw calls for one full composed frame, every pass included. */
  drawCalls: number
  triangles: number
  /** Live GPU-side objects, as Three.js counts them. */
  geometries: number
  textures: number
  programs: number
  /** Objects in the scene graph, and how many of them are drawable. */
  objects: number
  meshes: number
  instancedMeshes: number
  /** Instances actually drawn, which is the number a plot of 70 fixtures is
   *  usually assumed to mean and usually is not. */
  instances: number
  materials: number
  /** Real Three.js light sources, and how many of them cast shadows. The whole
   *  point of asking: a WYSIWYG beam does not need either. */
  lights: number
  shadowCasters: number
  /** Device pixels the renderer is sized to (canvas CSS size x pixel ratio). */
  devicePixels: number
  pixelRatio: number
  /** Heap in bytes where the browser will say. Chrome only. */
  heapBytes: number
  /** Full teardown-and-rebuild of every fixture mesh, geometry and texture.
   *  Should be one at boot and one per patch edit. Anything more means the
   *  scene is being recreated instead of updated. */
  patchRebuilds: number
}

export const perf: PerfCounters = {
  renders: Object.create(null),
  loops: Object.create(null),
  frames: 0,
  cpuMs: 0,
  drawMs: 0,
  fixtureReads: 0,
  dmxFrames: 0,
  wsBytes: 0,
  parseMs: 0,
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  programs: 0,
  objects: 0,
  meshes: 0,
  instancedMeshes: 0,
  instances: 0,
  materials: 0,
  lights: 0,
  shadowCasters: 0,
  devicePixels: 0,
  pixelRatio: 1,
  heapBytes: 0,
  patchRebuilds: 0,
}

/** Called from a component body. One property increment -- cheap enough to
 *  leave in a render path we are trying to measure. */
export function countRender(component: string): void {
  perf.renders[component] = (perf.renders[component] ?? 0) + 1
}

/** Wraps one tick of an animation loop. Returns what the callback returned, so
 *  it can be dropped around an existing draw with no other change. */
export function countLoop<T>(name: string, draw: () => T): T {
  const entry = perf.loops[name] ?? (perf.loops[name] = { frames: 0, ms: 0 })
  const startedAt = performance.now()
  try {
    return draw()
  } finally {
    entry.frames++
    entry.ms += performance.now() - startedAt
  }
}

export interface PerfSample {
  seconds: number
  fps: number
  /** Milliseconds per frame, split into the two halves that matter. */
  cpuMsPerFrame: number
  drawMsPerFrame: number
  rendersPerSecond: Record<string, number>
  totalRendersPerSecond: number
  /** Per loop: how many times a second it drew, and what each draw cost. */
  loops: Record<string, { fps: number; msPerFrame: number }>
  fixtureReadsPerSecond: number
  dmxFramesPerSecond: number
  kilobytesPerSecond: number
  parseUsPerFrame: number
  heapGrowthKbPerSecond: number
  /** Everything in perf that is a gauge rather than a rate. */
  gauges: Pick<
    PerfCounters,
    | 'drawCalls'
    | 'triangles'
    | 'geometries'
    | 'textures'
    | 'programs'
    | 'objects'
    | 'meshes'
    | 'instancedMeshes'
    | 'instances'
    | 'materials'
    | 'lights'
    | 'shadowCasters'
    | 'devicePixels'
    | 'pixelRatio'
    | 'heapBytes'
    | 'patchRebuilds'
  >
}

/**
 * Differences between two readings. Rates come from the gap between the two,
 * so a sampler that is late reports a correct rate rather than a low one.
 */
export class PerfSampler {
  private at = 0
  private frames = 0
  private cpuMs = 0
  private drawMs = 0
  private fixtureReads = 0
  private dmxFrames = 0
  private wsBytes = 0
  private parseMs = 0
  private heapBytes = 0
  private renders: Record<string, number> = Object.create(null)
  private loops: Record<string, { frames: number; ms: number }> = Object.create(null)

  constructor() {
    this.mark()
  }

  private mark(): void {
    this.at = performance.now()
    this.frames = perf.frames
    this.cpuMs = perf.cpuMs
    this.drawMs = perf.drawMs
    this.fixtureReads = perf.fixtureReads
    this.dmxFrames = perf.dmxFrames
    this.wsBytes = perf.wsBytes
    this.parseMs = perf.parseMs
    this.heapBytes = perf.heapBytes
    this.renders = { ...perf.renders }
    this.loops = Object.create(null)
    for (const [name, entry] of Object.entries(perf.loops)) this.loops[name] = { ...entry }
  }

  sample(): PerfSample {
    const now = performance.now()
    const seconds = Math.max(0.001, (now - this.at) / 1000)
    const frames = perf.frames - this.frames
    const dmxFrames = perf.dmxFrames - this.dmxFrames
    const rendersPerSecond: Record<string, number> = Object.create(null)
    let totalRenders = 0
    for (const [name, count] of Object.entries(perf.renders)) {
      const delta = count - (this.renders[name] ?? 0)
      rendersPerSecond[name] = round(delta / seconds)
      totalRenders += delta
    }
    const loops: Record<string, { fps: number; msPerFrame: number }> = Object.create(null)
    for (const [name, entry] of Object.entries(perf.loops)) {
      const was = this.loops[name] ?? { frames: 0, ms: 0 }
      const drawn = entry.frames - was.frames
      loops[name] = {
        fps: round(drawn / seconds),
        msPerFrame: round((entry.ms - was.ms) / Math.max(1, drawn), 3),
      }
    }
    const sample: PerfSample = {
      seconds: round(seconds),
      loops,
      fps: round(frames / seconds),
      cpuMsPerFrame: round((perf.cpuMs - this.cpuMs) / Math.max(1, frames), 3),
      drawMsPerFrame: round((perf.drawMs - this.drawMs) / Math.max(1, frames), 3),
      rendersPerSecond,
      totalRendersPerSecond: round(totalRenders / seconds),
      fixtureReadsPerSecond: round((perf.fixtureReads - this.fixtureReads) / seconds),
      dmxFramesPerSecond: round(dmxFrames / seconds),
      kilobytesPerSecond: round((perf.wsBytes - this.wsBytes) / seconds / 1024),
      parseUsPerFrame: round(((perf.parseMs - this.parseMs) * 1000) / Math.max(1, dmxFrames)),
      heapGrowthKbPerSecond: round((perf.heapBytes - this.heapBytes) / 1024 / seconds),
      gauges: {
        drawCalls: perf.drawCalls,
        triangles: perf.triangles,
        geometries: perf.geometries,
        textures: perf.textures,
        programs: perf.programs,
        objects: perf.objects,
        meshes: perf.meshes,
        instancedMeshes: perf.instancedMeshes,
        instances: perf.instances,
        materials: perf.materials,
        lights: perf.lights,
        shadowCasters: perf.shadowCasters,
        devicePixels: perf.devicePixels,
        pixelRatio: perf.pixelRatio,
        heapBytes: perf.heapBytes,
        patchRebuilds: perf.patchRebuilds,
      },
    }
    this.mark()
    return sample
  }
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

// Reachable from the console and from a headless browser, which is how the
// isolation tests below are driven without a human watching a number.
declare global {
  interface Window {
    __perf?: PerfCounters
    __perfSample?: () => PerfSample
  }
}

if (typeof window !== 'undefined') {
  window.__perf = perf
  const sampler = new PerfSampler()
  window.__perfSample = () => sampler.sample()
}
