// Everything in the room that is not a batten, drawn as the thing it is.
//
// The battens have their own path in PrevizScene and it is not touched here:
// it works, it was validated against a recording of the real console, and the
// rule for this whole pass was not to break it.
//
// What this file exists for is the other five families. They used to be one
// grey box each -- true about where they are, silent about what they do. A
// 240 W warm-white soft panel and a beam moving head are not the same object
// with a different colour:
//
//   wash   a panel: wide, soft, warm, washing a field of the room
//   flare  a blinder: wide, hard, pointed at the audience, blinding
//   beam   a moving head: a column you can see in the air, aimed somewhere
//   fog    a hazer: no light at all, a volume
//
// Which one a fixture gets comes from `beamShape()` in /core, which reads the
// profile's optics -- so the picture is a function of the datasheet, and
// correcting a datasheet corrects the picture. A fixture whose beam angle is
// not documented is drawn as a body with no beam at all, because a guessed cone
// is a previz lying about the room.
//
// Performance, since it was just paid for once: five InstancedMeshes total, one
// shared cone geometry, one shared gradient texture, no real lights, no
// shadows, nothing allocated per frame, and every instance of a dark fixture
// scaled to zero so it costs no fill at all. A rig nobody is driving is as
// cheap as an empty scene.

import * as THREE from 'three'
import {
  beamAngleDeg,
  beamShape,
  blankState,
  kelvinToRgb,
  kindOf,
  litColour,
  physicalCapabilities,
  readFixture,
  type BeamShape,
  type FixtureProfile,
  type FixtureState,
} from '../../../core/fixtures'
import type { FixtureIntent } from '../../../core/behaviors'
import type { Fixture, Patch } from '../patch'

/** Roughly what each family is, in metres, so the plot reads as a plot. */
const BODY_SIZE: Record<string, [number, number, number]> = {
  blinder: [0.55, 0.28, 0.3],
  panel: [0.62, 0.62, 0.12],
  movinghead: [0.36, 0.5, 0.36],
  fog: [0.6, 0.4, 0.35],
  unknown: [0.3, 0.3, 0.3],
}

/** How far the light is drawn as travelling, in metres, per shape. A wash dies
 *  quickly, a beam crosses the room. */
const THROW: Record<BeamShape, number> = { bar: 0, wash: 4.5, flare: 6, beam: 16, fog: 0, none: 0 }

/** The glowing face of the fixture itself, in metres. A panel's is most of the
 *  fixture; a beam's is a lens. */
const FACE_SIZE: Record<BeamShape, number> = { bar: 0, wash: 1.5, flare: 1.3, beam: 0.5, fog: 0, none: 0 }

const UNREAD_COLOR = '#242932'
const SELECTED_COLOR = new THREE.Color('#2563ff')
const HOVER_COLOR = new THREE.Color('#1c3a7a')

/** One fixture's drawing state, resolved once when the patch is applied. */
interface Other {
  fixture: Fixture
  profile: FixtureProfile
  shape: BeamShape
  /** Where it points when nothing is driving it. Unit vector in world space. */
  restAim: THREE.Vector3
  /** Metres the beam is drawn as travelling. */
  throwLength: number
}

export class OtherFixtures {
  /** Every non-batten fixture, in patch order. Picking indexes into this. */
  list: Fixture[] = []
  bodies: THREE.InstancedMesh | null = null

  private others: Other[] = []
  private states: FixtureState[] = []
  private cones: THREE.InstancedMesh | null = null
  private faces: THREE.InstancedMesh | null = null
  private fog: THREE.InstancedMesh | null = null

  // Scratch. This runs every frame for seventy fixtures and must not allocate.
  private dummy = new THREE.Object3D()
  private colour = new THREE.Color()
  private lit: [number, number, number] = [0, 0, 0]
  private white: [number, number, number] = [0, 0, 0]
  private direction = new THREE.Vector3()
  private quaternion = new THREE.Quaternion()
  private readonly coneAxis = new THREE.Vector3(0, -1, 0)

  private group: THREE.Group
  private selected = new Set<string>()
  private hovered = new Set<string>()
  /** Bumped whenever anything about the drawn state changed. */
  private lastSignature = ''

  constructor(group: THREE.Group) {
    this.group = group
  }

