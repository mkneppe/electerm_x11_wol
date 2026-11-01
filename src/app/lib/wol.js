/**
 * wake on lan: send the magic packet (6 x 0xff, then the mac 16 times) as
 * udp broadcast. Without an explicit address it goes to the directed
 * broadcast of every local ipv4 network plus 255.255.255.255, windows only
 * sends the latter out of one interface.
 */

const dgram = require('dgram')
const dns = require('dns')
const net = require('net')
const os = require('os')
const fs = require('fs')
const { execFile } = require('child_process')

/**
 * @param {string} mac aa:bb:cc:dd:ee:ff, aa-bb-..., or aabbccddeeff
 * @return {Buffer} 102 bytes
 */
function magicPacket (mac) {
  const hex = String(mac || '').replace(/[\s:.-]/g, '')
  if (!/^[0-9a-f]{12}$/i.test(hex)) {
    throw new Error(`invalid MAC address: ${mac}`)
  }
  const m = Buffer.from(hex, 'hex')
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(m)])
}

function broadcastAddresses (ifaces = os.networkInterfaces()) {
  const res = new Set()
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      // skip point-to-point (vpn /32) and link-local, no lan behind them
      if (
        i.family !== 'IPv4' || i.internal || !i.netmask ||
        i.netmask === '255.255.255.255' || i.address.startsWith('169.254.')
      ) {
        continue
      }
      const ip = i.address.split('.').map(Number)
      const mask = i.netmask.split('.').map(Number)
      res.add(ip.map((b, n) => (b | (~mask[n] & 255))).join('.'))
    }
  }
  res.add('255.255.255.255')
  return [...res]
}

/**
 * @param {{mac: string, address?: string, port?: number}} opts
 * @return {Promise<{ok: boolean, targets?: string[], error?: string}>}
 */
async function wakeOnLan ({ mac, address, port = 9 }) {
  const sock = dgram.createSocket('udp4')
  try {
    const packet = magicPacket(mac)
    const targets = address ? [address] : broadcastAddresses()
    await new Promise((resolve, reject) => {
      sock.once('error', reject)
      sock.bind(() => resolve())
    })
    sock.setBroadcast(true)
    const sent = []
    for (const t of targets) {
      // one unreachable network must not stop the others
      await new Promise(resolve => {
        sock.send(packet, port, t, err => {
          err || sent.push(t)
          resolve()
        })
      })
    }
    if (!sent.length) {
      throw new Error('magic packet could not be sent to ' + targets.join(', '))
    }
    return { ok: true, targets: sent }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    sock.close()
  }
}

const ipNum = ip => ip.split('.').reduce((n, b) => n * 256 + Number(b), 0)

/**
 * is the ipv4 address in the network of a local interface: ARP only
 * knows hosts of the own lan
 */
function isLocalNetwork (ip, ifaces = os.networkInterfaces()) {
  return Object.values(ifaces).flat().some(i => i && i.family === 'IPv4' &&
    !i.internal && i.netmask &&
    (ipNum(i.address) & ipNum(i.netmask)) >>> 0 ===
      (ipNum(ip) & ipNum(i.netmask)) >>> 0)
}

/**
 * MAC of ip from `arp -a` (windows, any language), `arp -n` (mac) or
 * /proc/net/arp (linux) output
 * @return {string} aa:bb:cc:dd:ee:ff, empty when not found
 */
function parseArp (text, ip) {
  const esc = ip.replace(/\./g, '\\.')
  const m = text.match(new RegExp(
    '(?:^|[\\s(])' + esc + '\\)?\\s.*?(([0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2})', 'im'
  ))
  if (!m) {
    return ''
  }
  const mac = m[1].split(/[:-]/).map(b => b.padStart(2, '0')).join(':').toLowerCase()
  return /^(00:){5}00$|^(ff:){5}ff$/.test(mac) ? '' : mac
}

function readArpTable (ip) {
  if (process.platform === 'linux') {
    return fs.promises.readFile('/proc/net/arp', 'utf8').catch(() => '')
  }
  const args = process.platform === 'win32' ? ['-a', ip] : ['-n', ip]
  return new Promise(resolve => {
    execFile('arp', args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout))
    })
  })
}

// any packet to the host makes the os resolve its MAC
function pokeHost (ip) {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4')
    sock.on('error', () => {})
    sock.send(Buffer.alloc(1), 9, ip, () => {
      sock.close()
      setTimeout(resolve, 1000)
    })
  })
}

/**
 * MAC address of a host in the local network, for wake on lan
 * @param {string} host ip or name
 * @return {Promise<{ok: boolean, mac?: string, ip?: string, error?: string}>}
 */
async function lookupMac (host) {
  try {
    const { address: ip } = net.isIPv4(String(host || ''))
      ? { address: host }
      : await dns.promises.lookup(String(host), { family: 4 })
    if (!isLocalNetwork(ip)) {
      return { ok: false, ip, error: `${ip} is not in a local network, ARP only knows hosts of the own LAN` }
    }
    let mac = parseArp(await readArpTable(ip), ip)
    if (!mac) {
      await pokeHost(ip)
      mac = parseArp(await readArpTable(ip), ip)
    }
    if (!mac) {
      return {
        ok: false,
        ip,
        error: `no ARP entry for ${ip}: a sleeping host does not answer, ` +
          'look up the MAC while it is on, or in the router'
      }
    }
    return { ok: true, ip, mac }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

module.exports = {
  magicPacket,
  broadcastAddresses,
  wakeOnLan,
  isLocalNetwork,
  parseArp,
  lookupMac
}
