/**
 * Test: setting sshTryDefaultKeys. On (default), a bookmark without password
 * or key logs on with a matching key found in ~/.ssh. Off, those keys are
 * never offered and the password is asked instead.
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

async function startServer (clientPublicKey) {
  const clients = new Set()
  const accepted = []
  const allowed = utils.parseKey(clientPublicKey)

  const server = new Server({
    hostKeys: [HOST_KEY.private]
  }, (client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx) => {
      if (ctx.method === 'publickey' && ctx.username === USERNAME &&
        ctx.key.algo === allowed.type &&
        ctx.key.data.equals(allowed.getPublicSSH())) {
        accepted.push('publickey')
        return ctx.accept()
      }
      if (ctx.method === 'password' && ctx.username === USERNAME && ctx.password === PASSWORD) {
        accepted.push('password')
        return ctx.accept()
      }
      ctx.reject(['publickey', 'password'])
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
    accepted,
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

describe('session-ssh sshTryDefaultKeys', () => {
  let tmpDir
  let oldEnv
  let clientKey

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-default-keys-'))
    oldEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
      sshKeysPath: process.env.sshKeysPath
    }
    const sshKeysDir = path.join(tmpDir, 'ssh-keys')
    fs.mkdirSync(sshKeysDir, { recursive: true })
    // the key the server accepts, lying in "~/.ssh"
    clientKey = utils.generateKeyPairSync('ed25519')
    fs.writeFileSync(path.join(sshKeysDir, 'id_ed25519'), clientKey.private)
    fs.writeFileSync(path.join(sshKeysDir, 'id_ed25519.pub'), clientKey.public)
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

  async function connect (extra) {
    const server = await startServer(clientKey.public)
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
      return {
        accepted: server.accepted,
        asked: ws.prompts.filter(p => p.mode !== 'confirm')
      }
    } finally {
      term?.kill?.()
      await server.close()
    }
  }

  test('on (default): a matching key from ~/.ssh logs on without asking', async () => {
    const { accepted, asked } = await connect({})
    // publickey is accepted twice: the key check, then the signed request
    assert.ok(accepted.includes('publickey'))
    assert.ok(!accepted.includes('password'))
    assert.equal(asked.length, 0)
  })

  test('off: the key from ~/.ssh is not used, the password is asked', async () => {
    const { accepted, asked } = await connect({ sshTryDefaultKeys: false })
    assert.deepEqual(accepted, ['password'], 'the key from ~/.ssh was never accepted')
    assert.equal(asked.length, 1)
  })
})
