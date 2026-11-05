/**
 * Keys held on the remote side of an RDP session. A key release that never
 * reaches the canvas leaves the key down on the remote: focus moved away
 * while the key was held, or the app handled the shortcut (Ctrl+C / Ctrl+V,
 * the Windows key). The remote then reads every key as a shortcut, or with
 * Shift. Every key or mouse event tells which modifiers are really down, and
 * which lock keys are on, so both are put right with the next event.
 * A key held for a while when focus leaves may be held on purpose: the user
 * is asked whether it stays pressed on the remote.
 */

const MODIFIER = {
  ControlLeft: 'Control',
  ControlRight: 'Control',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  MetaLeft: 'Meta',
  MetaRight: 'Meta'
}

const LOCKS = ['ScrollLock', 'NumLock', 'CapsLock']

// held at least this long (ms) when focus leaves: maybe on purpose, ask
export const KEEP_AFTER = 1000

// Alt and Win switch windows locally (Alt+Tab, the Start menu), held there
// on the way out: released without asking
const NEVER_KEEP = ['AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']

const LABEL = {
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  AltLeft: 'Alt',
  AltRight: 'AltGr',
  MetaLeft: 'Win',
  MetaRight: 'Win'
}

export const keyLabel = code => LABEL[code] || code.replace(/^(Key|Digit)/, '')

/**
 * @param {Map<string, number>} held DOM codes sent as pressed (-> since when)
 * @param {KeyboardEvent|MouseEvent} e
 * @param {Set<string>} [kept] kept pressed on purpose, see focusLost
 * @return {string[]} the held modifiers `e` says are up, except its own key
 */
export function staleModifiers (held, e, kept) {
  // AltGr (Windows: ControlLeft + AltRight) may be reported as AltGraph alone
  const altGr = e.getModifierState('AltGraph')
  const down = name => e.getModifierState(name) || (altGr && (name === 'Control' || name === 'Alt'))
  return [...held.keys()].filter(code =>
    code !== e.code && MODIFIER[code] && !kept?.has(code) && !down(MODIFIER[code])
  )
}

/**
 * Focus left the canvas: which held keys to release, which to ask about
 * @param {Map<string, number>} held DOM code -> time pressed
 * @param {Set<string>} kept already kept pressed: left alone
 * @param {number} now
 * @return {{release: string[], ask: string[]}}
 */
export function focusLost (held, kept, now) {
  const release = []
  const ask = []
  for (const [code, since] of held) {
    if (kept.has(code)) {
      continue
    }
    const long = now - since >= KEEP_AFTER && !NEVER_KEEP.includes(code)
    ;(long ? ask : release).push(code)
  }
  return { release, ask }
}

export const isLockKey = code => LOCKS.includes(code)

/**
 * @param {KeyboardEvent|MouseEvent} e
 * @return {boolean[]} scroll, num and caps lock, as synchronizeLockKeys takes them
 */
export function lockState (e) {
  return LOCKS.map(name => !!e.getModifierState(name))
}
