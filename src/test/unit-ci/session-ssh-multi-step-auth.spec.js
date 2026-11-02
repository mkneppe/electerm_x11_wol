/**
 * Test (#3827): a server that wants two steps, e.g. sshd_config
 * `AuthenticationMethods publickey,password`. After the key the server answers
 * "partial success, now password", and the login has to go on with the
 * password (saved or asked) instead of failing.
 */

process.env.NODE_ENV = 'development'

const { describe, test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const { Server, utils } = require('@electerm/ssh2')
const { session } = require('../../../src/app/server/session-ssh')

const USERNAME = 'tester'
const PASSWORD = 'electerm-test-password'

const HOST_KEY = utils.generateKeyPairSync('ed25519', {
  comment: 'electerm-test-host'
})

function setEnvVar (name, value) {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

// publickey first, then password (or the other way round with `order`)
async function startServer (clientPublicKey, order = ['publickey', 'password']) {
  const clients = new Set()
  const allowed = utils.parseKey(clientPublicKey)

  const server = new Server({
    hostKeys: [HOST_KEY.private]
  }, (client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    const done = new Set()
    client.on('authentication', (ctx) => {
      const next = order.find(m => !done.has(m))
      let ok = false
      if (ctx.username === USERNAME && ctx.method === next) {
        if (next === 'publickey') {
          ok = ctx.key.algo === allowed.type && ctx.key.data.equals(allowed.getPublicSSH())
          // the key check without signature: answer "this key would do"
          if (ok && !ctx.signature) {
            return ctx.accept()
          }
        } else if (next === 'password') {
          ok = ctx.password === PASSWORD
        }
      }
      if (!ok) {
        return ctx.reject([next], done.size > 0)
      }
      done.add(next)
      const after = order.find(m => !done.has(m))
      if (after) {
        return ctx.reject([after], true)
      }
      ctx.accept()
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const sshSession = accept()
        sshSession.on('env', (accept) => accept())
        sshSession.on('pty', (accept) => accept())
        sshSession.on('shell', (accept) => {
          accept().write('electerm ready\n')
        })
      })
    })
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  return {
    port: server.address().port,
    async close () {
      for (const client of clients) {
        client.end()
      }
      await new Promise(resolve => server.close(resolve))
    }
  }
}

// trusts the host key, answers a password prompt with PASSWORD
function createPromptWs () {
  const prompts = []
  return {
    prompts,
    s (payload) {
      if (payload.action === 'session-interactive') {
        prompts.push(payload.options)
      }
    },
    once (handler) {
      queueMicrotask(() => {
        const last = prompts[prompts.length - 1]
        handler({
          results: last && last.mode !== 'confirm' ? [PASSWORD] : ['trust']
        })
      })
    },
    close () {}
  }
}

describe('session-ssh multi step auth (#3827)', () => {
  let tmpDir
  let oldEnv
  let clientKey
  let keyFile
  let sshKeysDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-multi-auth-'))
    oldEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
      sshKeysPath: process.env.sshKeysPath
    }
    sshKeysDir = path.join(tmpDir, 'ssh-keys')
    fs.mkdirSync(sshKeysDir, { recursive: true })
    clientKey = utils.generateKeyPairSync('ed25519')
    keyFile = path.join(tmpDir, 'bookmark_key')
    fs.writeFileSync(keyFile, clientKey.private)
    setEnvVar('HOME', tmpDir)
    setEnvVar('USERPROFILE', tmpDir)
    setEnvVar('SSH_AUTH_SOCK', undefined)
    setEnvVar('sshKeysPath', sshKeysDir)
  })

  afterEach(() => {
    for (const [name, value] of Object.entries(oldEnv)) {
      setEnvVar(name, value)
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function keyInSshDir () {
    fs.writeFileSync(path.join(sshKeysDir, 'id_ed25519'), clientKey.private)
    fs.writeFileSync(path.join(sshKeysDir, 'id_ed25519.pub'), clientKey.public)
  }

  async function connect (extra, order) {
    const server = await startServer(clientKey.public, order)
    const ws = createPromptWs()
    let term
    try {
      term = await session({
        host: '127.0.0.1',
        port: server.port,
        username: USERNAME,
        useSshAgent: false,
        enableSsh: false,
        readyTimeout: 5000,
        ...extra
      }, ws)
      assert.ok(term, 'session should be created')
      return ws.prompts.filter(p => p.mode !== 'confirm')
    } finally {
      term?.kill?.()
      await server.close()
    }
  }

  test('key and password in the bookmark log on without asking', async () => {
    const asked = await connect({ privateKey: clientKey.private, password: PASSWORD })
    assert.equal(asked.length, 0)
  })

  test('key file path and password in the bookmark log on without asking', async () => {
    const asked = await connect({ privateKeyPath: keyFile, password: PASSWORD })
    assert.equal(asked.length, 0)
  })

  test('key only: the password is asked after the key', async () => {
    const asked = await connect({ privateKey: clientKey.private })
    assert.equal(asked.length, 1)
  })

  test('password only: the key from ~/.ssh is used for the first step', async () => {
    keyInSshDir()
    const asked = await connect({ password: PASSWORD })
    assert.equal(asked.length, 0)
  })

  test('nothing in the bookmark: key from ~/.ssh, then the password is asked', async () => {
    keyInSshDir()
    const asked = await connect({})
    assert.equal(asked.length, 1)
  })

  test('password first, then key (AuthenticationMethods password,publickey)', async () => {
    const asked = await connect(
      { privateKey: clientKey.private, password: PASSWORD },
      ['password', 'publickey']
    )
    assert.equal(asked.length, 0)
  })
})