  /**
   * Build the meshes for a patch. Called only when the patch changes -- never
   * per frame, and never per fixture.
   */
  build(patch: Patch, textures: { glow: THREE.Texture; beam: THREE.Texture }): void {
    this.dispose()
    this.list = patch.fixtures.filter((fixture) => {
      const profile = patch.fixtureTypes[fixture.type]
      return profile !== undefined && kindOf(profile) !== 'batten'
    })
    if (this.list.length === 0) return

    this.others = this.list.map((fixture) => {
      const profile = patch.fixtureTypes[fixture.type] as FixtureProfile
      const shape = beamShape(profile)
      return {
        fixture,
        profile,
        shape,
        restAim: restAim(fixture, shape),
        throwLength: THROW[shape],
      }
    })
    this.states = this.others.map(() => blankState())

    const count = this.others.length
    const dummy = this.dummy

    // ----- the bodies: where the machines physically are ---------------------
    const bodies = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: '#ffffff' }),
      count,
    )
    bodies.frustumCulled = false
    const unread = new THREE.Color(UNREAD_COLOR)
    this.others.forEach((other, index) => {
      const size = BODY_SIZE[kindOf(other.profile)] ?? BODY_SIZE.unknown
      dummy.position.fromArray(other.fixture.position)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(size[0], size[1], size[2])
      dummy.updateMatrix()
      bodies.setMatrixAt(index, dummy.matrix)
      bodies.setColorAt(index, unread)
    })
    dummy.scale.set(1, 1, 1)

    // ----- the light in the air ---------------------------------------------
    // One unit cone -- apex at the origin, one metre long down -Y, unit radius
    // at the base -- scaled per instance into whatever that fixture's optics
    // say. Open-ended so you can be inside a beam without it disappearing.
    const cone = new THREE.ConeGeometry(1, 1, 20, 1, true)
    cone.translate(0, -0.5, 0)
    const cones = new THREE.InstancedMesh(
      cone,
      new THREE.MeshBasicMaterial({
        map: textures.beam,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        opacity: 0.42,
      }),
      count,
    )
    cones.frustumCulled = false

    // The emitter itself, facing the camera. For a blinder pointed at the house
    // this is most of what you see, so it is not an afterthought.
    const faces = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: textures.glow,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0.8,
      }),
      count,
    )
    faces.frustumCulled = false

    // Haze: a soft volume sitting on the floor, and nothing else. No
    // volumetrics -- the cost of those is exactly what was just paid off.
    const fog = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: textures.glow,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0.3,
      }),
      count,
    )
    fog.frustumCulled = false

    // Everything starts dark, which for an instance means scaled to nothing:
    // a degenerate triangle costs no fill, so a rig nobody is driving is as
    // cheap as an empty scene.
    const black = new THREE.Color(0, 0, 0)
    dummy.scale.set(0, 0, 0)
    dummy.updateMatrix()
    for (let index = 0; index < count; index++) {
      cones.setMatrixAt(index, dummy.matrix)
      cones.setColorAt(index, black)
      faces.setMatrixAt(index, dummy.matrix)
      faces.setColorAt(index, black)
      fog.setMatrixAt(index, dummy.matrix)
      fog.setColorAt(index, black)
    }
    dummy.scale.set(1, 1, 1)

    this.bodies = bodies
    this.cones = cones
    this.faces = faces
    this.fog = fog
    this.group.add(bodies, cones, faces, fog)
    this.applyTint()
  }

  setSelection(ids: Set<string>, hovered: Set<string>): void {
    this.selected = ids
    this.hovered = hovered
    this.applyTint()
  }

  private applyTint(): void {
    const bodies = this.bodies
    if (!bodies) return
    const unread = new THREE.Color(UNREAD_COLOR)
    this.list.forEach((fixture, index) => {
      bodies.setColorAt(
        index,
        this.selected.has(fixture.id) ? SELECTED_COLOR : this.hovered.has(fixture.id) ? HOVER_COLOR : unread,
      )
    })
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true
  }

  /**
   * One frame.
   *
   * `intentFor` answers what Stage wants of a fixture, or null when it has no
   * opinion and the console is the truth. Everything below reads through
   * core/fixtures.ts, so nothing here knows a channel number.
   */
  update(
    feedUniverses: Map<number, Uint8Array>,
    feedActive: Map<number, boolean>,
    cameraQuaternion: THREE.Quaternion,
    intentFor: (fixtureId: string) => FixtureIntent | null,
  ): void {
    const cones = this.cones
    const faces = this.faces
    const fogMesh = this.fog
    if (!cones || !faces || !fogMesh) return

    const dummy = this.dummy
    const colour = this.colour
    let signature = ''

    this.others.forEach((other, index) => {
      const { fixture, profile, shape } = other
      const state = readFixture(
        profile,
        feedUniverses.get(fixture.universe) ?? null,
        fixture.address - 1,
        feedActive.get(fixture.universe) === true,
        this.states[index],
      )
      const intent = intentFor(fixture.id)

      // What the fixture is actually showing: what Stage asks for when it asks
      // for anything, otherwise what the console is sending, otherwise nothing.
      let level = 0
      let r = 0
      let g = 0
      let b = 0
      let fogLevel = 0
      let zoom: number | null = null
      let pan: number | null = null
      let tilt: number | null = null

      if (intent) {
        level = intent.intensity
        r = intent.r
        g = intent.g
        b = intent.b
        fogLevel = intent.fog ?? 0
        zoom = intent.zoom
        pan = intent.pan
        tilt = intent.tilt
        // A fixture with no colour mixing shows its own white whatever colour
        // the layer asked for: a warm-white panel cannot go blue, and drawing
        // it blue would be the interface promising something the rig cannot do.
        if (!hasColourMixing(profile)) {
          kelvinToRgb(profile.optics?.colourTemperatureK ?? 3200, this.white)
          r = this.white[0]
          g = this.white[1]
          b = this.white[2]
        }
      } else if (state.known) {
        litColour(state, this.lit)
        r = this.lit[0]
        g = this.lit[1]
        b = this.lit[2]
        level = state.lit ? state.intensity : 0
        fogLevel = state.fog ?? 0
        zoom = state.zoom
        pan = state.pan
        tilt = state.tilt
        // A fixture whose emitters are documented as one fixed white shows that
        // white, scaled by the dimmer -- litColour has no colour to work from.
        if (!hasColourMixing(profile) && level > 0) {
          kelvinToRgb(profile.optics?.colourTemperatureK ?? 3200, this.white)
          r = this.white[0] * level
          g = this.white[1] * level
          b = this.white[2] * level
        }
      }

      const bright = Math.max(r, g, b)

      if (shape === 'fog') {
        // Haze does not glow; it sits.
        this.poseZero(cones, index)
        this.poseZero(faces, index)
        if (fogLevel > 0.01) {
          const size = 3 + fogLevel * 5
          dummy.position.set(fixture.position[0], 0.6 + fogLevel * 0.8, fixture.position[2])
          dummy.quaternion.copy(cameraQuaternion)
          dummy.scale.set(size, size * 0.55, 1)
          dummy.updateMatrix()
          fogMesh.setMatrixAt(index, dummy.matrix)
          colour.setRGB(fogLevel * 0.16, fogLevel * 0.17, fogLevel * 0.2, THREE.SRGBColorSpace)
          fogMesh.setColorAt(index, colour)
          signature += `f${index}:${fogLevel.toFixed(2)}`
        } else {
          this.poseZero(fogMesh, index)
        }
        return
      }
      this.poseZero(fogMesh, index)

      if (bright <= 0.004) {
        // Dark: nothing to draw, and nothing to pay for.
        this.poseZero(cones, index)
        this.poseZero(faces, index)
        return
      }

      // --- the cone -----------------------------------------------------------
      const angle = beamAngleDeg(profile, zoom)
      if (angle !== null && other.throwLength > 0) {
        const length = other.throwLength
        const radius = Math.tan((Math.min(120, angle) * Math.PI) / 360) * length
        this.aimOf(other, pan, tilt, this.direction)
        this.quaternion.setFromUnitVectors(this.coneAxis, this.direction)
        dummy.position.fromArray(fixture.position)
        dummy.quaternion.copy(this.quaternion)
        dummy.scale.set(Math.max(0.05, radius), length, Math.max(0.05, radius))
        dummy.updateMatrix()
        cones.setMatrixAt(index, dummy.matrix)
        // A wide soft wash must not be as dense as a narrow beam carrying the
        // same power: the same light spread over more air is dimmer air.
        const density = shape === 'beam' ? 1 : shape === 'flare' ? 0.5 : 0.34
        colour.setRGB(r * density, g * density, b * density, THREE.SRGBColorSpace)
        cones.setColorAt(index, colour)
        signature += `c${index}:${bright.toFixed(2)}:${(pan ?? 0).toFixed(2)}:${(tilt ?? 0).toFixed(2)}`
      } else {
        // Documented as having no beam angle: draw the source, not a guess.
        this.poseZero(cones, index)
      }

      // --- the emitter --------------------------------------------------------
      const face = FACE_SIZE[shape]
      if (face > 0) {
        const size = face * (0.55 + bright * 0.75)
        dummy.position.fromArray(fixture.position)
        dummy.quaternion.copy(cameraQuaternion)
        dummy.scale.set(size, size, 1)
        dummy.updateMatrix()
        faces.setMatrixAt(index, dummy.matrix)
        colour.setRGB(r, g, b, THREE.SRGBColorSpace)
        faces.setColorAt(index, colour)
      } else {
        this.poseZero(faces, index)
      }
    })

    // One upload per frame, and only when something actually moved. An orbit
    // that has come to rest over a rig nobody is driving uploads nothing.
    if (signature !== this.lastSignature) {
      this.lastSignature = signature
      cones.instanceMatrix.needsUpdate = true
      faces.instanceMatrix.needsUpdate = true
      fogMesh.instanceMatrix.needsUpdate = true
      if (cones.instanceColor) cones.instanceColor.needsUpdate = true
      if (faces.instanceColor) faces.instanceColor.needsUpdate = true
      if (fogMesh.instanceColor) fogMesh.instanceColor.needsUpdate = true
    } else {
      // Billboards still have to follow the camera even when nothing changed.
      faces.instanceMatrix.needsUpdate = true
      fogMesh.instanceMatrix.needsUpdate = true
    }
  }

  /** Where a fixture points, from its rest aim turned by pan and tilt. */
  private aimOf(other: Other, pan: number | null, tilt: number | null, out: THREE.Vector3): THREE.Vector3 {
    out.copy(other.restAim)
    if (pan === null && tilt === null) return out
    // Tilt lifts the beam off its resting line; pan swings it around vertical.
    // Both are applied in the room's frame, which is true for a head hanging
    // level and close enough for one that is not -- the exact yoke geometry is
    // a fact about the install, and Placement is where that gets corrected.
    if (tilt !== null) {
      const axis = out.z !== 0 || out.x !== 0 ? tempAxis.set(-out.z, 0, out.x).normalize() : tempAxis.set(1, 0, 0)
      out.applyAxisAngle(axis, tilt)
    }
    if (pan !== null) out.applyAxisAngle(UP, pan)
    return out.normalize()
  }

  /** Scale to nothing: the instance still exists, and costs no fill. */
  private poseZero(mesh: THREE.InstancedMesh, index: number): void {
    mesh.setMatrixAt(index, ZERO_MATRIX)
  }

  dispose(): void {
    for (const mesh of [this.bodies, this.cones, this.faces, this.fog]) {
      if (!mesh) continue
      mesh.geometry.dispose()
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) material.dispose()
      this.group.remove(mesh)
    }
    this.bodies = null
    this.cones = null
    this.faces = null
    this.fog = null
    this.others = []
    this.states = []
    this.list = []
    this.lastSignature = ''
  }
}

