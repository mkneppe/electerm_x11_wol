const { describe, test, mock } = require('node:test')
const assert = require('node:assert/strict')
const { numberLabels, TaskbarTabs } = require('../../app/lib/taskbar-tabs')

// ref.js keeps its maps on window
globalThis.window = globalThis.window || {}
const pictureModule = import('../../client/common/taskbar-picture.js')

describe('taskbar tab thumbnails', () => {
  test('captions are the tab titles, equal ones numbered #1 #2 in tab order', () => {
    const labels = numberLabels([
      { id: 'a', title: 'server1' },
      { id: 'b', title: 'Marathon Man' },
      { id: 'c', title: 'server1' },
      { id: 'd', title: 'server2' },
      { id: 'e', title: 'server1' }
    ])
    assert.deepEqual(labels, [
      { id: 'a', label: 'server1 #1' },
      { id: 'b', label: 'Marathon Man' },
      { id: 'c', label: 'server1 #2' },
      { id: 'd', label: 'server2' },
      { id: 'e', label: 'server1 #3' }
    ])
  })

  test('no tabs, no captions', () => {
    assert.deepEqual(numberLabels([]), [])
  })
})

describe('taskbar thumbnails stay current when looked at', () => {
  // a TaskbarTabs without the Windows calls: the taskbar's requests are
  // wanted(), its invalidations counted
  function setup () {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const asked = []
    const tabs = new TaskbarTabs({ getMain: () => null, onPicture: id => asked.push(id) })
    let invalidated = 0
    tabs.invalidate = () => { invalidated++ }
    const proxy = { id: 'a', image: null, time: 0, asked: 0, row: 0, asking: null, stale: null }
    tabs.proxies.set('a', proxy)
    return { tabs, proxy, asked, invalidated: () => invalidated }
  }

  test('an old picture: the renderer is asked once, the new one invalidates', () => {
    const { tabs, proxy, asked, invalidated } = setup()
    try {
      mock.timers.tick(10000)
      tabs.wanted(proxy)
      tabs.wanted(proxy) // thumbnail and live preview at once
      assert.deepEqual(asked, ['a'])
      tabs.setImage(proxy, {})
      assert.equal(invalidated(), 1)
      assert.equal(proxy.asking, null)
    } finally {
      mock.timers.reset()
    }
  })

  test('a recent picture is sent as it is, and invalidated when it is old', () => {
    const { tabs, proxy, asked, invalidated } = setup()
    try {
      mock.timers.tick(10000)
      tabs.setImage(proxy, {})
      tabs.wanted(proxy)
      tabs.wanted(proxy)
      assert.deepEqual(asked, [])
      assert.equal(invalidated(), 1)
      mock.timers.tick(2000)
      assert.equal(invalidated(), 2)
      // the taskbar asks again: now the picture is old
      tabs.wanted(proxy)
      assert.deepEqual(asked, ['a'])
    } finally {
      mock.timers.reset()
    }
  })

  test('no answer from the renderer: asked again after a while', () => {
    const { tabs, proxy, asked } = setup()
    try {
      mock.timers.tick(10000)
      tabs.wanted(proxy)
      mock.timers.tick(1000)
      tabs.wanted(proxy)
      assert.deepEqual(asked, ['a'])
      mock.timers.tick(600)
      tabs.wanted(proxy)
      assert.deepEqual(asked, ['a', 'a'])
    } finally {
      mock.timers.reset()
    }
  })

  test('a taskbar that keeps asking is stopped after a while, until the tabs change', () => {
    const { tabs, proxy, asked, invalidated } = setup()
    try {
      mock.timers.tick(10000)
      // picture, invalidated after 2 s, asked again, ... like thumbnails left open
      for (let i = 0; i < 40; i++) {
        tabs.wanted(proxy)
        tabs.setImage(proxy, {})
        tabs.wanted(proxy)
        mock.timers.tick(2000)
      }
      assert.equal(asked.length, 40)
      const n = invalidated()
      // no more invalidations: the row is full
      mock.timers.tick(10000)
      assert.equal(invalidated(), n)
      assert.ok(proxy.row >= 30)
    } finally {
      mock.timers.reset()
    }
  })
})

describe('taskbar pictures of hidden terminals', () => {
  test('the 256 colors: theme, cube, grays', async () => {
    const { paletteColor } = await pictureModule
    const theme = { red: '#ff0000', brightBlue: '#8888ff' }
    assert.equal(paletteColor(1, theme), '#ff0000')
    assert.equal(paletteColor(12, theme), '#8888ff')
    assert.equal(paletteColor(2, theme), '#4e9a06') // xterm's default
    assert.equal(paletteColor(16), '#000000')
    assert.equal(paletteColor(196), '#ff0000')
    assert.equal(paletteColor(231), '#ffffff')
    assert.equal(paletteColor(232), '#080808')
    assert.equal(paletteColor(255), '#eeeeee')
  })

  test('cell colors: default, palette, rgb, bold bright, inverse', async () => {
    const { cellStyle } = await pictureModule
    const theme = { foreground: '#cccccc', background: '#111111', red: '#aa0000', brightRed: '#ff5555' }
    const cell = (o = {}) => ({
      isBold: () => !!o.bold,
      isInverse: () => !!o.inverse,
      isFgRGB: () => o.fg?.rgb !== undefined,
      isFgPalette: () => o.fg?.p !== undefined,
      getFgColor: () => o.fg?.rgb ?? o.fg?.p ?? 0,
      isBgRGB: () => o.bg?.rgb !== undefined,
      isBgPalette: () => o.bg?.p !== undefined,
      getBgColor: () => o.bg?.rgb ?? o.bg?.p ?? 0
    })
    assert.deepEqual(cellStyle(cell(), theme), { fg: '#cccccc', bg: null, bold: false })
    assert.deepEqual(cellStyle(cell({ fg: { p: 1 } }), theme), { fg: '#aa0000', bg: null, bold: false })
    assert.deepEqual(cellStyle(cell({ fg: { p: 1 }, bold: true }), theme), { fg: '#ff5555', bg: null, bold: true })
    assert.deepEqual(cellStyle(cell({ fg: { rgb: 0x123456 }, bg: { p: 1 } }), theme), { fg: '#123456', bg: '#aa0000', bold: false })
    assert.deepEqual(cellStyle(cell({ inverse: true }), theme), { fg: '#111111', bg: '#cccccc', bold: false })
  })
})
