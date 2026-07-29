// 3D previz of the rig, vanilla Three.js. The 512 Tambora pixels are one
// InstancedMesh whose instance colors are written from the feed's mutable DMX
// buffers every time a new frame arrives; everything else is static geometry.
// Bloom via UnrealBloomPass gives the emissive glow on a dark scene.
// Fixture meshes can be rebuilt at runtime (applyPatch) for the placement mode.

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { activeScene, renderScenePixel } from '../../../core/effects'
import {
  blankState,
  litColour,
  readFixture,
  type FixtureProfile,
  type FixtureState,
} from '../../../core/fixtures'
import { editor, effectiveShowTime } from '../editor'
import { feed } from '../feed'
import type { Fixture, Patch } from '../patch'

// Room dimensions from the brief: ~40 x 15 m, 10 m high. Stage/arch at -X.
const ROOM = { length: 40, width: 15, height: 10 }

// Unlit battens must still read as physical objects: a rig that disappears
// whenever the console goes dark looks broken, not dark.
const BAR_BASE_COLOR = new THREE.Color('#242932')
const BAR_SELECTED_COLOR = new THREE.Color('#2563ff')

// Views are directions, not positions: the distance is computed from the
// actual rig bounding box and the viewport aspect, so the installation is
// always framed whatever the patch or the window size.
export const VIEWS: Record<number, { name: string; dir: [number, number, number] }> = {
  1: { name: 'Room', dir: [0.72, 0.5, 1] },
  2: { name: 'Front', dir: [0, 0.16, 1] },
  3: { name: 'Top', dir: [0, 1, 0.02] },
}

const DEFAULT_VIEW = 1
const FRAME_MARGIN = 1.18
const BEAM_LENGTH = 7

interface PixelSlot {
  universe: number
  colorChannel: number // 0-based index of R in the DMX buffer (pixel zone)
  // 0-based channels of the fixture-wide RGB when the personality has one
  // (the real console drives this, not the pixel zone), else null.
  globalRgb: [number, number, number] | null
  // Fixture-wide channels of the Standard block (Tambora chart), all 0-based
  // absolute, null when the personality does not declare them.
  white: number | null
  masterDimmer: number | null
  masterDimmerFine: number | null
  strobe: number | null
  dimmerChannel: number // legacy dimmer x pixel personalities
  group: string
  wallPos: number // normalized 0-1 along the pixel's wall
  // Same, but for the fixture's centre. When the console drives a
  // fixture-wide colour the rig cannot do better than one colour per batten,
  // so our scenes must be shown at that resolution too.
  fixtureWallPos: number
  fixturePixelIndex: number
  fixtureIndex: number
}

// Motorized tilt: per fixture, the bar and its pixels are re-posed when the
// tilt channels move (the Tambora Batten physically tilts around its length).
interface TiltSlot {
  fixtureIndex: number
  universe: number
  tilt: number // 0-based absolute coarse channel
  tiltFine: number | null
  /** Radians last applied. NaN until the first pose, so it always runs once. */
  lastAngle: number
}

/** Where a fixture sits before it is aimed: position and rotation from the
 *  patch, plus where each of its pixels sits along it. */
interface Pose {
  base: THREE.Matrix4
  pixelOffsets: THREE.Matrix4[]
}

const AIM_KEY = 'lumenstage.beamAim'
/** Degrees, positive towards the middle of the room. Zero is straight down --
 *  a batten resting level, which is what a rig does when nothing is telling it
 *  otherwise, and what anyone looking at the previz expects to see. */
export const DEFAULT_AIM = 0
export const MAX_AIM = 60

export function readAim(): number {
  try {
    const stored = Number(localStorage.getItem(AIM_KEY))
    if (Number.isFinite(stored) && Math.abs(stored) <= MAX_AIM) return stored
  } catch {
    // Storage unavailable: the default is fine.
  }
  return DEFAULT_AIM
}

export class PrevizScene {
  onPick: ((fixtureId: string | null) => void) | null = null

  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private composer: EffectComposer
  private raycaster = new THREE.Raycaster()

