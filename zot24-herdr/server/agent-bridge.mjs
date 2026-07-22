#!/usr/bin/env node
/**
 * herdr agent-bridge — machine API for sibling Umbrel apps (e.g. Hermes).
 *
 * Binds an INTERNAL-only HTTP port (default 7682). Not fronted by Umbrel
 * app_proxy. Auth is a shared bearer token from /data/.env (HERDR_AGENT_TOKEN).
 *
 * Endpoints:
 *   GET  /health              → liveness (no auth)
 *   GET  /v1/status           → herdr + tool presence (auth)
 *   POST /v1/exec             → { "cmd": "...", "cwd"?, "timeout_ms"? } (auth)
 *   POST /v1/herdr            → { "args": ["session","list","--json"] } (auth)
 *
 * This is full shell power inside the container once authenticated — same
 * trust model as the web terminal. Do not publish this port publicly.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.HERDR_AGENT_PORT || 7682);
const BIND = process.env.HERDR_AGENT_BIND || "0.0.0.0";
const MAX_BODY = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_CWD = "/data/workspaces";

function loadToken() {
  // Prefer process env (compose env_file). Fallback: parse /data/.env directly
  // so a token dropped without restart still works after process recycle.
  if (process.env.HERDR_AGENT_TOKEN) {
    return process.env.HERDR_AGENT_TOKEN.trim();
  }
  const envPath = "/data/.env";
  if (!existsSync(envPath)) return "";
  try {
    const text = readFileSync(envPath, "utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 0) continue;
      const k = t.slice(0, i).trim();
      if (k !== "HERDR_AGENT_TOKEN") continue;
      let v = t.slice(i + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      return v;
    }
  } catch {
    /* ignore */
  }
  return "";
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length || ab.length === 0) {
    // still compare something to reduce trivial probes when empty
    return false;
  }
  let out = 0;
  for (let i = 0; i < ab.length; i++) out |= ab[i] ^ bb[i];
  return out === 0;
}

function authorize(req) {
  const token = loadToken();
  if (!token) {
    return { ok: false, status: 503, error: "HERDR_AGENT_TOKEN not configured" };
  }
  const hdr = req.headers.authorization || "";
  let provided = "";
  if (hdr.toLowerCase().startsWith("bearer ")) {
    provided = hdr.slice(7).trim();
  } else if (req.headers["x-herdr-token"]) {
    provided = String(req.headers["x-herdr-token"]).trim();
  }
  if (!timingSafeEqualStr(provided, token)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true };
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function runCommand(argv, { cwd, timeoutMs, env } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: cwd || DEFAULT_CWD,
      env: { ...process.env, ...(env || {}) },
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const maxCapture = 2 * 1024 * 1024;
    const onChunk = (buf, which) => {
      const s = buf.toString("utf8");
      if (which === "out") {
        if (stdout.length < maxCapture) stdout += s.slice(0, maxCapture - stdout.length);
      } else {
        if (stderr.length < maxCapture) stderr += s.slice(0, maxCapture - stderr.length);
      }
    };
    child.stdout.on("data", (b) => onChunk(b, "out"));
    child.stderr.on("data", (b) => onChunk(b, "err"));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolveRun({
        ok: false,
        timed_out: true,
        code: null,
        signal: "SIGKILL",
        stdout,
        stderr: stderr + "\n[agent-bridge] killed after timeout",
      });
    }, timeoutMs);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({
        ok: false,
        timed_out: false,
        code: null,
        signal: null,
        error: String(err.message || err),
        stdout,
        stderr,
      });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({
        ok: code === 0,
        timed_out: false,
        code,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

async function which(bin) {
  const r = await runCommand(["bash", "-lc", `command -v ${bin} || true`], {
    cwd: "/data",
    timeoutMs: 5000,
  });
  return (r.stdout || "").trim() || null;
}

async function handleStatus() {
  const tools = {};
  for (const bin of ["node", "npm", "claude", "codex", "gh", "git", "herdr", "curl"]) {
    tools[bin] = await which(bin);
  }
  let herdrVersion = null;
  const hv = await runCommand(["herdr", "--version"], { cwd: "/data", timeoutMs: 5000 });
  if (hv.ok) herdrVersion = (hv.stdout || hv.stderr || "").trim();
  let sessions = null;
  const sl = await runCommand(["herdr", "session", "list", "--json"], {
    cwd: "/data",
    timeoutMs: 8000,
  });
  if (sl.ok) {
    try {
      sessions = JSON.parse(sl.stdout || "null");
    } catch {
      sessions = { raw: sl.stdout };
    }
  }
  return {
    ok: true,
    service: "herdr-agent-bridge",
    herdr_version: herdrVersion,
    home: process.env.HOME || "/data",
    workspaces: "/data/workspaces",
    npm_prefix: process.env.NPM_CONFIG_PREFIX || "/data/.npm-global",
    tools,
    sessions,
    token_configured: Boolean(loadToken()),
  };
}

function sanitizeCwd(cwd) {
  if (!cwd) return DEFAULT_CWD;
  const abs = resolve(cwd);
  // Stay on the persistent volume.
  if (abs !== "/data" && !abs.startsWith("/data/")) {
    throw Object.assign(new Error("cwd must be under /data"), { status: 400 });
  }
  return abs;
}

function clampTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(n), MAX_TIMEOUT_MS);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && (path === "/health" || path === "/")) {
      return sendJson(res, 200, {
        ok: true,
        service: "herdr-agent-bridge",
        auth_required_for: ["/v1/status", "/v1/exec", "/v1/herdr"],
      });
    }

    if (req.method === "GET" && path === "/v1/status") {
      const auth = authorize(req);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
      return sendJson(res, 200, await handleStatus());
    }

    if (req.method === "POST" && path === "/v1/exec") {
      const auth = authorize(req);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
      const body = await readBody(req);
      const cmd = body.cmd ?? body.command;
      if (!cmd || typeof cmd !== "string") {
        return sendJson(res, 400, { ok: false, error: "cmd (string) required" });
      }
      let cwd;
      try {
        cwd = sanitizeCwd(body.cwd);
      } catch (e) {
        return sendJson(res, e.status || 400, { ok: false, error: e.message });
      }
      const timeoutMs = clampTimeout(body.timeout_ms);
      // bash -lc so PATH includes /data/.npm-global/bin from login-ish env.
      const result = await runCommand(["bash", "-lc", cmd], { cwd, timeoutMs });
      return sendJson(res, 200, {
        ok: result.ok,
        cwd,
        timeout_ms: timeoutMs,
        ...result,
      });
    }

    if (req.method === "POST" && path === "/v1/herdr") {
      const auth = authorize(req);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
      const body = await readBody(req);
      const args = body.args;
      if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
        return sendJson(res, 400, { ok: false, error: "args must be string[]" });
      }
      if (args.length > 32) {
        return sendJson(res, 400, { ok: false, error: "too many args" });
      }
      const timeoutMs = clampTimeout(body.timeout_ms);
      const result = await runCommand(["herdr", ...args], {
        cwd: "/data",
        timeoutMs,
      });
      return sendJson(res, 200, { ok: result.ok, args, timeout_ms: timeoutMs, ...result });
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    sendJson(res, status, { ok: false, error: String(err.message || err) });
  }
});

server.listen(PORT, BIND, () => {
  const has = Boolean(loadToken());
  console.error(
    `[agent-bridge] listening on ${BIND}:${PORT} token_configured=${has}`,
  );
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
