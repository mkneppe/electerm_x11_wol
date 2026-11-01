/**
 * wake on lan from the renderer, the packet is sent by the main process
 * (src/app/lib/wol.js)
 */

import { useState } from 'react'
import { Button, Input, Space } from 'antd'
import message from '../components/common/message'
import Modal from '../components/common/modal'
import { settingMap } from './constants'

const e = window.translate

/**
 * @param {{wolMac: string, wolBroadcast?: string}} item bookmark or form values
 */
export async function wakeOnLan ({ wolMac, wolBroadcast }) {
  const r = await window.pre.runGlobalAsync('wakeOnLan', {
    mac: wolMac,
    address: wolBroadcast || undefined
  })
  if (r?.ok) {
    message.success(`Wake-on-LAN: ${wolMac} -> ${r.targets.join(', ')}`)
  } else {
    message.error(`Wake-on-LAN: ${r?.error || 'failed'}`)
  }
  return !!r?.ok
}

/**
 * MAC, broadcast address, and a host to look the MAC up by ARP (bookmark
 * host by default). Writes into `values`, read by the dialog's ok button.
 */
function WakeOnLanForm ({ values, host: initHost }) {
  const [state, setState] = useState({ ...values, host: initHost || '' })
  const [busy, setBusy] = useState(false)
  const set = (name, value) => {
    values[name] = value.trim()
    setState(old => ({ ...old, [name]: value }))
  }
  const findMac = async () => {
    setBusy(true)
    const r = await window.pre.runGlobalAsync('lookupMac', state.host.trim())
    setBusy(false)
    if (r?.ok) {
      set('wolMac', r.mac)
      message.success(`${state.host} (${r.ip}): ${r.mac}`)
    } else {
      message.error(`ARP: ${r?.error || 'failed'}`, 10)
    }
  }
  return (
    <div>
      <Space.Compact className='mg1b' block>
        <Input
          placeholder='Host or IP to find the MAC (ARP, local network)'
          value={state.host}
          onChange={ev => setState(old => ({ ...old, host: ev.target.value }))}
          onPressEnter={findMac}
        />
        <Button loading={busy} disabled={!state.host.trim()} onClick={findMac}>
          Find MAC
        </Button>
      </Space.Compact>
      <Input
        className='mg1b'
        placeholder='MAC: aa:bb:cc:dd:ee:ff'
        value={state.wolMac}
        onChange={ev => set('wolMac', ev.target.value)}
      />
      <Input
        placeholder='Broadcast address (optional): 192.168.1.255'
        value={state.wolBroadcast}
        onChange={ev => set('wolBroadcast', ev.target.value)}
      />
    </div>
  )
}

/**
 * @param {object} [bookmark] given: the MAC is saved to it when waking works,
 *   so the next wake needs no dialog
 */
export function openWakeOnLanDialog (bookmark) {
  const values = {
    wolMac: bookmark?.wolMac || '',
    wolBroadcast: bookmark?.wolBroadcast || ''
  }
  Modal.confirm({
    title: 'Wake on LAN' + (bookmark ? ': ' + (bookmark.title || bookmark.host) : ''),
    content: <WakeOnLanForm values={values} host={bookmark?.host} />,
    okText: 'Wake',
    cancelText: e('cancel'),
    onOk: async () => {
      const ok = await wakeOnLan(values)
      if (ok && bookmark?.id) {
        window.store.editItem(bookmark.id, { ...values }, settingMap.bookmarks)
      }
    }
  })
}

/**
 * bookmark context menu: wake right away when the bookmark has a MAC,
 * otherwise ask for it
 * @param {string} id bookmark id
 */
export function wakeBookmark (id) {
  const bookmark = window.store.bookmarks.find(b => b.id === id)
  if (!bookmark) {
    return
  }
  if (bookmark.wolMac) {
    return wakeOnLan(bookmark)
  }
  openWakeOnLanDialog(bookmark)
}
