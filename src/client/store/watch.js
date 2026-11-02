/**
 * auto run when data change
 */

import createTitle from '../common/create-title'
import { autoRun } from 'manate'
import { update, remove, insert, dbNamesForWatch, dbNamesForSync } from '../common/db'
import {
  sftpDefaultSortSettingKey,
  checkedKeysLsKey,
  expandedKeysLsKey,
  resolutionsLsKey,
  localAddrBookmarkLsKey,
  syncServerDataKey,
  statusMap,
  isWin
} from '../common/constants'
import * as ls from '../common/safe-local-storage'
import { debounce, isEmpty } from 'lodash-es'
import deepCopy from 'json-deep-copy'
import { refsStatic } from '../components/common/ref'
import dataCompare from '../common/data-compare'
import { tabPicture } from '../common/taskbar-picture'

/**
 * Windows: the tabs as thumbnails in the taskbar (setting `taskbarTabs`).
 * The tab list goes to the main process on every change; the picture of a tab
 * is taken once, a moment after it connected while it is the visible one, and
 * again whenever the taskbar shows an outdated one: a snapshot when the tab is
 * on screen, else drawn from the hidden tab (taskbar-picture.js).
 */
function taskbarTabs (store) {
  const snapped = new Set()
  const send = debounce((tabs, activeId) => {
    window.pre.runGlobalAsync('setTaskbarTabs', tabs, activeId)
  }, 300)
  autoRun(() => {
    const on = !!store.config.taskbarTabs
    const tabs = on
      ? store.getTabs().map(t => ({ id: t.id, title: t.title || createTitle(t) }))
      : []
    send(tabs, store.activeTabId)
    if (!on) {
      snapped.clear()
    }
    return tabs
  }).start()
  // The session area of tab `id`, in window pixels, when it is what the user
  // sees right now: nothing over it (settings, dialogs), window not hidden.
  // Otherwise null, and the picture waits.
  const visibleRect = id => {
    if (store.showModal || document.visibilityState !== 'visible') {
      return null
    }
    const el = document.querySelector(`.session-${id}`)
    const r = el?.getBoundingClientRect()
    if (!r || !r.width || !r.height) {
      return null
    }
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    if (!hit || !el.contains(hit)) {
      return null
    }
    const zoom = window.api?.getZoomFactor?.() || 1
    return {
      x: Math.round(r.left * zoom),
      y: Math.round(r.top * zoom),
      width: Math.round(r.width * zoom),
      height: Math.round(r.height * zoom)
    }
  }
  let timer = null
  const trySnapshot = (id, tries) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const tab = store.getTabs().find(t => t.id === id)
      if (
        !store.config.taskbarTabs ||
        store.activeTabId !== id ||
        !tab ||
        tab.status !== statusMap.success ||
        snapped.has(id)
      ) {
        return
      }
      const rect = visibleRect(id)
      if (!rect) {
        // covered or hidden: look again a bit later, the autoRun below also
        // tries again when a modal closes
        if (tries > 1) {
          trySnapshot(id, tries - 1)
        }
        return
      }
      snapped.add(id)
      window.pre.runGlobalAsync('snapshotTaskbarTab', id, rect)
    }, 1500)
  }
  autoRun(() => {
    const { activeTabId, showModal } = store
    const tab = store.getTabs().find(t => t.id === activeTabId)
    if (
      store.config.taskbarTabs &&
      tab &&
      tab.status === statusMap.success &&
      !showModal &&
      !snapped.has(tab.id)
    ) {
      trySnapshot(tab.id, 20)
    }
    return [activeTabId, tab?.status, showModal, store.config.taskbarTabs]
  }).start()
  // the taskbar wants a current picture of tab `id`
  window.pre.ipcOnEvent('taskbar-tab-picture', async (e, id) => {
    const tab = store.getTabs().find(t => t.id === id)
    if (!store.config.taskbarTabs || !tab) {
      return
    }
    const rect = visibleRect(id)
    if (rect) {
      window.pre.runGlobalAsync('snapshotTaskbarTab', id, rect)
      return
    }
    const url = await tabPicture(tab)
    window.pre.runGlobalAsync('pictureTaskbarTab', id, url)
  })
  // the window coming back (restored, other desktop) can uncover the tab
  document.addEventListener('visibilitychange', () => {
    const { activeTabId } = store
    if (store.config.taskbarTabs && activeTabId && !snapped.has(activeTabId)) {
      trySnapshot(activeTabId, 20)
    }
  })
}

