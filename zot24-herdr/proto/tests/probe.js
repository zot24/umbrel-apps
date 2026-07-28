// Security probes against the running prototype. Runs inside the container.
const {WebSocket} = require('/app/node_modules/ws')

const BASE = 'http://127.0.0.1:7681'

const upgrade = (query, headers = {}) =>
	new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:7681/api/pty${query}`, {headers})
		const done = (result) => {
			try {
				ws.close()
			} catch {}
			resolve(result)
		}
		ws.on('unexpected-response', (_req, res) => done(`rejected ${res.statusCode}`))
		ws.on('open', () => done('ACCEPTED'))
		ws.on('error', (error) => done(`error ${error.message}`))
		setTimeout(() => done('timeout'), 4000)
	})

const main = async () => {
	const html = await (await fetch(`${BASE}/setup`)).text()
	const token = html.match(/const token = "([^"]+)"/)[1]

	console.log('no token           ->', await upgrade(''))
	console.log('wrong token        ->', await upgrade('?token=deadbeef'))
	console.log('right length wrong ->', await upgrade(`?token=${'A'.repeat(token.length)}`))
	console.log('cross-origin       ->', await upgrade(`?token=${token}`, {origin: 'http://evil.example'}))
	console.log('wrong path         ->', await upgrade('').then(() => 'n/a'))

	// Valid, then a second one while the first is open.
	const first = new WebSocket(`ws://127.0.0.1:7681/api/pty?token=${token}`)
	await new Promise((r) => first.on('open', r))
	console.log('valid token        -> ACCEPTED')
	console.log('second concurrent  ->', await upgrade(`?token=${token}`))
	first.close()
	setTimeout(() => process.exit(0), 500)
}

main()
