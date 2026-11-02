/**
 * Windows: every tab as its own thumbnail in the taskbar, like a browser.
 *
 * Windows' "tabbed thumbnails" (ITaskbarList3::RegisterTab): each tab gets an
 * invisible proxy window registered as a tab of the main window. The taskbar
 * then shows one thumbnail per proxy, captioned with its window title, and asks
 * the proxy for the picture (WM_DWMSENDICONICTHUMBNAIL). The first picture is
 * a snapshot of the tab taken once after it connected. When the taskbar asks
 * for a picture older than MAX_AGE, the cached one is sent at once and the
 * renderer is asked for a current one (a snapshot of a visible tab, else drawn
 * from the hidden tab); when that arrives the pictures are invalidated, so the
 * taskbar asks again and gets it. Nothing is redrawn while working, only when
 * the thumbnails are looked at, and at most every MAX_AGE then. Clicking a
 * thumbnail activates its proxy, which brings the main window and that tab to
 * the front.
 *
 * Electron has no API for this, the Win32 / COM calls go through koffi.
 * Anything failing here only turns the feature off.
 */

const { BaseWindow, nativeImage } = require('electron')
const log = require('../common/log')

const WM_ACTIVATE = 0x0006
const WM_DWMSENDICONICTHUMBNAIL = 0x0323
const WM_DWMSENDICONICLIVEPREVIEWBITMAP = 0x0326
const DWMWA_FORCE_ICONIC_REPRESENTATION = 7
const DWMWA_HAS_ICONIC_BITMAP = 10
const CLSCTX_INPROC_SERVER = 1
// a picture younger than this is sent as it is
const MAX_AGE = 2000
// how long to wait for the renderer's picture before asking again
const WAIT = 1500
// pictures in a row while the thumbnails stay open (a minute and more);
// then no more until the tabs change, in case the taskbar keeps asking on
// its own
const MAX_ROW = 30

// ITaskbarList3 vtable slots (IUnknown 0-2, ITaskbarList 3-7, ITaskbarList2 8)
const VT = {
  HrInit: 3,
  RegisterTab: 11,
  UnregisterTab: 12,
  SetTabOrder: 13,
  SetTabActive: 14
}

let api = null

function guid (str) {
  const hex = str.replace(/[{}-]/g, '')
  const b = Buffer.from(hex, 'hex')
  const out = Buffer.alloc(16)
  out.writeUInt32LE(b.readUInt32BE(0), 0)
  out.writeUInt16LE(b.readUInt16BE(4), 4)
  out.writeUInt16LE(b.readUInt16BE(6), 6)
  b.copy(out, 8, 8, 16)
  return out
}

function loadApi () {
  if (api !== null) {
    return api
  }
  api = false
  if (process.platform !== 'win32') {
    return api
  }
  try {
    const koffi = require('koffi')
    const ole32 = koffi.load('ole32.dll')
    const dwmapi = koffi.load('dwmapi.dll')
    const gdi32 = koffi.load('gdi32.dll')
    const CoCreateInstance = ole32.func('long __stdcall CoCreateInstance(void *clsid, void *outer, uint32_t ctx, void *iid, _Out_ void **ppv)')
    const out = [null]
    const hr = CoCreateInstance(
      guid('56FDF344-FD6D-11d0-958A-006097C9A090'), // CLSID_TaskbarList
      null,
      CLSCTX_INPROC_SERVER,
      // IID_ITaskbarList4: extends ITaskbarList3, the slots below are the same
      guid('c43dc798-95d1-4bea-9030-bb99e2983a1a'),
      out
    )
    if (hr !== 0 || !out[0]) {
      throw new Error('CoCreateInstance(TaskbarList4) 0x' + (hr >>> 0).toString(16))
    }
    const self = out[0]
    const vtbl = koffi.decode(self, 'void *')
    const slots = koffi.decode(vtbl, 'void *', 15)
    const method = (slot, sig) => {
      const proto = koffi.proto(sig)
      return (...args) => koffi.call(slots[slot], proto, self, ...args)
    }
    const tb = {
      HrInit: method(VT.HrInit, 'long __stdcall HrInit(void *self)'),
      RegisterTab: method(VT.RegisterTab, 'long __stdcall RegisterTab(void *self, intptr_t tab, intptr_t main)'),
      UnregisterTab: method(VT.UnregisterTab, 'long __stdcall UnregisterTab(void *self, intptr_t tab)'),
      SetTabOrder: method(VT.SetTabOrder, 'long __stdcall SetTabOrder(void *self, intptr_t tab, intptr_t before)'),
      SetTabActive: method(VT.SetTabActive, 'long __stdcall SetTabActive(void *self, intptr_t tab, intptr_t main, uint32_t reserved)')
    }
    const init = tb.HrInit()
    if (init !== 0) {
      throw new Error('ITaskbarList3::HrInit 0x' + (init >>> 0).toString(16))
    }
    api = {
      koffi,
      tb,
      DwmSetWindowAttribute: dwmapi.func('long __stdcall DwmSetWindowAttribute(intptr_t hwnd, uint32_t attr, void *value, uint32_t size)'),
      DwmSetIconicThumbnail: dwmapi.func('long __stdcall DwmSetIconicThumbnail(intptr_t hwnd, void *bitmap, uint32_t flags)'),
      DwmSetIconicLivePreviewBitmap: dwmapi.func('long __stdcall DwmSetIconicLivePreviewBitmap(intptr_t hwnd, void *bitmap, void *client, uint32_t flags)'),
      DwmInvalidateIconicBitmaps: dwmapi.func('long __stdcall DwmInvalidateIconicBitmaps(intptr_t hwnd)'),
      CreateDIBSection: gdi32.func('void * __stdcall CreateDIBSection(void *hdc, void *info, uint32_t usage, _Out_ void **bits, void *section, uint32_t offset)'),
      DeleteObject: gdi32.func('int __stdcall DeleteObject(void *obj)')
    }
  } catch (e) {
    log.warn('taskbar tabs not available:', e.message)
    api = false
  }
  return api
}

