/**
 * A server refusing X11 forwarding (X11Forwarding no, no xauth there) must
 * not break the session: ssh2 fails the whole shell request for it, while
 * OpenSSH only warns. session-ssh.openShell() opens the shell again without
 * X11 and tells the user with an x11-warning.
 */

process.env.NODE_ENV = 'development'

const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { Server, utils } = require('@electerm/ssh2')
const { session } = require('../../../src/app/server/session-ssh')

const USERNAME = 'x11-tester'
const PASSWORD = 'x11-test-password'
const HOST_KEY = utils.generateKeyPairSync('ed25519')

// acceptX11 false: no x11 listener, ssh2's server refuses the request
async function startServer ({ acceptX11 }) {
  const clients = new Set()
  const state = { x11Requests: 0, shells: 0 }
  const server = new Server({ hostKeys: [HOST_KEY.private] }, client => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === USERNAME && ctx.password === PASSWORD) {
        return ctx.accept()
      }
      return ctx.reject(['password'])
    })
    client.on('ready', () => {
      client.on('session', accept => {
        const sess = accept()
        const acceptIfAsked = accept => typeof accept === 'function' && accept()
        sess.on('env', acceptIfAsked)
        sess.on('pty', acceptIfAsked)
        if (acceptX11) {
          sess.on('x11', accept => {
            state.x11Requests++
            acceptIfAsked(accept)
          })
        }
        sess.on('shell', accept => {
          state.shells++
          accept().write('ready\n')
        })
      })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    state,
    async close () {
      for (const c of clients) c.end()
      await new Promise(resolve => server.close(resolve))
    }
  }
}

// trusts the host key, records the x11 warnings
function makeWs () {
  let pending = null
  const warnings = []
  return {
    warnings,
    s (payload) {
      if (payload?.action === 'x11-warning') {
        warnings.push(payload.message)
      }
      if (payload?.action === 'session-interactive') {
        pending = payload.options
      }
    },
    once (handler) {
      const opts = pending
      queueMicrotask(() => handler({ results: opts?.mode === 'confirm' ? ['trust'] : [] }))
    },
    close () {}
  }
}

async function connect (acceptX11) {
  const server = await startServer({ acceptX11 })
  const ws = makeWs()
  let term
  try {
    term = await session({
      host: '127.0.0.1',
      port: server.port,
      username: USERNAME,
      password: PASSWORD,
      x11: true,
      readyTimeout: 10000
    }, ws)
    return { term, state: server.state, warnings: ws.warnings }
  } finally {
    term?.kill()
    await server.close()
  }
}

describe('SSH X11 forwarding refused by the server', () => {
  test('the session opens without X11 and warns', async () => {
    const { term, state, warnings } = await connect(false)
    assert.ok(term, 'session should resolve')
    assert.equal(state.shells, 1, 'shell opened once, on the retry without X11')
    assert.ok(
      warnings.some(w => w.includes('refused X11 forwarding')),
      'the user is told: ' + JSON.stringify(warnings)
    )
  })

  test('an accepted X11 request: no refusal warning', async () => {
    const { term, state, warnings } = await connect(true)
    assert.ok(term)
    assert.equal(state.x11Requests, 1)
    assert.equal(state.shells, 1)
    assert.ok(!warnings.some(w => w.includes('refused X11 forwarding')))
  })
})
