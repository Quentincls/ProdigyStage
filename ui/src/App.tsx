import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { feed } from './feed'
import Monitor from './Monitor'
import { fetchPatch, savePatch, type Patch } from './patch'
import PlacementPanel from './previz/PlacementPanel'
import Previz from './previz/Previz'
import { fetchShow, saveShow, type ShowFile } from './show'
import Timeline from './Timeline'

type View = 'previz' | 'monitor'

export default function App() {
  const [patch, setPatch] = useState<Patch | null>(null)
  const [savedJson, setSavedJson] = useState('')
  const [view, setView] = useState<View>('previz')
  const [placement, setPlacement] = useState(false)
  const [selection, setSelection] = useState<string[]>([])
  const { connected, stats } = useSyncExternalStore(feed.subscribe, feed.getSnapshot)

  const [show, setShow] = useState<ShowFile | null>(null)
  const [showSaveState, setShowSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const showSaveTimer = useRef<number | null>(null)
  const showLoaded = useRef(false)

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
      .catch(() => setShow({ markers: [] }))
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
  const sources = stats
    ? [...new Set(Object.values(stats.perUniverse).map((u) => u.from).filter(Boolean))]
    : []

  let statusText: string
  if (!connected) statusText = 'Connecting to server…'
  else if (!stats?.udp.listening) statusText = `Server up — UDP ${stats?.udp.port ?? 6454} unavailable`
  else if (totalPps > 0)
    statusText = `Listening on universes 1–4 — ${totalPps} pkt/s${sources.length ? ` from ${sources.join(', ')}` : ''}`
  else statusText = 'Listening on universes 1–4 — no Art-Net traffic'

  async function handleSave(): Promise<void> {
    if (!patch) return
    await savePatch(patch)
    setSavedJson(JSON.stringify(patch))
  }

  function handleRevert(): void {
    if (savedJson) setPatch(JSON.parse(savedJson) as Patch)
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>PRODIGY STAGE</h1>
          <nav className="tabs">
            <button className={view === 'previz' ? 'active' : ''} onClick={() => setView('previz')}>
              Previz
            </button>
            <button
              className={view === 'monitor' ? 'active' : ''}
              onClick={() => setView('monitor')}
            >
              Monitor
            </button>
          </nav>
          {view === 'previz' && (
            <button
              className={`ghost-button ${placement ? 'active' : ''}`}
              onClick={() => setPlacement(!placement)}
            >
              Placement
            </button>
          )}
          {dirty && <span className="dirty-badge">unsaved changes</span>}
        </div>
        <div className="statusline">
          <span className={`dot ${connected && totalPps > 0 ? 'ok' : connected ? 'idle' : 'down'}`} />
          <span>{statusText}</span>
          {stats && stats.otherPps > 0 && (
            <span className="muted">+{stats.otherPps} pkt/s on other universes</span>
          )}
        </div>
      </header>
      <main className="content">
        {!patch ? (
          <p className="loading">Waiting for server…</p>
        ) : view === 'previz' ? (
          <>
            <Previz
              patch={patch}
              selection={selection}
              onPick={(id) => setSelection(id ? [id] : [])}
            />
            {placement && (
              <PlacementPanel
                patch={patch}
                selection={selection}
                dirty={dirty}
                onSelect={setSelection}
                onChange={setPatch}
                onSave={handleSave}
                onRevert={handleRevert}
              />
            )}
            {(!connected || totalPps === 0) && (
              <div className="welcome">
                <h2>LumenStage Previz</h2>
                <div className="welcome-row">
                  <span className={`dot ${connected ? 'idle' : 'down'}`} />
                  <span>{connected ? 'Server connected' : 'Connecting to server…'}</span>
                </div>
                <div className="welcome-row">
                  <span className={`dot ${connected && stats?.udp.listening ? 'idle' : 'down'}`} />
                  <span>
                    {stats?.udp.listening
                      ? 'Listening for Art-Net on universes 1–4 — waiting for the console or the fake show'
                      : `UDP ${stats?.udp.port ?? 6454} unavailable`}
                  </span>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="monitor-wrap">
            <Monitor patch={patch} />
          </div>
        )}
      </main>
      {show && <Timeline show={show} onChange={handleShowChange} saveState={showSaveState} />}
    </div>
  )
}