// a failing call is logged, not thrown: one broken thumbnail must not break
// the others
function check (name, hr) {
  if (hr !== 0) {
    log.warn(`taskbar tabs: ${name} 0x${(hr >>> 0).toString(16)}`)
  }
  return hr === 0
}

function hwndOf (win) {
  const buf = win.getNativeWindowHandle()
  return buf.length >= 8 ? buf.readBigInt64LE(0) : BigInt(buf.readInt32LE(0))
}

/**
 * A 32 bit top-down DIB from a NativeImage, for the DWM calls; the caller
 * deletes it.
 */
function toHBitmap (img) {
  const { width, height } = img.getSize()
  if (!width || !height) {
    return null
  }
  const info = Buffer.alloc(40) // BITMAPINFOHEADER
  info.writeUInt32LE(40, 0)
  info.writeInt32LE(width, 4)
  info.writeInt32LE(-height, 8) // top-down
  info.writeUInt16LE(1, 12) // planes
  info.writeUInt16LE(32, 14) // bpp
  const bits = [null]
  const hbmp = api.CreateDIBSection(null, info, 0, bits, null, 0)
  if (!hbmp || !bits[0]) {
    return null
  }
  // toBitmap() is BGRA, as the DIB wants it
  const data = img.toBitmap()
  api.koffi.encode(bits[0], api.koffi.array('uint8_t', data.length), data)
  return hbmp
}

function fit (img, maxW, maxH) {
  const { width, height } = img.getSize()
  const scale = Math.min(maxW / width, maxH / height, 1)
  return scale < 1
    ? img.resize({ width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), quality: 'good' })
    : img
}

class TaskbarTabs {
  constructor (opts) {
    // getMain() -> the main BrowserWindow, onActivate(id), onClose(id),
    // onPicture(id): ask the renderer for a current picture,
    // icon: picture for a tab that has no snapshot yet
    this.opts = opts
    this.proxies = new Map() // tab id -> { win, hwnd, label, image }
    this.order = ''
    this.fallbackImage = opts.icon ? nativeImage.createFromPath(opts.icon) : null
  }

  get main () {
    const win = this.opts.getMain()
    return win && !win.isDestroyed() ? win : null
  }

