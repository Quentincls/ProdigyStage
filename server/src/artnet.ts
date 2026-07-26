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

const HEADER = Buffer.from('Art-Net\0', 'ascii')
export const OP_DMX = 0x5000
const PROTOCOL_VERSION = 14
export const DMX_CHANNELS = 512

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
