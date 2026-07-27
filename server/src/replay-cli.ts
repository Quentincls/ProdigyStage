// Standalone replay: `npm run replay -- <file.artrec>` re-emits a recording
// to 127.0.0.1:6454 (works with or without the main server running).

import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { Replayer } from './replayer.js'

const file = process.argv[2]
if (!file) {
  console.error('usage: npm run replay -- <path/to/run.artrec>')
  process.exit(1)
}
const path = resolve(file)
if (!existsSync(path)) {
  console.error(`replay: file not found: ${path}`)
  process.exit(1)
}

const replayer = new Replayer(process.env.REPLAY_TARGET ?? '127.0.0.1')
replayer.onEnd = () => process.exit(0)
replayer.start(path, basename(path))

process.on('SIGINT', () => {
  replayer.onEnd = null
  replayer.stop()
  process.exit(0)
})
