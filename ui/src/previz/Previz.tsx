import { useCallback, useEffect, useRef, useState } from 'react'
import type { Patch } from '../patch'
import { LightPicker } from './LightPicker'
import { MAX_AIM, PrevizScene, readAim, VIEWS } from './PrevizScene'

interface PrevizProps {
  patch: Patch
  selection: string[]
  onPick: (fixtureId: string | null, add: boolean) => void
  /** Present in the modes where lights are chosen, absent where the viewport
   *  is only there to be looked at. */
  onSelect?: (ids: string[]) => void
}

export default function Previz({ patch, selection, onPick, onSelect }: PrevizProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<PrevizScene | null>(null)
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick
  const onHover = useCallback((ids: string[]) => sceneRef.current?.setHover(ids), [])
  // Mirrors the scene's camera so the corner buttons can show which one is on.
  const [activeView, setActiveView] = useState(1)
  const [aim, setAim] = useState(readAim)

  useEffect(() => {
    const container = containerRef.current!
    const scene = new PrevizScene(canvasRef.current!, patch)
    scene.onPick = (id, add) => onPickRef.current(id, add)
    sceneRef.current = scene

    const observer = new ResizeObserver(() => {
      scene.resize(container.clientWidth, container.clientHeight)
    })
    observer.observe(container)

    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') {
        return
      }
      const view = Number(event.key)
      if (VIEWS[view] && !event.metaKey && !event.ctrlKey && !event.altKey) {
        scene.setView(view)
        setActiveView(view)
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      observer.disconnect()
      window.removeEventListener('keydown', onKey)
      scene.dispose()
      sceneRef.current = null
    }
    // The scene is created once; patch/selection updates go through the
    // dedicated effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    sceneRef.current?.applyPatch(patch)
  }, [patch])

  useEffect(() => {
    sceneRef.current?.setSelection(selection)
  }, [selection])

  return (
    <div className="previz" ref={containerRef}>
      <canvas ref={canvasRef} />
      {/* Camera, in the corner and out of the way. These used to be a legend
          telling you which key to press; they are the buttons now, and the key
          still works. */}
      <div className="previz-views">
        {Object.entries(VIEWS).map(([key, view]) => (
          <button
            key={key}
            className={`previz-view ${activeView === Number(key) ? 'active' : ''}`}
            title={`${view.name} view — key ${key}`}
            onClick={() => {
              sceneRef.current?.setView(Number(key))
              setActiveView(Number(key))
            }}
          >
            {view.name}
          </button>
        ))}
        {/* Where the battens rest when no console is telling them. It changes
            the picture and nothing else -- the rig is never sent a tilt from
            here -- but a room lit by lights pointing somewhere they are not is
            worse than no previz at all. */}
        <span className="previz-sep" />
        {onSelect && (
          <LightPicker
            patch={patch}
            selection={selection}
            onSelect={onSelect}
            onHover={onHover}
          />
        )}
        <label className="previz-aim" title="Where the battens point when the console is silent">
          <span className="previz-aim-label">Aim</span>
          <input
            type="range"
            min={-MAX_AIM}
            max={MAX_AIM}
            step={5}
            value={aim}
            onChange={(event) => {
              const next = event.target.valueAsNumber
              setAim(next)
              sceneRef.current?.setAim(next)
            }}
          />
          <span className="previz-aim-value">
            {aim === 0 ? 'down' : `${aim > 0 ? 'in' : 'out'} ${Math.abs(aim)}°`}
          </span>
        </label>
      </div>
    </div>
  )
}