export default store => {
  for (const name of dbNamesForWatch) {
    // ai chat history changes on every streaming tick (200ms polls,
    // per-chunk agent updates); debounce to coalesce them into one
    // db write after the stream pauses
    const schedule = name === 'aiChatHistory'
      ? func => debounce(func, 1000)
      : undefined
    window[`watch${name}`] = autoRun(async () => {
      const n = store.getItems(name)
      if (window.migrating) {
        return
      }
      const old = refsStatic.get('oldState-' + name)
      const { updated, added, removed } = dataCompare(
        old,
        n
      )
      const newOrder = (n || []).map(d => d.id)
      // with large collections (thousands of bookmarks) this autoRun fires
      // often; when neither content nor order changed, skip the deep-copy
      // snapshot and the DB writes entirely
      const orderChanged = !old ||
        old.length !== (n || []).length ||
        old.some((d, i) => d.id !== newOrder[i])
      if (!updated.length && !added.length && !removed.length && !orderChanged) {
        return store[name]
      }
      // Update snapshot immediately before async DB writes to prevent
      // race conditions: a second autoRun firing before the first
      // completes would see stale oldState and re-insert the same items,
      // causing NeDB unique constraint errors.
      refsStatic.add('oldState-' + name, deepCopy(n) || [])
      await Promise.all([
        ...removed.map(item => remove(name, item.id)),
        ...updated.map(item => update(item.id, item, name, false)),
        added.length ? insert(name, added) : Promise.resolve()
      ])
      if (orderChanged) {
        await update(
          `${name}:order`,
          newOrder
        )
      }
      if (name === 'bookmarks') {
        store.bookmarksMap = new Map(
          n.map(d => [d.id, d])
        )
      }
      await store.updateLastDataUpdateTime()
      if (dbNamesForSync.includes(name)) {
        const syncSetting = store.config.syncSetting || {}
        const { autoSync, autoSyncInterval, autoSyncDirection } = syncSetting
        if (autoSync && autoSyncInterval === 0) {
          if (autoSyncDirection === 'download') {
            await store.downloadSettingAll()
          } else {
            await store.uploadSettingAll()
          }
        }
      }
      return store[name]
    }, schedule)
    // Make the current store contents the watcher's baseline, so a later
    // start() diffs against the store rather than a snapshot that no longer
    // describes it. Needed after a rolled-back import: the store has just been
    // restored to its pre-import state, and diffing that against the snapshot
    // taken before the import would be read as "every record was removed".
    window[`watch${name}`].reseed = () => {
      refsStatic.add('oldState-' + name, deepCopy(store.getItems(name)) || [])
    }
    window[`watch${name}`].start()
  }

  autoRun(async () => {
    ls.setItemJSON(resolutionsLsKey, store.resolutions)
    return store.resolutions
  }).start()

  autoRun(() => {
    if (!store.showModal) {
      store.focus()
    } else {
      store.blur()
    }
    return store.showModal
  }).start()

  autoRun(() => {
    if (!isEmpty(store.config)) {
      window.pre.runGlobalAsync('saveUserConfig', store.config)
    }
    return store.config
  }, func => debounce(func, 100)).start()

  autoRun(() => {
    store.updateLastDataUpdateTime()
    return store.config.theme
  }, func => debounce(func, 100)).start()

  autoRun(() => {
    store.updateTabsStatus()
    return store.transferCount
  }).start()

  autoRun(() => {
    ls.setItemJSON(sftpDefaultSortSettingKey, store.sftpSortSetting)
    return store.sftpSortSetting
  }).start()

  autoRun(() => {
    ls.setItemJSON(expandedKeysLsKey, store.expandedKeys)
    return store.expandedKeys
  }).start()

  autoRun(() => {
    ls.setItemJSON(localAddrBookmarkLsKey, store.addressBookmarksLocal)
    return store.addressBookmarksLocal
  }).start()

  autoRun(() => {
    ls.setItemJSON(checkedKeysLsKey, store.checkedKeys)
    return store.checkedKeys
  }).start()

  autoRun(() => {
    ls.setItemJSON(syncServerDataKey, store.syncServerStatus)
    return store.syncServerStatus
  }).start()

  if (isWin) {
    taskbarTabs(store)
  }

  autoRun(() => {
    store.updateBatchInputSelectedTabIds()
    const tabs = store.getTabs()
    const { activeTabId } = store
    const tab = tabs.find(t => t.id === activeTabId)
    if (tab) {
      const title = createTitle(tab)
      window.pre.runGlobalAsync('setTitle', title)
      window.store.currentLayoutBatch = tab.batch
    }
    // refreshing the info panel on tab switch only concerns the info tab: the
    // right panel can also be showing the AI chat or the cmd history
    if (tab && store.rightPanelVisible && store.rightPanelTab === 'info') {
      window.store.openInfoPanelAction()
    }
    return store.activeTabId
  }).start()
}
