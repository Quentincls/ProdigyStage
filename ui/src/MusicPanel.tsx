// Build the show from the music.
//
// The panel is honest about the division of labour: the analysis reports what
// it heard, in its own words, and the operator decides whether that becomes a
// show. Nothing is written until they say so, and what is written is a draft
// they will edit -- so the button says "Build a draft", not "Generate".

import { useEffect, useState } from 'react'
import type { SceneSpec } from '../../core/effects'
import {
  analyseMusic,
  listMusic,
  player,
  proposeFromMusic,
  rememberedFile,
  type AudioAnalysis,
  type MusicFile,
} from './music'
import type { Marker, ShowFile } from './show'
import { formatTime } from './TimeInput'

export default function MusicPanel({
  show,
  onChange,
  onClose,
}: {
  show: ShowFile
  onChange: (show: ShowFile) => void
  onClose: () => void
}) {
  const [files, setFiles] = useState<MusicFile[] | null>(null)
  const [dir, setDir] = useState('')
  const [selected, setSelected] = useState<string | null>(player.file ?? rememberedFile())
  const [analysis, setAnalysis] = useState<AudioAnalysis | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listMusic()
      .then((result) => {
        setFiles(result.files)
        setDir(result.dir)
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  function choose(file: string): void {
    setSelected(file)
    setAnalysis(null)
    setError(null)
    player.load(file)
  }

  async function analyse(): Promise<void> {
    if (!selected) return
    setBusy(true)
    setError(null)
    try {
      setAnalysis(await analyseMusic(selected))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function build(): Promise<void> {
    if (!selected) return
    if (
      (show.scenes.length > 0 || show.markers.length > 0) &&
      !window.confirm(
        'This replaces every section and scene in the show with a draft built from the music. Continue?',
      )
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { analysis: fresh, proposal } = await proposeFromMusic(selected)
      setAnalysis(fresh)
      onChange({
        ...show,
        markers: proposal.markers as Marker[],
        scenes: proposal.scenes as SceneSpec[],
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="panel">
      <header className="panel-header">
        <div className="scene-identity">
          <h2>Music</h2>
          <span className="muted-note">Listen to the track, and build a first show from it.</span>
        </div>
        <button className="icon-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      {files === null && !error && <span className="muted-note">Reading the music folder…</span>}

      {files !== null && files.length === 0 && (
        <div className="panel-section">
          <span className="muted-note">
            No WAV files yet. Drop the show's audio into this folder, then reopen this panel:
          </span>
          <code className="music-path">{dir}</code>
        </div>
      )}

      {files !== null && files.length > 0 && (
        <div className="panel-section">
          <span className="panel-label">Track</span>
          {files.map((file) => (
            <button
              key={file.file}
              className={`music-file ${selected === file.file ? 'active' : ''}`}
              onClick={() => choose(file.file)}
            >
              <span className="music-file-name">{file.file}</span>
              <span className="music-file-size">{(file.sizeBytes / 1e6).toFixed(0)} MB</span>
            </button>
          ))}
        </div>
      )}

      {selected && <Playback />}

      {selected && (
        <div className="panel-section">
          <button className="button block" onClick={() => void analyse()} disabled={busy}>
            {busy ? 'Listening…' : analysis ? 'Listen again' : 'Analyse the track'}
          </button>
          <span className="muted-note">
            Reads the whole file to find where the music changes and how fast each part runs.
            Nothing is written to the show.
          </span>
        </div>
      )}

      {error && <span className="error-text">{error}</span>}

      {analysis && (
        <>
          <div className="panel-section">
            <span className="panel-label">What it heard</span>
            <div className="music-summary">
              <span>{formatTime(analysis.seconds)}</span>
              <span>{analysis.sections.length} sections</span>
              <span>{analysis.bpm ? `${analysis.bpm} BPM` : 'no steady tempo'}</span>
              <span className="muted-note">in {(analysis.analysedInMs / 1000).toFixed(1)} s</span>
            </div>
            <div className="music-sections">
              {analysis.sections.map((section) => (
                <div className={`music-section ${section.kind}`} key={section.start}>
                  <span className="music-section-time">{formatTime(section.start)}</span>
                  <span className="music-section-kind">{section.kind}</span>
                  <span className="music-section-bpm">
                    {section.bpm ? `${Math.round(section.bpm)}` : '—'}
                  </span>
                  <span
                    className="music-section-level"
                    style={{ width: `${Math.round(section.level * 100)}%` }}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="panel-section">
            <button className="button block primary" onClick={() => void build()} disabled={busy}>
              Build a draft show
            </button>
            {/* The honest sentence about what a machine can and cannot do here. */}
            <span className="muted-note">
              One section and one scene per part of the track, with every effect running on that
              part's own tempo. Where the changes happen is measured; which colour goes where is a
              convention — change anything you disagree with.
            </span>
          </div>
        </>
      )}
    </aside>
  )
}

// Volume lives here rather than in the timeline: the transport already plays
// and pauses the music, this only decides how loud it is in the room you are
// sitting in.
function Playback() {
  const [, force] = useState(0)
  useEffect(() => player.subscribe(() => force((n) => n + 1)), [])

  return (
    <div className="panel-section">
      <span className="panel-label">Playback</span>
      <div className="music-playback">
        <button
          className="ins-icon"
          onClick={() => player.toggleMute()}
          title={player.muted ? 'Unmute' : 'Mute'}
        >
          {player.muted ? '🔇' : '🔊'}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={player.volume}
          onChange={(e) => player.setVolume(e.target.valueAsNumber)}
        />
      </div>
      <span className="muted-note">
        {player.error
          ? player.error
          : player.ready
            ? 'Follows the timeline: play, pause and scrub move the track with the show.'
            : 'Loading the track…'}
      </span>
    </div>
  )
}
