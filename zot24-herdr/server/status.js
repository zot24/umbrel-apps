// Status page for the Umbrel app tile.
//
// Umbrel requires every app to declare a `port` and answer on it — app_proxy
// has to have somewhere to send the tile, and umbreld's manifest schema makes
// `port` mandatory. This app has no web UI to put there: Herdr is a terminal
// multiplexer and you drive it over SSH (port 7682), deliberately, so that the
// browser is never a shell into a container holding API keys and git
// credentials.
//
// So the tile gets this: a read-only "it's running, here's how to attach"
// page. No input, no WebSocket, no terminal.

const http = require('node:http')
const {execFile} = require('node:child_process')

const PORT = Number(process.env.STATUS_PORT || 7681)
const SSH_PORT = Number(process.env.SSH_PORT || 7682)

const sessions = () =>
	new Promise((resolve) => {
		execFile('herdr', ['session', 'list', '--json'], {timeout: 3000}, (error, stdout) => {
			if (error) return resolve(null)
			try {
				resolve(JSON.parse(stdout).sessions ?? [])
			} catch {
				resolve(null)
			}
		})
	})

const escape = (value) =>
	String(value).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c])

const page = (list) => {
	const rows =
		list === null
			? '<tr><td colspan="2" class="dim">Herdr server not reachable — check the app logs.</td></tr>'
			: list.length === 0
				? '<tr><td colspan="2" class="dim">No sessions yet. Attach over SSH to create one.</td></tr>'
				: list
						.map(
							(s) =>
								`<tr><td>${escape(s.name)}${s.default ? ' <span class="dim">(default)</span>' : ''}</td>` +
								`<td class="${s.running ? 'ok' : 'dim'}">${s.running ? 'running' : 'stopped'}</td></tr>`,
						)
						.join('')

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Herdr</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
         margin: 0; padding: 2.5rem 1.5rem; display: flex; justify-content: center; }
  main { width: 100%; max-width: 34rem; }
  h1 { font-size: 1.3rem; margin: 0 0 .25rem; }
  p { margin: .4rem 0 1.4rem; opacity: .75; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .08em;
       opacity: .6; margin: 1.8rem 0 .5rem; font-weight: 600; }
  pre { background: rgba(127,127,127,.14); padding: .8rem 1rem; border-radius: 8px;
        overflow-x: auto; margin: 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: .35rem 0; border-bottom: 1px solid rgba(127,127,127,.2); }
  td + td { text-align: right; }
  .dim { opacity: .55; }
  .ok { color: #16a34a; }
  @media (prefers-color-scheme: dark) { .ok { color: #4ade80; } }
</style>
</head>
<body>
<main>
  <h1>Herdr is running</h1>
  <p>Your agents keep running here whether or not anything is attached.
     There is no terminal in this page on purpose — attach over SSH.</p>

  <h2>Attach</h2>
  <pre>ssh -p ${SSH_PORT} node@&lt;your-umbrel&gt;
herdr</pre>

  <h2>Sessions</h2>
  <table>${rows}</table>

  <h2>First time?</h2>
  <p class="dim">SSH only starts once a key is authorised: add
     <code>SSH_AUTHORIZED_KEYS=…</code> to the app's <code>.env</code>, or a key to
     <code>data/.ssh/authorized_keys</code>, then restart the app.</p>
</main>
</body>
</html>
`
}

http
	.createServer(async (request, response) => {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			response.writeHead(405, {allow: 'GET, HEAD'}).end()
			return
		}
		const list = await sessions()
		if (request.url === '/health') {
			response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({sessions: list ?? []}))
			return
		}
		response.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'})
		response.end(request.method === 'HEAD' ? undefined : page(list))
	})
	.listen(PORT, '0.0.0.0', () => console.log(`status: listening on ${PORT}`))
