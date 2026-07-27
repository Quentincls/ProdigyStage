// Runs tool: record the incoming console feed, replay it anytime. Lives in
// the Tools menu -- occasional use, so it stays out of the main chrome.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { feed } from './feed'
import { controlRecord, controlReplay, fetchRecordings, type RecordingInfo } from './show'
import { formatTime } from './TimeInput'

export default function RunsPanel({ onClose }: { onClose: () => void }) {
  const [recordings, setRecordings] = useState<RecordingInfo[]>([])
  const { stats } = useSyncExternalStore(feed.subscribe, feed.getSnapshot)

  const recording = stats?.record.recording ?? false
  const replayingFile = stats?.replay.replaying ? stats.replay.file : null

  useEffect(() => {
    void fetchRecordings().then(setRecordings)
  }, [])

  const wasRecording = useRef(false)
  useEffect(() => {
    if (wasRecording.current && !recording) void fetchRecordings().then(setRecordings)
    wasRecording.current = recording
  }, [recording])

  return (
    <aside className="panel">
      <header className="panel-header scene-header">
        <div>
          <h2>Runs</h2>
          <span className="muted-note">Record the console feed, replay it anytime. Nothing is sent to the rig.</span>
        </div>
        <button className="button" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="panel-section">
        <button
          className={`button record ${recording ? 'on' : ''}`}
          onClick={() => void controlRecord(recording ? 'stop' : 'start')}
        >
          {recording ? `■ Stop recording — ${formatTime(stats?.record.seconds ?? 0)}` : '● Record a run'}
        </button>
      </div>

      <div className="panel-section">
        <span className="panel-label">Recordings</span>
        {recordings.length === 0 && <span className="muted-note">No recordings yet.</span>}
        {recordings.map((entry) => (
          <div className="preset-row" key={entry.file}>
            <span className="run-name">
              {entry.file.replace(/\.artrec$/, '')}
              {entry.durationMs ? ` · ${formatTime(Math.round(entry.durationMs / 1000))}` : ''}
            </span>
            <button
              className="chip"
              onClick={() =>
                void controlReplay(
                  replayingFile === entry.file ? 'stop' : 'start',
                  entry.file,
                )
              }
            >
              {replayingFile === entry.file ? '■ Stop' : '▶ Replay'}
            </button>
          </div>
        ))}
      </div>
    </aside>
  )
}
