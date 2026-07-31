// herdr setup wizard + read-only status dashboard — LOCAL PROTOTYPE.
//
// Shape follows Umbrel's official Hermes packaging (see
// reports/2026-07-27/HERDR-SETUP-PAGE.md):
//
//   - The wizard is a terminal, not an HTML form. A PTY is the only surface on
//     which every credential flow works without reimplementing OAuth: pasted
//     keys, pasted tokens, print-URL-then-paste-code, device codes.
//   - The PTY execs ONE FIXED ARGV — this app's own wizard script — and never a
//     shell. That is the whole difference between this and ttyd. Hermes gets the
//     same property by resolving argv in code (web_server.py:3402 ->
//     main.py:1331-1338); here it is a literal constant, which is stronger.
//   - "Is it configured?" is derived per request, never stored. No sentinel.
//   - No login of its own: Umbrel's app_proxy is the auth boundary, exactly as
//     HERMES_UMBREL_APP_PROXY_AUTH declares (hermes-agent/docker-compose.yml:21).
//
// PROTOTYPE CAVEAT: there is no app_proxy in front of this locally, so nothing
// authenticates you. Run it on a scratch data dir with fake placeholders only.

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const {WebSocketServer} = require('ws')
const pty = require('node-pty')

const state = require('./lib/state')
const pages = require('./lib/pages')

const PORT = Number(process.env.STATUS_PORT || 7681)
const SSH_PORT = Number(process.env.SSH_PORT || 7682)

// The wizard argv. A literal, module-scope constant: no request data reaches it,
// no shell interprets it, no environment variable redirects it.
const WIZARD_ARGV = [process.execPath, '/app/herdr-setup']

// Ephemeral, regenerated every process start, injected into the page HTML.
// Be honest about what this is: anyone who can GET / obtains it, so it is a
// CSRF / cross-origin-upgrade defence, not authentication. WebSocket upgrades
// are not covered by CORS, so without it any page the owner has open could
// open a PTY. Same pattern and same limits as Hermes's _SESSION_TOKEN
// (hermes_cli/web_server.py:88, 3744, 126-148).
const SESSION_TOKEN = crypto.randomBytes(32).toString('base64url')

// Only one PTY at a time, and it dies on idle. An abandoned PTY is a warm
// wizard waiting for whoever opens the tab next.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000
const MAX_LIFETIME_MS = 30 * 60 * 1000
let activePty = null

const constantTimeEqual = (a, b) => {
	const left = Buffer.from(String(a))
	const right = Buffer.from(String(b))
	if (left.length !== right.length) return false
	return crypto.timingSafeEqual(left, right)
}

// Behind Umbrel's app_proxy the original Host is forwarded, so comparing it is
// a real origin check. NOTE (prototype): PROXY_HOST is unset locally, which
// disables the comparison — production must set it. Hermes's _is_accepted_host
// (hermes_cli/web_server.py:163-203) is the same idea, including its admission
// that a 0.0.0.0 bind cannot be defended at this layer.
const PROXY_HOST = (process.env.APP_PROXY_HOST || '').toLowerCase()

const hostAccepted = (request) => {
	if (!PROXY_HOST) return true // prototype default — see note above
	const host = String(request.headers.host || '').toLowerCase()
	const bare = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
	return bare === PROXY_HOST
}

const originAccepted = (request) => {
	const origin = request.headers.origin
	if (!origin) return true // non-browser client; the token still gates it
	try {
		const url = new URL(origin)
		return url.host.toLowerCase() === String(request.headers.host || '').toLowerCase()
	} catch {
		return false
	}
}

const send = (response, status, type, body) => {
	response.writeHead(status, {'content-type': type, 'cache-control': 'no-store'})
	response.end(body)
}

const ASSET_ROOT = path.join(__dirname, 'assets')
const ASSET_TYPES = {'.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8'}

const serveAsset = (response, name) => {
	// Basename only: no traversal, no nested paths.
	const file = path.join(ASSET_ROOT, path.basename(name))
	const type = ASSET_TYPES[path.extname(file)]
	if (!type) return send(response, 404, 'text/plain', 'not found')
	fs.readFile(file, (error, data) => {
		if (error) return send(response, 404, 'text/plain', 'not found')
		response.writeHead(200, {'content-type': type, 'cache-control': 'no-store'})
		response.end(data)
	})
}

