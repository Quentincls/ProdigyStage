// Node-side self-test of the shared engine (`node core/selftest.ts`).
// Proves the exact code the previz runs also runs server-side (Phase 6) and
// that rendering is deterministic against the timecode.

import {
  activeScene,
  defaultParams,
  EFFECTS,
  renderEffect,
  renderScenePixel,
  type SceneSpec,
} from './effects.ts'

let failures = 0

function check(label: string, ok: boolean): void {
  if (!ok) {
    failures++
    console.error(`FAIL ${label}`)
  }
}

// 1. Determinism: same inputs, same outputs, across repeated calls.
for (const def of EFFECTS) {
  const params = defaultParams(def.type)
  for (const t of [0, 1.37, 61.04, 3599.96]) {
    for (const [pos, index] of [
      [0.01, 0],
      [0.5, 255],
      [0.99, 511],
    ] as const) {
      const a = renderEffect(def.type, params, pos, index, t)
      const b = renderEffect(def.type, params, pos, index, t)
      check(`${def.type} deterministic @t=${t}`, a[0] === b[0] && a[1] === b[1] && a[2] === b[2])
      check(
        `${def.type} in range @t=${t}`,
        a.every((v) => v >= 0 && v <= 255 && Number.isFinite(v)),
      )
    }
  }
}

// 2. Scene priority: covered group renders, uncovered group returns null.
const scene: SceneSpec = {
  id: 's1',
  name: 'Test',
  start: 130,
  end: 220,
  tracks: [
    {
      id: 't1',
      target: 'wall-left',
      effect: 'wave',
      params: defaultParams('wave'),
      fadeIn: 1,
      fadeOut: 1,
    },
  ],
}
check('covered group renders', renderScenePixel(scene, 'wall-left', 0.3, 10, 150) !== null)
check('uncovered group is null', renderScenePixel(scene, 'wall-right', 0.3, 10, 150) === null)
check('outside range is null', renderScenePixel(scene, 'wall-left', 0.3, 10, 100) === null)
check('fade-in at start is dark', renderScenePixel(scene, 'wall-left', 0.3, 10, 130.001)!.every((v) => v < 3))
check('activeScene finds it', activeScene([scene], 150)?.id === 's1')
check('activeScene outside', activeScene([scene], 500) === null)

if (failures > 0) {
  console.error(`core selftest: ${failures} failure(s)`)
  process.exit(1)
}
console.log(`core selftest: OK (${EFFECTS.length} effects deterministic, scene priority verified)`)
