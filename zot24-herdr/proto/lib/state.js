// Derived state: everything this app knows about itself, computed per request.
//
// There is no sentinel file and no ".setup-complete". "Is this box configured?"
// is answered by looking, the way Umbrel's Hermes image answers it —
// providerConfigured() in umbrel-chat-tui-entry.js:20-58 runs a probe and reads
// the exit status. Derived state cannot desynchronise from reality, needs
// nothing on the volume, survives an app update for free, and correctly comes
// back if the owner deletes their keys.

const fs = require('node:fs')
const path = require('node:path')
const {execFile} = require('node:child_process')

const catalog = require('../catalog.json')
const envfile = require('./envfile')

const DATA_DIR = process.env.HERDR_DATA_DIR || '/data'
const ENV_FILE = path.join(DATA_DIR, '.env')
const AUTHORIZED_KEYS = path.join(DATA_DIR, '.ssh', 'authorized_keys')
const NPM_BIN = path.join(DATA_DIR, '.npm-global', 'bin')

const VERSION_TIMEOUT_MS = 3000
const CACHE_MS = 30_000

const run = (file, args, options = {}) =>
	new Promise((resolve) => {
		execFile(file, args, {timeout: VERSION_TIMEOUT_MS, maxBuffer: 1 << 20, ...options}, (error, stdout, stderr) =>
			resolve({ok: !error, stdout: String(stdout || ''), stderr: String(stderr || '')}),
		)
	})

// One line, no banner. `node --version` is clean; most CLIs print a paragraph.
const firstVersionLine = (text) => {
	const line = text.split('\n').find((l) => l.trim() !== '')
	if (!line) return null
	const trimmed = line.trim()
	return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed
}

const which = (bin) => {
	for (const dir of [NPM_BIN, '/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/usr/sbin']) {
		const candidate = path.join(dir, bin)
		try {
			fs.accessSync(candidate, fs.constants.X_OK)
			return candidate
		} catch {}
	}
	return null
}

const credentials = () => {
	const env = envfile.read(ENV_FILE)
	return catalog.credentials.map((entry) => ({
		name: entry.name,
		label: entry.label,
		docs: entry.docs ?? null,
		fix: entry.fix,
		note: entry.note ?? null,
		// Presence only. Never the value, never a masked prefix, never a length —
		// a masked prefix still identifies which key it is, and this app has SSH
		// for anyone entitled to read the file.
		set: Boolean((env[entry.name] ?? '').trim()),
	}))
}

const authorizedKeys = () => {
	try {
		return fs
			.readFileSync(AUTHORIZED_KEYS, 'utf8')
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l !== '' && !l.startsWith('#')).length
	} catch {
		return 0
	}
}

// Extra binaries the owner npm-installed that the catalogue doesn't know about.
const extraNpmBins = () => {
	const known = new Set(catalog.tools.map((t) => t.bin))
	try {
		return fs
			.readdirSync(NPM_BIN)
			.filter((name) => !known.has(name))
			.sort()
	} catch {
		return []
	}
}

const tools = async () => {
	const results = await Promise.all(
		catalog.tools.map(async (tool) => {
			const location = which(tool.bin)
			if (!location) return {...tool, installed: false, version: null, path: null}
			const {ok, stdout, stderr} = await run(location, ['--version'])
			return {
				...tool,
				installed: true,
				path: location,
				version: ok ? firstVersionLine(stdout) || firstVersionLine(stderr) : null,
			}
		}),
	)
	return results
}

// `claude auth status --json` exists and defaults to JSON (VERIFIED against
// claude 2.1.219). It is the only agent CLI in the catalogue that exposes a
// machine-readable login check, so it is the only one asked.
const claudeAuth = async () => {
	const location = which('claude')
	if (!location) return {available: false}
	const {ok, stdout} = await run(location, ['auth', 'status', '--json'], {env: {...process.env, HOME: DATA_DIR}})
	if (!ok) return {available: true, ok: false}
	try {
		const parsed = JSON.parse(stdout)
		// Deliberately narrow: only ever surface booleans and source labels from
		// this blob, never a token or an account identifier.
		return {
			available: true,
			ok: true,
			loggedIn: Boolean(parsed.loggedIn ?? parsed.logged_in ?? parsed.authenticated),
			source: parsed.source ?? parsed.authMethod ?? parsed.auth_method ?? null,
		}
	} catch {
		return {available: true, ok: false}
	}
}

// Claude Code's documented precedence puts ANTHROPIC_API_KEY above
// CLAUDE_CODE_OAUTH_TOKEN. A box with both set bills the Console account and
// fails confusingly when that org is disabled — so say which one wins.
const anthropicPrecedence = (creds) => {
	const has = (name) => creds.find((c) => c.name === name)?.set === true
	if (has('ANTHROPIC_API_KEY') && has('CLAUDE_CODE_OAUTH_TOKEN')) {
		return {winner: 'ANTHROPIC_API_KEY', conflict: true}
	}
	if (has('ANTHROPIC_API_KEY')) return {winner: 'ANTHROPIC_API_KEY', conflict: false}
	if (has('CLAUDE_CODE_OAUTH_TOKEN')) return {winner: 'CLAUDE_CODE_OAUTH_TOKEN', conflict: false}
	return {winner: null, conflict: false}
}

const sessions = async () => {
	const location = which('herdr')
	if (!location) return null
	const {ok, stdout} = await run(location, ['session', 'list', '--json'], {env: {...process.env, HOME: DATA_DIR}})
	if (!ok) return null
	try {
		return JSON.parse(stdout).sessions ?? []
	} catch {
		return null
	}
}

let cache = null

const snapshot = async ({fresh = false} = {}) => {
	if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value

	const creds = credentials()
	const keys = authorizedKeys()
	const [toolList, claude, sessionList] = await Promise.all([tools(), claudeAuth(), sessions()])

	// The derived check, in one place. Both halves matter: a credential with no
	// authorised key means the owner cannot reach the box to use it, and a key
	// with no credential means the agents have nothing to authenticate with.
	const hasProvider = creds.some((c) => c.set && catalog.providerKeys.includes(c.name))
	const configured = hasProvider && keys > 0

	const value = {
		configured,
		checks: {hasProvider, authorizedKeys: keys},
		credentials: creds,
		anthropic: anthropicPrecedence(creds),
		tools: toolList,
		extraTools: extraNpmBins(),
		claude,
		sessions: sessionList,
		dataDir: DATA_DIR,
		envFile: ENV_FILE,
		generatedAt: new Date().toISOString(),
	}
	cache = {at: Date.now(), value}
	return value
}

const invalidate = () => {
	cache = null
}

module.exports = {snapshot, invalidate, DATA_DIR, ENV_FILE, AUTHORIZED_KEYS, NPM_BIN, which}
