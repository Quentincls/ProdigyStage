// Art-Net ArtDMX framing, hand-rolled on purpose (brief section 3): the format is
// tiny and stable, and we do not want to depend on abandoned libraries.

export const ARTNET_PORT = 6454

// Show universes are numbered 1-4 (console convention). On the wire, Art-Net
// port-addresses start at 0, and MagicQ maps console universe N to Art-Net
// universe N-1 by default. Single place to change if the real console says
// otherwise -- to confirm on the first real connection (Phase 3/4bis).
export const SHOW_TO_ARTNET_OFFSET = -1

export function showUniverseToArtnet(showUniverse: number): number {
  return showUniverse + SHOW_TO_ARTNET_OFFSET
}

export function artnetUniverseToShow(artnetUniverse: number): number {
  return artnetUniverse - SHOW_TO_ARTNET_OFFSET
}

const HEADER = Buffer.from('Art-Net\0', 'ascii')
export const OP_DMX = 0x5000
const PROTOCOL_VERSION = 14
export const DMX_CHANNELS = 512

const OP_TIMECODE = 0x9700

// SMPTE frame rates indexed by the ArtTimeCode "type" byte.
export const TIMECODE_FPS = [24, 25, 29.97, 30] as const

export interface ArtTimecode {
  frames: number
  seconds: number
  minutes: number
  hours: number
  fpsType: number
}

export function timecodeToSeconds(tc: ArtTimecode): number {
  const fps = TIMECODE_FPS[tc.fpsType] ?? 25
  return tc.hours * 3600 + tc.minutes * 60 + tc.seconds + tc.frames / fps
}

// ArtTimeCode layout: header(8) opcode(2) protver(2) filler(2) then
// frames, seconds, minutes, hours, type -- 19 bytes total.
export function parseArtTimeCode(msg: Buffer): ArtTimecode | null {
  if (msg.length < 19) return null
  if (!msg.subarray(0, 8).equals(HEADER)) return null
  if (msg.readUInt16LE(8) !== OP_TIMECODE) return null
  return { frames: msg[14], seconds: msg[15], minutes: msg[16], hours: msg[17], fpsType: msg[18] }
}

export function buildArtTimeCodePacket(tc: ArtTimecode): Buffer {
  const packet = Buffer.alloc(19)
  HEADER.copy(packet, 0)
  packet.writeUInt16LE(OP_TIMECODE, 8)
  packet.writeUInt16BE(PROTOCOL_VERSION, 10)
  packet[14] = tc.frames
  packet[15] = tc.seconds
  packet[16] = tc.minutes
  packet[17] = tc.hours
  packet[18] = tc.fpsType
  return packet
}

export interface ArtDmxPacket {
  artnetUniverse: number
  sequence: number
  length: number
  data: Buffer
}

// Returns null for anything that is not a valid ArtDMX packet (ArtPoll,
// ArtSync, foreign UDP traffic...). We are a pure spectator: no replies.
export function parseArtDmx(msg: Buffer): ArtDmxPacket | null {
  if (msg.length < 18) return null
  if (!msg.subarray(0, 8).equals(HEADER)) return null
  if (msg.readUInt16LE(8) !== OP_DMX) return null
  const declaredLength = msg.readUInt16BE(16)
  const length = Math.min(declaredLength, msg.length - 18, DMX_CHANNELS)
  return {
    artnetUniverse: msg.readUInt16LE(14) & 0x7fff,
    sequence: msg[12],
    length,
    data: msg.subarray(18, 18 + length),
  }
}

export function buildArtDmxPacket(
  artnetUniverse: number,
  sequence: number,
  data: Uint8Array,
): Buffer {
  const packet = Buffer.alloc(18 + DMX_CHANNELS)
  HEADER.copy(packet, 0)
  packet.writeUInt16LE(OP_DMX, 8)
  packet.writeUInt16BE(PROTOCOL_VERSION, 10)
  packet[12] = sequence & 0xff
  packet[13] = 0 // physical port, informational only
  packet.writeUInt16LE(artnetUniverse & 0x7fff, 14) // SubUni + Net
  packet.writeUInt16BE(DMX_CHANNELS, 16)
  Buffer.from(data.buffer, data.byteOffset, Math.min(data.length, DMX_CHANNELS)).copy(packet, 18)
  return packet
}