const server = http.createServer(async (request, response) => {
	const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)

	if (request.method !== 'GET' && request.method !== 'HEAD') {
		// There is no POST anywhere in this design. Credentials go in over the
		// PTY, so there is no HTTP write path to harden, forge, or rate-limit.
		response.writeHead(405, {allow: 'GET, HEAD'}).end()
		return
	}

	if (url.pathname.startsWith('/assets/')) return serveAsset(response, url.pathname.slice('/assets/'.length))

	if (url.pathname === '/health') {
		const snapshot = await state.snapshot()
		return send(response, 200, 'application/json', JSON.stringify({ok: true, configured: snapshot.configured}))
	}

	if (url.pathname === '/api/state') {
		const snapshot = await state.snapshot({fresh: url.searchParams.get('fresh') === '1'})
		return send(response, 200, 'application/json', JSON.stringify(snapshot))
	}

	if (url.pathname === '/setup') {
		// Always the wizard, configured or not: this is how a key gets rotated,
		// without the "delete a file to get the wizard back" papercut.
		return send(response, 200, 'text/html; charset=utf-8', pages.wizard({token: SESSION_TOKEN, sshPort: SSH_PORT}))
	}

	if (url.pathname === '/') {
		const snapshot = await state.snapshot()
		const body = snapshot.configured
			? pages.dashboard({snapshot, token: SESSION_TOKEN, sshPort: SSH_PORT})
			: pages.wizard({token: SESSION_TOKEN, sshPort: SSH_PORT, first: true})
		return send(response, 200, 'text/html; charset=utf-8', body)
	}

	send(response, 404, 'text/plain', 'not found')
})

const wss = new WebSocketServer({noServer: true})

server.on('upgrade', (request, socket, head) => {
	const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
	const reject = (code, reason) => {
		socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`)
		socket.destroy()
	}

	if (url.pathname !== '/api/pty') return reject(404, 'Not Found')
	if (!hostAccepted(request)) return reject(400, 'Bad Request')
	if (!originAccepted(request)) return reject(403, 'Forbidden')
	if (!constantTimeEqual(url.searchParams.get('token') || '', SESSION_TOKEN)) return reject(401, 'Unauthorized')
	if (activePty) return reject(409, 'Conflict')

	wss.handleUpgrade(request, socket, head, (ws) => attach(ws))
})

const attach = (ws) => {
	const child = pty.spawn(WIZARD_ARGV[0], WIZARD_ARGV.slice(1), {
		name: 'xterm-256color',
		cols: 80,
		rows: 24,
		cwd: state.DATA_DIR,
		env: {
			// A deliberately minimal environment. Nothing from the request, and
			// none of the secrets this container holds — the wizard reads .env
			// itself, it does not need them inherited.
			PATH: `${state.NPM_BIN}:/usr/local/bin:/usr/bin:/bin`,
			HOME: state.DATA_DIR,
			TERM: 'xterm-256color',
			LANG: 'C.UTF-8',
			HERDR_DATA_DIR: state.DATA_DIR,
			HERDR_SSH_PORT: String(SSH_PORT),
		},
	})

	activePty = child
	let lastActivity = Date.now()
	const startedAt = Date.now()

	const kill = (why) => {
		try {
			ws.send(JSON.stringify({type: 'notice', data: why}))
		} catch {}
		try {
			child.kill()
		} catch {}
	}

	const timer = setInterval(() => {
		if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) kill('\r\n[closed: idle]\r\n')
		else if (Date.now() - startedAt > MAX_LIFETIME_MS) kill('\r\n[closed: session limit]\r\n')
	}, 15_000)

	// Nothing here logs PTY contents in either direction. The owner types
	// secrets into this stream.
	child.onData((data) => {
		if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({type: 'data', data}))
	})

	child.onExit(({exitCode}) => {
		clearInterval(timer)
		activePty = null
		state.invalidate()
		if (ws.readyState === ws.OPEN) {
			ws.send(JSON.stringify({type: 'exit', code: exitCode}))
			ws.close()
		}
	})

	ws.on('message', (raw) => {
		lastActivity = Date.now()
		let message
		try {
			message = JSON.parse(raw.toString())
		} catch {
			return
		}
		if (message.type === 'input' && typeof message.data === 'string') child.write(message.data)
		else if (message.type === 'resize') {
			const cols = Math.min(Math.max(Number(message.cols) | 0, 20), 300)
			const rows = Math.min(Math.max(Number(message.rows) | 0, 8), 120)
			try {
				child.resize(cols, rows)
			} catch {}
		}
	})

	ws.on('close', () => {
		clearInterval(timer)
		try {
			child.kill()
		} catch {}
	})
}

server.listen(PORT, '0.0.0.0', () => {
	console.log(`herdr setup+status: listening on ${PORT}`)
	console.log(`  data dir: ${state.DATA_DIR}`)
	console.log(`  wizard argv: ${JSON.stringify(WIZARD_ARGV)}`)
})
