// Builds the distributable package: dist-package/LumenStage + a zip archive.
// The zip is written with unix mode 0755 on the .command launchers so they
// stay double-clickable after extraction on macOS (a plain Windows zip would
// strip the executable bit).

import { execSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import archiver from 'archiver'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT_DIR = join(ROOT, 'dist-package')
const STAGE = join(OUT_DIR, 'LumenStage')
const ZIP_NAME = 'LumenStage-Previz-v3.zip'
const LIVRABLES = 'C:\\Users\\quent\\Desktop\\Livrables'

console.log('package: building server + ui...')
execSync('npm run build', { cwd: ROOT, stdio: 'inherit', shell: true })

console.log('package: assembling LumenStage/ ...')
rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(join(STAGE, 'server'), { recursive: true })
mkdirSync(join(STAGE, 'data'), { recursive: true })

for (const file of readdirSync(join(ROOT, 'server', 'dist'))) {
  if (file.endsWith('.js')) {
    copyFileSync(join(ROOT, 'server', 'dist', file), join(STAGE, 'server', file))
  }
}
cpSync(join(ROOT, 'ui', 'dist'), join(STAGE, 'ui'), { recursive: true })
copyFileSync(join(ROOT, 'data', 'patch.json'), join(STAGE, 'data', 'patch.json'))
cpSync(join(ROOT, 'node_modules', 'ws'), join(STAGE, 'node_modules', 'ws'), { recursive: true })
// The shared effect engine is a workspace package: npm links it, so the copy
// must dereference the symlink to land real files in the client's zip.
cpSync(
  join(ROOT, 'node_modules', '@prodigy-stage', 'core'),
  join(STAGE, 'node_modules', '@prodigy-stage', 'core'),
  { recursive: true, dereference: true },
)

const launchers = join(ROOT, 'scripts', 'launchers')
for (const file of readdirSync(launchers)) {
  copyFileSync(join(launchers, file), join(STAGE, file))
}
copyFileSync(join(ROOT, 'docs', 'client', 'README.html'), join(STAGE, 'README.html'))

// Build stamp shown by Update-LumenStage so "am I on the new version?" is
// answerable over the phone.
let commit = 'unknown'
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim()
} catch {
  // not a git checkout (e.g. building from an exported archive)
}
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
writeFileSync(join(STAGE, 'version.txt'), `LumenStage build ${stamp} UTC (${commit})\n`)

console.log('package: zipping...')
const zipPath = join(OUT_DIR, ZIP_NAME)
await new Promise((resolve, reject) => {
  const output = createWriteStream(zipPath)
  const archive = archiver('zip', { zlib: { level: 9 } })
  output.on('close', resolve)
  archive.on('error', reject)
  archive.pipe(output)
  archive.directory(STAGE, 'LumenStage', (entry) =>
    entry.name.endsWith('.command') ? false : entry,
  )
  for (const file of readdirSync(STAGE)) {
    if (file.endsWith('.command')) {
      archive.file(join(STAGE, file), { name: `LumenStage/${file}`, mode: 0o755 })
    }
  }
  void archive.finalize()
})

if (existsSync(LIVRABLES)) {
  copyFileSync(zipPath, join(LIVRABLES, ZIP_NAME))
  console.log(`package: copied to ${join(LIVRABLES, ZIP_NAME)}`)
}
console.log(`package: done -> ${zipPath}`)
