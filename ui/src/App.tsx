import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { defaultParams } from '../../core/effects'
import { backToLive, editor } from './editor'
import { feed } from './feed'
import Monitor from './Monitor'
import { fetchPatch, savePatch, type Patch } from './patch'
import PlacementPanel from './previz/PlacementPanel'
import Previz from './previz/Previz'
import RunsPanel from './RunsPanel'
import SceneEditor from './SceneEditor'
import { fetchShow, saveShow, type ShowFile } from './show'
import Timeline from './Timeline'
import { round1 } from './TimeInput'

// Two intents, two modes: Watch (default, safe, zero chrome) and Edit.
// Technical tools (DMX monitor, placement, runs) live behind the gear menu.
type Mode = 'watch' | 'edit'
type Tool = 'monitor' | 'placement' | 'runs' | null

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

  // Auto-save show.json, debounced: markers are low-stakes and frequent edits
  // (typing a name) should not hammer the server.
  function handleShowChange(next: ShowFile): void {
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

  const dirty = useMemo(
    () => patch !== null && JSON.stringify(patch) !== savedJson,
    [patch, savedJson],
  )

  const totalPps = stats
    ? Object.values(stats.perUniverse).reduce((sum, u) => sum + u.pps, 0)
    : 0

  // Status in plain words -- the metrics live in the DMX monitor.
  let statusText: string
  let dotClass: string
  if (!connected) {
    statusText = 'Connecting to server…'
    dotClass = 'down'
  } else if (stats?.replay.replaying) {
    statusText = `Replaying ${stats.replay.file ?? ''} — nothing is sent`
    dotClass = 'ok'
  } else if (!stats?.udp.listening) {
    statusText = 'Art-Net port unavailable — open the DMX monitor'
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
    const scene = {
      id: crypto.randomUUID(),
      name: `Scene ${show.scenes.length + 1}`,
      start: round1(start),
      end: round1(start + 60),
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
          <span className={`dot ${dotClass}`} />
          <span>{statusText}</span>
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
                <div className="tools-menu">
                  <button onClick={() => openTool('monitor')}>
                    DMX monitor {tool === 'monitor' ? '·' : ''}
                  </button>
                  <button onClick={() => openTool('placement')}>
                    Placement {tool === 'placement' ? '·' : ''}
                  </button>
                  <button onClick={() => openTool('runs')}>
                    Runs — record and replay {tool === 'runs' ? '·' : ''}
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
              <h2>DMX monitor</h2>
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
            {mode === 'edit' && selectedSceneId && show && (
              <SceneEditor
                show={show}
                sceneId={selectedSceneId}
                onChange={handleShowChange}
                onClose={() => setSelectedSceneId(null)}
              />
            )}
            {(!connected || (totalPps === 0 && stats?.udp.listening)) && (
              <div className="welcome">
                <h2>LumenStage</h2>
                <div className="welcome-row">
                  <span className={`dot ${connected ? 'idle' : 'down'}`} />
                  <span>{connected ? 'Server connected' : 'Connecting to server…'}</span>
                </div>
                <div className="welcome-row">
                  <span className="dot idle" />
                  <span>Waiting for the console or a test show — nothing is ever sent.</span>
                </div>
              </div>
            )}
          </>
        )}
      </main>
      {show && (
        <Timeline
          show={show}
          mode={mode}
          onChange={handleShowChange}
          saveState={showSaveState}
          selectedSceneId={selectedSceneId}
          onSelectScene={handleSelectScene}
          onAddScene={handleAddScene}
        />
      )}
    </div>
  )
}
