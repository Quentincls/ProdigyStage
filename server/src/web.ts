// HTTP + WebSocket server: serves the built UI (when present), exposes
// /api/patch, and pushes the consolidated DMX state to the browser.
// Hand-rolled static serving on purpose: no backend framework (brief).

import { spawn } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

export const WEB_PORT = 4480

// Repo layout (server/src or server/dist -> ../../ui/dist) vs package layout
// (LumenStage/server -> ../ui).
const UI_CANDIDATES = ['../../ui/dist', '../ui']

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

function uiRoot(): string | null {
  for (const candidate of UI_CANDIDATES) {
    const path = fileURLToPath(new URL(candidate, import.meta.url))
    if (existsSync(join(path, 'index.html'))) return path
  }
  return null
}

export interface WebOptions {
  port?: number
  readPatch: () => string
  writePatch: (raw: string) => void
  readShow: () => string
  writeShow: (raw: string) => void
  listRecordings: () => unknown
  controlRecord: (action: string) => unknown
  controlReplay: (action: string, file?: string) => unknown
  controlOutput: (action: string, value?: unknown) => unknown
  /** Phase 7: the music the show is built against. */
  listMusic: () => unknown
  controlMusic: (action: string, file?: string) => unknown
  musicPath: (file: string) => string | null
  openBrowser?: boolean
}

export function startWebServer(options: WebOptions): { server: Server; wss: WebSocketServer } {
  const port = options.port ?? WEB_PORT
  const root = uiRoot()

  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    const url = (req.url ?? '/').split('?')[0]

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (url === '/api/patch' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 1_000_000) req.destroy()
      })
      req.on('end', () => {
        try {
          options.writePatch(body)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
          console.log('web: patch.json updated from the placement UI')
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: (error as Error).message }))
        }
      })
      return
    }

    if (url === '/api/patch') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(options.readPatch())
      return
    }

    if (url === '/api/show' && req.method === 'POST') {
      collectBody(req, res, (body) => {
        options.writeShow(body)
        return { ok: true }
      })
      return
    }

    if (url === '/api/show') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(options.readShow())
      return
    }

    if (url === '/api/recordings') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(options.listRecordings()))
      return
    }

    if (url === '/api/record' && req.method === 'POST') {
      collectBody(req, res, (body) => {
        const { action } = JSON.parse(body) as { action: string }
        return options.controlRecord(action)
      })
      return
    }

    if (url === '/api/replay' && req.method === 'POST') {
      collectBody(req, res, (body) => {
        const { action, file } = JSON.parse(body) as { action: string; file?: string }
        return options.controlReplay(action, file)
      })
      return
    }

    if (url === '/api/music' && req.method === 'POST') {
      collectBody(req, res, (body) => {
        const { action, file } = JSON.parse(body) as { action: string; file?: string }
        return options.controlMusic(action, file)
      })
      return
    }

    if (url === '/api/music') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(options.listMusic()))
      return
    }

    // The audio itself. Range matters: without it the browser can play the
    // track but not seek inside it, and seeking is most of what editing is.
    if (url.startsWith('/music/')) {
      const path = options.musicPath(decodeURIComponent(url.slice('/music/'.length)))
      if (!path || !existsSync(path)) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const total = statSync(path).size
      const range = req.headers.range
      const type = extname(path) === '.mp3' ? 'audio/mpeg' : 'audio/wav'
      if (range) {
        const match = /bytes=(\d*)-(\d*)/.exec(range)
        const start = match && match[1] ? Number(match[1]) : 0
        const end = match && match[2] ? Math.min(Number(match[2]), total - 1) : total - 1
        if (start >= total || start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` })
          res.end()
          return
        }
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        })
        createReadStream(path, { start, end }).pipe(res)
        return
      }
      res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': total })
      createReadStream(path).pipe(res)
      return
    }

    // Phase 6: the only endpoint that can make this software transmit.
    if (url === '/api/output' && req.method === 'POST') {
      collectBody(req, res, (body) => {
        const { action, value } = JSON.parse(body) as { action: string; value?: unknown }
        return options.controlOutput(action, value)
      })
      return
    }

    if (!root) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('PRODIGY STAGE server is running.\nUI build not found - in dev, open http://localhost:3019 (npm run dev).\n')
      return
    }

    const relative = normalize(url === '/' ? 'index.html' : url.replace(/^\/+/, ''))
    const filePath = join(root, relative)
    if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      // SPA fallback: unknown paths get the app shell.
      res.writeHead(200, { 'Content-Type': MIME['.html'] })
      res.end(readFileSync(join(root, 'index.html')))
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' })
    res.end(readFileSync(filePath))
  })

  const wss = new WebSocketServer({ server })

  server.listen(port, () => {
    const url = `http://localhost:${port}`
    console.log(`web: UI + WebSocket on ${url}${root ? '' : ' (UI build not found, dev mode)'}`)
    if (options.openBrowser) openBrowser(url)
  })

  return { server, wss }
}

// Shared body collector for the small JSON POST endpoints: 200 with the
// handler's JSON result, 400 with the error message if the handler throws.
function collectBody(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  handle: (body: string) => unknown,
): void {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
    if (body.length > 1_000_000) req.destroy()
  })
  req.on('end', () => {
    try {
      const result = handle(body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result ?? { ok: true }))
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (error as Error).message }))
    }
  })
}

function openBrowser(url: string): void {
  const platform = process.platform
  try {
    if (platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
    else if (platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' })
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
  } catch {
    // Opening the browser is best-effort; the URL is in the console anyway.
  }
}
