// The two questions the venue asked that nothing in this software could
// answer: "am I sending to the console by mistake?" and "can this machine
// reach that address at all?".
//
// Pure IPv4 arithmetic over plain data, no imports, so it can be tested
// outside a browser (`npm run test:net`). It makes claims to an operator
// standing in front of a dark rig, so it is tested rather than believed.

/** The shape this module needs: what the server reports about the network. */
export interface NetworkView {
  /** This machine's own IPv4 addresses. Absent on an older server. */
  network?: { iface: string; address: string; netmask: string }[]
  /** Where console frames are arriving from, per universe. */
  perUniverse: Record<string, { from: string | null }>
  output: { targets: string[] }
}

export function ipToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    // Number('') is 0 and Number(' 1') is 1, neither of which is an octet.
    if (!/^\d{1,3}$/.test(part)) return null
    const byte = Number(part)
    if (byte > 255) return null
    value = (value << 8) | byte
  }
  return value >>> 0
}

/**
 * Is `address` on the same IPv4 subnet as one of this machine's own?
 *
 * `null` means "cannot say" -- an older server that does not report its
 * addresses, or something that is not an IPv4 address. Callers must treat
 * `null` as silence, never as a fault: announcing a problem we cannot prove
 * is worse than announcing nothing.
 */
export function onOurNetwork(view: NetworkView | null, address: string): boolean | null {
  const local = view?.network
  if (!local || local.length === 0) return null
  const target = ipToInt(address)
  if (target === null) return null
  for (const entry of local) {
    const mine = ipToInt(entry.address)
    const mask = ipToInt(entry.netmask)
    if (mine === null || mask === null) continue
    if (((mine & mask) >>> 0) === ((target & mask) >>> 0)) return true
  }
  return false
}

/**
 * Output addresses this machine has no route to.
 *
 * Hearing the console proves nothing about being able to answer it. A console
 * broadcasting Art-Net reaches every machine on the wire, including one whose
 * own address is on a different subnet -- a Mac left on DHCP, or fallen back to
 * a self-assigned 169.254 address, hears the whole show perfectly and cannot
 * send a single frame back to the rig. Everything on screen looks healthy; the
 * packets die in the kernel for want of a route.
 */
export function unroutableTargets(view: NetworkView | null): string[] {
  if (!view) return []
  return view.output.targets.filter((target) => onOurNetwork(view, target) === false)
}

/**
 * Output addresses that are in fact the console talking to us.
 *
 * On site this cost a whole session. The address field was set to the console's
 * own IP, so every merged frame was posted straight back at the desk that sent
 * it and the rig never heard a word -- while the panel cheerfully reported
 * frames going out, because they were. Nothing in the software knew that the
 * one address it must never send to was the one address it already knew.
 *
 * It knows now. Not a block: an install where the node and the desk really do
 * share an address is somebody's problem to solve, not ours to forbid.
 */
export function targetsPointingAtTheConsole(view: NetworkView | null): string[] {
  if (!view) return []
  const sources = new Set(
    Object.values(view.perUniverse)
      .map((universe) => universe.from)
      .filter((from): from is string => from !== null),
  )
  return view.output.targets.filter((target) => sources.has(target))
}
