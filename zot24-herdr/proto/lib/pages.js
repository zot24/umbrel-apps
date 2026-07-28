// Server-rendered HTML. Deliberately no framework and no CDN: the app ships no
// external assets today and must not gain any — a strict-CSP-shaped constraint
// that also keeps the image small. xterm.js is vendored from node_modules at
// build time (see Dockerfile).

const escape = (value) =>
	String(value ?? '').replace(
		/[&<>"']/g,
		(c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c],
	)

const STYLE = `
  :root { color-scheme: light dark; --ok: #16a34a; --warn: #b45309; --bad: #b91c1c; }
  @media (prefers-color-scheme: dark) {
    :root { --ok: #4ade80; --warn: #fbbf24; --bad: #f87171; }
  }
  * { box-sizing: border-box; }
  body { font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
         margin: 0; padding: 2.5rem 1.5rem; display: flex; justify-content: center; }
  main { width: 100%; max-width: 46rem; }
  h1 { font-size: 1.3rem; margin: 0 0 .25rem; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .08em;
       opacity: .6; margin: 2rem 0 .6rem; font-weight: 600; }
  p { margin: .4rem 0 1.2rem; opacity: .75; }
  pre, code { font-family: inherit; }
  pre { background: rgba(127,127,127,.14); padding: .8rem 1rem; border-radius: 8px;
        overflow-x: auto; margin: 0 0 1rem; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: .4rem 0; border-bottom: 1px solid rgba(127,127,127,.2);
           text-align: left; font-weight: inherit; vertical-align: top; }
  td + td, th + th { text-align: right; padding-left: 1rem; }
  .dim { opacity: .55; }
  .ok { color: var(--ok); }
  .warn { color: var(--warn); }
  .bad { color: var(--bad); }
  .sub { font-size: .82rem; opacity: .6; display: block; }
  .row-actions { margin: 1.4rem 0; display: flex; gap: .6rem; flex-wrap: wrap; }
  a.button, button {
    font: inherit; padding: .5rem .9rem; border-radius: 8px; cursor: pointer;
    border: 1px solid rgba(127,127,127,.45); background: transparent;
    color: inherit; text-decoration: none;
  }
  a.button:hover, button:hover { background: rgba(127,127,127,.14); }
  .banner { border: 1px solid rgba(127,127,127,.35); border-left-width: 3px;
            border-radius: 6px; padding: .7rem 1rem; margin: 0 0 1.4rem; font-size: .9rem; }
  .banner.warn { border-left-color: var(--warn); }
  .banner.proto { border-left-color: var(--bad); }
  #term { height: 26rem; border-radius: 8px; padding: .6rem;
          background: #0b0e14; overflow: hidden; }
  .term-status { font-size: .82rem; opacity: .7; margin: .6rem 0 0; }
`

const PROTO_BANNER = `<div class="banner proto"><strong>Local prototype.</strong>
  Nothing authenticates this page — there is no Umbrel app proxy in front of it.
  Use a scratch data directory and obviously-fake placeholder credentials only.</div>`

const shell = ({title, body, head = ''}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${STYLE}</style>
${head}
</head>
<body><main>${body}</main></body>
</html>
`

const wizard = ({token, sshPort, first = false}) =>
	shell({
		title: first ? 'Herdr — setup' : 'Herdr — configure',
		head: `<link rel="stylesheet" href="/assets/xterm.css">`,
		body: `
  ${PROTO_BANNER}
  <h1>${first ? 'Set up Herdr' : 'Configure Herdr'}</h1>
  <p>${
		first
			? 'This box has no agent credential or no authorised SSH key yet. Work through the wizard below, then you land on the status page.'
			: 'Re-run the wizard any time to add or rotate a credential. Existing values are kept unless you replace them.'
	}</p>

  <div id="term"></div>
  <p class="term-status" id="status">connecting…</p>

  <div class="row-actions">
    <a class="button" href="/">Status page</a>
    <button id="restart" hidden>Run again</button>
  </div>

  <h2>What this terminal is</h2>
  <p class="dim">It runs one fixed program — this app's setup script — and never a shell.
     That is why a terminal is acceptable here when a full web terminal was not:
     the wizard prompts, writes <code>.env</code>, and exits. It cannot be steered
     somewhere else. Everything the wizard cannot do (minting a Claude subscription
     token, device-code logins) it tells you to run over
     <code>ssh -p ${sshPort} node@&lt;your-umbrel&gt;</code> instead.</p>

<script src="/assets/xterm.js"></script>
<script src="/assets/addon-fit.js"></script>
<script>
(() => {
  const token = ${JSON.stringify(token)}
  const statusEl = document.getElementById('status')
  const restartEl = document.getElementById('restart')
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: {background: '#0b0e14'},
  })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  term.open(document.getElementById('term'))
  fit.fit()

  let socket = null

  const connect = () => {
    restartEl.hidden = true
    term.reset()
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    socket = new WebSocket(scheme + '://' + location.host + '/api/pty?token=' + encodeURIComponent(token))

    socket.onopen = () => {
      statusEl.textContent = 'connected'
      fit.fit()
      socket.send(JSON.stringify({type: 'resize', cols: term.cols, rows: term.rows}))
      term.focus()
    }
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.type === 'data') term.write(message.data)
      else if (message.type === 'notice') term.write(message.data)
      else if (message.type === 'exit') {
        statusEl.textContent = message.code === 0
          ? 'setup finished — redirecting to the status page…'
          : 'wizard exited with code ' + message.code
        restartEl.hidden = false
        if (message.code === 0) setTimeout(() => { location.href = '/' }, 1500)
      }
    }
    socket.onclose = () => {
      if (statusEl.textContent === 'connected') statusEl.textContent = 'disconnected'
      restartEl.hidden = false
    }
    socket.onerror = () => { statusEl.textContent = 'connection failed' }
  }

  term.onData((data) => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type: 'input', data}))
  })

  addEventListener('resize', () => {
    fit.fit()
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({type: 'resize', cols: term.cols, rows: term.rows}))
    }
  })

  restartEl.addEventListener('click', connect)
  connect()
})()
</script>
`,
	})

const credentialRows = (credentials) =>
	credentials
		.map((entry) => {
			const status = entry.set
				? '<span class="ok">set</span>'
				: '<span class="dim">not set</span>'
			const detail = entry.set
				? ''
				: `<span class="sub">${escape(entry.fix)}</span>` +
					(entry.note ? `<span class="sub">${escape(entry.note)}</span>` : '')
			return `<tr><td><code>${escape(entry.name)}</code><span class="sub">${escape(entry.label)}</span>${detail}</td><td>${status}</td></tr>`
		})
		.join('')

const toolRows = (tools) =>
	tools
		.map((tool) => {
			if (!tool.installed) {
				return `<tr><td>${escape(tool.label)}<span class="sub dim">${escape(tool.install || 'not installed')}</span></td><td class="dim">absent</td></tr>`
			}
			return `<tr><td>${escape(tool.label)}<span class="sub dim">${escape(tool.path)}</span></td><td class="ok">${escape(tool.version || 'installed')}</td></tr>`
		})
		.join('')

const sessionRows = (sessions) => {
	if (sessions === null) return '<tr><td colspan="2" class="dim">Herdr server not reachable — check the app logs.</td></tr>'
	if (sessions.length === 0) return '<tr><td colspan="2" class="dim">No sessions yet. Attach over SSH to create one.</td></tr>'
	return sessions
		.map(
			(session) =>
				`<tr><td>${escape(session.name)}${session.default ? ' <span class="dim">(default)</span>' : ''}</td>` +
				`<td class="${session.running ? 'ok' : 'dim'}">${session.running ? 'running' : 'stopped'}</td></tr>`,
		)
		.join('')
}

const dashboard = ({snapshot, sshPort}) => {
	const {anthropic, claude} = snapshot

	const anthropicLine = anthropic.winner
		? anthropic.conflict
			? `<div class="banner warn"><strong>Two Anthropic credentials are set.</strong>
			   <code>ANTHROPIC_API_KEY</code> wins — Claude Code ranks it above
			   <code>CLAUDE_CODE_OAUTH_TOKEN</code>, so your subscription token is being ignored
			   and usage is billed to the Console account. Remove one.</div>`
			: `<p class="dim">Anthropic credential in effect: <code>${escape(anthropic.winner)}</code>.</p>`
		: '<p class="dim">No Anthropic credential set.</p>'

	const claudeLine = !claude.available
		? '<p class="dim">Claude Code is not installed, so there is no login state to read.</p>'
		: claude.ok
			? `<p class="dim">Claude Code login: <span class="${claude.loggedIn ? 'ok' : 'warn'}">${claude.loggedIn ? 'signed in' : 'not signed in'}</span>${claude.source ? ` <span class="dim">(${escape(claude.source)})</span>` : ''}</p>`
			: '<p class="dim">Claude Code is installed but <code>claude auth status --json</code> did not answer.</p>'

	const extras =
		snapshot.extraTools.length > 0
			? `<h2>Other npm globals</h2><p class="dim">${snapshot.extraTools.map((n) => escape(n)).join(', ')}</p>`
			: ''

	return shell({
		title: 'Herdr',
		body: `
  ${PROTO_BANNER}
  <h1>Herdr is running</h1>
  <p>Your agents keep running here whether or not anything is attached.
     There is no terminal on this page on purpose — attach over SSH.</p>

  <h2>Attach</h2>
  <pre>ssh -p ${sshPort} node@&lt;your-umbrel&gt;
herdr</pre>

  <h2>Sessions</h2>
  <table>${sessionRows(snapshot.sessions)}</table>

  <h2>Configured providers</h2>
  <p class="dim">Presence only — this page never shows a credential value, not even a masked prefix.</p>
  ${anthropicLine}
  ${claudeLine}
  <table>${credentialRows(snapshot.credentials)}</table>

  <h2>Installed tools</h2>
  <table>${toolRows(snapshot.tools)}</table>
  ${extras}

  <h2>Access</h2>
  <table>
    <tr><td>Authorised SSH keys</td><td class="${snapshot.checks.authorizedKeys > 0 ? 'ok' : 'warn'}">${snapshot.checks.authorizedKeys}</td></tr>
    <tr><td>Secrets file<span class="sub dim">${escape(snapshot.envFile)}</span></td><td class="dim">0600</td></tr>
  </table>

  <div class="row-actions">
    <a class="button" href="/setup">Add or rotate a credential</a>
    <a class="button" href="/?">Refresh</a>
  </div>

  <p class="dim">Generated ${escape(snapshot.generatedAt)}. Values are cached for 30s.</p>
`,
	})
}

module.exports = {wizard, dashboard, escape}
