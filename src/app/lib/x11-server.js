/**
 * local x server managed by electerm (windows only)
 *
 * - vcxsrv: start VcXsrv on display :n (tcp 6000 + n)
 * - wslg: bridge the WSLg x server to tcp with a small perl script
 *   inside WSL (perl-base is an essential package on Debian/Ubuntu, so
 *   nothing to install), WSL2 localhost forwarding makes it reachable
 *   from windows
 *
 * Never started on a port that is taken: an x server or program there that
 * is not ours (one that takes our cookie and turns away any other) is
 * reported with the program's name and a free port, and the user picks:
 * that port, or (an x server that takes any client) using that one. So x
 * clients never end up on a server the user did not pick.
 *
 * Both only accept x clients that present our MIT-MAGIC-COOKIE-1: VcXsrv
 * listens on every interface, the bridge on 127.0.0.1. The cookie goes to
 * the remote side with the ssh x11 request, so only the forwarded apps
 * know it. It is kept on disk, so a server left over from an earlier run
 * still matches.
 *
 * Lives in the main process on purpose: every ssh tab runs in its own
 * session process, the x server must outlive any single tab. One instance is
 * shared by all sessions, it is only stopped when the app quits, and only
 * when electerm started it (an x server the user runs is never touched).
 * Settings are read from the main process config, never from the renderer:
 * the vcxsrv path is an executable we start.
 */

const { spawn, execFile } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const net = require('net')
const path = require('path')
const log = require('../common/log')
const globalState = require('./glob-state')
const { probeXServer } = require('../server/x11')

const defaultVcxsrvPath = 'C:\\Program Files\\VcXsrv\\vcxsrv.exe'
const defaultPort = 6000
const authName = 'MIT-MAGIC-COOKIE-1'
const startTimeout = 8000

let owned = null
let pending = null
// port of a foreign x server the user chose to use, for this run
let sharedPort = null

/**
 * tcp 127.0.0.1:port -> unix socket, one forked child per x client.
 * Checks the client's cookie and forwards the setup request without auth,
 * WSLg trusts local clients. Fed to perl on stdin: no quoting through
 * wsl.exe, and the cookie never shows up in a process list.
 */
function wslgBridge (port, cookie, socketPath = '/tmp/.X11-unix/X0') {
  return `
use IO::Socket::INET; use IO::Socket::UNIX; use IO::Select;
$SIG{CHLD} = 'IGNORE';
my $cookie = pack('H*', '${cookie}');
my $l = IO::Socket::INET->new(LocalAddr => '127.0.0.1', LocalPort => ${port},
  Listen => 16, ReuseAddr => 1) or die "listen ${port}: $!\\n";
sub rd {
  my ($fh, $len) = @_;
  my $buf = '';
  while (length($buf) < $len) {
    my $n = sysread($fh, $buf, $len - length($buf), length($buf));
    return undef unless $n;
  }
  return $buf;
}
sub pad4 { ($_[0] + 3) & ~3 }
while (1) {
  my $c = $l->accept or next;
  my $pid = fork;
  if (!defined $pid || $pid) { close $c; next }
  close $l;
  # setup request: byte order, pad, major, minor, name len, data len, pad
  my $h = rd($c, 12);
  exit 0 unless defined $h;
  my $f = substr($h, 0, 1) eq 'l' ? 'v' : 'n';
  my ($nl, $dl) = unpack("x6 $f $f", $h);
  my $auth = rd($c, pad4($nl) + pad4($dl));
  exit 0 unless defined $auth
    && substr($auth, 0, $nl) eq '${authName}'
    && substr($auth, pad4($nl), $dl) eq $cookie;
  my $x = IO::Socket::UNIX->new(Peer => '${socketPath}') or exit 1;
  syswrite($x, substr($h, 0, 6) . pack("$f $f x2", 0, 0));
  my $s = IO::Select->new($c, $x);
  my $buf;
  while (1) {
    for my $r ($s->can_read) {
      my $n = sysread($r, $buf, 65536);
      exit 0 unless $n;
      my $o = $r == $c ? $x : $c;
      for (my $off = 0; $off < $n;) {
        my $w = syswrite($o, $buf, $n - $off, $off);
        exit 0 unless defined $w;
        $off += $w;
      }
    }
  }
}
`
}

/**
 * one Xauthority entry, any address (FamilyWild)
 * @param {number} display
 * @param {string} cookie hex
 * @return {Buffer}
 */
function xauthEntry (display, cookie) {
  const field = (b) => {
    const len = Buffer.alloc(2)
    len.writeUInt16BE(b.length)
    return Buffer.concat([len, b])
  }
  return Buffer.concat([
    Buffer.from([0xff, 0xff]),
    field(Buffer.alloc(0)),
    field(Buffer.from(String(display))),
    field(Buffer.from(authName)),
    field(Buffer.from(cookie, 'hex'))
  ])
}

