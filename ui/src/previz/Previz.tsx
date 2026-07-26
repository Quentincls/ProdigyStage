import { useEffect, useRef } from 'react'
import type { Patch } from '../patch'
import { PrevizScene, VIEWS } from './PrevizScene'

interface PrevizProps {
  patch: Patch
  selection: string[]
  onPick: (fixtureId: string | null) => void
}

export default function Previz({ patch, selection, onPick }: PrevizProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<PrevizScene | null>(null)
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick

  useEffect(() => {
    const container = containerRef.current!
    const scene = new PrevizScene(canvasRef.current!, patch)
    scene.onPick = (id) => onPickRef.current(id)
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
      <div className="previz-hint">
        {Object.entries(VIEWS).map(([key, view]) => (
          <span key={key}>
            <b>{key}</b> {view.name}
          </span>
        ))}
        <span className="muted">drag to orbit · wheel to zoom</span>
      </div>
    </div>
  )
}
