// Test driver — copied into the container by `./run.sh test`. Drives the wizard over the same
// WebSocket the browser uses, with obviously-fake placeholder values, then
// prints the transcript. Not part of the prototype; deleted by run.sh reset.

const {WebSocket} = require('/app/node_modules/ws')

const BASE = 'http://127.0.0.1:7681'

const INPUTS = [
	'1\r', // menu -> agent credentials
	'sk-ant-FAKE-do-not-use\r', // ANTHROPIC_API_KEY
	'\r', // CLAUDE_CODE_OAUTH_TOKEN — skip
	'\r', // XAI_API_KEY — skip
	'\r', // GEMINI_API_KEY — skip
	'\r', // VERCEL_TOKEN — skip
	'\r', // GH_TOKEN — skip
	'3\r', // menu -> SSH access
	'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE proto@fake\r',
	'q\r', // finish
]

const main = async () => {
	const html = await (await fetch(`${BASE}/setup`)).text()
	const token = html.match(/const token = "([^"]+)"/)[1]
	console.log(`[driver] got session token (${token.length} chars)`)

	const ws = new WebSocket(`ws://127.0.0.1:7681/api/pty?token=${encodeURIComponent(token)}`)
	let transcript = ''
	let quiet = null
	let index = 0

	const pump = () => {
		if (index >= INPUTS.length) return
		const next = INPUTS[index++]
		ws.send(JSON.stringify({type: 'input', data: next}))
	}

	ws.on('open', () => {
		console.log('[driver] pty open')
		ws.send(JSON.stringify({type: 'resize', cols: 100, rows: 30}))
	})

	ws.on('message', (raw) => {
		const message = JSON.parse(raw.toString())
		if (message.type === 'data' || message.type === 'notice') {
			transcript += message.data
			clearTimeout(quiet)
			quiet = setTimeout(pump, 300)
		} else if (message.type === 'exit') {
			clearTimeout(quiet)
			console.log(`\n===== TRANSCRIPT =====\n${transcript}\n===== END (exit ${message.code}) =====`)
			ws.close()
			setTimeout(async () => {
				const state = await (await fetch(`${BASE}/api/state?fresh=1`)).json()
				console.log('[driver] configured now:', state.configured, JSON.stringify(state.checks))
				console.log('[driver] credentials set:', state.credentials.filter((c) => c.set).map((c) => c.name))
				process.exit(0)
			}, 300)
		}
	})

	ws.on('error', (error) => {
		console.error('[driver] error', error.message)
		process.exit(1)
	})
}

main()