/**
 * @param {object} config electerm config
 * @return {{type: string, port: number, vcxsrvPath: string} | null}
 *   null: nothing to manage
 */
function getX11Options (config = {}) {
  const type = config.x11Server
  if (type !== 'wslg' && type !== 'vcxsrv') {
    return null
  }
  const port = parseInt(config.x11Port, 10)
  return {
    type,
    port: port >= 6000 && port <= 6099 ? port : defaultPort,
    vcxsrvPath: config.x11VcxsrvPath || defaultVcxsrvPath
  }
}

/**
 * @param {object} opts from getX11Options
 * @param {string} cookie hex
 * @param {string} authFile Xauthority file for vcxsrv
 * @return {{cmd: string, args: string[], stdin?: string}}
 */
function buildX11ServerCommand (opts, cookie, authFile) {
  if (opts.type === 'wslg') {
    return {
      cmd: 'wsl.exe',
      args: ['-e', 'perl'],
      stdin: wslgBridge(opts.port, cookie)
    }
  }
  return {
    cmd: opts.vcxsrvPath,
    args: [
      ':' + (opts.port - defaultPort),
      '-multiwindow', '-clipboard', '-wgl',
      '-auth', authFile
    ]
  }
}

function getX11Dir () {
  const { appPath } = require('../common/app-props')
  return path.join(appPath, 'electerm', 'x11')
}

/**
 * the cookie, created once and kept
 * @return {{cookie: string, authFile: string}}
 */
function getCookie (opts, dir = getX11Dir()) {
  fs.mkdirSync(dir, { recursive: true })
  const cookieFile = path.join(dir, 'cookie')
  let cookie = ''
  try {
    cookie = fs.readFileSync(cookieFile, 'utf8').trim()
  } catch (e) {}
  if (!/^[0-9a-f]{32}$/.test(cookie)) {
    cookie = crypto.randomBytes(16).toString('hex')
    fs.writeFileSync(cookieFile, cookie, { mode: 0o600 })
  }
  const authFile = path.join(dir, 'Xauthority')
  fs.writeFileSync(authFile, xauthEntry(opts.port - defaultPort, cookie), { mode: 0o600 })
  return { cookie, authFile }
}

/**
 * x connection setup with a cookie on 127.0.0.1:port
 * @param {number} port
 * @param {string} cookie hex
 * @param {number} timeout ms
 * @return {Promise<string>} 'free' nothing listens, 'ok' accepted,
 *   'denied' refused (failed / authenticate), 'closed' closed without an
 *   answer, 'silent' no answer
 */
function xSetup (port, cookie, timeout = 1500) {
  return new Promise(resolve => {
    const sock = net.connect(port, '127.0.0.1')
    let state = 'free'
    const done = r => {
      clearTimeout(timer)
      sock.destroy()
      resolve(r)
    }
    const timer = setTimeout(() => done(state === 'free' ? 'free' : 'silent'), timeout)
    sock.on('connect', () => {
      state = 'connected'
      const name = Buffer.from(authName)
      const data = Buffer.from(cookie, 'hex')
      const pad = b => Buffer.concat([b, Buffer.alloc((4 - b.length % 4) % 4)])
      const head = Buffer.alloc(12)
      head.write('l', 0)
      head.writeUInt16LE(11, 2)
      head.writeUInt16LE(name.length, 6)
      head.writeUInt16LE(data.length, 8)
      sock.write(Buffer.concat([head, pad(name), pad(data)]))
    })
    sock.on('data', d => done(d[0] === 1 ? 'ok' : 'denied'))
    sock.on('error', () => done(state === 'free' ? 'free' : 'closed'))
    sock.on('close', () => done(state === 'free' ? 'free' : 'closed'))
  })
}

/**
 * who has the port: nobody, our x server (from this or an earlier run), an x
 * server taking any client ('open'), one with its own access control
 * ('x11'), or something else
 * @return {Promise<'free'|'ours'|'open'|'x11'|'other'>}
 */
async function portOwner (port, cookie, setup = xSetup) {
  const mine = await setup(port, cookie)
  if (mine === 'free') {
    return 'free'
  }
  if (mine === 'ok') {
    // ours takes only our cookie; an x server without access control
    // takes any
    const other = await setup(port, crypto.randomBytes(16).toString('hex'))
    return other === 'ok' ? 'open' : 'ours'
  }
  return mine === 'denied' ? 'x11' : 'other'
}

/**
 * the first port from 6000-6099 nobody listens on, after `port`, then
 * before it
 * @return {Promise<number|null>}
 */
async function freePort (port, cookie, setup = xSetup) {
  const after = []
  const before = []
  for (let p = defaultPort; p <= 6099; p++) {
    if (p !== port) {
      (p > port ? after : before).push(p)
    }
  }
  for (const p of [...after, ...before]) {
    if (await setup(p, cookie, 500) === 'free') {
      return p
    }
  }
  return null
}