  private fixtureGroup = new THREE.Group()
  private bars: THREE.InstancedMesh | null = null
  private pixels: THREE.InstancedMesh | null = null
  private glows: THREE.InstancedMesh | null = null
  // Camera-facing halo per fixture: the light you see *in the air*, which a
  // flat emissive plane alone never suggests.
  private halos: THREE.InstancedMesh | null = null
  private beams: THREE.InstancedMesh | null = null
  private fixtures: Fixture[] = []
  private pixelSlots: PixelSlot[] = []
  private tiltSlots: TiltSlot[] = []
  private poses: Pose[] = []
  // One profile and one reusable state per fixture: the DMX arithmetic lives
  // in core/fixtures.ts and this is where its answers are kept for the frame.
  // Read once per fixture rather than once per pixel -- sixteen pixels of a
  // batten were recomputing the same fixture-wide colour sixteen times.
  private profiles: FixtureProfile[] = []
  private states: FixtureState[] = []
  private litColours = new Float32Array(0)
  private tiltRange = 0 // radians of full travel
  // Where the battens point when no console is saying. Local radians, negated
  // from the degrees the operator sets because a positive local rotation sends
  // a hanging fixture away from the room, not into it.
  private aim = (-readAim() * Math.PI) / 180
  private selected = new Set<string>()

  private lastVersion = -1
  private lastEditorVersion = -1
  private lastTiltVersion = -1
  // Bounding sphere of the rig, used to frame every view.
  private rigCenter = new THREE.Vector3(0, 6, 0)
  private rigRadius = 12
  private currentView = DEFAULT_VIEW
  // Set as soon as the operator orbits, so a resize never yanks their camera.
  private userMoved = false
  private glowSums = new Float32Array(0)
  private raf = 0
  private disposed = false
  private pointerDown: { x: number; y: number } | null = null
  private tween: {
    fromPosition: THREE.Vector3
    fromTarget: THREE.Vector3
    toPosition: THREE.Vector3
    toTarget: THREE.Vector3
    startedAt: number
  } | null = null

