// What Stage wants a fixture to be doing right now, out of everything that
// might have an opinion about it.
//
// Four states can speak, and the order between them is fixed and short:
//
//   preview   what the inspector is doing to the selection this second
//   layer     what a light layer on the timeline asks for at this time
//   scene     the wall-look engine (battens only, unchanged since Phase 5)
//   console   what the desk is actually sending
//
// The first one that has something to say wins, and when none of them do, the
// console is the truth -- which is the default, and the reason Watch mode shows
// the show rather than an opinion about it. `null` means exactly that: nobody
// here has anything to say, leave the fixture alone.
//
// Read on the render loop's hot path. Nothing in it allocates.

import { blankIntent, renderBehavior, type FixtureIntent } from '../../core/behaviors'
import { renderLayerIntent, type FixtureRef, type LightLayer } from '../../core/layers'
import { editor, layerMembership } from './editor'

const scratch = blankIntent()

/**
 * The layer covering an instant, if any. Later layers win on overlap, the same
 * rule scenes already use, so two layers that touch behave predictably.
 */
export function activeLayerAt(layers: LightLayer[], showTime: number | null): LightLayer | null {
  if (showTime === null) return null
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]
    if (showTime >= layer.start && showTime < layer.end) return layer
  }
  return null
}

/**
 * One fixture, one instant.
 *
 * `layer` is passed in rather than looked up because the caller resolves it
 * once per frame for all seventy fixtures -- looking it up seventy times to get
 * the same answer is the kind of thing that turns into a performance report.
 */
export function intentFor(
  fixture: FixtureRef,
  layer: LightLayer | null,
  showTime: number | null,
  refs: FixtureRef[],
): FixtureIntent | null {
  const preview = editor.preview
  if (preview) {
    const index = preview.ids.indexOf(fixture.id)
    if (index >= 0) {
      const count = Math.max(1, preview.ids.length)
      return renderBehavior(
        preview.behavior,
        preview.params,
        {
          index,
          count,
          pos: count > 1 ? index / (count - 1) : 0.5,
          // Wall clock, not show time: a preview runs whether or not the
          // console is sending a timecode, which is the whole point of being
          // able to design with the desk switched off.
          time: (performance.now() - preview.startedAt) / 1000,
        },
        scratch,
      )
    }
  }
  if (!layer || showTime === null) return null
  const members = layerMembership(refs).get(layer.id)
  if (!members) return null
  return renderLayerIntent(layer, fixture, members, showTime, scratch)
}