  createProxy (id, label) {
    const main = this.main
    const win = new BaseWindow({
      show: false,
      width: 320,
      height: 200,
      title: label
    })
    const hwnd = hwndOf(win)
    const on = Buffer.alloc(4)
    on.writeInt32LE(1, 0)
    check('DWMWA_FORCE_ICONIC_REPRESENTATION', api.DwmSetWindowAttribute(hwnd, DWMWA_FORCE_ICONIC_REPRESENTATION, on, 4))
    check('DWMWA_HAS_ICONIC_BITMAP', api.DwmSetWindowAttribute(hwnd, DWMWA_HAS_ICONIC_BITMAP, on, 4))
    // time: when image was taken, asked: when the renderer was asked last,
    // row: pictures in a row, asking / stale: timers
    const proxy = { id, win, hwnd, label, image: null, time: 0, asked: 0, row: 0, asking: null, stale: null }
    win.hookWindowMessage(WM_DWMSENDICONICTHUMBNAIL, (wParam, lParam) => {
      const v = lParam.readUInt32LE(0)
      this.sendThumbnail(proxy, v >>> 16, v & 0xffff)
      this.wanted(proxy)
    })
    win.hookWindowMessage(WM_DWMSENDICONICLIVEPREVIEWBITMAP, () => {
      this.sendPreview(proxy)
      this.wanted(proxy)
    })
    win.hookWindowMessage(WM_ACTIVATE, (wParam) => {
      // low word: WA_ACTIVE 1 / WA_CLICKACTIVE 2
      if ((wParam.readUInt32LE(0) & 0xffff) !== 0) {
        setImmediate(() => this.activate(id))
      }
    })
    win.on('close', e => {
      // the X on the thumbnail: close the tab, the proxy goes with it
      if (!this.disposing) {
        e.preventDefault()
        this.opts.onClose(id)
      }
    })
    check('RegisterTab', api.tb.RegisterTab(hwnd, hwndOf(main)))
    check('SetTabOrder', api.tb.SetTabOrder(hwnd, 0n))
    return proxy
  }

  activate (id) {
    const main = this.main
    if (!main) {
      return
    }
    if (main.isMinimized()) {
      main.restore()
    }
    main.show()
    main.focus()
    this.opts.onActivate(id)
  }

  /**
   * The taskbar showed the cached picture. A recent one stays, but is
   * invalidated once it is MAX_AGE old, so the next look (or the one going on)
   * asks again; an older one is replaced by a current one from the renderer.
   */
  wanted (proxy) {
    const now = Date.now()
    if (now - proxy.time < MAX_AGE) {
      if (!proxy.stale && proxy.row < MAX_ROW) {
        proxy.stale = setTimeout(() => {
          proxy.stale = null
          this.invalidate(proxy)
        }, MAX_AGE)
      }
      return
    }
    if (proxy.asking) {
      return
    }
    proxy.asking = setTimeout(() => {
      proxy.asking = null
    }, WAIT)
    proxy.row = now - proxy.asked < MAX_AGE * 2 + WAIT ? proxy.row + 1 : 0
    proxy.asked = now
    this.opts.onPicture?.(proxy.id)
  }

  invalidate (proxy) {
    if (this.proxies.get(proxy.id) === proxy) {
      check('DwmInvalidateIconicBitmaps', api.DwmInvalidateIconicBitmaps(proxy.hwnd))
    }
  }

  // a new picture: the taskbar asks again, and gets it
  setImage (proxy, img) {
    clearTimeout(proxy.asking)
    proxy.asking = null
    proxy.image = img
    proxy.time = Date.now()
    this.invalidate(proxy)
  }

  sendThumbnail (proxy, maxW, maxH) {
    try {
      const img = proxy.image || this.fallbackImage
      if (!img || img.isEmpty()) {
        return
      }
      const hbmp = toHBitmap(fit(img, maxW, maxH))
      if (hbmp) {
        check('DwmSetIconicThumbnail', api.DwmSetIconicThumbnail(proxy.hwnd, hbmp, 0))
        api.DeleteObject(hbmp)
      }
    } catch (e) {
      log.warn('taskbar thumbnail', e.message)
    }
  }

  sendPreview (proxy) {
    try {
      const main = this.main
      const img = proxy.image || this.fallbackImage
      if (!main || !img || img.isEmpty()) {
        return
      }
      const { width, height } = main.getContentBounds()
      const hbmp = toHBitmap(fit(img, width, height))
      if (hbmp) {
        check('DwmSetIconicLivePreviewBitmap', api.DwmSetIconicLivePreviewBitmap(proxy.hwnd, hbmp, null, 0))
        api.DeleteObject(hbmp)
      }
    } catch (e) {
      log.warn('taskbar live preview', e.message)
    }
  }

