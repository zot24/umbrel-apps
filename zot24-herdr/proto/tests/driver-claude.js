// Drives menu option 4 (claude setup-token) using the quiet-timer pump.
const {WebSocket} = require('/app/node_modules/ws')
const BASE = 'http://127.0.0.1:7681'
const INPUTS = ['4\r', 'q\r']
const main = async () => {
  const html = await (await fetch(`${BASE}/setup`)).text()
  const token = html.match(/const token = "([^"]+)"/)[1]
  const ws = new WebSocket(`ws://127.0.0.1:7681/api/pty?token=${encodeURIComponent(token)}`)
  let transcript = ''
  let quiet = null
  let index = 0
  let sentInterrupt = false
  const pump = () => {
    const plain = transcript.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    // If setup-token actually launched (claude installed), Ctrl+C out first.
    if (!sentInterrupt && /https:\/\/claude\.ai|console\.anthropic\.com|Paste code/i.test(plain)) {
      sentInterrupt = true
      ws.send(JSON.stringify({type: 'input', data: '\x03'}))
      return
    }
    if (index >= INPUTS.length) return
    ws.send(JSON.stringify({type: 'input', data: INPUTS[index++]}))
  }
  ws.on('open', () => ws.send(JSON.stringify({type: 'resize', cols: 100, rows: 30})))
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.type === 'exit') { console.log(transcript); console.log(`[exit ${m.code}]`); process.exit(0) }
    if (m.type !== 'data' && m.type !== 'notice') return
    transcript += m.data
    clearTimeout(quiet)
    quiet = setTimeout(pump, 400)
  })
  ws.on('error', (e) => { console.error('err', e.message); process.exit(1) })
  setTimeout(() => { console.log(transcript); console.log('[global timeout]'); process.exit(0) }, 90000)
}
main()
