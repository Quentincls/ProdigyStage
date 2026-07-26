// 3D previz of the rig, vanilla Three.js. The 512 Tambora pixels are one
// InstancedMesh whose instance colors are written from the feed's mutable DMX
// buffers every time a new frame arrives; everything else is static geometry.
// Bloom via UnrealBloomPass gives the emissive glow on a dark scene.

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { feed } from '../feed'
import type { Fixture, Patch } from '../patch'

// Room dimensions from the brief: ~40 x 15 m, 10 m high. Stage/arch at -X.
const ROOM = { length: 40, width: 15, height: 10 }

export const VIEWS: Record<number, { position: number[]; target: number[]; name: string }> = {
  1: { position: [0, 4.5, 6], target: [0, 6, -6], name: 'Face' },
  2: { position: [0.01, 36, 0], target: [0, 0, 0], name: 'Top' },
  3: { position: [10, 4.5, 0], target: [-16, 5, 0], name: 'Tribune' },
}

const DEFAULT_VIEW = { position: [19, 12, 14], target: [0, 4, 0] }

interface PixelSlot {
  universe: number
  colorChannel: number // 0-based index of R in the DMX buffer
  dimmerChannel: number
}

export class PrevizScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private composer: EffectComposer
  private bloom: UnrealBloomPass

  private pixels: THREE.InstancedMesh
  private glows: THREE.InstancedMesh
  private pixelSlots: PixelSlot[] = []
  private glowSlots: PixelSlot[][] = [] // per fixture: its 16 pixel slots

  private lastVersion = -1
  private raf = 0
  private disposed = false
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
    this.scene.background = new THREE.Color('#0b0c0f')

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 300)
    this.camera.position.fromArray(DEFAULT_VIEW.position)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.target.fromArray(DEFAULT_VIEW.target)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.maxDistance = 90

    this.buildRoom()
    const { pixels, glows } = this.buildFixtures(patch)
    this.pixels = pixels
    this.glows = glows

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.05, 0.45, 0.3)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())

    this.loop()
  }

  private buildRoom(): void {
    const line = new THREE.LineBasicMaterial({ color: '#23272e' })
    const panel = new THREE.MeshBasicMaterial({ color: '#14161a' })

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.length, ROOM.width), panel)
    floor.rotation.x = -Math.PI / 2
    this.scene.add(floor)

    const grid = new THREE.GridHelper(ROOM.length, ROOM.length / 2, 0x1c1f25, 0x181b20)
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
    const tribuneMaterial = new THREE.MeshBasicMaterial({ color: '#191c22' })
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
      new THREE.MeshBasicMaterial({ color: '#2a2e36' }),
    )
    arch.position.set(-16, 0, 0)
    arch.rotation.y = Math.PI / 2
    this.scene.add(arch)
  }

  private buildFixtures(patch: Patch): {
    pixels: THREE.InstancedMesh
    glows: THREE.InstancedMesh
  } {
    const fixtures = patch.fixtures
    const type = patch.fixtureTypes[fixtures[0]?.type ?? '']
    const pixelsPerFixture = type?.pixels ?? 16
    const totalPixels = fixtures.length * pixelsPerFixture

    // Batten bodies.
    const bars = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.02, 0.12, 0.06),
      new THREE.MeshBasicMaterial({ color: '#101216' }),
      fixtures.length,
    )

    // Emissive pixels.
    const pixels = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.058, 0.09),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
      totalPixels,
    )

    // Fake floor glow: one soft additive pool per batten, tinted by the
    // average pixel color (no real volumetrics in v1).
    const glows = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(3.4, 5.2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: makeGlowTexture(),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      fixtures.length,
    )

    const dummy = new THREE.Object3D()
    const pixelMatrix = new THREE.Matrix4()
    const offset = new THREE.Matrix4()
    const black = new THREE.Color(0x000000)
    const degreesToRadians = Math.PI / 180

    fixtures.forEach((fixture: Fixture, fixtureIndex: number) => {
      dummy.position.set(...fixture.position)
      dummy.rotation.set(
        fixture.rotation[0] * degreesToRadians,
        fixture.rotation[1] * degreesToRadians,
        fixture.rotation[2] * degreesToRadians,
      )
      dummy.updateMatrix()
      bars.setMatrixAt(fixtureIndex, dummy.matrix)

      const base = fixture.address - 1
      const dimmerChannel = base + (type?.standardMap.dimmer ?? 1) - 1
      const fixtureSlots: PixelSlot[] = []

      for (let p = 0; p < pixelsPerFixture; p++) {
        const localX = -0.5 + (p + 0.5) / pixelsPerFixture
        offset.makeTranslation(localX, 0, 0.036)
        pixelMatrix.multiplyMatrices(dummy.matrix, offset)
        const instance = fixtureIndex * pixelsPerFixture + p
        pixels.setMatrixAt(instance, pixelMatrix)
        pixels.setColorAt(instance, black)
        const slot = {
          universe: fixture.universe,
          colorChannel: base + (type?.pixelStart ?? 14) - 1 + p * 3,
          dimmerChannel,
        }
        this.pixelSlots.push(slot)
        fixtureSlots.push(slot)
      }
      this.glowSlots.push(fixtureSlots)

      // Glow pool sits on the floor, pushed towards the room center.
      const inward = fixture.group === 'wall-left' ? 2.1 : -2.1
      dummy.position.set(fixture.position[0], 0.02, fixture.position[2] + inward)
      dummy.rotation.set(0, 0, 0)
      dummy.updateMatrix()
      glows.setMatrixAt(fixtureIndex, dummy.matrix)
      glows.setColorAt(fixtureIndex, black)
    })

    this.scene.add(bars, pixels, glows)
    return { pixels, glows }
  }

  private updateColors(): void {
    if (feed.version === this.lastVersion) return
    this.lastVersion = feed.version
    const color = new THREE.Color()

    this.pixelSlots.forEach((slot, instance) => {
      const buffer = feed.universes.get(slot.universe)
      if (!buffer) return
      const dimmer = buffer[slot.dimmerChannel] / 255
      color.setRGB(
        (buffer[slot.colorChannel] / 255) * dimmer,
        (buffer[slot.colorChannel + 1] / 255) * dimmer,
        (buffer[slot.colorChannel + 2] / 255) * dimmer,
        THREE.SRGBColorSpace,
      )
      this.pixels.setColorAt(instance, color)
    })
    this.pixels.instanceColor!.needsUpdate = true

    this.glowSlots.forEach((slots, fixtureIndex) => {
      const buffer = feed.universes.get(slots[0]?.universe ?? 0)
      if (!buffer || slots.length === 0) return
      let r = 0
      let g = 0
      let b = 0
      for (const slot of slots) {
        r += buffer[slot.colorChannel]
        g += buffer[slot.colorChannel + 1]
        b += buffer[slot.colorChannel + 2]
      }
      const dimmer = buffer[slots[0].dimmerChannel] / 255
      const scale = (dimmer * 0.55) / (255 * slots.length)
      color.setRGB(r * scale, g * scale, b * scale, THREE.SRGBColorSpace)
      this.glows.setColorAt(fixtureIndex, color)
    })
    this.glows.instanceColor!.needsUpdate = true
  }

  setView(view: number): void {
    const preset = VIEWS[view]
    if (!preset) return
    this.tween = {
      fromPosition: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPosition: new THREE.Vector3().fromArray(preset.position),
      toTarget: new THREE.Vector3().fromArray(preset.target),
      startedAt: performance.now(),
    }
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
  }

  private loop = (): void => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.loop)
    this.updateTween()
    this.controls.update()
    this.updateColors()
    this.composer.render()
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.raf)
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