  /**
   * @param {{id: string, label: string}[]} tabs in tab order
   * @param {string} activeId
   */
  update (tabs, activeId) {
    if (!loadApi() || !this.main) {
      return false
    }
    const ids = new Set(tabs.map(t => t.id))
    for (const [id, proxy] of this.proxies) {
      if (!ids.has(id)) {
        this.remove(id, proxy)
      }
    }
    for (const t of tabs) {
      const proxy = this.proxies.get(t.id)
      if (!proxy) {
        this.proxies.set(t.id, this.createProxy(t.id, t.label))
      } else if (proxy.label !== t.label) {
        proxy.label = t.label
        proxy.win.setTitle(t.label)
      }
    }
    const order = tabs.map(t => t.id).join('\n')
    if (order !== this.order) {
      this.order = order
      // each one before the next, the last at the end
      for (let i = tabs.length - 1; i >= 0; i--) {
        const next = tabs[i + 1] && this.proxies.get(tabs[i + 1].id)
        check('SetTabOrder', api.tb.SetTabOrder(this.proxies.get(tabs[i].id).hwnd, next ? next.hwnd : 0n))
      }
    }
    for (const proxy of this.proxies.values()) {
      if (proxy.row >= MAX_ROW) {
        proxy.row = 0
        this.invalidate(proxy)
      }
    }
    const active = this.proxies.get(activeId)
    if (active) {
      check('SetTabActive', api.tb.SetTabActive(active.hwnd, hwndOf(this.main), 0))
    }
    return true
  }

  /**
   * The picture of a visible tab: after it connected, and when the taskbar
   * wants a current one.
   * @param {object} rect the tab's area in the window, null for all of it
   */
  async snapshot (id, rect) {
    const proxy = this.proxies.get(id)
    const main = this.main
    if (!proxy || !main) {
      return false
    }
    const img = await main.webContents.capturePage(rect || undefined)
    if (img.isEmpty()) {
      return false
    }
    this.setImage(proxy, img)
    return true
  }

  /**
   * A picture the renderer made of a tab that is not visible.
   * @param {string|null} dataUrl null: none for this tab, keep the last one
   */
  picture (id, dataUrl) {
    const proxy = this.proxies.get(id)
    if (!proxy || !dataUrl) {
      return false
    }
    const img = nativeImage.createFromDataURL(dataUrl)
    if (img.isEmpty()) {
      return false
    }
    this.setImage(proxy, img)
    return true
  }

  remove (id, proxy = this.proxies.get(id)) {
    if (!proxy) {
      return
    }
    this.proxies.delete(id)
    clearTimeout(proxy.asking)
    clearTimeout(proxy.stale)
    try {
      api.tb.UnregisterTab(proxy.hwnd)
    } catch (_) {}
    this.disposing = true
    proxy.win.destroy()
    this.disposing = false
  }

  dispose () {
    for (const [id, proxy] of this.proxies) {
      this.remove(id, proxy)
    }
    this.order = ''
  }
}

/**
 * Captions for the thumbnails: the tab title, and "#2", "#3" ... for tabs
 * with the same title, in tab order.
 * @param {{id: string, title: string}[]} tabs
 */
function numberLabels (tabs) {
  const count = {}
  for (const t of tabs) {
    count[t.title] = (count[t.title] || 0) + 1
  }
  const seen = {}
  return tabs.map(t => {
    if (count[t.title] < 2) {
      return { id: t.id, label: t.title }
    }
    seen[t.title] = (seen[t.title] || 0) + 1
    return { id: t.id, label: `${t.title} #${seen[t.title]}` }
  })
}

let instance = null

function getInstance () {
  if (!instance) {
    const globalState = require('./glob-state')
    const { iconPath } = require('../common/runtime-constants')
    const send = (event, id) => {
      const win = globalState.get('win')
      win && !win.isDestroyed() && win.webContents.send(event, id)
    }
    instance = new TaskbarTabs({
      getMain: () => globalState.get('win'),
      onActivate: id => send('taskbar-focus-tab', id),
      onClose: id => send('taskbar-close-tab', id),
      onPicture: id => send('taskbar-tab-picture', id),
      icon: iconPath
    })
  }
  return instance
}

/**
 * From the renderer: the open tabs, [] turns the thumbnails off.
 * @param {{id: string, title: string}[]} tabs in tab order
 */
function setTaskbarTabs (tabs, activeId) {
  if (process.platform !== 'win32') {
    return false
  }
  if (!tabs || !tabs.length) {
    instance?.dispose()
    return true
  }
  return getInstance().update(numberLabels(tabs), activeId)
}

function snapshotTaskbarTab (id, rect) {
  return instance ? instance.snapshot(id, rect) : false
}

function pictureTaskbarTab (id, dataUrl) {
  return instance ? instance.picture(id, dataUrl) : false
}

function disposeTaskbarTabs () {
  instance?.dispose()
}

module.exports = {
  TaskbarTabs,
  numberLabels,
  loadApi,
  setTaskbarTabs,
  snapshotTaskbarTab,
  pictureTaskbarTab,
  disposeTaskbarTabs
}