  constructor(canvas: HTMLCanvasElement, patch: Patch) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    // Not flat black: pure black made the room a hole in the screen, with no
    // sense of depth behind the rig. A barely-lifted centre falling back to
    // black at the edges reads as air in a dark venue, and still leaves the
    // corners genuinely off on an OLED panel.
    this.scene.background = makeBackdropTexture()

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 300)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.maxDistance = 120
    this.controls.addEventListener('start', () => {
      this.userMoved = true
    })

    this.buildRoom()
    this.scene.add(this.fixtureGroup)
    this.applyPatch(patch)
    this.applyView(DEFAULT_VIEW, false)

    // Filmic tone mapping keeps saturated LEDs from clipping to flat white,
    // and a wider bloom sells the light rather than the emitter.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.15

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    // Restrained: the haze below carries the light now, so the bloom only has
    // to soften the emitters instead of blowing them out.
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.55, 0.2))
    this.composer.addPass(new OutputPass())

    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointerup', this.onPointerUp)

    this.loop()
  }

  // ----- picking ----------------------------------------------------------

  private onPointerDown = (event: PointerEvent): void => {
    this.pointerDown = { x: event.clientX, y: event.clientY }
  }

  private onPointerUp = (event: PointerEvent): void => {
    const down = this.pointerDown
    this.pointerDown = null
    if (!down || !this.onPick || !this.bars) return
    // A click that moved is an orbit, not a pick.
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return

    const rect = (event.target as HTMLCanvasElement).getBoundingClientRect()
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(pointer, this.camera)
    const hit = this.raycaster.intersectObject(this.bars, false)[0]
    this.onPick(
      hit?.instanceId !== undefined ? (this.fixtures[hit.instanceId]?.id ?? null) : null,
    )
  }

  setSelection(ids: string[]): void {
    this.selected = new Set(ids)
    this.applySelectionTint()
  }

  private applySelectionTint(): void {
    if (!this.bars) return
    this.fixtures.forEach((fixture, index) => {
      this.bars!.setColorAt(index, this.selected.has(fixture.id) ? BAR_SELECTED_COLOR : BAR_BASE_COLOR)
    })
    this.bars.instanceColor!.needsUpdate = true
  }

  // ----- static scenery ---------------------------------------------------

  private buildRoom(): void {
    const line = new THREE.LineBasicMaterial({ color: '#1c2028' })
    const panel = new THREE.MeshBasicMaterial({ color: '#0a0c0f' })

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.length, ROOM.width), panel)
    floor.rotation.x = -Math.PI / 2
    this.scene.add(floor)

    const grid = new THREE.GridHelper(ROOM.length, ROOM.length / 2, 0x161a20, 0x101318)
    grid.scale.z = ROOM.width / ROOM.length
    grid.position.y = 0.01
    this.scene.add(grid)

    const shell = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(ROOM.length, ROOM.height, ROOM.width)),
      line,
    )
    shell.position.y = ROOM.height / 2
    this.scene.add(shell)

    // Symbolic raked tribune in the middle of the room, rising towards +X.
    const tribuneMaterial = new THREE.MeshBasicMaterial({ color: '#101318' })
    const steps = 4
    for (let i = 0; i < steps; i++) {
      const height = 0.9 * (i + 1)
      const length = 4.5
      const step = new THREE.Mesh(new THREE.BoxGeometry(length, height, 9), tribuneMaterial)
      step.position.set(-7 + length / 2 + i * length, height / 2, 0)
      this.scene.add(step)
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(step.geometry), line)
      edges.position.copy(step.position)
      this.scene.add(edges)
    }

    // Stage-end arch as an orientation cue (blinders/beams live there, out of
    // the MVP scope).
    const arch = new THREE.Mesh(
      new THREE.TorusGeometry(6, 0.12, 8, 40, Math.PI),
      new THREE.MeshBasicMaterial({ color: '#212630' }),
    )
    arch.position.set(-16, 0, 0)
    arch.rotation.y = Math.PI / 2
    this.scene.add(arch)
  }

  // ----- fixtures (rebuildable) ------------------------------------------

  applyPatch(patch: Patch): void {
    for (const child of [...this.fixtureGroup.children]) {
      const mesh = child as THREE.Mesh
      mesh.geometry.dispose()
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) {
        const mapped = material as THREE.MeshBasicMaterial
        mapped.map?.dispose()
        material.dispose()
      }
      this.fixtureGroup.remove(child)
    }
    this.pixelSlots = []
    this.tiltSlots = []
    this.lastTiltVersion = -1
    // Battens only, for now. The rest of the plot is in the patch and on the
    // wire, but a Perseo is not a bar of sixteen pixels and drawing it as one
    // would be worse than not drawing it: the viewport's job is to be true.
    // Their own geometry comes next; until then the room looks exactly as it
    // did, which is the point of adding them in this order.
    this.fixtures = patch.fixtures.filter(
      (fixture) => patch.fixtureTypes[fixture.type]?.kind === 'batten',
    )
    this.measureRig()

    const type = patch.fixtureTypes[this.fixtures[0]?.type ?? '']
    const pixelsPerFixture = type?.pixels ?? 16
    this.tiltRange =
      (((type?.tiltRangeDeg ?? 0) * Math.PI) / 180) * (type?.tiltInvert ? -1 : 1)

    const bars = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.02, 0.12, 0.06),
      new THREE.MeshBasicMaterial({ color: '#ffffff' }),
      this.fixtures.length,
    )
    const pixels = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.058, 0.09),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
      this.fixtures.length * pixelsPerFixture,
    )
    const glowTexture = makeGlowTexture()
    const glows = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(3.4, 5.2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: glowTexture,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      this.fixtures.length,
    )
    const halos = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(2.6, 2.6),
      new THREE.MeshBasicMaterial({
        map: glowTexture,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0.34,
      }),
      this.fixtures.length,
    )
    halos.frustumCulled = false

    // Light in the air: a soft sheet leaning from each batten towards the
    // room, brightest at the fixture and fading with distance. Cheap stand-in
    // for haze, and the thing that makes a wash read as a wash.
    const beams = new THREE.InstancedMesh(
      // Wider than a batten so neighbouring sheets overlap into one wash
      // instead of reading as separate streaks.
      new THREE.PlaneGeometry(2.4, BEAM_LENGTH).translate(0, -BEAM_LENGTH / 2, 0),
      new THREE.MeshBasicMaterial({
        map: makeBeamTexture(),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        opacity: 0.5,
      }),
      this.fixtures.length,
    )
    beams.frustumCulled = false

    const dummy = new THREE.Object3D()
    const pixelMatrix = new THREE.Matrix4()
    const offset = new THREE.Matrix4()
    const black = new THREE.Color(0x000000)
    const degreesToRadians = Math.PI / 180

    // Normalized position of each pixel along its wall (same convention as
    // the fake-show and the effect engine): fixtures ordered by numeric id.
    const wallOrder = new Map<string, number>()
    const wallSizes = new Map<string, number>()
    for (const group of patch.groups) {
      const wall = this.fixtures
        .filter((f) => f.group === group)
        .sort((a, b) => parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10))
      wall.forEach((fixture, index) => wallOrder.set(fixture.id, index))
      wallSizes.set(group, wall.length * pixelsPerFixture)
    }

    this.poses = []
    this.profiles = this.fixtures.map((fixture) => patch.fixtureTypes[fixture.type] as FixtureProfile)
    this.states = this.fixtures.map(() => blankState())
    this.litColours = new Float32Array(this.fixtures.length * 3)
    this.fixtures.forEach((fixture: Fixture, fixtureIndex: number) => {
      dummy.position.set(...fixture.position)
      dummy.rotation.set(
        fixture.rotation[0] * degreesToRadians,
        fixture.rotation[1] * degreesToRadians,
        fixture.rotation[2] * degreesToRadians,
      )
      dummy.updateMatrix()
      bars.setMatrixAt(fixtureIndex, dummy.matrix)

      const base = fixture.address - 1
      const map = type?.standardMap
      const globalRgb: [number, number, number] | null =
        map && map.red !== undefined && map.green !== undefined && map.blue !== undefined
          ? [base + map.red - 1, base + map.green - 1, base + map.blue - 1]
          : null
      const abs = (key: string): number | null =>
        map && map[key] !== undefined ? base + map[key] - 1 : null
      const white = abs('white')
      const masterDimmer = globalRgb ? abs('dimmer') : null
      const masterDimmerFine = globalRgb ? abs('dimmerFine') : null
      const strobe = globalRgb ? abs('strobe') : null
      const dimmerChannel = base + (map?.dimmer ?? 1) - 1
      const pixelOffsets: THREE.Matrix4[] = []

      for (let p = 0; p < pixelsPerFixture; p++) {
        const localX = -0.5 + (p + 0.5) / pixelsPerFixture
        offset.makeTranslation(localX, 0, 0.036)
        pixelOffsets.push(offset.clone())
        pixelMatrix.multiplyMatrices(dummy.matrix, offset)
        const instance = fixtureIndex * pixelsPerFixture + p
        pixels.setMatrixAt(instance, pixelMatrix)
        pixels.setColorAt(instance, black)
        const wallIndex = wallOrder.get(fixture.id) ?? 0
        const wallPixels = wallSizes.get(fixture.group) ?? pixelsPerFixture
        const slot = {
          universe: fixture.universe,
          colorChannel: base + (type?.pixelStart ?? 14) - 1 + p * 3,
          globalRgb,
          white,
          masterDimmer,
          masterDimmerFine,
          strobe,
          dimmerChannel,
          group: fixture.group,
          wallPos: (wallIndex * pixelsPerFixture + p + 0.5) / wallPixels,
          fixtureWallPos: (wallIndex + 0.5) / (wallPixels / pixelsPerFixture),
          fixturePixelIndex: wallIndex * pixelsPerFixture + Math.floor(pixelsPerFixture / 2),
          fixtureIndex,
        }
        this.pixelSlots.push(slot)
      }

      this.poses.push({ base: dummy.matrix.clone(), pixelOffsets })

      const tiltChannel = this.tiltRange > 0 ? abs('tilt') : null
      if (tiltChannel !== null) {
        this.tiltSlots.push({
          fixtureIndex,
          universe: fixture.universe,
          tilt: tiltChannel,
          tiltFine: abs('tiltFine'),
          lastAngle: Number.NaN,
        })
      }

      // Glow pool sits on the floor, pushed towards the room center.
      const inward = fixture.group === 'wall-left' ? 2.1 : -2.1
      dummy.position.set(fixture.position[0], 0.02, fixture.position[2] + inward)
      dummy.rotation.set(0, 0, 0)
      dummy.updateMatrix()
      glows.setMatrixAt(fixtureIndex, dummy.matrix)
      glows.setColorAt(fixtureIndex, black)
      halos.setColorAt(fixtureIndex, black)
      beams.setColorAt(fixtureIndex, black)
    })

    this.bars = bars
    this.pixels = pixels
    this.glows = glows
    this.halos = halos
    this.beams = beams
    // Bar, pixels and haze are aimed in one place, from one angle -- see
    // poseFixture. Nothing else in here is allowed to decide where a fixture
    // points.
    for (let index = 0; index < this.fixtures.length; index++) this.poseFixture(index, this.aim)
    this.fixtureGroup.add(bars, pixels, glows, halos, beams)
    this.applySelectionTint()
    this.lastVersion = -1 // force a recolor on the next frame
  }

  // ----- per-frame --------------------------------------------------------

  // Scene priority (brief Phase 5): pixels covered by a track of the active
  // scene render the shared engine's output; every other pixel keeps showing
  // the console feed. Preview/scrub time overrides the live timecode.
  private updateColors(): void {
    if (!this.pixels || !this.glows) return
    const tc = feed.timecode
    const liveTime = tc.receiving ? tc.total : null
    const showTime = effectiveShowTime(liveTime)
    const scene = showTime !== null ? activeScene(editor.scenes, showTime) : null

    // An active scene animates continuously (its time advances even without
    // new DMX frames); otherwise redraw only on new frames or editor changes.
    if (!scene && feed.version === this.lastVersion && editor.version === this.lastEditorVersion) {
      return
    }
    this.lastVersion = feed.version
    this.lastEditorVersion = editor.version

    const color = new THREE.Color()
    const fixtureCount = this.fixtures.length
    if (this.glowSums.length !== fixtureCount * 3) this.glowSums = new Float32Array(fixtureCount * 3)
    this.glowSums.fill(0)
    const sums = this.glowSums

    // Every fixture, once, through the one place that knows what a DMX channel
    // means. `live` is the difference between a rig that is dark and a rig
    // nobody is talking to -- see core/fixtures.ts.
    const lit: [number, number, number] = [0, 0, 0]
    for (let index = 0; index < fixtureCount; index++) {
      const fixture = this.fixtures[index]
      const state = readFixture(
        this.profiles[index],
        feed.universes.get(fixture.universe) ?? null,
        fixture.address - 1,
        feed.active.get(fixture.universe) === true,
        this.states[index],
      )
      litColour(state, lit)
      this.litColours[index * 3] = lit[0]
      this.litColours[index * 3 + 1] = lit[1]
      this.litColours[index * 3 + 2] = lit[2]
    }

    this.pixelSlots.forEach((slot, instance) => {
      let r = 0
      let g = 0
      let b = 0
      // Honest resolution: with a fixture-wide personality the real bar shows
      // one colour, so a scene gradient must not look finer on screen than it
      // ever can in the room.
      const perFixture = slot.globalRgb !== null
      const sceneColor = scene
        ? renderScenePixel(
            scene,
            slot.group,
            perFixture ? slot.fixtureWallPos : slot.wallPos,
            perFixture ? slot.fixturePixelIndex : instance,
            showTime!,
          )
        : null
      if (sceneColor) {
        r = sceneColor[0] / 255
        g = sceneColor[1] / 255
        b = sceneColor[2] / 255
      } else if (slot.globalRgb) {
        // What the real fixture displays under the console's programming
        // (validated on the venue recording): the fixture-wide RGBW of the
        // Standard block, through its master dimmer and shutter. The parked
        // pixel zone is not what the eye sees in the room. Already read above.
        const o = slot.fixtureIndex * 3
        r = this.litColours[o]
        g = this.litColours[o + 1]
        b = this.litColours[o + 2]
      } else {
        // Personalities with no fixture-wide colour: the pixel zone is the
        // colour, through a plain 8-bit dimmer. Nothing in this plot uses it.
        const buffer = feed.universes.get(slot.universe)
        if (buffer && feed.active.get(slot.universe) === true) {
          const dimmer = buffer[slot.dimmerChannel] / 255
          r = (buffer[slot.colorChannel] / 255) * dimmer
          g = (buffer[slot.colorChannel + 1] / 255) * dimmer
          b = (buffer[slot.colorChannel + 2] / 255) * dimmer
        }
      }
      color.setRGB(r, g, b, THREE.SRGBColorSpace)
      this.pixels!.setColorAt(instance, color)
      const o = slot.fixtureIndex * 3
      sums[o] += r
      sums[o + 1] += g
      sums[o + 2] += b
    })
    this.pixels.instanceColor!.needsUpdate = true

    const perFixture = this.pixelSlots.length / Math.max(1, fixtureCount)
    for (let f = 0; f < fixtureCount; f++) {
      const o = f * 3
      color.setRGB(
        (sums[o] / perFixture) * 0.55,
        (sums[o + 1] / perFixture) * 0.55,
        (sums[o + 2] / perFixture) * 0.55,
        THREE.SRGBColorSpace,
      )
      this.glows!.setColorAt(f, color)
      this.halos?.setColorAt(f, color)
      this.beams?.setColorAt(f, color)
    }
    this.glows.instanceColor!.needsUpdate = true
    if (this.halos?.instanceColor) this.halos.instanceColor.needsUpdate = true
    if (this.beams?.instanceColor) this.beams.instanceColor.needsUpdate = true
  }

  // Halos are billboards: rebuilt each frame so they always face the camera
  // and sit at the fixture, scaled with how hard it is running.
  private updateHalos(): void {
    const halos = this.halos
    if (!halos) return
    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const scale = new THREE.Vector3()
    const sums = this.glowSums
    this.fixtures.forEach((fixture, index) => {
      const o = index * 3
      const level = sums.length > o ? (sums[o] + sums[o + 1] + sums[o + 2]) / 3 : 0
      const perPixel = this.pixelSlots.length / Math.max(1, this.fixtures.length)
      const brightness = Math.min(1, level / Math.max(1, perPixel))
      const size = 0.35 + brightness * 1.15
      position.fromArray(fixture.position)
      scale.setScalar(size)
      matrix.compose(position, this.camera.quaternion, scale)
      halos.setMatrixAt(index, matrix)
    })
    halos.instanceMatrix.needsUpdate = true
  }

  /**
   * Point one fixture, everything at once: the bar, the pixels riding on it,
   * and the sheet of haze coming off it. One angle, one place -- the haze used
   * to carry a fixed lean of its own on top of the tilt, which meant the light
   * in the air was always aimed some thirty degrees away from the thing
   * emitting it.
   */
  private poseFixture(fixtureIndex: number, angle: number): void {
    const pose = this.poses[fixtureIndex]
    if (!pose || !this.bars || !this.pixels) return
    const posed = new THREE.Matrix4().multiplyMatrices(
      pose.base,
      new THREE.Matrix4().makeRotationX(angle),
    )
    this.bars.setMatrixAt(fixtureIndex, posed)
    const pixelMatrix = new THREE.Matrix4()
    pose.pixelOffsets.forEach((offset, p) => {
      pixelMatrix.multiplyMatrices(posed, offset)
      this.pixels!.setMatrixAt(fixtureIndex * pose.pixelOffsets.length + p, pixelMatrix)
    })
    // The haze hangs from the same matrix, so it can only ever point where the
    // fixture points.
    if (this.beams) this.beams.setMatrixAt(fixtureIndex, posed)
  }

  /** Where the battens rest when no console is driving them. Degrees, positive
   *  towards the middle of the room; zero is straight down. */
  setAim(degrees: number): void {
    const clamped = Math.max(-MAX_AIM, Math.min(MAX_AIM, degrees))
    this.aim = (-clamped * Math.PI) / 180
    try {
      localStorage.setItem(AIM_KEY, String(clamped))
    } catch {
      // Storage refused: the choice simply will not be remembered.
    }
    // Fixtures with a tilt channel are left to updateTilt, which decides
    // between the console and this and runs on the very next frame -- posing
    // them here as well would flash the new aim across a rig the console is
    // driving. Fixtures without one have no other opinion to wait for.
    const motorised = new Set(this.tiltSlots.map((slot) => slot.fixtureIndex))
    for (let index = 0; index < this.fixtures.length; index++) {
      if (!motorised.has(index)) this.poseFixture(index, this.aim)
    }
    for (const slot of this.tiltSlots) slot.lastAngle = Number.NaN
    this.lastTiltVersion = -1
    this.markPosesDirty()
  }

  private markPosesDirty(): void {
    if (this.bars) this.bars.instanceMatrix.needsUpdate = true
    if (this.pixels) this.pixels.instanceMatrix.needsUpdate = true
    if (this.beams) this.beams.instanceMatrix.needsUpdate = true
  }

  // Re-pose bars and their pixels when the motorized tilt moves. A console
  // driving the universe is the truth: 0-65535 spans the full mechanical
  // travel, mid-course = level, and it replaces the resting aim rather than
  // adding to it.
  private updateTilt(): void {
    if (!this.bars || !this.pixels || this.tiltSlots.length === 0) return
    if (feed.version === this.lastTiltVersion) return
    this.lastTiltVersion = feed.version

    let dirty = false
    for (const slot of this.tiltSlots) {
      const fixture = this.fixtures[slot.fixtureIndex]
      // A universe nobody is sending is not a universe saying zero. Zero is
      // one end of the mechanical travel, so reading a silent console as data
      // aimed every batten a hundred and ten degrees away from level -- which
      // is why the light in the previz used to come out sideways, on a rig
      // that was simply switched off. core/fixtures.ts answers `null` for it.
      const state = readFixture(
        this.profiles[slot.fixtureIndex],
        feed.universes.get(fixture.universe) ?? null,
        fixture.address - 1,
        feed.active.get(fixture.universe) === true,
        this.states[slot.fixtureIndex],
      )
      const angle = state.tilt ?? this.aim
      if (angle === slot.lastAngle) continue
      slot.lastAngle = angle
      dirty = true
      this.poseFixture(slot.fixtureIndex, angle)
    }
    if (dirty) this.markPosesDirty()
  }

  // ----- framing ----------------------------------------------------------

  // The rig, not the room, is the subject: every view frames the battens.
  private measureRig(): void {
    const box = new THREE.Box3()
    const point = new THREE.Vector3()
    for (const fixture of this.fixtures) box.expandByPoint(point.fromArray(fixture.position))
    if (this.fixtures.length === 0) {
      box.set(new THREE.Vector3(-8, 5, -6), new THREE.Vector3(8, 7, 6))
    }
    box.expandByScalar(0.8) // batten length and its glow
    box.getCenter(this.rigCenter)
    const sphere = new THREE.Sphere()
    box.getBoundingSphere(sphere)
    this.rigRadius = Math.max(2, sphere.radius)
  }

  // Distance at which the rig's bounding sphere fits the *narrower* of the
  // two field of views, so a wide window and a tall one both frame it.
  private frameDistance(): number {
    const vFov = (this.camera.fov * Math.PI) / 180
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.2, this.camera.aspect))
    return (this.rigRadius * FRAME_MARGIN) / Math.sin(Math.min(vFov, hFov) / 2)
  }

  private applyView(view: number, animate: boolean): void {
    const preset = VIEWS[view]
    if (!preset) return
    this.currentView = view
    this.userMoved = false
    const target = this.rigCenter.clone()
    const position = target
      .clone()
      .addScaledVector(new THREE.Vector3(...preset.dir).normalize(), this.frameDistance())
    if (!animate) {
      this.camera.position.copy(position)
      this.controls.target.copy(target)
      this.controls.update()
      return
    }
    this.tween = {
      fromPosition: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPosition: position,
      toTarget: target,
      startedAt: performance.now(),
    }
  }

  setView(view: number): void {
    this.applyView(view, true)
  }

  private updateTween(): void {
    if (!this.tween) return
    // Wall-clock based so the move is framerate-independent.
    const t = Math.min(1, (performance.now() - this.tween.startedAt) / 600)
    const e = easeInOut(t)
    this.camera.position.lerpVectors(this.tween.fromPosition, this.tween.toPosition, e)
    this.controls.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, e)
    if (t >= 1) this.tween = null
  }

  resize(width: number, height: number): void {
    if (width === 0 || height === 0) return
    this.renderer.setSize(width, height, false)
    this.composer.setSize(width, height)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    // Keep the rig framed as the window changes -- unless the operator has
    // taken the camera themselves, in which case we never move it.
    if (!this.userMoved && !this.tween) this.applyView(this.currentView, false)
  }

  private loop = (): void => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.loop)
    this.updateTween()
    this.controls.update()
    this.updateColors()
    this.updateTilt()
    this.updateHalos()
    this.composer.render()
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    const canvas = this.renderer.domElement
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointerup', this.onPointerUp)
    this.controls.dispose()
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      if (mesh.material) {
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          material.dispose()
        }
      }
    })
    this.composer.dispose()
    this.renderer.dispose()
  }
}

