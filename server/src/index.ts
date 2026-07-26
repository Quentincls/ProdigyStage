// Phase 0 scaffold. The Art-Net listener (UDP 6454), the DMX state buffers and
// the WebSocket bridge to the UI arrive in Phase 1. Nothing is received or
// emitted on the network yet.

import { loadPatch } from './patch.js'

const patch = loadPatch()

console.log('PRODIGY STAGE server -- Phase 0 scaffold')
console.log(
  `Patch loaded: ${patch.fixtures.length} fixtures ` +
    `(${Object.keys(patch.fixtureTypes).join(', ')}) on universes 1-4`,
)
console.log('Art-Net listener arrives in Phase 1.')

// Keep the process alive so `npm run dev` behaves like the future server.
setInterval(() => {}, 1 << 30)
