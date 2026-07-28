// Merge-writing /data/.env.
//
// The owner hand-edits this file (umbrel-app.yml setup steps 3-4), so a save
// must preserve comments, blank lines, ordering, and any key this app has never
// heard of. Rewriting the file wholesale — which the deleted zot24-hermes app
// did (setup/server.js:181-195 at 1009cde^) — silently eats all of that.
//
// Written atomically at 0600: the file is created O_EXCL with the mode set at
// open() time and then renamed over the target. `writeFileSync(path, data,
// {mode})` is not equivalent — the mode argument is ignored when the file
// already exists — and write-then-chmod leaves a window where the secrets are
// world-readable. Same reasoning as upstream Hermes at
// agent/anthropic_adapter.py:1052-1064.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

const unquote = (raw) => {
	const v = raw.trim()
	if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
		return v.slice(1, -1)
	}
	return v
}

const parse = (text) => {
	const out = {}
	for (const line of text.split('\n')) {
		const m = line.match(LINE)
		if (m) out[m[1]] = unquote(m[2])
	}
	return out
}

const read = (file) => {
	try {
		return parse(fs.readFileSync(file, 'utf8'))
	} catch (error) {
		if (error.code === 'ENOENT') return {}
		throw error
	}
}

// A value containing a newline would write an attacker-chosen second variable
// into the file. Reject rather than escape: nothing legitimate needs it.
const validate = (key, value) => {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid key name: ${key}`)
	if (/[\n\r\0]/.test(value)) throw new Error(`value for ${key} contains a newline`)
	if (value.length > 4096) throw new Error(`value for ${key} is too long`)
}

// Values are quoted only when they need it, so a hand-edited file stays
// hand-editable and a diff of this file stays readable.
const render = (value) => (/^[A-Za-z0-9_@%+=:,./-]*$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, '\\$1')}"`)

const merge = (file, updates) => {
	for (const [key, value] of Object.entries(updates)) validate(key, value)

	let text = ''
	try {
		text = fs.readFileSync(file, 'utf8')
	} catch (error) {
		if (error.code !== 'ENOENT') throw error
	}

	const lines = text === '' ? [] : text.split('\n')
	const pending = new Map(Object.entries(updates))

	const merged = lines.map((line) => {
		const m = line.match(LINE)
		if (!m || !pending.has(m[1])) return line
		const key = m[1]
		const value = pending.get(key)
		pending.delete(key)
		return `${key}=${render(value)}`
	})

	if (pending.size > 0) {
		while (merged.length > 0 && merged.at(-1).trim() === '') merged.pop()
		if (merged.length > 0) merged.push('')
		for (const [key, value] of pending) merged.push(`${key}=${render(value)}`)
	}

	const body = merged.join('\n').replace(/\n*$/, '\n')

	fs.mkdirSync(path.dirname(file), {recursive: true})
	const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`
	const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
	try {
		fs.writeSync(fd, body)
		fs.fsyncSync(fd)
	} finally {
		fs.closeSync(fd)
	}
	fs.renameSync(tmp, file)
	return Object.keys(updates)
}

module.exports = {parse, read, merge, validate}

if (require.main === module) {
	// CLI shim so the shell wizard can save without reimplementing any of this.
	//   envfile.js <file> KEY   (value on stdin, so it never reaches argv/ps)
	const [file, key] = process.argv.slice(2)
	if (!file || !key) {
		process.stderr.write('usage: envfile.js <file> <KEY>   # value on stdin\n')
		process.exit(2)
	}
	let value = fs.readFileSync(0, 'utf8')
	value = value.replace(/\r?\n$/, '')
	try {
		merge(file, {[key]: value})
		process.stdout.write(`saved ${key}${os.EOL}`)
	} catch (error) {
		process.stderr.write(`${error.message}${os.EOL}`)
		process.exit(1)
	}
}
