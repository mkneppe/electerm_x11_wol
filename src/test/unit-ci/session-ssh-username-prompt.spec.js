/**
 * Test: a bookmark without user name asks for it, and the saved password is
 * never sent as the user name.
 *
 * The user name prompt used to be a hidden field without a label. That is the
 * shape the password auto-fill in onKeyboardEvent answers, so with a saved
 * password the password went to the server as the user name, without asking.
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

async function startServer () {
  const clients = new Set()
  const usernames = []

  const server = new Server({
    hostKeys: [HOST_KEY.private]
  }, (client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx) => {
      usernames.push(ctx.username)
      if (ctx.method === 'password' && ctx.username === USERNAME && ctx.password === PASSWORD) {
        return ctx.accept()
      }
      ctx.reject(['password'])
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
    usernames,
    async close () {
      for (const client of clients) {
        client.end()
      }
      await new Promise(resolve => server.close(resolve))
    }
  }
}

// answers the host key question with "trust" and a user name prompt with USERNAME
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
          results: last && last.mode !== 'confirm' ? [USERNAME] : ['trust']
        })
      })
    },
    close () {}
  }
}

describe('session-ssh user name prompt', () => {
  let tmpDir
  let oldEnv

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-username-'))
    oldEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
      sshKeysPath: process.env.sshKeysPath
    }
    const sshKeysDir = path.join(tmpDir, 'ssh-keys')
    fs.mkdirSync(sshKeysDir, { recursive: true })
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

  test('asks for the user name in a visible field, even with a saved password', async () => {
    const server = await startServer()
    const ws = createPromptWs()
    let term
    try {
      term = await session({
        host: '127.0.0.1',
        port: server.port,
        username: '',
        password: PASSWORD,
        useSshAgent: false,
        enableSsh: false,
        readyTimeout: 5000
      }, ws)
      assert.ok(term, 'session should be created')

      const asked = ws.prompts.filter(p => p.mode !== 'confirm')
      assert.equal(asked.length, 1, 'the user name is asked once')
      assert.equal(asked[0].prompts.length, 1)
      assert.equal(asked[0].prompts[0].echo, true, 'the user name is visible while typed')
      assert.ok(asked[0].prompts[0].prompt, 'the field has a label')

      assert.ok(!server.usernames.includes(PASSWORD), 'the password was never sent as user name')
      assert.ok(server.usernames.every(name => name === USERNAME))
    } finally {
      term?.kill?.()
      await server.close()
    }
  })
})
