/**
 * Asks a session prompt (user name, password, one-time code, host key) inside
 * the terminal, the way OpenSSH and PuTTY do, instead of in a popup. Used when
 * the setting `sshPromptPopup` is off.
 *
 * Works on anything with xterm's `write(text)` and `onData(listener)`.
 */

const dim = text => `\x1b[2m${text}\x1b[0m`

// one line, in the terminal's line endings
const line = text => String(text).replace(/\r?\n/g, '\r\n') + '\r\n'

/**
 * "password" -> "password: ", "login as:" -> "login as: ", "" -> ""
 */
export function promptLabel (text) {
  const t = (text || '').trimEnd()
  if (!t) {
    return ''
  }
  return /[:?]$/.test(t) ? t + ' ' : t + ': '
}

/**
 * The questions a prompt asks, as fields read one after the other.
 * @param {object} options the `options` of a session-interactive message
 */
export function buildFields (options = {}) {
  const instructions = (options.instructions || []).filter(t => t)
  if (options.mode === 'confirm') {
    // the last instruction is the question
    const question = instructions.length
      ? instructions[instructions.length - 1]
      : options.name || '?'
    return [{
      confirm: true,
      before: [dim(options.name || ''), ...instructions.slice(0, -1)].filter(t => t),
      label: `${question.trimEnd()} (yes/no) `,
      echo: true,
      result: options.confirmResult || 'yes'
    }]
  }
  const prompts = options.prompts || []
  return prompts.map((p, i) => {
    const note = (options.instructions || [])[i]
    const before = []
    if (i === 0 && options.name && options.name !== p.prompt) {
      before.push(dim(options.name))
    }
    if (note) {
      before.push(note)
    }
    return {
      before,
      label: promptLabel(p.prompt || options.name || 'input'),
      echo: !!p.echo
    }
  })
}

/**
 * Asks `options` in `term`.
 * @returns {{ promise: Promise<string[]|null>, cancel: Function }}
 *   resolves with the answers, `[]` when the user cancelled (Ctrl+C, Esc,
 *   "no"), or `null` when `cancel()` took the prompt back.
 */
export function askInTerminal (term, options) {
  const fields = buildFields(options)
  const results = []
  let index = -1
  let buffer = ''
  let done = false
  let settle
  const promise = new Promise(resolve => { settle = resolve })
  let listener = null

  function finish (value) {
    if (done) {
      return
    }
    done = true
    listener?.dispose()
    settle(value)
  }

  function next () {
    index++
    buffer = ''
    if (index >= fields.length) {
      return finish(results)
    }
    const field = fields[index]
    for (const text of field.before) {
      term.write(line(text))
    }
    term.write(field.label)
  }

  function enter () {
    const field = fields[index]
    term.write('\r\n')
    if (!field.confirm) {
      results.push(buffer)
      return next()
    }
    const answer = buffer.trim().toLowerCase()
    if (answer === 'yes' || answer === 'y') {
      results.push(field.result)
      return finish(results)
    }
    if (answer === 'no' || answer === 'n') {
      return finish([])
    }
    buffer = ''
    term.write("Please type 'yes' or 'no': ")
  }

  function onData (data) {
    // an escape sequence (arrow keys, F keys, ...) is not input; Esc alone cancels
    if (data.length > 1 && data[0] === '\x1b') {
      return
    }
    let last = ''
    for (const ch of data) {
      if (done) {
        return
      }
      const prev = last
      last = ch
      if (ch === '\x03' || ch === '\x1b' || (ch === '\x04' && !buffer)) {
        term.write('^C\r\n')
        return finish([])
      }
      if (ch === '\n' && prev === '\r') {
        // pasted CRLF: one line end
      } else if (ch === '\r' || ch === '\n') {
        enter()
      } else if (ch === '\x7f' || ch === '\b') {
        if (buffer) {
          buffer = [...buffer].slice(0, -1).join('')
          if (fields[index].echo) {
            term.write('\b \b')
          }
        }
      } else if (ch >= ' ') {
        buffer += ch
        if (fields[index].echo) {
          term.write(ch)
        }
      }
    }
  }

  if (!fields.length) {
    finish([])
  } else {
    listener = term.onData(onData)
    next()
  }

  return {
    promise,
    cancel () {
      if (!done) {
        term.write('\r\n' + line(dim('(prompt withdrawn)')))
      }
      finish(null)
    }
  }
}