/**
 * pid listening on tcp `port`, from `netstat -ano -p TCP`; the state column
 * is translated, a listener is the one without remote end (0.0.0.0:0)
 */
function listenerPid (netstat, port) {
  for (const line of netstat.split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+(\S+)\s+\S+\s+(\d+)$/i)
    if (m && +m[1] === port && /:0$/.test(m[2])) {
      return +m[3]
    }
  }
  return 0
}

function run (cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 5000, encoding: 'latin1' },
      (e, out) => e ? reject(e) : resolve(out))
  })
}

/**
 * windows: name of the program listening on `port`, '' unknown
 * @return {Promise<string>}
 */
async function portProgram (port, exec = run) {
  try {
    const pid = listenerPid(await exec('netstat', ['-ano', '-p', 'TCP']), port)
    if (!pid) {
      return ''
    }
    const out = await exec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
    const m = out.match(/^"([^"]+)"/m)
    return m ? m[1] : ''
  } catch (e) {
    return ''
  }
}

function portTakenMessage (opts, owner, program = '') {
  const name = opts.type === 'wslg' ? 'WSLg' : 'VcXsrv'
  const xserver = owner === 'open' || owner === 'x11'
  const what = program
    ? `${program} (${xserver ? 'an X server' : 'not an X server'})`
    : xserver ? 'another X server' : 'another program'
  return `Port ${opts.port} is already in use by ${what}, so electerm did not start ${name} there.`
}

function waitForServer (proc, endpoint, getError) {
  const until = Date.now() + startTimeout
  const check = async () => {
    if (await probeXServer(endpoint, 300)) {
      return true
    }
    if (proc.exitCode !== null || proc.killed || Date.now() > until) {
      throw new Error(getError() || 'x server did not start')
    }
    await new Promise(resolve => setTimeout(resolve, 300))
    return check()
  }
  return check()
}

/**
 * @param {object} opts from getX11Options
 * @param {boolean} share use a foreign x server that takes any client
 */
async function start (opts, share) {
  const { cookie, authFile } = getCookie(opts)
  const result = { ok: true, port: opts.port, cookie, authFile }
  const endpoint = [{ port: opts.port, host: '127.0.0.1' }]
  const owner = await portOwner(opts.port, cookie)
  // already running: started by us, now or in an earlier run
  if (owner === 'ours') {
    return result
  }
  if (owner === 'open' && (share || sharedPort === opts.port)) {
    sharedPort = opts.port
    return { ...result, shared: true }
  }
  if (owner !== 'free') {
    const program = await portProgram(opts.port)
    const e = new Error(portTakenMessage(opts, owner, program))
    e.conflict = {
      port: opts.port,
      owner,
      program,
      suggestion: await freePort(opts.port, cookie)
    }
    throw e
  }
  const command = buildX11ServerCommand(opts, cookie, authFile)
  log.log('start x11 server:', command.cmd, command.args.join(' '))
  let error = ''
  const proc = spawn(command.cmd, command.args, {
    windowsHide: true,
    stdio: [command.stdin ? 'pipe' : 'ignore', 'ignore', 'pipe']
  })
  if (command.stdin) {
    proc.stdin.on('error', () => {})
    proc.stdin.end(command.stdin)
  }
  proc.stderr.on('data', d => {
    error += d.toString()
  })
  proc.on('error', e => {
    error = e.message
  })
  proc.on('exit', code => {
    log.log('x11 server exited', code)
    if (owned?.proc === proc) {
      owned = null
    }
  })
  owned = { proc }
  await waitForServer(proc, endpoint, () => error.trim())
  return result
}

/**
 * make sure the configured x server is up, concurrent calls share one start
 * @param {{port?: number, share?: boolean}} choice the user's answer to a
 *   taken port: start on this port (the config may not be saved yet), or
 *   use the x server there
 * @return {Promise<{ok: boolean, port?: number, cookie?: string, authFile?: string, shared?: boolean, error?: string, conflict?: object}>}
 *   no port: nothing managed, the session keeps its own x11 lookup;
 *   conflict: the port is taken, {port, owner, program, suggestion}
 */
function ensureX11Server (choice = {}) {
  const config = { ...globalState.get('config') }
  if (choice.port) {
    config.x11Port = choice.port
  }
  const opts = process.platform === 'win32' && getX11Options(config)
  if (!opts) {
    return Promise.resolve({ ok: true })
  }
  const go = () => start(opts, !!choice.share)
    .catch(e => ({ ok: false, error: e.message, conflict: e.conflict }))
  if (choice.port || choice.share) {
    return go()
  }
  if (!pending) {
    pending = go().finally(() => {
      pending = null
    })
  }
  return pending
}

function stopX11Server () {
  if (!owned) {
    return
  }
  const { proc } = owned
  owned = null
  proc.kill()
}

process.on('exit', stopX11Server)

module.exports = {
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
  ensureX11Server,
  stopX11Server
}
