"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const helmet = require("helmet");
const pinoHttp = require("pino-http");
const pino = require("pino");

const DEFAULT_TOKEN_FILE = "/data/.env";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(n)));
}

// Playwright accepts "load" | "domcontentloaded" | "networkidle". Map the
// Puppeteer-style "networkidle0" / "networkidle2" aliases for parity with
// Cloudflare Browser Rendering's /content contract; unknown values default
// to "networkidle".
function mapWaitUntil(value) {
  if (value == null) return "networkidle";
  const v = String(value);
  if (v === "networkidle0" || v === "networkidle2") return "networkidle";
  if (v === "load" || v === "domcontentloaded" || v === "networkidle") return v;
  return "networkidle";
}

function isValidUrl(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function safeEqualToken(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isTimeoutError(err) {
  if (!err) return false;
  const name = err.name || "";
  const msg = err.message || "";
  return name === "TimeoutError" || /Timeout\s+\d+ms exceeded|exceeded timeout/i.test(msg);
}

/**
 * Build the Express app.
 *
 * @param {object} opts
 * @param {() => Promise<import('playwright').Browser>} opts.getBrowser
 *   Returns a shared Browser instance. Caller is responsible for lifecycle.
 * @param {string} opts.token  Bearer token to require on /render.
 * @param {import('pino').Logger} [opts.logger]
 */
function createApp({ getBrowser, token, logger }) {
  const app = express();
  const log = logger || pino({ level: process.env.LOG_LEVEL || "info" });

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(pinoHttp({ logger: log }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  function requireAuth(req, res, next) {
    const header = req.get("authorization") || "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    const provided = m ? m[1].trim() : "";
    if (!token || !safeEqualToken(provided, token)) {
      return res.status(401).json({ success: false, error: "unauthorized" });
    }
    return next();
  }

  app.post("/render", requireAuth, async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res
        .status(422)
        .json({ success: false, error: "invalid JSON body" });
    }

    const { url, gotoOptions, waitForSelector, viewport, userAgent } = body;

    if (!isValidUrl(url)) {
      return res.status(422).json({
        success: false,
        error: "missing or invalid 'url' (must be http(s) URL)",
      });
    }

    const timeout = clampTimeout(gotoOptions?.timeout);
    const waitUntil = mapWaitUntil(gotoOptions?.waitUntil);
    const vp =
      viewport && Number.isFinite(viewport.width) && Number.isFinite(viewport.height)
        ? { width: Math.trunc(viewport.width), height: Math.trunc(viewport.height) }
        : DEFAULT_VIEWPORT;

    let browser;
    try {
      browser = await getBrowser();
    } catch (err) {
      req.log?.error({ err }, "playwright launch failed");
      return res
        .status(502)
        .json({ success: false, error: "renderer unavailable" });
    }

    let context;
    let page;
    try {
      context = await browser.newContext({
        viewport: vp,
        userAgent: typeof userAgent === "string" && userAgent.length > 0 ? userAgent : undefined,
      });
      page = await context.newPage();

      const response = await page.goto(url, { waitUntil, timeout });
      if (typeof waitForSelector === "string" && waitForSelector.length > 0) {
        await page.waitForSelector(waitForSelector, { timeout });
      }

      const html = await page.content();
      const finalUrl = page.url();
      const statusCode = response ? response.status() : 0;

      return res.json({
        success: true,
        result: html,
        finalUrl,
        statusCode,
      });
    } catch (err) {
      req.log?.warn({ err: { name: err?.name, message: err?.message } }, "render failed");
      if (isTimeoutError(err)) {
        return res
          .status(504)
          .json({ success: false, error: `render timeout: ${err.message}` });
      }
      return res
        .status(500)
        .json({ success: false, error: err?.message || "render failed" });
    } finally {
      if (page) {
        try {
          await page.close();
        } catch {}
      }
      if (context) {
        try {
          await context.close();
        } catch {}
      }
    }
  });

  return app;
}

/**
 * Lazy, self-healing shared Browser. Launches once on first call; relaunches
 * on `disconnected`. Suitable for low-concurrency single-tenant use.
 */
function createBrowserPool() {
  let browserPromise = null;

  async function launch() {
    // Lazy-require to keep `node:test` runs (which inject a stub) cheap.
    const { chromium } = require("playwright");
    const browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    browser.on("disconnected", () => {
      browserPromise = null;
    });
    return browser;
  }

  async function getBrowser() {
    if (!browserPromise) {
      browserPromise = launch().catch((err) => {
        browserPromise = null;
        throw err;
      });
    }
    return browserPromise;
  }

  async function close() {
    if (!browserPromise) return;
    try {
      const b = await browserPromise;
      await b.close();
    } catch {}
    browserPromise = null;
  }

  return { getBrowser, close };
}

function startServer() {
  const port = Number(process.env.PORT) || 3030;
  const host = process.env.HOST || "0.0.0.0";
  const logger = pino({ level: process.env.LOG_LEVEL || "info" });

  // Umbrel doesn't have a setup wizard for this app, so we bootstrap the
  // token ourselves: read it from /data/.env if present, generate + persist
  // one if not. Without this the container refuses to start on a fresh
  // install (no env var was ever set) and the user has no obvious way to
  // fix it from the Umbrel UI.
  ensureRendererToken({ logger });

  const token = process.env.RENDERER_TOKEN || "";
  if (!token) {
    logger.error(
      "RENDERER_TOKEN env var is required — refusing to start without auth"
    );
    process.exit(1);
  }

  const pool = createBrowserPool();
  const app = createApp({ getBrowser: pool.getBrowser, token, logger });

  const server = app.listen(port, host, () => {
    logger.info({ port, host }, "playwright-renderer listening");
  });

  function shutdown(signal) {
    logger.info({ signal }, "shutting down");
    server.close(async () => {
      await pool.close();
      process.exit(0);
    });
    // Hard cap so we don't hang forever.
    setTimeout(() => process.exit(1), 25_000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

/**
 * Read KEY=VALUE lines from `filePath` into `process.env` (without
 * overwriting existing values). Returns true when the file was read.
 * Intentionally minimal — no quoting, no `export` prefix, no comments.
 * The file we read is one we wrote ourselves a few lines later.
 */
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
  return true;
}

/**
 * Bootstrap `RENDERER_TOKEN`:
 *   1. If already in process.env, do nothing.
 *   2. Else load /data/.env (if present) and re-check.
 *   3. Else generate a fresh 256-bit token, persist to /data/.env, and
 *      print a prominent banner so the user can grab it from the Umbrel
 *      app logs without needing SSH.
 *
 * `tokenFile` defaults to /data/.env (matches the Docker volume mount in
 * docker-compose.yml). Tests inject a temp path.
 */
function ensureRendererToken({ logger, tokenFile = DEFAULT_TOKEN_FILE } = {}) {
  if (process.env.RENDERER_TOKEN) return { source: "env", token: process.env.RENDERER_TOKEN };

  loadEnvFile(tokenFile);
  if (process.env.RENDERER_TOKEN) return { source: "file", token: process.env.RENDERER_TOKEN };

  const token = crypto.randomBytes(32).toString("hex");
  let persisted = false;
  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, `RENDERER_TOKEN=${token}\n`, { mode: 0o600 });
    persisted = true;
  } catch (err) {
    logger?.warn?.(
      { err: err.message, tokenFile },
      "could not persist RENDERER_TOKEN to disk — in-memory only for this run"
    );
  }
  process.env.RENDERER_TOKEN = token;

  // Print to stdout so it shows up in `docker logs` and Umbrel's app logs
  // view (the user's only discovery path without SSH). Triple-banner makes
  // it survive a scroll-back even when app_proxy is spamming retries.
  const banner = [
    "",
    "═════════════════════════════════════════════════════════════════════",
    `  Playwright Renderer — first-boot token generated`,
    `    RENDERER_TOKEN=${token}`,
    persisted
      ? `  Persisted to ${tokenFile} (Docker volume — survives restarts).`
      : `  NOT persisted — restart will rotate the token (volume not writable).`,
    "  Share this with any client that calls POST /render.",
    "═════════════════════════════════════════════════════════════════════",
    "",
  ].join("\n");
  process.stdout.write(banner + "\n");

  return { source: "generated", token, persisted };
}

module.exports = {
  createApp,
  createBrowserPool,
  clampTimeout,
  mapWaitUntil,
  isValidUrl,
  ensureRendererToken,
  loadEnvFile,
};

if (require.main === module) {
  startServer();
}
