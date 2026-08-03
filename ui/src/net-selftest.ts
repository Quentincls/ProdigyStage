// Self-test for the network claims made on the Diagnostics screen
// (`npm run test:net`). These are sentences an operator reads while standing
// in front of a rig that will not light, so a wrong one costs more than none.

import {
  ipToInt,
  onOurNetwork,
  targetsPointingAtTheConsole,
  unroutableTargets,
  type NetworkView,
} from './net.js'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures++
    console.error(`FAIL ${label}${detail ? ` -- ${detail}` : ''}`)
  }
}

// ----- parsing ---------------------------------------------------------------
check('a plain address parses', ipToInt('2.0.0.1') === 0x02000001)
check('the top bit does not go negative', ipToInt('255.255.255.255') === 4294967295)
check('zero parses', ipToInt('0.0.0.0') === 0)
check('a mask parses', ipToInt('255.0.0.0') === 0xff000000)
check('three octets is not an address', ipToInt('2.0.0') === null)
check('five octets is not an address', ipToInt('2.0.0.1.5') === null)
check('an octet over 255 is not an address', ipToInt('2.0.0.256') === null)
check('an empty octet is not an address', ipToInt('2..0.1') === null)
check('a hostname is not an address', ipToInt('artnet-node.local') === null)
check('whitespace is not an address', ipToInt(' 2.0.0.1') === null)

// ----- the venue's own network ----------------------------------------------
// A lighting network is 2.x.x.x with a /8 mask, which is what makes the
// "different subnet" failure so easy to walk into: 2.0.0.1 and 2.0.0.10 look
// related to a human even when the Mac is sitting on 192.168.1.х.
const onTheRig: NetworkView = {
  network: [{ iface: 'en0', address: '2.0.0.50', netmask: '255.0.0.0' }],
  perUniverse: { 1: { from: '2.0.0.1' } },
  output: { targets: ['2.0.0.10'] },
}
check('the node is on our network', onOurNetwork(onTheRig, '2.0.0.10') === true)
check('and so nothing is unroutable', unroutableTargets(onTheRig).length === 0)
check('a far address is not', onOurNetwork(onTheRig, '192.168.1.10') === false)

// The failure this was written for: the Mac hears a broadcasting console
// perfectly from a subnet it cannot answer on.
const strandedOnDhcp: NetworkView = {
  network: [{ iface: 'en0', address: '192.168.1.24', netmask: '255.255.255.0' }],
  perUniverse: { 1: { from: '2.0.0.1' } },
  output: { targets: ['2.0.0.10'] },
}
check('a Mac on the wrong subnet cannot reach the node', unroutableTargets(strandedOnDhcp).join() === '2.0.0.10')

// Self-assigned addressing: the cable is in, nothing handed out a lease.
const selfAssigned: NetworkView = {
  network: [{ iface: 'en0', address: '169.254.13.7', netmask: '255.255.0.0' }],
  perUniverse: { 1: { from: '2.0.0.1' } },
  output: { targets: ['2.0.0.10'] },
}
check('a self-assigned address reaches nothing on the rig', unroutableTargets(selfAssigned).length === 1)

// Two interfaces, one of them right: Wi-Fi up, Ethernet on the lighting net.
const bothCables: NetworkView = {
  network: [
    { iface: 'en1', address: '192.168.1.24', netmask: '255.255.255.0' },
    { iface: 'en0', address: '2.0.0.50', netmask: '255.0.0.0' },
  ],
  perUniverse: { 1: { from: '2.0.0.1' } },
  output: { targets: ['2.0.0.10'] },
}
check('any one interface is enough', unroutableTargets(bothCables).length === 0)

// A narrower mask really does exclude: /24 on 2.0.0.x cannot reach 2.0.1.x.
const narrow: NetworkView = {
  network: [{ iface: 'en0', address: '2.0.0.50', netmask: '255.255.255.0' }],
  perUniverse: {},
  output: { targets: ['2.0.1.10'] },
}
check('a /24 does not span the third octet', unroutableTargets(narrow).join() === '2.0.1.10')

// ----- silence when we cannot know -------------------------------------------
// Every one of these must stay quiet rather than accuse: an operator who is
// told the network is broken when it is not will stop trusting the screen.
check(
  'an older server that reports no addresses says nothing',
  onOurNetwork({ perUniverse: {}, output: { targets: ['2.0.0.10'] } }, '2.0.0.10') === null,
)
check(
  'and accuses nothing',
  unroutableTargets({ perUniverse: {}, output: { targets: ['2.0.0.10'] } }).length === 0,
)
check('no stats at all says nothing', unroutableTargets(null).length === 0)
check(
  'an empty address list says nothing',
  onOurNetwork({ network: [], perUniverse: {}, output: { targets: [] } }, '2.0.0.10') === null,
)
check(
  'a broadcast target is not called unroutable',
  unroutableTargets({
    network: [{ iface: 'en0', address: '2.0.0.50', netmask: '255.0.0.0' }],
    perUniverse: {},
    output: { targets: ['2.255.255.255'] },
  }).length === 0,
)
check(
  'a hostname target is not called unroutable',
  unroutableTargets({
    network: [{ iface: 'en0', address: '2.0.0.50', netmask: '255.0.0.0' }],
    perUniverse: {},
    output: { targets: ['artnet-node.local'] },
  }).length === 0,
)

// ----- sending to the console ------------------------------------------------
check(
  'the console address is caught',
  targetsPointingAtTheConsole({
    perUniverse: { 1: { from: '2.0.0.1' }, 2: { from: '2.0.0.1' } },
    output: { targets: ['2.0.0.1'] },
  }).join() === '2.0.0.1',
)
check(
  'a second console address is caught too',
  targetsPointingAtTheConsole({
    perUniverse: { 1: { from: '2.0.0.1' }, 5: { from: '2.0.0.2' } },
    output: { targets: ['2.0.0.10', '2.0.0.2'] },
  }).join() === '2.0.0.2',
)
check(
  'a node that is not a source is left alone',
  targetsPointingAtTheConsole({
    perUniverse: { 1: { from: '2.0.0.1' } },
    output: { targets: ['2.0.0.10'] },
  }).length === 0,
)
check(
  'universes with no source accuse nobody',
  targetsPointingAtTheConsole({
    perUniverse: { 1: { from: null }, 2: { from: null } },
    output: { targets: ['2.0.0.10'] },
  }).length === 0,
)

if (failures > 0) {
  console.error(`net selftest: ${failures} FAILURES`)
  process.exit(1)
}
console.log('net selftest: OK (address parsing, subnet reach, silence when unknown, console loopback)')
