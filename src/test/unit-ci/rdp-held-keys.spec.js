const { before, describe, test } = require('node:test')
const assert = require('node:assert/strict')

let staleModifiers
let isLockKey
let lockState
let focusLost
let keyLabel

before(async () => {
  const mod = await import('../../client/components/rdp/held-keys.js')
  staleModifiers = mod.staleModifiers
  isLockKey = mod.isLockKey
  lockState = mod.lockState
  focusLost = mod.focusLost
  keyLabel = mod.keyLabel
})

// a key or mouse event with these modifiers / lock keys on
const ev = (code, ...on) => ({ code, getModifierState: name => on.includes(name) })

describe('RDP held keys', () => {
  test('a held modifier the event says is up is stale', () => {
    // Ctrl+V: the release of Ctrl never reached the canvas
    const held = new Map([['ControlLeft', 0], ['KeyV', 0]])
    assert.deepEqual(staleModifiers(held, ev('KeyA')), ['ControlLeft'])
    assert.deepEqual(staleModifiers(held, ev('KeyA', 'Control')), [])
    // only modifiers: the event cannot tell about other keys
    assert.deepEqual(staleModifiers(new Map([['KeyV', 0]]), ev('KeyA')), [])
    assert.deepEqual(staleModifiers(new Map([['ShiftRight', 0], ['MetaLeft', 0], ['AltLeft', 0]]), ev('KeyA', 'Alt')), ['ShiftRight', 'MetaLeft'])
  })

  test('the key of the event itself is not stale', () => {
    // the release of Shift: its own event already says Shift is up
    assert.deepEqual(staleModifiers(new Map([['ShiftLeft', 0]]), ev('ShiftLeft')), [])
  })

  test('AltGr counts for Control and Alt', () => {
    assert.deepEqual(staleModifiers(new Map([['ControlLeft', 0], ['AltRight', 0]]), ev('KeyQ', 'AltGraph')), [])
  })

  test('mouse events have no key code', () => {
    assert.deepEqual(staleModifiers(new Map([['ControlLeft', 0]]), ev(undefined)), ['ControlLeft'])
  })

  test('a key kept pressed on purpose is not stale', () => {
    const held = new Map([['ShiftLeft', 0]])
    assert.deepEqual(staleModifiers(held, ev('KeyA'), new Set(['ShiftLeft'])), [])
  })

  test('focus lost: a key held 1 s or longer is asked about, not Alt or Win', () => {
    const held = new Map([
      ['ShiftLeft', 0], ['KeyA', 500], ['AltLeft', 0], ['MetaLeft', 0], ['ControlLeft', 0]
    ])
    assert.deepEqual(focusLost(held, new Set(['ControlLeft']), 1200), {
      release: ['KeyA', 'AltLeft', 'MetaLeft'],
      ask: ['ShiftLeft']
    })
  })

  test('key names', () => {
    assert.deepEqual(['ControlRight', 'AltRight', 'MetaLeft', 'KeyA', 'Digit1', 'F5'].map(keyLabel),
      ['Ctrl', 'AltGr', 'Win', 'A', '1', 'F5'])
  })

  test('lock keys: scroll, num, caps', () => {
    assert.deepEqual(lockState(ev('KeyA', 'CapsLock')), [false, false, true])
    assert.deepEqual(lockState(ev('KeyA', 'NumLock', 'ScrollLock')), [true, true, false])
    assert.equal(isLockKey('CapsLock'), true)
    assert.equal(isLockKey('KeyA'), false)
  })
})
