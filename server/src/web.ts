// HTTP + WebSocket server: serves the built UI (when present), exposes
// /api/patch, and pushes the consolidated DMX state to the browser.
// Hand-rolled static serving on purpose: no backend framework (brief).

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
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
  patchJson: () => string
  openBrowser?: boolean
}

export function startWebServer(options: WebOptions): { server: Server; wss: WebSocketServer } {
  const port = options.port ?? WEB_PORT
  const root = uiRoot()

  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    const url = (req.url ?? '/').split('?')[0]

    if (url === '/api/patch') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(options.patchJson())
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
