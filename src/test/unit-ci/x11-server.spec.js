const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  wslgBridge,
  xauthEntry,
  getX11Options,
  buildX11ServerCommand,
  getCookie,
  portOwner,
  freePort,
  listenerPid,
  portProgram,
  portTakenMessage,
  ensureX11Server
} = require('../../../src/app/lib/x11-server')
const net = require('node:net')

const cookie = '00112233445566778899aabbccddeeff'

describe('x11 server', () => {
  test('external or unset: nothing to manage', () => {
    assert.equal(getX11Options({ x11Server: 'external' }), null)
    assert.equal(getX11Options({}), null)
    assert.equal(getX11Options(undefined), null)
  })

  test('port: 6000-6099, else default', () => {
    assert.equal(getX11Options({ x11Server: 'wslg' }).port, 6000)
    assert.equal(getX11Options({ x11Server: 'wslg', x11Port: 6012 }).port, 6012)
    assert.equal(getX11Options({ x11Server: 'wslg', x11Port: 22 }).port, 6000)
    assert.equal(getX11Options({ x11Server: 'wslg', x11Port: 6100 }).port, 6000)
  })

  test('wslg: perl bridge on the port, checks the cookie', () => {
    const c = buildX11ServerCommand(getX11Options({ x11Server: 'wslg', x11Port: 6003 }), cookie)
    assert.equal(c.cmd, 'wsl.exe')
    assert.deepEqual(c.args, ['-e', 'perl'])
    assert.match(c.stdin, /LocalAddr => '127\.0\.0\.1', LocalPort => 6003/)
    assert.ok(c.stdin.includes(`pack('H*', '${cookie}')`))
    assert.ok(c.stdin.includes("eq 'MIT-MAGIC-COOKIE-1'"))
    assert.ok(c.stdin.includes("Peer => '/tmp/.X11-unix/X0'"))
    // cookie only on stdin, never on the command line
    assert.ok(!c.args.join(' ').includes(cookie))
  })

  test('vcxsrv: display from port, auth file instead of -ac', () => {
    const opts = getX11Options({ x11Server: 'vcxsrv', x11Port: 6002, x11VcxsrvPath: 'D:\\x\\vcxsrv.exe' })
    const c = buildX11ServerCommand(opts, cookie, 'C:\\a\\Xauthority')
    assert.equal(c.cmd, 'D:\\x\\vcxsrv.exe')
    assert.equal(c.args[0], ':2')
    assert.ok(!c.args.includes('-ac'))
    assert.deepEqual(c.args.slice(-2), ['-auth', 'C:\\a\\Xauthority'])
    assert.equal(
      getX11Options({ x11Server: 'vcxsrv' }).vcxsrvPath,
      'C:\\Program Files\\VcXsrv\\vcxsrv.exe'
    )
  })

  test('xauth entry: FamilyWild, display, MIT-MAGIC-COOKIE-1, cookie', () => {
    assert.equal(
      xauthEntry(2, cookie).toString('hex'),
      'ffff' + '0000' + '0001' + '32' +
      '0012' + Buffer.from('MIT-MAGIC-COOKIE-1').toString('hex') +
      '0010' + cookie
    )
  })

  test('cookie is created once and kept', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-x11-'))
    const opts = getX11Options({ x11Server: 'vcxsrv', x11Port: 6001 })
    const a = getCookie(opts, dir)
    assert.match(a.cookie, /^[0-9a-f]{32}$/)
    assert.equal(getCookie(opts, dir).cookie, a.cookie)
    assert.deepEqual(fs.readFileSync(a.authFile), xauthEntry(1, a.cookie))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('bridge script keeps the socket path parameter', () => {
    assert.ok(wslgBridge(6000, cookie, '/tmp/x').includes("Peer => '/tmp/x'"))
  })

  test('a taken port: ours is used, anything else is reported', async () => {
    // a tiny x server: answers the setup with `reply(data)`, or closes
    const serve = reply => new Promise(resolve => {
      const s = net.createServer(c => c.once('data', d => {
        const r = reply(d)
        r === null ? c.destroy() : c.end(Buffer.from([r]))
      }))
      s.listen(0, '127.0.0.1', () => resolve(s))
    })
    const has = d => d.includes(Buffer.from(cookie, 'hex'))
    const cases = [
      // our bridge: our cookie on, any other closed
      [d => has(d) ? 1 : null, 'ours'],
      // our vcxsrv: our cookie on, any other refused
      [d => has(d) ? 1 : 0, 'ours'],
      // an x server without access control: can be used instead
      [() => 1, 'open'],
      // an x server with its own cookie
      [() => 0, 'x11'],
      // not an x server
      [() => null, 'other']
    ]
    for (const [reply, expected] of cases) {
      const s = await serve(reply)
      assert.equal(await portOwner(s.address().port, cookie), expected)
      await new Promise(resolve => s.close(resolve))
    }
    const free = await serve(() => 1)
    const { port } = free.address()
    await new Promise(resolve => free.close(resolve))
    assert.equal(await portOwner(port, cookie), 'free')
    assert.equal(
      portTakenMessage({ type: 'wslg', port: 6000 }, 'x11'),
      'Port 6000 is already in use by another X server, so electerm did not start WSLg there.'
    )
    assert.equal(
      portTakenMessage({ type: 'vcxsrv', port: 6000 }, 'open', 'XWin_MobaX.exe'),
      'Port 6000 is already in use by XWin_MobaX.exe (an X server), so electerm did not start VcXsrv there.'
    )
    assert.match(portTakenMessage({ type: 'wslg', port: 6001 }, 'other', 'httpd.exe'), /httpd\.exe \(not an X server\)/)
  })

  test('a free port is suggested: after the taken one, then before it', async () => {
    const taken = new Set([6000, 6003, 6004])
    const setup = async p => taken.has(p) ? 'ok' : 'free'
    assert.equal(await freePort(6003, cookie, setup), 6005)
    assert.equal(await freePort(6000, cookie, setup), 6001)
    taken.clear()
    for (let p = 6050; p <= 6099; p++) taken.add(p)
    assert.equal(await freePort(6050, cookie, setup), 6000)
    for (let p = 6000; p <= 6099; p++) taken.add(p)
    assert.equal(await freePort(6050, cookie, setup), null)
  })

  test('the program on a port: netstat listener, then tasklist', async () => {
    // a German Windows: the state column is translated
    const netstat = [
      'Aktive Verbindungen',
      '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              ABH\u00d6REN         1204',
      '  TCP    127.0.0.1:6000         127.0.0.1:51234        HERGESTELLT      28608',
      '  TCP    0.0.0.0:6000           0.0.0.0:0              ABH\u00d6REN         28608',
      '  TCP    [::]:6001              [::]:0                 LISTENING        4711'
    ].join('\r\n')
    assert.equal(listenerPid(netstat, 6000), 28608)
    assert.equal(listenerPid(netstat, 6001), 4711)
    assert.equal(listenerPid(netstat, 6002), 0)
    const calls = []
    const exec = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      return cmd === 'netstat'
        ? netstat
        : '"XWin_MobaX.exe","28608","Console","1","85.432 K"\r\n'
    }
    assert.equal(await portProgram(6000, exec), 'XWin_MobaX.exe')
    assert.deepEqual(calls, ['netstat -ano -p TCP', 'tasklist /FI PID eq 28608 /FO CSV /NH'])
    assert.equal(await portProgram(6002, exec), '')
    assert.equal(await portProgram(6000, async () => { throw new Error('no netstat') }), '')
  })

  test('ensure is a no-op without a managed server', async () => {
    assert.deepEqual(await ensureX11Server(), { ok: true })
  })
})
