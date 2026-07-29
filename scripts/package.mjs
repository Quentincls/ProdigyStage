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
  readFileSync,
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
// The same file under a second name: data/patch.json belongs to the operator
// from the first launch onwards and is never overwritten again, so this is how
// a later build tells an old install about fixtures it has never heard of.
copyFileSync(join(ROOT, 'data', 'patch.json'), join(STAGE, 'data', 'patch.reference.json'))

// The music folder ships empty but present, with a note in it. Telling someone
// to "drop the audio in data/music" only works if the folder is there to be
// found -- and a zip cannot carry an empty directory, so the note is also what
// makes it survive the archive.
mkdirSync(join(STAGE, 'data', 'music'), { recursive: true })
writeFileSync(
  join(STAGE, 'data', 'music', 'PUT THE SHOW MUSIC HERE.txt'),
  [
    'Put the show’s audio in this folder, as a WAV file.',
    '',
    'Then open LumenStage, go to Compose, and pick it from the list.',
    'It is read, never modified, and never sent anywhere.',
    '',
    'WAV only for now (.wav). An hour of music takes about twenty seconds',
    'to analyse the first time, and is remembered afterwards.',
    '',
  ].join('\r\n'),
)
// Runtime dependencies, with everything they themselves need. Naming each one
// by hand was fine with a single dependency and is a trap with more: the SDK
// pulls in half a dozen packages, and a missing one is not a build error --
// it is the client's launcher printing ERR_MODULE_NOT_FOUND at a venue.
for (const name of ['ws', '@anthropic-ai/sdk']) copyPackage(name)

// The shared effect engine is a workspace package: npm links it, so the copy
// must dereference the symlink to land real files in the client's zip.
cpSync(
  join(ROOT, 'node_modules', '@prodigy-stage', 'core'),
  join(STAGE, 'node_modules', '@prodigy-stage', 'core'),
  { recursive: true, dereference: true },
)

function copyPackage(name, copied = new Set()) {
  if (copied.has(name)) return copied
  const from = join(ROOT, 'node_modules', name)
  if (!existsSync(from)) throw new Error(`package: ${name} is not installed -- run npm install`)
  copied.add(name)
  cpSync(from, join(STAGE, 'node_modules', name), { recursive: true, dereference: true })
  const manifest = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'))
  // Optional peers are exactly that: ws's bufferutil and the SDK's zod are not
  // installed here and are not needed to run.
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    copyPackage(dependency, copied)
  }
  return copied
}

const launchers = join(ROOT, 'scripts', 'launchers')
for (const file of readdirSync(launchers)) {
  copyFileSync(join(launchers, file), join(STAGE, file))
}
copyFileSync(join(ROOT, 'docs', 'client', 'README.html'), join(STAGE, 'README.html'))

// Without this, Node reparses every server file as ESM and prints a
// MODULE_TYPELESS_PACKAGE_JSON warning in the client's terminal window.
writeFileSync(
  join(STAGE, 'package.json'),
  JSON.stringify({ name: 'lumenstage', private: true, type: 'module' }, null, 2) + '\n',
)

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