// The room's backdrop: a near-black wash, lifted just enough at the centre to
// give the volume somewhere to sit, black again by the corners. Values this low
// band badly as a flat gradient, so the ramp is drawn once, large, and left to
// the GPU's linear filtering to smooth.
function makeBackdropTexture(): THREE.Texture {
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, size, size)
  // Centred a little above the middle: that is where the rig hangs, and where
  // the eye expects the room to open up.
  const gradient = ctx.createRadialGradient(size / 2, size * 0.42, 0, size / 2, size * 0.42, size * 0.72)
  gradient.addColorStop(0, '#1b1f27')
  gradient.addColorStop(0.55, '#0d0f13')
  gradient.addColorStop(1, '#000000')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function makeGlowTexture(): THREE.Texture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(255,255,255,0.9)')
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.28)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
}

// Vertical falloff for the haze sheet: bright where it leaves the fixture,
// gone by the time it reaches the floor, and soft on the sides so the sheet
// never shows an edge.
function makeBeamTexture(): THREE.Texture {
  const w = 32
  const h = 128
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(w, h)
  for (let y = 0; y < h; y++) {
    const along = 1 - y / h
    const fall = Math.pow(along, 2.2)
    for (let x = 0; x < w; x++) {
      const across = Math.abs((x + 0.5) / w - 0.5) * 2
      const sides = Math.pow(1 - across, 1.6)
      const a = Math.max(0, Math.min(1, fall * sides))
      const o = (y * w + x) * 4
      image.data[o] = 255
      image.data[o + 1] = 255
      image.data[o + 2] = 255
      image.data[o + 3] = a * 255
    }
  }
  ctx.putImageData(image, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
