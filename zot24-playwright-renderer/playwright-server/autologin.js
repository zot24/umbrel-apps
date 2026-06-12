"use strict";

// Instagram session auto-refresh — the renderer half of
// zot24/onlyinparaguay#119 (Option B).
//
// Two layers live here:
//
//   1. Detection (`looksLikeLoginWall`) — recognise when a sessioned render
//      came back as Instagram's login wall instead of content.
//   2. Recovery (`createAutoLoginManager`) — opt-in, rate-limited, fail-stop
//      auto-login that re-authenticates with operator-provisioned
//      credentials (IG_USERNAME / IG_PASSWORD / optional IG_TOTP_SECRET in
//      /data/.env) and persists a fresh storageState.json.
//
// Failure-mode contract with the scraper worker (onlyinparaguay#202): when
// recovery is unavailable or fails, the renderer returns the wall HTML
// UNCHANGED as a normal success response. The worker runs the same
// login-wall detector and backs off — auto-recovery failing must look
// exactly like no auto-recovery at all.
//
// Logging hygiene is an acceptance criterion: nothing in this module may
// log credentials, TOTP secrets/codes, cookies, or HTML bodies — at ANY
// level. Failures are logged as short category strings only.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Same Docker volume as /data/storageState.json and /data/.env.
const DEFAULT_AUTOLOGIN_STATE_FILE = "/data/autologin-state.json";
const DEFAULT_ENV_FILE = "/data/.env";

const IG_LOGIN_URL = "https://www.instagram.com/accounts/login/";

// Rate-limit / fail-stop defaults. Every IG login is a security event on
// their side; hammering the login endpoint with bad credentials is the
// fastest way to get the account flagged. Conservative by default.
const DEFAULT_MIN_INTERVAL_HOURS = 6;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

// ---------------------------------------------------------------------------
// Login-wall detection
// ---------------------------------------------------------------------------

// Positive Instagram markers ONLY — never emptiness. An empty-but-valid page
// (slow hydration, JS error, brand-new account with zero posts) must NOT
// look like an expired session, or we'd burn login attempts on false
// positives and risk flagging the account.
//
// KEEP IN SYNC with the worker-side detector:
//   onlyinparaguay services/scraper/src/sources/instagram.rs
//   `looks_like_login_wall` — same four markers, same case-insensitive
//   substring semantics. The worker uses these to detect an expired session
//   in the HTML we return, so divergence here breaks the back-off contract.
const LOGIN_WALL_MARKERS = [
  // The login form action is the strongest, most specific signal: it only
  // appears on IG's actual login page (covers `/accounts/login/ajax/` too).
  'action="/accounts/login',
  // Redirect/next pattern IG appends when bouncing an unauthenticated
  // request to the login page.
  "/accounts/login/?next=",
  // Canonical / redirect / location pointing at the login page — covers the
  // `<link rel="canonical">` and meta-refresh shells.
  'href="https://www.instagram.com/accounts/login/',
  'href="/accounts/login/',
];

function looksLikeLoginWall(html) {
  if (typeof html !== "string" || html.length === 0) return false;
  const lower = html.toLowerCase();
  return LOGIN_WALL_MARKERS.some((marker) => lower.includes(marker));
}

// If the REQUESTED url is itself the login page, the response legitimately
// contains all the wall markers — rendering it must not trigger auto-login.
function isLoginPageUrl(url) {
  try {
    return new URL(url).pathname.startsWith("/accounts/login");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Env-file parsing + credentials
// ---------------------------------------------------------------------------

/**
 * Parse KEY=VALUE lines from `filePath` into a plain object WITHOUT touching
 * process.env. Same intentionally-minimal grammar as server.js's
 * `loadEnvFile` (no quoting, no `export`, no comments) — server.js delegates
 * to this so the two can't drift.
 *
 * Returns `{}` when the file is missing/unreadable — callers treat that the
 * same as "no values".
 */
function parseEnvFile(filePath) {
  const vars = {};
  let content;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return vars;
  }
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    vars[match[1]] = match[2];
  }
  return vars;
}

