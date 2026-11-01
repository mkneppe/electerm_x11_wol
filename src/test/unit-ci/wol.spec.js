const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const dgram = require('node:dgram')
const {
  magicPacket,
  broadcastAddresses,
  wakeOnLan,
  isLocalNetwork,
  parseArp,
  lookupMac
} = require('../../../src/app/lib/wol')

describe('wake on lan', () => {
  test('magic packet: 6 x ff then the mac 16 times', () => {
    const p = magicPacket('01:23:45:67:89:ab')
    assert.equal(p.length, 102)
    assert.equal(p.subarray(0, 6).toString('hex'), 'ffffffffffff')
    assert.equal(p.subarray(6).toString('hex'), '0123456789ab'.repeat(16))
  })

  test('mac formats', () => {
    const hex = magicPacket('01:23:45:67:89:ab').toString('hex')
    assert.equal(magicPacket('01-23-45-67-89-AB').toString('hex'), hex)
    assert.equal(magicPacket('0123.4567.89ab').toString('hex'), hex)
    assert.equal(magicPacket('0123456789ab').toString('hex'), hex)
    assert.throws(() => magicPacket('01:23:45:67:89'), /invalid MAC/)
    assert.throws(() => magicPacket(''), /invalid MAC/)
  })

  test('broadcast addresses from interfaces', () => {
    assert.deepEqual(broadcastAddresses({
      eth0: [
        { family: 'IPv4', internal: false, address: '192.168.1.20', netmask: '255.255.255.0' },
        { family: 'IPv6', internal: false, address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::' }
      ],
      vpn: [{ family: 'IPv4', internal: false, address: '10.8.3.4', netmask: '255.255.252.0' }],
      ptp: [{ family: 'IPv4', internal: false, address: '10.8.0.6', netmask: '255.255.255.255' }],
      apipa: [{ family: 'IPv4', internal: false, address: '169.254.10.1', netmask: '255.255.0.0' }],
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }]
    }), ['192.168.1.255', '10.8.3.255', '255.255.255.255'])
  })

  test('sends the packet to an explicit address', async () => {
    const server = dgram.createSocket('udp4')
    await new Promise(resolve => server.bind(0, '127.0.0.1', resolve))
    const got = new Promise(resolve => server.once('message', resolve))
    const r = await wakeOnLan({
      mac: 'aa:bb:cc:dd:ee:ff',
      address: '127.0.0.1',
      port: server.address().port
    })
    assert.deepEqual(r, { ok: true, targets: ['127.0.0.1'] })
    assert.equal((await got).toString('hex'), magicPacket('aabbccddeeff').toString('hex'))
    server.close()
  })

  test('invalid mac is reported, not thrown', async () => {
    const r = await wakeOnLan({ mac: 'nope' })
    assert.equal(r.ok, false)
    assert.match(r.error, /invalid MAC/)
  })
})

describe('mac lookup by arp', () => {
  const win = [
    '',
    'Schnittstelle: 192.168.1.74 --- 0x17',
    '  Internetadresse       Physische Adresse     Typ',
    '  192.168.1.1         02-00-5e-10-00-01     dynamisch ',
    '  192.168.1.80        02-00-5e-10-00-50     dynamisch ',
    '  192.168.1.255       ff-ff-ff-ff-ff-ff     statisch  '
  ].join('\r\n')

  test('windows arp -a, any language', () => {
    assert.equal(parseArp(win, '192.168.1.80'), '02:00:5e:10:00:50')
    assert.equal(parseArp(win, '192.168.1.8'), '')
    assert.equal(parseArp(win, '192.168.1.255'), '')
    const en = '  10.0.0.5              00-11-22-33-44-55     dynamic'
    assert.equal(parseArp(en, '10.0.0.5'), '00:11:22:33:44:55')
  })

  test('mac arp -n and linux /proc/net/arp', () => {
    const mac = '? (192.168.1.20) at 0:1b:21:a:b:c on en0 ifscope [ethernet]'
    assert.equal(parseArp(mac, '192.168.1.20'), '00:1b:21:0a:0b:0c')
    const linux = [
      'IP address       HW type     Flags       HW address            Mask     Device',
      '192.168.1.20     0x1         0x2         00:1b:21:0a:0b:0c     *        eth0',
      '192.168.1.21     0x1         0x0         00:00:00:00:00:00     *        eth0'
    ].join('\n')
    assert.equal(parseArp(linux, '192.168.1.20'), '00:1b:21:0a:0b:0c')
    assert.equal(parseArp(linux, '192.168.1.21'), '')
    assert.equal(parseArp(linux, '192.168.1.2'), '')
  })

  test('only hosts of a local network', async () => {
    const ifaces = {
      eth: [{ family: 'IPv4', internal: false, address: '192.168.1.74', netmask: '255.255.255.0' }],
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }]
    }
    assert.equal(isLocalNetwork('192.168.1.80', ifaces), true)
    assert.equal(isLocalNetwork('192.168.2.80', ifaces), false)
    assert.equal(isLocalNetwork('127.0.0.2', ifaces), false)
    const r = await lookupMac('203.0.113.9')
    assert.equal(r.ok, false)
    assert.match(r.error, /not in a local network/)
  })
})
