// Watch mode is the screen left running in the control room. Nobody edits on
// it, so it answers three questions instead of offering controls: where are
// we in the show, what is playing, and what comes next.
//
// Everything is written imperatively from a rAF loop -- at 25 fps a React
// re-render per frame would be absurd for six strings.

import { useEffect, useRef } from 'react'
import { activeScene, type SceneSpec } from '../../core/effects'
import { feed } from './feed'
import type { Marker, ShowFile } from './show'
import { formatTime, pad } from './TimeInput'

export default function WatchBar({ show }: { show: ShowFile }) {
  const timeRef = useRef<HTMLSpanElement>(null)
  const stateRef = useRef<HTMLSpanElement>(null)
  const sectionRef = useRef<HTMLSpanElement>(null)
  const nowRef = useRef<HTMLSpanElement>(null)
  const nextRef = useRef<HTMLSpanElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const showRef = useRef(show)
  showRef.current = show

  useEffect(() => {
    let raf = 0
    let lastNow = ''
    let lastNext = ''
    let lastSection = ''

    const draw = () => {
      raf = requestAnimationFrame(draw)
      const tc = feed.timecode
      const t = tc.receiving ? tc.total : null
      const current = showRef.current

      if (timeRef.current) {
        timeRef.current.textContent = tc.receiving
          ? `${pad(tc.hours)}:${pad(tc.minutes)}:${pad(tc.seconds)}:${pad(tc.frames)}`
          : '--:--:--:--'
      }
      if (stateRef.current) {
        stateRef.current.textContent = tc.receiving ? `${tc.fps} fps` : 'waiting for the console'
      }

      // What section of the show we are in.
      const section = t === null ? null : lastStartedBefore(current.markers, t)
      const sectionLabel = section ? section.name : ''
      if (sectionRef.current && sectionLabel !== lastSection) {
        sectionRef.current.textContent = sectionLabel
        lastSection = sectionLabel
      }

      // What is on the walls right now, and what takes over next.
      const playing = t === null ? null : activeScene(current.scenes, t)
      const nowLabel = playing ? playing.name : 'Console'
      if (nowRef.current && nowLabel !== lastNow) {
        nowRef.current.textContent = nowLabel
        nowRef.current.className = `watch-now-value ${playing ? 'scene' : 'console'}`
        lastNow = nowLabel
      }

      const upcoming = t === null ? null : nextScene(current.scenes, t)
      const nextLabel = upcoming
        ? `${upcoming.name} · in ${formatTime(Math.max(0, upcoming.start - (t ?? 0)))}`
        : 'nothing scheduled'
      if (nextRef.current && nextLabel !== lastNext) {
        nextRef.current.textContent = nextLabel
        lastNext = nextLabel
      }

      // Progress across the whole show.
      if (barRef.current) {
        const end = showEnd(current.scenes, current.markers)
        const ratio = t === null || end <= 0 ? 0 : Math.max(0, Math.min(1, t / end))
        barRef.current.style.width = `${ratio * 100}%`
      }
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [])

  const end = showEnd(show.scenes, show.markers)

  return (
    <footer className="watchbar">
      <div className="watch-time">
        <span className="watch-clock" ref={timeRef}>
          --:--:--:--
        </span>
        <span className="watch-state" ref={stateRef} />
      </div>

      <div className="watch-track">
        <div className="watch-progress">
          <div className="watch-progress-fill" ref={barRef} />
          {show.scenes.map((scene) => (
            <span
              key={scene.id}
              className="watch-tick"
              style={{
                left: `${end > 0 ? (scene.start / end) * 100 : 0}%`,
                width: `${end > 0 ? Math.max(0.4, ((scene.end - scene.start) / end) * 100) : 0}%`,
              }}
            />
          ))}
        </div>
        <span className="watch-section" ref={sectionRef} />
      </div>

      <div className="watch-cues">
        <div className="watch-cue">
          <span className="watch-cue-label">On the walls</span>
          <span className="watch-now-value console" ref={nowRef}>
            Console
          </span>
        </div>
        <div className="watch-cue">
          <span className="watch-cue-label">Next</span>
          <span className="watch-next-value" ref={nextRef}>
            nothing scheduled
          </span>
        </div>
      </div>
    </footer>
  )
}

function lastStartedBefore(markers: Marker[], t: number): Marker | null {
  let best: Marker | null = null
  for (const marker of markers) {
    if (marker.start <= t && t < marker.end && (!best || marker.start > best.start)) best = marker
  }
  return best
}

function nextScene(scenes: SceneSpec[], t: number): SceneSpec | null {
  let best: SceneSpec | null = null
  for (const scene of scenes) {
    if (scene.start > t && (!best || scene.start < best.start)) best = scene
  }
  return best
}

function showEnd(scenes: SceneSpec[], markers: Marker[]): number {
  let end = 0
  for (const scene of scenes) end = Math.max(end, scene.end)
  for (const marker of markers) end = Math.max(end, marker.end)
  return end
}
