/**
 * Windows taskbar thumbnails: a current picture of a tab that is not on
 * screen (another tab is active, the window is minimized or covered).
 * Inactive tabs stay mounted, only hidden, and keep receiving data, so:
 * - terminal: drawn from the xterm buffer, the rows the tab shows
 * - RDP / VNC / SPICE: a copy of the session canvas
 * - web tab: the webview's own capturePage()
 * Anything else (sftp, file manager): null, the last snapshot stays.
 */

import { refs } from '../components/common/ref.js'

// longest side of a picture; the live preview is at most the window size
const MAX_SIDE = 1920
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
// xterm's defaults for the 16 theme colors
const DEFAULT_ANSI = [
  '#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'
]

const hex = (r, g, b) => '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')

/**
 * xterm's 256 colors: 0-15 from the theme, 16-231 a 6x6x6 cube, 232-255 grays
 * @param {number} n
 * @param {object} theme xterm theme
 */
export function paletteColor (n, theme = {}) {
  if (n < 16) {
    const base = ANSI[n % 8]
    const name = n < 8 ? base : 'bright' + base[0].toUpperCase() + base.slice(1)
    return theme[name] || DEFAULT_ANSI[n]
  }
  if (n < 232) {
    const i = n - 16
    const v = c => c ? 55 + c * 40 : 0
    return hex(v(Math.floor(i / 36)), v(Math.floor(i / 6) % 6), v(i % 6))
  }
  const g = 8 + (n - 232) * 10
  return hex(g, g, g)
}

/**
 * Colors of one xterm buffer cell
 * @return {{fg: string, bg: string|null, bold: boolean}} bg null: the
 *   terminal background
 */
export function cellStyle (cell, theme = {}) {
  const bold = !!cell.isBold()
  const color = (rgb, palette, value, isFg) => {
    if (rgb) {
      return hex((value >> 16) & 255, (value >> 8) & 255, value & 255)
    }
    if (palette) {
      // bold text in the bright colors, as xterm draws it
      return paletteColor(isFg && bold && value < 8 ? value + 8 : value, theme)
    }
    return null
  }
  let fg = color(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor(), true)
  let bg = color(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor(), false)
  if (cell.isInverse()) {
    [fg, bg] = [bg || theme.background || '#000000', fg || theme.foreground || '#ffffff']
  }
  return { fg: fg || theme.foreground || '#ffffff', bg, bold }
}

/**
 * The rows an xterm shows, drawn on a canvas
 * @param {import('@xterm/xterm').Terminal} term
 * @return {HTMLCanvasElement|null}
 */
export function drawTerminal (term) {
  const buf = term?.buffer?.active
  const { cols, rows } = term || {}
  if (!buf || !cols || !rows) {
    return null
  }
  const opts = term.options || {}
  const theme = opts.theme || {}
  const size = opts.fontSize || 14
  const family = opts.fontFamily || 'monospace'
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  ctx.font = `${size}px ${family}`
  const cw = ctx.measureText('W').width || size * 0.6
  const lh = Math.ceil(size * 1.2 * (opts.lineHeight || 1))
  canvas.width = Math.ceil(cw * cols)
  canvas.height = lh * rows
  // a transparent theme background is drawn on black
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = theme.background || '#000000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.textBaseline = 'middle'
  const fonts = [`${size}px ${family}`, `bold ${size}px ${family}`]
  let font = ''
  const cell = buf.getNullCell()
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.viewportY + y)
    if (!line) {
      continue
    }
    const top = y * lh
    for (let x = 0; x < cols; x++) {
      if (!line.getCell(x, cell)) {
        continue
      }
      // 0: the right half of a wide character
      const w = cell.getWidth()
      if (!w) {
        continue
      }
      const { fg, bg, bold } = cellStyle(cell, theme)
      if (bg) {
        ctx.fillStyle = bg
        ctx.fillRect(Math.floor(x * cw), top, Math.ceil(cw * w), lh)
      }
      const ch = cell.getChars()
      if (ch && ch !== ' ' && !cell.isInvisible()) {
        const f = fonts[bold ? 1 : 0]
        if (f !== font) {
          ctx.font = font = f
        }
        ctx.fillStyle = fg
        ctx.fillText(ch, x * cw, top + lh / 2)
      }
    }
  }
  return canvas
}

// the session canvas of an RDP / VNC / SPICE tab: the largest one, not
// xterm's own
function sessionCanvas (el) {
  let best = null
  for (const c of el.querySelectorAll('canvas')) {
    if (c.closest('.xterm') || !c.width || !c.height) {
      continue
    }
    if (!best || c.width * c.height > best.width * best.height) {
      best = c
    }
  }
  return best
}

function encode (canvas) {
  const scale = Math.min(1, MAX_SIDE / Math.max(canvas.width, canvas.height))
  let src = canvas
  if (scale < 1) {
    src = document.createElement('canvas')
    src.width = Math.max(1, Math.round(canvas.width * scale))
    src.height = Math.max(1, Math.round(canvas.height * scale))
    src.getContext('2d').drawImage(canvas, 0, 0, src.width, src.height)
  }
  return src.toDataURL('image/jpeg', 0.9)
}

const timeout = (promise, ms) => Promise.race([
  promise,
  new Promise(resolve => setTimeout(() => resolve(null), ms))
])

/**
 * @param {object} tab
 * @return {Promise<string|null>} a data url, null: no picture for this tab
 */
export async function tabPicture (tab) {
  const el = document.querySelector(`.session-${tab.id}`)
  if (!el) {
    return null
  }
  try {
    const term = refs.get('term-' + tab.id)?.term
    if (term) {
      // the sftp / file manager pane covers the terminal
      if (tab.pane === 'sftp' || tab.pane === 'fileManager') {
        return null
      }
      const canvas = drawTerminal(term)
      return canvas ? encode(canvas) : null
    }
    const canvas = sessionCanvas(el)
    if (canvas) {
      return encode(canvas)
    }
    const view = el.querySelector('webview')
    if (view?.capturePage) {
      const img = await timeout(view.capturePage(), 1000)
      return img && !img.isEmpty() ? img.toDataURL() : null
    }
  } catch (e) {
    console.warn('taskbar picture', e)
  }
  return null
}
