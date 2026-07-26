import { useEffect, useState, useSyncExternalStore } from 'react'
import { feed } from './feed'
import Monitor from './Monitor'
import { fetchPatch, type Patch } from './patch'

export default function App() {
  const [patch, setPatch] = useState<Patch | null>(null)
  const { connected, stats } = useSyncExternalStore(feed.subscribe, feed.getSnapshot)

  useEffect(() => {
    feed.start()
    void fetchPatch().then(setPatch)
  }, [])

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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>PRODIGY STAGE</h1>
          <span className="page">Monitor</span>
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
        {patch ? <Monitor patch={patch} /> : <p className="loading">Waiting for server…</p>}
      </main>
    </div>
  )
}
