/**
 * ensureX11Server (src/app/lib/x11-server.js) for the renderer: when the
 * port of the electerm-managed x server is taken, ask the user once, for all
 * tabs connecting now: use the free port found (saved in the settings), use
 * the x server there (only one that takes any client), or go on without X11.
 */

import { createRoot } from 'react-dom/client'
import Modal from '../components/common/modal'

let asking = null

/**
 * @param {{error: string, conflict: {port: number, owner: string, program: string, suggestion: number|null}}} r
 * @return {Promise<object>} what ensureX11Server returns for the choice,
 *   { ok: false, declined: true }: without X11
 */
function askPortTaken (r) {
  const { owner, suggestion } = r.conflict
  const canShare = owner === 'open'
  return new Promise(resolve => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const pick = choice => {
      root.unmount()
      container.remove()
      resolve(choice
        ? window.pre.runGlobalAsync('ensureX11Server', choice)
        : { ok: false, declined: true })
    }
    const usePort = () => {
      window.store.updateConfig({ x11Port: suggestion })
      pick({ port: suggestion })
    }
    const button = (text, onClick, primary) => (
      <button
        type='button'
        className={primary ? 'custom-modal-ok-btn' : 'custom-modal-cancel-btn'}
        onClick={onClick}
        key={text}
      >
        {text}
      </button>
    )
    const footer = (
      <div className='custom-modal-footer-buttons'>
        {button('Without X11', () => pick(null))}
        {canShare ? button('Use it', () => pick({ share: true }), !suggestion) : null}
        {suggestion ? button(`Use port ${suggestion}`, usePort, true) : null}
      </div>
    )
    root.render(
      <Modal
        open
        title='X11 server'
        width={560}
        footer={footer}
        onCancel={() => pick(null)}
      >
        <div className='pd1y'>
          <div>{r.error}</div>
          {canShare
            ? <div className='pd1t'>It takes any client: "Use it" sends the X11 apps of the SSH tabs there, for as long as electerm runs.</div>
            : null}
          {suggestion
            ? <div className='pd1t'>Port {suggestion} is free: "Use port {suggestion}" starts it there and keeps that port in Settings &gt; Terminal &gt; X11 server.</div>
            : <div className='pd1t'>No free port found in 6000-6099.</div>}
        </div>
      </Modal>
    )
  })
}

/**
 * @return {Promise<{ok: boolean, port?: number, cookie?: string, authFile?: string, error?: string, declined?: boolean}>}
 */
export async function ensureX11Server () {
  const r = await window.pre.runGlobalAsync('ensureX11Server')
  if (!r?.conflict) {
    return r
  }
  if (!asking) {
    asking = askPortTaken(r).finally(() => {
      asking = null
    })
  }
  return asking
}
