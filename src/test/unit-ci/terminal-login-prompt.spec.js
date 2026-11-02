const { before, describe, test } = require('node:test')
const assert = require('node:assert/strict')

let mod

before(async () => {
  mod = await import('../../client/components/terminal/terminal-login-prompt.js')
})

// enough of xterm: write() collects the output, type() feeds onData
function fakeTerm () {
  const listeners = new Set()
  return {
    out: '',
    write (text) {
      this.out += text
    },
    onData (fn) {
      listeners.add(fn)
      return { dispose: () => listeners.delete(fn) }
    },
    type (data) {
      for (const fn of [...listeners]) {
        fn(data)
      }
    },
    get listening () {
      return listeners.size
    }
  }
}

const userPrompt = {
  name: 'login for host',
  instructions: [''],
  prompts: [{ echo: true, prompt: 'login as' }]
}

const passwordPrompt = {
  name: 'password for me@host',
  instructions: [''],
  prompts: [{ echo: false, prompt: 'password' }]
}

const hostKeyPrompt = {
  mode: 'confirm',
  name: 'Trust SSH host key for host?',
  instructions: [
    "The authenticity of host 'host' can't be established.",
    'Fingerprint: SHA256:abc',
    'Trust this host key and add it to known_hosts?'
  ],
  prompts: [],
  confirmResult: 'trust'
}

describe('terminal login prompt', () => {
  test('labels end with ": " unless they already end with : or ?', () => {
    assert.equal(mod.promptLabel('password'), 'password: ')
    assert.equal(mod.promptLabel('Password: '), 'Password: ')
    assert.equal(mod.promptLabel('Continue?'), 'Continue? ')
    assert.equal(mod.promptLabel(''), '')
  })

  test('user name is echoed, backspace edits, enter answers', async () => {
    const term = fakeTerm()
    const { promise } = mod.askInTerminal(term, userPrompt)
    assert.match(term.out, /login as: $/)
    term.type('marx')
    term.type('\x7f')
    term.type('tin\r')
    assert.deepEqual(await promise, ['martin'])
    assert.ok(term.out.endsWith('login as: marx\b \btin\r\n'))
    assert.equal(term.listening, 0, 'stops reading keys')
  })

  test('password is not echoed', async () => {
    const term = fakeTerm()
    const { promise } = mod.askInTerminal(term, passwordPrompt)
    term.type('s3cret\r')
    assert.deepEqual(await promise, ['s3cret'])
    assert.ok(!term.out.includes('s3cret'))
  })

  test('several prompts are asked one after the other, pasted CRLF is one enter', async () => {
    const term = fakeTerm()
    const { promise } = mod.askInTerminal(term, {
      name: 'two step',
      instructions: ['', 'code from the app'],
      prompts: [{ echo: false, prompt: 'Password:' }, { echo: true, prompt: 'Code:' }]
    })
    term.type('pw\r\n123456\r')
    assert.deepEqual(await promise, ['pw', '123456'])
    assert.ok(term.out.includes('code from the app\r\nCode: 123456'))
  })

  test('ctrl+c and esc cancel, arrow keys are ignored', async () => {
    const t1 = fakeTerm()
    const p1 = mod.askInTerminal(t1, passwordPrompt).promise
    t1.type('ab\x03')
    assert.deepEqual(await p1, [])

    const t2 = fakeTerm()
    const p2 = mod.askInTerminal(t2, userPrompt).promise
    t2.type('\x1b[A')
    t2.type('me')
    t2.type('\x1b')
    assert.deepEqual(await p2, [])
    assert.ok(!t2.out.includes('[A'))
  })

  test('host key: shows the details, yes trusts, anything else asks again', async () => {
    const term = fakeTerm()
    const { promise } = mod.askInTerminal(term, hostKeyPrompt)
    assert.ok(term.out.includes('Fingerprint: SHA256:abc\r\n'))
    assert.match(term.out, /known_hosts\? \(yes\/no\) $/)
    term.type('maybe\r')
    assert.match(term.out, /Please type 'yes' or 'no': $/)
    term.type('yes\r')
    assert.deepEqual(await promise, ['trust'])
  })

  test('host key: no rejects', async () => {
    const term = fakeTerm()
    const { promise } = mod.askInTerminal(term, hostKeyPrompt)
    term.type('no\r')
    assert.deepEqual(await promise, [])
  })

  test('a prompt taken back resolves null and stops reading keys', async () => {
    const term = fakeTerm()
    const ask = mod.askInTerminal(term, passwordPrompt)
    ask.cancel()
    assert.equal(await ask.promise, null)
    assert.equal(term.listening, 0)
    assert.ok(term.out.includes('(prompt withdrawn)'))
  })
})
