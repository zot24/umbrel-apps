#!/usr/bin/env node
/**
 * herdr web gate — loading + tile-password + setup, then ttyd TUI.
 *
 * Binds :7681 (Umbrel app_proxy). ttyd stays on 127.0.0.1:7684 (--writable).
 * Auth: Umbrel login (proxy) AND the tile password (APP_PASSWORD) as a
 * session cookie. Never print secrets. Setup writes /data/.env (0600).
 */
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const PORT = Number(process.env.HERDR_GATE_PORT || 7681);
const BIND = process.env.HERDR_GATE_BIND || "0.0.0.0";
const TTYD_HOST = process.env.HERDR_TTYD_HOST || "127.0.0.1";
const TTYD_PORT = Number(process.env.HERDR_TTYD_PORT || 7684);
const ENV_PATH = "/data/.env";
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
const COOKIE = "herdr_gate";
const MAX_BODY = 64 * 1024;
const APP_PASSWORD = (process.env.APP_PASSWORD || "").trim();
const APP_SEED = (process.env.APP_SEED || APP_PASSWORD || "herdr-dev-seed").trim();
const SSH_PORT = Number(process.env.HERDR_SSH_PORT || 7683);
const MOSHI_ENV = {
  ...process.env,
  HOME: "/data",
  MOSHI_HOOK_SKIP_FIRST_RUN: "1",
  MOSHI_HERDR_PATH: "/usr/local/bin/herdr",
};

const KEYS = [
  ["ANTHROPIC_API_KEY", "anthropic", "Claude Code"],
  ["XAI_API_KEY", "grok", "Grok"],
  ["MOONSHOT_API_KEY", "kimi", "Kimi"],
  ["OPENAI_API_KEY", "openai", "OpenAI"],
  ["GITHUB_TOKEN", "github", "GitHub"],
  ["VERCEL_TOKEN", "vercel", "Vercel"],
  ["SUPABASE_ACCESS_TOKEN", "supabase", "Supabase"],
  ["GIT_AUTHOR_NAME", "git_name", "Git author name"],
  ["GIT_AUTHOR_EMAIL", "git_email", "Git author email"],
  ["SSH_AUTHORIZED_KEYS", "ssh_key", "SSH public key"],
];

const fails = new Map();