/**
 * Load Instagram credentials FRESH from the env file, falling back to
 * process.env. Read at attempt time (not boot) on purpose: the operator
 * appends IG_USERNAME / IG_PASSWORD / IG_TOTP_SECRET to /data/.env over ssh
 * and the next recovery attempt picks them up — no container restart.
 *
 * Returns `null` when username or password is missing. TOTP secret is
 * optional — the account may not have 2FA enabled.
 */
function loadCredentials({ envFile = DEFAULT_ENV_FILE, env = process.env } = {}) {
  const fileVars = parseEnvFile(envFile);
  const pick = (key) => {
    const fromFile = fileVars[key];
    if (fromFile != null && fromFile !== "") return fromFile;
    const fromEnv = env[key];
    if (fromEnv != null && fromEnv !== "") return fromEnv;
    return undefined;
  };
  const username = pick("IG_USERNAME");
  const password = pick("IG_PASSWORD");
  if (!username || !password) return null;
  return { username, password, totpSecret: pick("IG_TOTP_SECRET") };
}

// ---------------------------------------------------------------------------
// Atomic file writes
// ---------------------------------------------------------------------------

/**
 * Write `data` to `filePath` atomically: tmp file in the same directory
 * (rename(2) is only atomic within a filesystem), mode 600, then rename over
 * the original. The tmp name embeds pid + random bytes so two concurrent
 * writers can't collide on the tmp path — last rename wins, which is
 * acceptable for both storageState.json and the autologin state file.
 */
function atomicWriteFile(filePath, data) {
  const dir = path.dirname(filePath);
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
  );
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Don't leave credential-bearing tmp files lying around on failure.
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Auto-login attempt state ({lastAttemptAt, consecutiveFailures})
// ---------------------------------------------------------------------------

/**
 * Read the persisted attempt state. Malformed/missing files are treated as
 * fresh state — a corrupt JSON file must degrade to "we've never tried",
 * not crash the render path.
 */
function readAutologinState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        lastAttemptAt: Number(parsed.lastAttemptAt) || 0,
        consecutiveFailures: Number(parsed.consecutiveFailures) || 0,
      };
    }
  } catch {}
  return { lastAttemptAt: 0, consecutiveFailures: 0 };
}

