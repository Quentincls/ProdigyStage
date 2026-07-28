import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { defaultParams } from '../../core/effects'
import { backToLive, editor, isTimeOverridden, startPreview } from './editor'
import { feed } from './feed'
import Diagnostics from './Diagnostics'
import Monitor from './Monitor'
import OutputPanel from './OutputPanel'
import { fetchPatch, savePatch, type Patch } from './patch'
import PlacementPanel from './previz/PlacementPanel'
import Previz from './previz/Previz'
import RunsPanel from './RunsPanel'
import SceneEditor from './SceneEditor'
import { findFreeSlot } from './sceneRules'
import { controlOutput, fetchShow, saveShow, type ShowFile } from './show'
import Timeline from './Timeline'
import WatchBar from './WatchBar'
import { formatTime } from './TimeInput'

// Two intents, two modes: Watch (default, safe, zero chrome) and Edit.
// Technical tools (DMX monitor, placement, runs, live output) live behind the
// gear menu.
type Mode = 'watch' | 'edit'
type Tool = 'monitor' | 'placement' | 'runs' | 'output' | 'diag' | null

export default function App() {
  const [patch, setPatch] = useState<Patch | null>(null)
  const [savedJson, setSavedJson] = useState('')
  const [mode, setMode] = useState<Mode>('watch')
  const [tool, setTool] = useState<Tool>(null)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [selection, setSelection] = useState<string[]>([])
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null)
  const { connected, stats } = useSyncExternalStore(feed.subscribe, feed.getSnapshot)

  const [show, setShow] = useState<ShowFile | null>(null)
  const [showSaveState, setShowSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const showSaveTimer = useRef<number | null>(null)
  const showLoaded = useRef(false)

  // The previz render loop reads scenes from the mutable editor store.
  useEffect(() => {
    editor.scenes = show?.scenes ?? []
    editor.version++
  }, [show])

  useEffect(() => {
    feed.start()
    void fetchPatch().then((initial) => {
      setPatch(initial)
      setSavedJson(JSON.stringify(initial))
    })
    void fetchShow()
      .then((initial) => {
        setShow(initial)
        showLoaded.current = true
      })
      .catch(() => setShow({ markers: [], scenes: [], presets: [] }))
  }, [])

  // Undo history: direct manipulation demands Ctrl+Z. Consecutive edits
  // within 400 ms coalesce into one step (a slider drag = one undo).
  const historyRef = useRef<{ past: ShowFile[]; future: ShowFile[]; lastPushAt: number }>({
    past: [],
    future: [],
    lastPushAt: 0,
  })
  const showRef = useRef<ShowFile | null>(null)
  showRef.current = show

  // Apply + auto-save (debounced: typing a name should not hammer the server).
  function applyShow(next: ShowFile): void {
    setShow(next)
    if (!showLoaded.current) return
    if (showSaveTimer.current !== null) window.clearTimeout(showSaveTimer.current)
    setShowSaveState('saving')
    showSaveTimer.current = window.setTimeout(() => {
      saveShow(next)
        .then(() => {
          setShowSaveState('saved')
          window.setTimeout(() => setShowSaveState('idle'), 1200)
        })
        .catch(() => setShowSaveState('error'))
    }, 600)
  }

  function handleShowChange(next: ShowFile): void {
    const current = showRef.current
    if (current && showLoaded.current) {
      const history = historyRef.current
      const now = performance.now()
      if (now - history.lastPushAt > 400) {
        history.past.push(current)
        if (history.past.length > 100) history.past.shift()
        history.lastPushAt = now
      }
      history.future = []
    }
    applyShow(next)
  }

  function undo(): void {
    const history = historyRef.current
    const previous = history.past.pop()
    const current = showRef.current
    if (!previous || !current) return
    history.future.push(current)
    history.lastPushAt = 0
    applyShow(previous)
  }

  function redo(): void {
    const history = historyRef.current
    const next = history.future.pop()
    const current = showRef.current
    if (!next || !current) return
    history.past.push(current)
    history.lastPushAt = 0
    applyShow(next)
  }

  const dirty = useMemo(
    () => patch !== null && JSON.stringify(patch) !== savedJson,
    [patch, savedJson],
  )

  // Global shortcuts: Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y), Space = preview the
  // selected scene, Escape = back out (preview > panel > tool).
  const selectedSceneRef = useRef(selectedSceneId)
  selectedSceneRef.current = selectedSceneId
  const toolRef = useRef(tool)
  toolRef.current = tool
  const undoRef = useRef(undo)
  undoRef.current = undo
  const redoRef = useRef(redo)
  redoRef.current = redo

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redoRef.current()
        else undoRef.current()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redoRef.current()
        return
      }
      if (event.key === ' ') {
        const sceneId = selectedSceneRef.current
        if (sceneId) {
          event.preventDefault()
          if (editor.playing && editor.previewSceneId === sceneId) backToLive()
          else startPreview(sceneId)
        }
        return
      }
      if (event.key === 'Escape') {
        if (isTimeOverridden()) backToLive()
        else if (selectedSceneRef.current) setSelectedSceneId(null)
        else if (toolRef.current) setTool(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const totalPps = stats
    ? Object.values(stats.perUniverse).reduce((sum, u) => sum + u.pps, 0)
    : 0

  // Status in plain words -- the metrics live in the DMX monitor. Whatever
  // else is going on, if we are driving the real lights that comes first.
  const outputMode = stats?.output?.mode ?? 'off'
  let statusText: string
  let dotClass: string
  if (!connected) {
    statusText = 'Connecting to server…'
    dotClass = 'down'
  } else if (outputMode === 'blackout') {
    statusText = 'BLACKOUT — the lights are forced off'
    dotClass = 'live'
  } else if (outputMode === 'armed') {
    statusText = 'LIVE — your scenes are playing on the lights'
    dotClass = 'live'
  } else if (outputMode === 'spectator') {
    statusText = 'Connected to the lights — the console passes through'
    dotClass = 'ok'
  } else if (stats?.replay.replaying) {
    statusText = `Replaying ${stats.replay.file ?? ''} — nothing is sent`
    dotClass = 'ok'
  } else if (!stats?.udp.listening) {
    statusText = 'Art-Net port unavailable — open the signal monitor'
    dotClass = 'down'
  } else if (totalPps > 0) {
    statusText = 'Console connected — nothing is sent'
    dotClass = 'ok'
  } else {
    statusText = 'Waiting for the console — nothing is sent'
    dotClass = 'idle'
  }

  function switchMode(next: Mode): void {
    setMode(next)
    setToolsOpen(false)
    if (next === 'watch') {
      setSelectedSceneId(null)
      setTool((current) => (current === 'monitor' ? current : null))
      backToLive()
    }
  }

  function openTool(next: Tool): void {
    setToolsOpen(false)
    setTool((current) => (current === next ? null : next))
    if (next === 'placement' || next === 'runs') setSelectedSceneId(null)
  }

  function handleSelectScene(id: string | null): void {
    setSelectedSceneId(id)
    if (id && tool !== 'monitor') setTool(null)
  }

  async function handleSavePatch(): Promise<void> {
    if (!patch) return
    await savePatch(patch)
    setSavedJson(JSON.stringify(patch))
  }

  function handleRevertPatch(): void {
    if (savedJson) setPatch(JSON.parse(savedJson) as Patch)
  }

  function handleAddScene(start: number): void {
    if (!show) return
    const slot = findFreeSlot(show.scenes, start, 60)
    const scene = {
      id: crypto.randomUUID(),
      // Named after when it happens: more useful than "Scene 4" when you are
      // looking for the moment you want to change.
      name: `At ${formatTime(slot.start)}`,
      start: slot.start,
      end: slot.end,
      tracks: [
        {
          id: crypto.randomUUID(),
          target: 'both' as const,
          effect: 'wave' as const,
          params: defaultParams('wave'),
          fadeIn: 0.5,
          fadeOut: 0.5,
        },
      ],
    }
    handleShowChange({ ...show, scenes: [...show.scenes, scene] })
    setSelectedSceneId(scene.id)
    setTool((current) => (current === 'monitor' ? current : null))
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>PRODIGY STAGE</h1>
          <nav className="tabs">
            <button className={mode === 'watch' ? 'active' : ''} onClick={() => switchMode('watch')}>
              Watch
            </button>
            <button className={mode === 'edit' ? 'active' : ''} onClick={() => switchMode('edit')}>
              Edit
            </button>
          </nav>
          {dirty && tool === 'placement' && <span className="dirty-badge">unsaved changes</span>}
        </div>
        <div className="statusline">
          <WallClock />
          <span className={`status-line ${dotClass}`}>
            <span className={`dot ${dotClass}`} />
            {statusText}
          </span>
          {outputMode !== 'off' && outputMode !== 'blackout' && (
            <button
              className="button blackout compact"
              onClick={() => void controlOutput('mode', 'blackout')}
            >
              BLACKOUT
            </button>
          )}
          <div className="tools">
            <button
              className="ghost-button icon-button"
              aria-label="Tools"
              onClick={() => setToolsOpen(!toolsOpen)}
            >
              ⚙
            </button>
            {toolsOpen && (
              <>
                <div className="menu-backdrop" onClick={() => setToolsOpen(false)} />
                {/* Each entry says what it is for: a bare list of four nouns
                    made people click to find out. */}
                <div className="tools-menu">
                  <span className="menu-label">Tools</span>
                  <button className={tool === 'runs' ? 'on' : ''} onClick={() => openTool('runs')}>
                    <b>Runs</b>
                    <em>Record the console, replay it anytime</em>
                  </button>
                  <button
                    className={tool === 'placement' ? 'on' : ''}
                    onClick={() => openTool('placement')}
                  >
                    <b>Placement</b>
                    <em>Move the light bars to match the venue</em>
                  </button>
                  <button
                    className={tool === 'monitor' ? 'on' : ''}
                    onClick={() => openTool('monitor')}
                  >
                    <b>Signal monitor</b>
                    <em>Raw values coming from the console</em>
                  </button>
                  <button className={tool === 'diag' ? 'on' : ''} onClick={() => openTool('diag')}>
                    <b>Diagnostics</b>
                    <em>Everything about the current state, as text to send us</em>
                  </button>
                  <span className="menu-sep" />
                  <button
                    className={`danger-item ${tool === 'output' ? 'on' : ''}`}
                    onClick={() => openTool('output')}
                  >
                    <b>
                      Live output
                      {outputMode !== 'off' && <span className="menu-live">ON</span>}
                    </b>
                    <em>Play your scenes on the real lights</em>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="content">
        {!patch ? (
          <p className="loading">Waiting for server…</p>
        ) : tool === 'monitor' ? (
          <div className="monitor-wrap">
            <div className="monitor-header">
              <h2>Signal monitor</h2>
              <button className="button" onClick={() => setTool(null)}>
                Close
              </button>
            </div>
            <Monitor patch={patch} />
          </div>
        ) : (
          <>
            <Previz
              patch={patch}
              selection={tool === 'placement' ? selection : []}
              onPick={(id) => {
                if (tool === 'placement') setSelection(id ? [id] : [])
              }}
            />
            {tool === 'placement' && (
              <PlacementPanel
                patch={patch}
                selection={selection}
                dirty={dirty}
                onSelect={setSelection}
                onChange={setPatch}
                onSave={handleSavePatch}
                onRevert={handleRevertPatch}
              />
            )}
            {tool === 'runs' && <RunsPanel onClose={() => setTool(null)} />}
            {tool === 'output' && <OutputPanel onClose={() => setTool(null)} />}
            {tool === 'diag' && (
              <Diagnostics patch={patch} show={show} onClose={() => setTool(null)} />
            )}
            {mode === 'edit' && selectedSceneId && show && (
              <SceneEditor
                show={show}
                sceneId={selectedSceneId}
                onChange={handleShowChange}
                onClose={() => setSelectedSceneId(null)}
                onSelect={setSelectedSceneId}
              />
            )}
            {/* Nothing to look at yet: say so in the middle of the empty room
                rather than in a card floating over it. */}
            {(!connected || (totalPps === 0 && stats?.udp.listening)) && (
              <div className="stage-empty">
                <span className="stage-empty-title">
                  {connected ? 'Waiting for the console' : 'Connecting to the server'}
                </span>
                <span className="stage-empty-note">Nothing is ever sent to the lights.</span>
              </div>
            )}
          </>
        )}
      </main>
      {/* Watch is a show monitor, not an editor with its buttons hidden: it
          answers where we are, what is on the walls and what comes next. */}
      {show &&
        (mode === 'watch' ? (
          <WatchBar show={show} />
        ) : (
          <Timeline
            show={show}
            mode={mode}
            onChange={handleShowChange}
            saveState={showSaveState}
            selectedSceneId={selectedSceneId}
            onSelectScene={handleSelectScene}
            onAddScene={handleAddScene}
          />
        ))}
    </div>
  )
}

// Wall clock. A control room screen that shows the show's timecode but not
// the actual time of day is missing the one thing everyone else in the room
// is looking at their phone for.
function WallClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 10_000)
    return () => clearInterval(id)
  }, [])
  return (
    <span className="wall-clock" title="Local time">
      {String(now.getHours()).padStart(2, '0')}:{String(now.getMinutes()).padStart(2, '0')}
    </span>
  )
}