function hmac(data) {
  return crypto.createHmac("sha256", APP_SEED).update(data).digest("hex");
}
function cookieValue() {
  return hmac("ok");
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function authed(req) {
  if (!APP_PASSWORD) return true;
  return parseCookies(req)[COOKIE] === cookieValue();
}
function setCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${cookieValue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
  );
}
function clearCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}
function sendFile(res, file, type) {
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function parseEnv(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    map.set(t.slice(0, i).trim(), v);
  }
  return map;
}
function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return new Map();
  try {
    return parseEnv(fs.readFileSync(ENV_PATH, "utf8"));
  } catch {
    return new Map();
  }
}
function quote(v) {
  if (/[\s#'"]/.test(v)) return JSON.stringify(v);
  return v;
}
function upsertEnv(updates) {
  let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  if (text && !text.endsWith("\n")) text += "\n";
  const present = new Set();
  const lines = text ? text.split("\n") : [];
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) {
      out.push(line);
      continue;
    }
    const i = t.indexOf("=");
    if (i < 0) {
      out.push(line);
      continue;
    }
    const k = t.slice(0, i).trim();
    if (Object.prototype.hasOwnProperty.call(updates, k)) {
      present.add(k);
      out.push(`${k}=${quote(updates[k])}`);
    } else {
      out.push(line);
    }
  }
  for (const [k, v] of Object.entries(updates)) {
    if (!present.has(k)) out.push(`${k}=${quote(v)}`);
  }
  const final = out.join("\n").replace(/\n+$/, "\n");
  const tmp = ENV_PATH + ".tmp";
  fs.writeFileSync(tmp, final, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, ENV_PATH);
  fs.chmodSync(ENV_PATH, 0o600);
}
function portOpen(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port }, () => {
      s.end();
      resolve(true);
    });
    s.setTimeout(400);
    s.on("error", () => resolve(false));
    s.on("timeout", () => {
      s.destroy();
      resolve(false);
    });
  });
}
function loginAllowed(ip) {
  const now = Date.now();
  const rec = fails.get(ip) || { n: 0, t: now };
  if (now - rec.t > 10 * 60_000) {
    fails.delete(ip);
    return true;
  }
  return rec.n < 20;
}
function loginFail(ip) {
  const rec = fails.get(ip) || { n: 0, t: Date.now() };
  rec.n += 1;
  rec.t = Date.now();
  fails.set(ip, rec);
}
function clientIp(req) {
  return (
    String(req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}
function keyStatus(env) {
  const keys = {};
  for (const [envKey, id] of KEYS) keys[id] = Boolean(env.get(envKey));
  return keys;
}

let moshiSetup = {
  proc: null,
  payload: null,
  claimed: false,
  error: null,
  buf: "",
};

function suggestedHost(req) {
  const raw = String(req.headers["x-forwarded-host"] || req.headers.host || "");
  const host = raw.split(",")[0].trim().split(":")[0].trim();
  if (!host) return "";
  const low = host.toLowerCase();
  if (low === "localhost" || low === "127.0.0.1" || low.startsWith("10.21.")) return "";
  return host;
}

function validHost(h) {
  if (typeof h !== "string") return "";
  const s = h.trim();
  if (!s || s.length > 253) return "";
  if (/\s/.test(s) || s.includes("://") || s.includes("/")) return "";
  return s;
}

function killMoshiSetup() {
  if (moshiSetup.proc) {
    try {
      moshiSetup.proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    moshiSetup.proc = null;
  }
}

function hasAuthorizedKey() {
  try {
    const t = fs.readFileSync("/data/.ssh/authorized_keys", "utf8");
    return t.split(/\n/).some((line) => {
      const s = line.trim();
      return s && !s.startsWith("#") && /^(ssh-|ecdsa-|sk-)/.test(s);
    });
  } catch {
    return false;
  }
}

let pairedCache = { t: 0, v: false };
function moshiPaired() {
  const now = Date.now();
  if (now - pairedCache.t < 3000) return pairedCache.v;
  try {
    const r = spawnSync("moshi-hook", ["status", "--json"], {
      env: MOSHI_ENV,
      encoding: "utf8",
      timeout: 4000,
    });
    if (r.status !== 0) {
      pairedCache = { t: now, v: false };
      return false;
    }
    const j = JSON.parse(r.stdout || "{}");
    pairedCache = { t: now, v: Boolean(j.paired) };
    return pairedCache.v;
  } catch {
    pairedCache = { t: now, v: false };
    return false;
  }
}

function actuallyPaired() {
  return moshiPaired() || hasAuthorizedKey();
}

function parseSetupBuf() {
  if (moshiSetup.payload) return;
  const t = moshiSetup.buf.trim();
  const start = t.indexOf("{");
  if (start < 0) return;
  const lineEnd = t.indexOf("\n", start);
  const slice = (lineEnd >= 0 ? t.slice(start, lineEnd) : t.slice(start)).trim();
  try {
    const j = JSON.parse(slice);
    if (j && (j.deepLink || j.setupId)) moshiSetup.payload = j;
  } catch {
    /* wait for more */
  }
}

function startMoshiSetup(host, name) {
  killMoshiSetup();
  moshiSetup = {
    proc: null,
    payload: null,
    claimed: false,
    error: null,
    buf: "",
  };
  const args = [
    "host",
    "setup",
    "--json",
    "--force",
    "--host",
    host,
    "--port",
    String(SSH_PORT),
    "--user",
    "node",
    "--name",
    name || "Herdr",
  ];
  const proc = spawn("moshi-hook", args, {
    env: MOSHI_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });
  moshiSetup.proc = proc;
  proc.stdout.on("data", (c) => {
    moshiSetup.buf += c.toString("utf8");
    parseSetupBuf();
  });
  proc.stderr.on("data", () => {
    /* swallow — never log pairing material */
  });
  proc.on("exit", (code) => {
    moshiSetup.proc = null;
    parseSetupBuf();
    // host setup --json prints the grant and exits 0 immediately. That is
    // NOT a phone claim. Keep the payload so the QR can stay on screen.
    if (code === 0) {
      spawn("moshi-hook", ["install"], { env: MOSHI_ENV, stdio: "ignore" });
    } else if (!moshiSetup.payload && !moshiSetup.error) {
      moshiSetup.error = code == null ? "setup stopped" : `setup exited ${code}`;
    }
  });
}

function publicMoshi(req) {
  const p = moshiSetup.payload || {};
  const expired = p.expiresAt ? Date.parse(p.expiresAt) < Date.now() : false;
  const paired = actuallyPaired();
  const showGrant = Boolean(p.deepLink) && !expired && !paired;
  return {
    running: Boolean(moshiSetup.proc),
    claimed: paired,
    paired,
    error: moshiSetup.error,
    expired,
    hostname: p.hostname || null,
    loginUser: p.loginUser || "node",
    sshPort: p.sshPort || SSH_PORT,
    expiresAt: p.expiresAt || null,
    setupId: p.setupId || null,
    prereqs: p.prereqs || null,
    deepLink: showGrant ? p.deepLink : null,
    suggestedHost: suggestedHost(req),
  };
}

function safeStatic(urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
  if (!rel || rel.includes("..") || path.isAbsolute(rel)) return null;
  const full = path.join(WEB_DIR, rel);
  const root = WEB_DIR.endsWith(path.sep) ? WEB_DIR : WEB_DIR + path.sep;
  if (full !== WEB_DIR && !full.startsWith(root)) return null;
  try {
    if (!fs.statSync(full).isFile()) return null;
  } catch {
    return null;
  }
  return full;
}

function mimeFor(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function appendAuthorizedKey(raw) {
  const dir = "/data/.ssh";
  const file = path.join(dir, "authorized_keys");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    existing = "";
  }
  let changed = false;
  for (const line of String(raw).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (!/^(ssh-|ecdsa-|sk-)/.test(t)) continue;
    if (existing.includes(t)) continue;
    existing += (existing.endsWith("\n") || existing === "" ? "" : "\n") + t + "\n";
    changed = true;
  }
  if (!changed && existing) return;
  fs.writeFileSync(file, existing, { mode: 0o600 });
}

async function handleApi(req, res, url) {
  if (url.pathname === "/healthz" || url.pathname === "/health") {
    json(res, 200, { ok: true, service: "herdr-web-gate" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    const env = loadEnv();
    const ttyd = await portOpen(TTYD_HOST, TTYD_PORT);
    json(res, 200, {
      ok: true,
      ready: ttyd,
      authed: authed(req),
      password_required: Boolean(APP_PASSWORD),
      setup_done: env.get("HERDR_WEB_SETUP_DONE") === "1",
      token_configured: Boolean(env.get("HERDR_AGENT_TOKEN") || process.env.HERDR_AGENT_TOKEN),
      bootstrap: env.get("HERDR_BOOTSTRAP_AGENTS") === "1",
      keys: keyStatus(env),
      moshi: {
        paired: actuallyPaired(),
        running: Boolean(moshiSetup.proc),
        claimed: actuallyPaired(),
      },
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/login") {
    if (!APP_PASSWORD) {
      setCookie(res);
      json(res, 200, { ok: true });
      return;
    }
    const ip = clientIp(req);
    if (!loginAllowed(ip)) {
      json(res, 429, { ok: false, error: "too many attempts" });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { ok: false, error: "bad json" });
      return;
    }
    const pw = String(body.password || "");
    const a = Buffer.from(pw);
    const b = Buffer.from(APP_PASSWORD);
    let match = a.length === b.length && a.length > 0;
    if (match) {
      let x = 0;
      for (let i = 0; i < a.length; i++) x |= a[i] ^ b[i];
      match = x === 0;
    }
    if (!match) {
      loginFail(ip);
      json(res, 401, { ok: false, error: "wrong password" });
      return;
    }
    fails.delete(ip);
    setCookie(res);
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/logout") {
    clearCookie(res);
    json(res, 200, { ok: true });
    return;
  }
  if (!authed(req)) {
    json(res, 401, { ok: false, error: "auth required" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/config") {
    const env = loadEnv();
    json(res, 200, {
      ok: true,
      keys: keyStatus(env),
      bootstrap: env.get("HERDR_BOOTSTRAP_AGENTS") !== "0",
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/config") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { ok: false, error: "bad json" });
      return;
    }
    const env = loadEnv();
    const updates = {};
    for (const [envKey, id] of KEYS) {
      if (typeof body[id] !== "string") continue;
      const v = body[id].trim();
      if (!v) continue; // empty = leave existing
      updates[envKey] = v;
    }
    if (typeof body.git_name === "string" && body.git_name.trim()) {
      updates.GIT_COMMITTER_NAME = body.git_name.trim();
    }
    if (typeof body.git_email === "string" && body.git_email.trim()) {
      updates.GIT_COMMITTER_EMAIL = body.git_email.trim();
    }
    if (body.bootstrap === false) updates.HERDR_BOOTSTRAP_AGENTS = "0";
    else updates.HERDR_BOOTSTRAP_AGENTS = "1";
    updates.HERDR_BOOTSTRAP_TOOLS = "all";
    updates.HERDR_WEB_SETUP_DONE = "1";
    if (!env.get("HERDR_AGENT_TOKEN") && !process.env.HERDR_AGENT_TOKEN) {
      updates.HERDR_AGENT_TOKEN = crypto.randomBytes(36).toString("base64url");
    }
    upsertEnv(updates);
    if (typeof body.ssh_key === "string" && body.ssh_key.trim()) {
      appendAuthorizedKey(body.ssh_key);
    }
    const next = loadEnv();
    json(res, 200, {
      ok: true,
      keys: keyStatus(next),
      bootstrap: next.get("HERDR_BOOTSTRAP_AGENTS") === "1",
      token_configured: Boolean(next.get("HERDR_AGENT_TOKEN") || process.env.HERDR_AGENT_TOKEN),
      note: "Keys are on disk. New Herdr attaches pick them up. Umbrel Restart applies bootstrap + env to the whole container.",
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/moshi") {
    json(res, 200, { ok: true, ...publicMoshi(req) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/moshi/setup") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { ok: false, error: "bad json" });
      return;
    }
    const host = validHost(body.host || "");
    if (!host) {
      json(res, 400, { ok: false, error: "host required (Tailscale IP or LAN hostname, not a docker 10.21 address)" });
      return;
    }
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 64) : "Herdr";
    startMoshiSetup(host, name);
    const started = Date.now();
    while (!moshiSetup.payload && Date.now() - started < 4000) {
      if (!moshiSetup.proc && moshiSetup.error) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    json(res, 200, { ok: true, ...publicMoshi(req) });
    return;
  }
  if (req.method === "DELETE" && url.pathname === "/api/moshi/setup") {
    killMoshiSetup();
    moshiSetup.payload = null;
    moshiSetup.claimed = false;
    moshiSetup.error = null;
    moshiSetup.buf = "";
    json(res, 200, { ok: true, ...publicMoshi(req) });
    return;
  }
  json(res, 404, { ok: false, error: "not found" });
}

function proxyHttp(req, res) {
  const headers = { ...req.headers, host: `${TTYD_HOST}:${TTYD_PORT}` };
  const p = http.request(
    {
      hostname: TTYD_HOST,
      port: TTYD_PORT,
      path: req.url,
      method: req.method,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  p.on("error", () => {
    if (!res.headersSent) json(res, 502, { ok: false, error: "terminal not ready" });
    else res.end();
  });
  req.pipe(p);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      sendFile(res, path.join(WEB_DIR, "index.html"), "text/html; charset=utf-8");
      return;
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/healthz" || url.pathname === "/health") {
      await handleApi(req, res, url);
      return;
    }
    if (url.pathname === "/t" || url.pathname.startsWith("/t/")) {
      if (!authed(req)) {
        res.writeHead(302, { location: "/" });
        res.end();
        return;
      }
      proxyHttp(req, res);
      return;
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    const staticFile = safeStatic(url.pathname);
    if (staticFile) {
      sendFile(res, staticFile, mimeFor(staticFile));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  } catch (e) {
    if (!res.headersSent) json(res, 500, { ok: false, error: "gate error" });
    else res.end();
  }
});

server.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  if (!url.startsWith("/t")) {
    socket.destroy();
    return;
  }
  if (!authed(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const p = net.connect(TTYD_PORT, TTYD_HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    const headers = { ...req.headers, host: `${TTYD_HOST}:${TTYD_PORT}` };
    for (const [k, v] of Object.entries(headers)) {
      if (v == null) continue;
      if (Array.isArray(v)) lines.push(`${k}: ${v.join(", ")}`);
      else lines.push(`${k}: ${v}`);
    }
    p.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) p.write(head);
    p.pipe(socket);
    socket.pipe(p);
  });
  p.on("error", () => socket.destroy());
  socket.on("error", () => p.destroy());
});

server.listen(PORT, BIND, () => {
  console.error(`[web-gate] http://${BIND}:${PORT} → ttyd ${TTYD_HOST}:${TTYD_PORT}`);
});
