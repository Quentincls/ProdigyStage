import { useEffect, useRef } from 'react'
import type { Patch } from '../patch'
import { PrevizScene, VIEWS } from './PrevizScene'

export default function Previz({ patch }: { patch: Patch }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const container = containerRef.current!
    const scene = new PrevizScene(canvasRef.current!, patch)

    const observer = new ResizeObserver(() => {
      scene.resize(container.clientWidth, container.clientHeight)
    })
    observer.observe(container)

    const onKey = (event: KeyboardEvent) => {
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
    }
  }, [patch])

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
