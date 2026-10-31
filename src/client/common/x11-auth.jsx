/**
 * show display and cookie of the x server electerm manages
 * (src/app/lib/x11-server.js), to use it from other ssh clients, eg PuTTY
 */

import CopyIcon from '../components/ai/copy-icon'
import message from '../components/common/message'
import Modal from '../components/common/modal'
import { ensureX11Server } from './x11-server.jsx'

function row (label, value) {
  return (
    <div className='pd1b' key={label}>
      <div>{label}</div>
      <code className='mg1r'>{value}</code>
      <CopyIcon text={value} />
    </div>
  )
}

export async function showX11Auth () {
  // starts the x server if needed, the other client wants to connect now
  const r = await ensureX11Server()
  if (r?.declined) {
    return
  }
  if (!r?.port) {
    message.error(`X11 server: ${r?.error || 'not managed by electerm'}`)
    return
  }
  const display = `localhost:${r.port - 6000}`
  Modal.info({
    title: 'X11 authority',
    width: 640,
    content: (
      <div>
        {row('X display location', display)}
        {row('X authority file', r.authFile)}
        {row('MIT-MAGIC-COOKIE-1', r.cookie)}
        {row('xauth', `xauth add ${display} MIT-MAGIC-COOKIE-1 ${r.cookie}`)}
        <p>
          PuTTY: Connection &gt; SSH &gt; X11, enable X11 forwarding, set
          X display location and X authority file as above.
          The x server runs as long as electerm does.
        </p>
      </div>
    )
  })
}