const UP = new THREE.Vector3(0, 1, 0)
const tempAxis = new THREE.Vector3()
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0)

/** Whether the fixture can be told a colour at all -- additively or by filter. */
function hasColourMixing(profile: FixtureProfile): boolean {
  return physicalCapabilities(profile).includes('color')
}

/**
 * Where a fixture points when nothing is driving it.
 *
 * The lighting plan is a top view: it gives positions and no angles, so this is
 * derived from where the fixture hangs rather than measured. Panels along the
 * walls face across the room; blinders upstage face the audience; moving heads
 * rest pointing down and slightly into the room. All of it is a starting point
 * to be corrected in Placement mode, which writes the patch -- and none of it
 * is ever sent to a real fixture.
 */
function restAim(fixture: Fixture, shape: BeamShape): THREE.Vector3 {
  const [x, , z] = fixture.position
  switch (shape) {
    case 'wash':
      // Across the room and a little down: a soft light washing the tribune.
      return new THREE.Vector3(0, -0.55, z >= 0 ? -1 : 1).normalize()
    case 'flare':
      // Upstage, pointed back at the house: that is what a blinder is for.
      return new THREE.Vector3(1, -0.32, z * -0.04).normalize()
    case 'beam':
      // Resting into the room, from wherever it hangs.
      return new THREE.Vector3(x < -8 ? 1 : 0, -1, z >= 0 ? -0.35 : 0.35).normalize()
    default:
      return new THREE.Vector3(0, -1, 0)
  }
}