function writeAutologinState(filePath, state) {
  atomicWriteFile(
    filePath,
    JSON.stringify(
      {
        lastAttemptAt: state.lastAttemptAt,
        consecutiveFailures: state.consecutiveFailures,
      },
      null,
      2
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) in pure node:crypto — no new npm dependency. This repo
// deliberately keeps the dependency surface tiny; a 30-line HMAC loop does
// not justify pulling in otplib + its transitive tree.
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * RFC 4648 base32 decode. Tolerant of the formats authenticator-app exports
 * actually use: lowercase, spaces/dashes for readability, trailing `=`
 * padding. Throws on genuinely invalid characters so a typo'd secret fails
 * loudly at attempt time instead of generating wrong codes forever.
 */
function base32Decode(input) {
  if (typeof input !== "string") throw new Error("base32 input must be a string");
  const clean = input.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  if (clean.length === 0) throw new Error("base32 input is empty");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP — SHA-1, dynamic truncation, fixed digit count. */
function hotp(keyBuffer, counter, digits) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", keyBuffer).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(code % 10 ** digits).padStart(digits, "0");
}

/**
 * RFC 6238 TOTP from a base32 secret. Defaults match what Instagram (and
 * virtually every authenticator app) uses: SHA-1, 30s step, 6 digits.
 */
function totp(base32Secret, { timeMs = Date.now(), stepSeconds = 30, digits = 6 } = {}) {
  const counter = Math.floor(timeMs / 1000 / stepSeconds);
  return hotp(base32Decode(base32Secret), counter, digits);
}

// ---------------------------------------------------------------------------
// Instagram login flow
// ---------------------------------------------------------------------------

/**
 * Error with a short, credential-free category string. The category is the
 * ONLY thing the manager logs about a failed attempt — never the message of
 * an arbitrary wrapped error, which could echo page text or typed input.
 */
class LoginError extends Error {
  constructor(category) {
    super(`instagram login failed: ${category}`);
    this.name = "LoginError";
    this.category = category;
  }
}

function categorizeLoginError(err) {
  if (err && typeof err.category === "string") return err.category;
  const name = err?.name || "";
  const message = err?.message || "";
  if (name === "TimeoutError" || /Timeout\s+\d+ms exceeded|exceeded timeout/i.test(message)) {
    return "timeout";
  }
  if (/net::|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_INTERNET/i.test(message)) {
    return "network";
  }
  return "unknown";
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded visibility probe — never throws, never hangs past `timeout`. */
async function isVisible(page, selector, timeout) {
  try {
    await page.waitForSelector(selector, { timeout, state: "visible" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Click a button matching `namePattern` if one is visible within `timeout`.
 * IG renders its interstitials as real <button>s in some shells and
 * div[role=button] in others — try both, tolerate absence. Returns whether
 * a click happened.
 */
async function clickButtonByName(page, namePattern, timeout) {
  try {
    await page.getByRole("button", { name: namePattern }).first().click({ timeout });
    return true;
  } catch {}
  try {
    await page
      .locator('div[role="button"]', { hasText: namePattern })
      .first()
      .click({ timeout: Math.min(timeout, 1000) });
    return true;
  } catch {}
  return false;
}

/** Strongest success signal: a non-empty `sessionid` cookie for instagram.com. */
async function hasInstagramSessionCookie(context) {
  try {
    const cookies = await context.cookies("https://www.instagram.com/");
    return cookies.some(
      (c) => c.name === "sessionid" && typeof c.value === "string" && c.value.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Drive the actual Instagram login UI in a fresh context. Returns the
 * Playwright `storageState()` object on success; throws `LoginError` (with
 * a category, never credentials) on failure.
 *
 * The post-submit phase is deliberately a tolerant polling loop rather than
 * a strict state machine: IG shows the TOTP prompt, the "Save your login
 * info?" interstitial, and the "Turn on Notifications" dialog in varying
 * orders, and any of them may simply not appear. Each probe is bounded, the
 * whole loop is deadline-capped, and success is judged ONLY by the
 * `sessionid` cookie — not by which dialogs we happened to see.
 */
async function performInstagramLogin({
  browser,
  credentials,
  viewport,
  userAgent,
  stealthInitScript,
  logger,
  now = Date.now,
}) {
  // Fresh context with the same stealth surface as normal renders — logging
  // in from an unmasked context would hand IG an automation fingerprint at
  // the worst possible moment.
  const context = await browser.newContext({
    viewport: viewport || { width: 1280, height: 800 },
    userAgent: userAgent || undefined,
  });
  let page;
  try {
    if (stealthInitScript) await context.addInitScript(stealthInitScript);
    page = await context.newPage();

    await page.goto(IG_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector('input[name="username"]', { timeout: 15_000 });

    // Human-ish per-key delay. pressSequentially is the non-deprecated
    // page.type — one keydown/keyup pair per character.
    await page
      .locator('input[name="username"]')
      .pressSequentially(credentials.username, { delay: 80 });
    await page
      .locator('input[name="password"]')
      .pressSequentially(credentials.password, { delay: 80 });
    await page.click('button[type="submit"]');

    const deadline = now() + 75_000;
    let totpSubmitted = false;
    let saveInfoHandled = false;
    let notNowHandled = false;

    while (now() < deadline) {
      if (await hasInstagramSessionCookie(context)) {
        // Already authenticated. Give the longevity interstitials one
        // bounded shot each before declaring victory: clicking "Save info"
        // is what makes IG hand out a long-lived session instead of a
        // browser-session one.
        if (!saveInfoHandled) {
          saveInfoHandled = await clickButtonByName(page, /save info/i, 4_000);
        }
        if (!notNowHandled) {
          notNowHandled = await clickButtonByName(page, /not now/i, 2_000);
        }
        break;
      }

      // 2FA prompt. Compute the code at the moment we see the prompt (not
      // earlier) so we don't submit a code from an expired 30s window.
      if (!totpSubmitted && (await isVisible(page, 'input[name="verificationCode"]', 1_500))) {
        if (!credentials.totpSecret) throw new LoginError("totp_required_but_no_secret");
        const code = totp(credentials.totpSecret);
        await page
          .locator('input[name="verificationCode"]')
          .pressSequentially(code, { delay: 60 });
        if (!(await clickButtonByName(page, /confirm/i, 3_000))) {
          await page.keyboard.press("Enter");
        }
        totpSubmitted = true;
        continue;
      }

      // Interstitials can also appear BEFORE the sessionid probe succeeds
      // on slow networks — handle them here too.
      if (!saveInfoHandled && (saveInfoHandled = await clickButtonByName(page, /save info/i, 1_000))) {
        continue;
      }
      if (!notNowHandled && (notNowHandled = await clickButtonByName(page, /not now/i, 1_000))) {
        continue;
      }

      await sleep(1_500);
    }

    if (!(await hasInstagramSessionCookie(context))) {
      // Covers bad credentials, IG checkpoint/challenge pages, and silent
      // rejections alike — we don't try to distinguish them because doing
      // so would mean inspecting (and risking logging) page content.
      throw new LoginError(totpSubmitted ? "no_session_cookie_after_totp" : "no_session_cookie");
    }

    logger?.info?.("instagram auto-login verified (sessionid cookie present)");
    return await context.storageState();
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {}
    }
    try {
      await context.close();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Manager — gating, rate-limit, fail-stop, single-flight orchestration
// ---------------------------------------------------------------------------

function parseBool(value, defaultValue) {
  if (value == null || value === "") return defaultValue;
  return /^(true|1|yes|on)$/i.test(String(value).trim());
}

function parsePositiveNumber(value, defaultValue) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

/**
 * Create the auto-login manager the /render path consults when a sessioned
 * render comes back as a login wall.
 *
 * Everything dynamic (enabled flag, credentials, tuning knobs) is re-read
 * from `envFile` on EVERY attempt, falling back to process.env — so the
 * operator can provision/disable without restarting the container. Test
 * seams: `enabled`, `minIntervalHours`, `maxConsecutiveFailures` overrides,
 * injectable `loginFn` and `now`.
 *
 * `recover()` returns `true` when a fresh session was persisted (caller
 * should retry the render once) and `false` in every other case (caller
 * serves the wall HTML unchanged so the worker detects it and backs off).
 */
function createAutoLoginManager({
  storageStateFile,
  stateFile = DEFAULT_AUTOLOGIN_STATE_FILE,
  envFile = DEFAULT_ENV_FILE,
  logger,
  stealthInitScript,
  enabled,
  minIntervalHours,
  maxConsecutiveFailures,
  loginFn = performInstagramLogin,
  now = Date.now,
} = {}) {
  if (!storageStateFile) throw new Error("createAutoLoginManager requires storageStateFile");

  // In-process single-flight: while one request is mid-login, concurrent
  // wall-hitting requests skip recovery and serve their wall HTML. Two
  // parallel logins would be both pointless and a flag-me signal to IG.
  let inProgress = false;

  function resolveConfig() {
    const fileVars = parseEnvFile(envFile);
    const pick = (key) => {
      const fromFile = fileVars[key];
      if (fromFile != null && fromFile !== "") return fromFile;
      const fromEnv = process.env[key];
      if (fromEnv != null && fromEnv !== "") return fromEnv;
      return undefined;
    };
    return {
      // Opt-in by design (acceptance criterion): storing credentials on the
      // box is a real tradeoff the operator must consciously accept.
      enabled:
        typeof enabled === "boolean"
          ? enabled
          : parseBool(pick("STORAGE_STATE_AUTOREFRESH"), false),
      minIntervalHours: parsePositiveNumber(
        minIntervalHours ?? pick("AUTOLOGIN_MIN_INTERVAL_HOURS"),
        DEFAULT_MIN_INTERVAL_HOURS
      ),
      maxConsecutiveFailures: parsePositiveNumber(
        maxConsecutiveFailures ?? pick("AUTOLOGIN_MAX_CONSECUTIVE_FAILURES"),
        DEFAULT_MAX_CONSECUTIVE_FAILURES
      ),
    };
  }

  async function recover({ browser, viewport, userAgent, log } = {}) {
    const logr = log || logger;

    if (inProgress) {
      logr?.debug?.("auto-login already in progress — serving wall HTML");
      return false;
    }

    const cfg = resolveConfig();
    if (!cfg.enabled) {
      logr?.debug?.(
        "login wall detected but STORAGE_STATE_AUTOREFRESH is not enabled — serving wall HTML"
      );
      return false;
    }

    const state = readAutologinState(stateFile);

    // Fail-stop: after too many consecutive failures, refuse to keep
    // hammering IG's login endpoint (each failed login raises the odds the
    // account gets flagged). Loud on every render that WOULD have tried,
    // so the operator can't miss it in the app logs.
    if (state.consecutiveFailures >= cfg.maxConsecutiveFailures) {
      logr?.error?.(
        { consecutiveFailures: state.consecutiveFailures, stateFile },
        `auto-login disabled after ${state.consecutiveFailures} consecutive failures — refresh the session manually per STORAGESTATE.md, then delete ${stateFile} to re-arm`
      );
      return false;
    }

    const minIntervalMs = cfg.minIntervalHours * 3_600_000;
    if (state.lastAttemptAt > 0 && now() - state.lastAttemptAt < minIntervalMs) {
      logr?.warn?.(
        { lastAttemptAt: state.lastAttemptAt, minIntervalHours: cfg.minIntervalHours },
        "login wall detected but last auto-login attempt is too recent — serving wall HTML"
      );
      return false;
    }

    const credentials = loadCredentials({ envFile });
    if (!credentials) {
      logr?.warn?.(
        { envFile },
        "STORAGE_STATE_AUTOREFRESH is enabled but IG_USERNAME/IG_PASSWORD are missing — see STORAGESTATE.md"
      );
      return false;
    }

    inProgress = true;
    try {
      // Record the attempt BEFORE making it: a crash mid-login must still
      // count against the rate limit, otherwise a crashing flow retries on
      // every render.
      writeAutologinState(stateFile, {
        lastAttemptAt: now(),
        consecutiveFailures: state.consecutiveFailures,
      });
      logr?.warn?.("login wall detected — attempting Instagram auto-login");

      const storageState = await loginFn({
        browser,
        credentials,
        viewport,
        userAgent,
        stealthInitScript,
        logger: logr,
      });

      atomicWriteFile(storageStateFile, JSON.stringify(storageState, null, 2) + "\n");
      writeAutologinState(stateFile, { lastAttemptAt: now(), consecutiveFailures: 0 });
      logr?.info?.({ storageStateFile }, "auto-login succeeded — fresh session state persisted");
      return true;
    } catch (err) {
      const consecutiveFailures = state.consecutiveFailures + 1;
      try {
        writeAutologinState(stateFile, { lastAttemptAt: now(), consecutiveFailures });
      } catch {}
      // Category ONLY — never the raw error message, which for arbitrary
      // wrapped errors could echo page text or typed input.
      logr?.error?.(
        {
          category: categorizeLoginError(err),
          consecutiveFailures,
          maxConsecutiveFailures: cfg.maxConsecutiveFailures,
        },
        "instagram auto-login failed — serving wall HTML so the worker backs off"
      );
      return false;
    } finally {
      inProgress = false;
    }
  }

  return { recover };
}

module.exports = {
  // detection
  looksLikeLoginWall,
  isLoginPageUrl,
  LOGIN_WALL_MARKERS,
  // env / credentials
  parseEnvFile,
  loadCredentials,
  // persistence
  atomicWriteFile,
  readAutologinState,
  writeAutologinState,
  DEFAULT_AUTOLOGIN_STATE_FILE,
  DEFAULT_ENV_FILE,
  // totp
  base32Decode,
  hotp,
  totp,
  // login flow
  performInstagramLogin,
  LoginError,
  categorizeLoginError,
  IG_LOGIN_URL,
  // manager
  createAutoLoginManager,
};
