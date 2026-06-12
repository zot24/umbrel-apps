"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const pino = require("pino");

const {
  createApp,
  clampTimeout,
  mapWaitUntil,
  isValidUrl,
  ensureRendererToken,
  loadEnvFile,
  DEFAULT_STORAGE_STATE_FILE,
  STEALTH_INIT_SCRIPT,
} = require("./server.js");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const silentLogger = pino({ level: "silent" });

const TOKEN = "test-token-supersecret";

// ---------------------------------------------------------------------------
// Mock Playwright surface — implements just enough of Browser/Context/Page
// for the route handler. Behaviour is controlled via the `behaviour` arg.
// ---------------------------------------------------------------------------
function makeMockBrowser(behaviour = {}) {
  const calls = {
    newContextArgs: [],
    initScripts: [],
    gotoArgs: [],
    waitForSelectorArgs: [],
    storageStateCalls: 0,
  };

  // `behaviour.htmlQueue` lets a test serve different HTML per render —
  // needed for the auto-login orchestration tests where the first render
  // returns a login wall and the post-login retry returns content. The
  // last entry repeats once the queue drains.
  function nextHtml() {
    if (Array.isArray(behaviour.htmlQueue) && behaviour.htmlQueue.length > 0) {
      return behaviour.htmlQueue.length > 1
        ? behaviour.htmlQueue.shift()
        : behaviour.htmlQueue[0];
    }
    return behaviour.html ?? "<html><body>ok</body></html>";
  }

  function makePage(finalUrl) {
    let currentUrl = finalUrl || "https://example.com/";
    return {
      async goto(url, opts) {
        calls.gotoArgs.push({ url, opts });
        if (behaviour.gotoTimeout) {
          const err = new Error(
            `Timeout ${opts?.timeout || 30000}ms exceeded`
          );
          err.name = "TimeoutError";
          throw err;
        }
        if (behaviour.gotoThrows) throw behaviour.gotoThrows;
        currentUrl = behaviour.finalUrl || url;
        return {
          status: () => behaviour.statusCode ?? 200,
        };
      },
      async waitForSelector(selector, opts) {
        calls.waitForSelectorArgs.push({ selector, opts });
        if (behaviour.selectorTimeout) {
          const err = new Error(
            `Timeout ${opts?.timeout || 30000}ms exceeded`
          );
          err.name = "TimeoutError";
          throw err;
        }
      },
      async content() {
        return nextHtml();
      },
      url() {
        return currentUrl;
      },
      async close() {},
    };
  }

  const browser = {
    async newContext(args) {
      calls.newContextArgs.push(args);
      return {
        // The stealth init script is applied via `context.addInitScript`
        // before `newPage` — record the call so tests can assert the
        // patches actually got pushed into the page bootstrap.
        async addInitScript(script) {
          calls.initScripts.push(script);
        },
        async newPage() {
          return makePage(behaviour.finalUrl);
        },
        // Keep-alive write-back serializes the context via storageState().
        // Tests assert call counts + what got persisted to disk.
        async storageState() {
          calls.storageStateCalls += 1;
          return behaviour.contextStorageState ?? { cookies: [], origins: [] };
        },
        async close() {},
      };
    },
    on() {},
    async close() {},
  };

  return { browser, calls };
}

function makeGetBrowser(behaviour) {
  const { browser, calls } = makeMockBrowser(behaviour);
  let launches = 0;
  const getBrowser = async () => {
    launches += 1;
    if (behaviour.launchThrows) throw behaviour.launchThrows;
    return browser;
  };
  return { getBrowser, calls, launches: () => launches };
}

// ---------------------------------------------------------------------------
// Test harness — boots the express app on a random port for each test.
// ---------------------------------------------------------------------------
function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
    server.on("error", reject);
  });
}

function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          ...(data
            ? {
                "content-type": "application/json",
                "content-length": data.length,
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            // leave as null
          }
          resolve({ status: res.statusCode, raw, json });
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function withServer(behaviour, fn, opts = {}) {
  const { getBrowser, calls } = makeGetBrowser(behaviour);
  const app = createApp({
    getBrowser,
    token: TOKEN,
    logger: opts.logger || silentLogger,
    storageStateFile: opts.storageStateFile,
    sessionKeepalive: opts.sessionKeepalive,
    autoLogin: opts.autoLogin,
  });
  const { server, port } = await listen(app);
  try {
    await fn({ port, calls });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ---------------------------------------------------------------------------
// Pure-helper tests
// ---------------------------------------------------------------------------
test("clampTimeout clamps to allowed range", () => {
  assert.equal(clampTimeout(1_000), 5_000);
  assert.equal(clampTimeout(15_000), 15_000);
  assert.equal(clampTimeout(120_000), 60_000);
  assert.equal(clampTimeout(undefined), 30_000);
  assert.equal(clampTimeout("not a number"), 30_000);
});

test("mapWaitUntil maps Puppeteer aliases to Playwright values", () => {
  assert.equal(mapWaitUntil(undefined), "networkidle");
  assert.equal(mapWaitUntil("networkidle0"), "networkidle");
  assert.equal(mapWaitUntil("networkidle2"), "networkidle");
  assert.equal(mapWaitUntil("domcontentloaded"), "domcontentloaded");
  assert.equal(mapWaitUntil("load"), "load");
  assert.equal(mapWaitUntil("garbage"), "networkidle");
});

test("isValidUrl accepts http(s), rejects others", () => {
  assert.equal(isValidUrl("https://example.com"), true);
  assert.equal(isValidUrl("http://example.com/foo?bar=1"), true);
  assert.equal(isValidUrl("ftp://example.com"), false);
  assert.equal(isValidUrl("not-a-url"), false);
  assert.equal(isValidUrl(""), false);
  assert.equal(isValidUrl(undefined), false);
});

// ---------------------------------------------------------------------------
// HTTP route tests
// ---------------------------------------------------------------------------
test("GET /health responds with { ok: true } and needs no auth", async () => {
  await withServer({}, async ({ port }) => {
    const res = await request(port, { method: "GET", path: "/health" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
  });
});

test("POST /render without Authorization returns 401", async () => {
  await withServer({}, async ({ port }) => {
    const res = await request(port, {
      method: "POST",
      path: "/render",
      body: { url: "https://example.com" },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { success: false, error: "unauthorized" });
  });
});

test("POST /render with wrong token returns 401", async () => {
  await withServer({}, async ({ port }) => {
    const res = await request(port, {
      method: "POST",
      path: "/render",
      headers: { authorization: "Bearer wrong-token" },
      body: { url: "https://example.com" },
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.success, false);
  });
});

test("POST /render with token-length match but wrong bytes returns 401", async () => {
  await withServer({}, async ({ port }) => {
    // Same length as TOKEN but different bytes — exercises timingSafeEqual.
    const sameLen = "x".repeat(TOKEN.length);
    const res = await request(port, {
      method: "POST",
      path: "/render",
      headers: { authorization: `Bearer ${sameLen}` },
      body: { url: "https://example.com" },
    });
    assert.equal(res.status, 401);
  });
});

test("POST /render with missing url returns 422", async () => {
  await withServer({}, async ({ port }) => {
    const res = await request(port, {
      method: "POST",
      path: "/render",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: {},
    });
    assert.equal(res.status, 422);
    assert.equal(res.json.success, false);
    assert.match(res.json.error, /url/);
  });
});

test("POST /render with non-http url returns 422", async () => {
  await withServer({}, async ({ port }) => {
    const res = await request(port, {
      method: "POST",
      path: "/render",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: { url: "ftp://example.com/file" },
    });
    assert.equal(res.status, 422);
  });
});

test("POST /render with non-object body returns 422", async () => {
  await withServer({}, async ({ port }) => {
    // Send raw JSON array — express.json will parse it, then handler should reject.
    const res = await request(port, {
      method: "POST",
      path: "/render",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: [1, 2, 3],
    });
    assert.equal(res.status, 422);
  });
});

test("POST /render happy path returns rendered HTML with expected shape", async () => {
  await withServer(
    {
      html: "<html><body><h1>hi</h1></body></html>",
      finalUrl: "https://example.com/landing",
      statusCode: 200,
    },
    async ({ port, calls }) => {
      const res = await request(port, {
        method: "POST",
        path: "/render",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: {
          url: "https://example.com",
          gotoOptions: { waitUntil: "networkidle0", timeout: 20_000 },
          viewport: { width: 1366, height: 900 },
          userAgent: "OnlyInParaguayTestBot/1.0",
        },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.result, "<html><body><h1>hi</h1></body></html>");
      assert.equal(res.json.finalUrl, "https://example.com/landing");
      assert.equal(res.json.statusCode, 200);

      // Verify the request flowed into Playwright correctly.
      assert.equal(calls.gotoArgs.length, 1);
      assert.equal(calls.gotoArgs[0].url, "https://example.com");
      assert.equal(calls.gotoArgs[0].opts.waitUntil, "networkidle");
      assert.equal(calls.gotoArgs[0].opts.timeout, 20_000);
      assert.deepEqual(calls.newContextArgs[0].viewport, {
        width: 1366,
        height: 900,
      });
      assert.equal(calls.newContextArgs[0].userAgent, "OnlyInParaguayTestBot/1.0");
    }
  );
});

test("POST /render honors waitForSelector when provided", async () => {
  await withServer({}, async ({ port, calls }) => {
    const res = await request(port, {
      method: "POST",
      path: "/render",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: { url: "https://example.com", waitForSelector: ".loaded" },
    });
    assert.equal(res.status, 200);
    assert.equal(calls.waitForSelectorArgs.length, 1);
    assert.equal(calls.waitForSelectorArgs[0].selector, ".loaded");
  });
});

test("POST /render returns 504 on Playwright TimeoutError", async () => {
  await withServer({ gotoTimeout: true }, async ({ port }) => {
    const res = await request(port, {
      method: "POST",
      path: "/render",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: { url: "https://example.com" },
    });
    assert.equal(res.status, 504);
    assert.equal(res.json.success, false);
    assert.match(res.json.error, /timeout/i);
  });
});

test("POST /render returns 504 when waitForSelector times out", async () => {
  await withServer({ selectorTimeout: true }, async ({ port }) => {
    const res = await request(port, {
      method: "POST",
      path: "/render",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: { url: "https://example.com", waitForSelector: ".never-appears" },
    });
    assert.equal(res.status, 504);
  });
});

test("POST /render returns 502 when browser launch fails", async () => {
  await withServer(
    { launchThrows: new Error("chromium failed to start") },
    async ({ port }) => {
      const res = await request(port, {
        method: "POST",
        path: "/render",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: { url: "https://example.com" },
      });
      assert.equal(res.status, 502);
      assert.equal(res.json.success, false);
      assert.match(res.json.error, /unavailable/i);
    }
  );
});

test("POST /render uses default viewport when none provided", async () => {
  await withServer({}, async ({ port, calls }) => {
    const res = await request(port, {
      method: "POST",
      path: "/render",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: { url: "https://example.com" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls.newContextArgs[0].viewport, {
      width: 1280,
      height: 800,
    });
  });
});

test("POST /render clamps absurd timeouts into the allowed range", async () => {
  await withServer({}, async ({ port, calls }) => {
    const res = await request(port, {
      method: "POST",
      path: "/render",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: {
        url: "https://example.com",
        gotoOptions: { timeout: 9_999_999 },
      },
    });
    assert.equal(res.status, 200);
    assert.equal(calls.gotoArgs[0].opts.timeout, 60_000);
  });
});

// ---------------------------------------------------------------------------
// ensureRendererToken — Umbrel install bootstrap
// ---------------------------------------------------------------------------
// Reasoning: without setup-wizard machinery Umbrel never sets
// RENDERER_TOKEN, so the server bootstraps one on first boot and persists
// to a Docker volume. These tests cover the three paths (env wins, file
// wins when env empty, generate when neither) and the persistence.

function withTokenFixture(testFn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-token-"));
    const tokenFile = path.join(dir, ".env");
    const prevToken = process.env.RENDERER_TOKEN;
    delete process.env.RENDERER_TOKEN;
    try {
      await testFn({ tokenFile });
    } finally {
      if (prevToken === undefined) delete process.env.RENDERER_TOKEN;
      else process.env.RENDERER_TOKEN = prevToken;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  "ensureRendererToken prefers process.env when set",
  withTokenFixture(async ({ tokenFile }) => {
    process.env.RENDERER_TOKEN = "from-env";
    const result = ensureRendererToken({ logger: silentLogger, tokenFile });
    assert.equal(result.source, "env");
    assert.equal(result.token, "from-env");
    assert.equal(fs.existsSync(tokenFile), false, "should not write a file when env was already set");
  })
);

test(
  "ensureRendererToken loads from token file when env is empty",
  withTokenFixture(async ({ tokenFile }) => {
    fs.writeFileSync(tokenFile, "RENDERER_TOKEN=from-file\n");
    const result = ensureRendererToken({ logger: silentLogger, tokenFile });
    assert.equal(result.source, "file");
    assert.equal(result.token, "from-file");
    assert.equal(process.env.RENDERER_TOKEN, "from-file");
  })
);

test(
  "ensureRendererToken generates and persists a 64-char hex token when neither env nor file has one",
  withTokenFixture(async ({ tokenFile }) => {
    const result = ensureRendererToken({ logger: silentLogger, tokenFile });
    assert.equal(result.source, "generated");
    assert.equal(result.persisted, true);
    assert.match(result.token, /^[0-9a-f]{64}$/);
    assert.equal(process.env.RENDERER_TOKEN, result.token);
    const written = fs.readFileSync(tokenFile, "utf-8");
    assert.equal(written.trim(), `RENDERER_TOKEN=${result.token}`);
  })
);

test(
  "ensureRendererToken still serves an in-memory token if persistence fails",
  withTokenFixture(async ({ tokenFile }) => {
    // Point at a path under a non-existent parent that mkdir -p can create —
    // then pre-create the dir as a *read-only file* so the write fails.
    const blockedDir = path.join(path.dirname(tokenFile), "blocked");
    fs.mkdirSync(blockedDir);
    fs.chmodSync(blockedDir, 0o500); // r-x for owner — write rejected
    const result = ensureRendererToken({
      logger: silentLogger,
      tokenFile: path.join(blockedDir, ".env"),
    });
    fs.chmodSync(blockedDir, 0o700); // restore so cleanup works
    assert.equal(result.source, "generated");
    assert.equal(result.persisted, false);
    assert.match(result.token, /^[0-9a-f]{64}$/);
    assert.equal(process.env.RENDERER_TOKEN, result.token);
  })
);

test(
  "loadEnvFile parses KEY=VALUE lines without overwriting non-empty existing env",
  withTokenFixture(async ({ tokenFile }) => {
    fs.writeFileSync(tokenFile, "FOO=bar\nRENDERER_TOKEN=from-file\nBAZ=qux\n");
    process.env.FOO = "preset"; // non-empty preset should NOT be overwritten
    delete process.env.BAZ;
    const found = loadEnvFile(tokenFile);
    assert.equal(found, true);
    assert.equal(process.env.FOO, "preset");
    assert.equal(process.env.BAZ, "qux");
    assert.equal(process.env.RENDERER_TOKEN, "from-file");
    delete process.env.FOO;
    delete process.env.BAZ;
  })
);

test(
  "loadEnvFile overwrites empty-string env vars (regression: docker-compose RENDERER_TOKEN=${RENDERER_TOKEN} interpolation)",
  withTokenFixture(async ({ tokenFile }) => {
    // Empirical bug: docker-compose.yml declares `RENDERER_TOKEN:
    // ${RENDERER_TOKEN}` so the host env can override. When Umbrel
    // doesn't set RENDERER_TOKEN on the host, compose interpolates the
    // missing variable to an empty STRING (not unset), so the container
    // boots with `process.env.RENDERER_TOKEN === ""`. The original
    // strict `=== undefined` check left the empty env in place and the
    // bootstrap fell through to "generate a new token + overwrite the
    // persisted file", which rotated the token on every container
    // restart. This test pins the empty-vs-unset behavior:
    //   - empty string in env  → file value wins
    //   - non-empty in env     → file value loses (covered by previous test)
    //   - undefined in env     → file value wins (covered too)
    fs.writeFileSync(tokenFile, "RENDERER_TOKEN=from-file\nFOO=bar\n");
    process.env.RENDERER_TOKEN = ""; // exactly the docker-compose case
    process.env.FOO = "";            // and confirm it generalises
    const found = loadEnvFile(tokenFile);
    assert.equal(found, true);
    assert.equal(process.env.RENDERER_TOKEN, "from-file");
    assert.equal(process.env.FOO, "bar");
    delete process.env.FOO;
  })
);

test(
  "ensureRendererToken keeps the persisted token across boots when env is empty (regression #TBD)",
  withTokenFixture(async ({ tokenFile }) => {
    // End-to-end version of the empty-env regression: persist a token
    // to the file, set the env to "" the way docker-compose does, and
    // confirm the bootstrap picks the file value instead of rolling a
    // new one. Before the fix this test would surface a `source:
    // "generated"` result and the file contents would change.
    fs.writeFileSync(tokenFile, "RENDERER_TOKEN=persisted-aaaaaaaaaaaa\n");
    const fileBefore = fs.readFileSync(tokenFile, "utf-8");
    process.env.RENDERER_TOKEN = ""; // docker-compose's interpolated empty
    const result = ensureRendererToken({ logger: silentLogger, tokenFile });
    assert.equal(result.source, "file", "must read from file, not regenerate");
    assert.equal(result.token, "persisted-aaaaaaaaaaaa");
    assert.equal(process.env.RENDERER_TOKEN, "persisted-aaaaaaaaaaaa");
    // Cardinal proof: the file on disk MUST NOT have been rewritten.
    assert.equal(fs.readFileSync(tokenFile, "utf-8"), fileBefore, "file was rewritten — token would rotate on next boot");
  })
);

// ---------------------------------------------------------------------------
// Stealth init script + storageState (Instagram-class sites)
// ---------------------------------------------------------------------------
// Reasoning: Instagram fingerprints the Playwright/Chromium-automation
// surface aggressively. The renderer ships a small set of page-side
// patches (`STEALTH_INIT_SCRIPT`) that are applied to every context, and
// an opt-in `useSession: true` flag that mounts a persisted cookies
// snapshot for logged-in scrapes. These tests pin the wire contract
// for both.

test("STEALTH_INIT_SCRIPT patches the high-signal automation tells", () => {
  // Substring assertions — we don't want to type-check the exact JS,
  // we want to know each named patch is still present after future
  // refactors.
  assert.match(STEALTH_INIT_SCRIPT, /navigator,\s*'webdriver'/);
  assert.match(STEALTH_INIT_SCRIPT, /navigator,\s*'plugins'/);
  assert.match(STEALTH_INIT_SCRIPT, /navigator,\s*'languages'/);
  assert.match(STEALTH_INIT_SCRIPT, /window\.chrome/);
});

test("DEFAULT_STORAGE_STATE_FILE matches the docker-compose mount path", () => {
  // The Umbrel app mounts ${APP_DATA_DIR}/data:/data, so the default
  // must live under /data — otherwise the operator's scp ritual lands
  // a file the server never reads. Hard-coded contract.
  assert.equal(DEFAULT_STORAGE_STATE_FILE, "/data/storageState.json");
});

test("POST /render applies stealth init script to every context (no session)", async () => {
  await withServer({}, async ({ port, calls }) => {
    const res = await request(port, {
      method: "POST",
      path: "/render",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: { url: "https://example.com" },
    });
    assert.equal(res.status, 200);
    assert.equal(calls.initScripts.length, 1);
    assert.equal(calls.initScripts[0], STEALTH_INIT_SCRIPT);
  });
});

test("POST /render with useSession:true and a file present passes storageState path to newContext", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-session-"));
  const stateFile = path.join(dir, "storageState.json");
  fs.writeFileSync(stateFile, JSON.stringify({ cookies: [], origins: [] }));
  try {
    await withServer(
      {},
      async ({ port, calls }) => {
        const res = await request(port, {
          method: "POST",
          path: "/render",
          headers: { authorization: `Bearer ${TOKEN}` },
          body: { url: "https://example.com", useSession: true },
        });
        assert.equal(res.status, 200);
        assert.equal(calls.newContextArgs.length, 1);
        assert.equal(calls.newContextArgs[0].storageState, stateFile);
        // Stealth still applied on the session path — the masks are
        // orthogonal to whether we're logged in.
        assert.equal(calls.initScripts.length, 1);
      },
      { storageStateFile: stateFile }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /render with useSession:true and no file returns 503 (fail loud, no silent downgrade)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-no-session-"));
  // intentionally do NOT create the file
  const stateFile = path.join(dir, "storageState.json");
  try {
    await withServer(
      {},
      async ({ port, calls }) => {
        const res = await request(port, {
          method: "POST",
          path: "/render",
          headers: { authorization: `Bearer ${TOKEN}` },
          body: { url: "https://example.com", useSession: true },
        });
        assert.equal(res.status, 503);
        assert.equal(res.json.success, false);
        assert.match(res.json.error, /useSession/);
        assert.match(res.json.error, /missing/);
        // The browser pool MUST NOT have been touched — the 503 fires
        // before we even ask getBrowser(). Asserts that the early exit
        // really is early.
        assert.equal(calls.newContextArgs.length, 0);
      },
      { storageStateFile: stateFile }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Session auto-refresh (zot24/onlyinparaguay#119) — layer 1: keep-alive
// write-back; layer 2: auto-login on login-wall detection.
// ---------------------------------------------------------------------------
// Reasoning: a sessioned render that WORKED should roll its (possibly
// refreshed) cookies back to disk so the session's sliding expiry keeps
// extending. A sessioned render that hit Instagram's login wall must never
// write back (that would clobber good state with logged-out cookies) and
// may instead trigger the rate-limited auto-login manager. When recovery
// is off/unavailable/failed, the wall HTML is served UNCHANGED as success —
// the scraper worker's own detector (onlyinparaguay#202) needs to see it
// to back off.

const { createAutoLoginManager, readAutologinState } = require("./autologin.js");

const WALL_HTML = `<html><head><link rel="canonical" href="https://www.instagram.com/accounts/login/"></head><body><form action="/accounts/login/ajax/" method="post"></form></body></html>`;
const PROFILE_HTML = `<html><body><main><a href="/p/AbC123/">post</a></main></body></html>`;

// Boots a server with a real (temp-file-backed) auto-login manager + the
// session fixture files every orchestration test needs.
async function withAutoRefreshServer({ behaviour, manager, sessionKeepalive, logger }, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-autorefresh-"));
  const stateFile = path.join(dir, "storageState.json");
  const autologinStateFile = path.join(dir, "autologin-state.json");
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(stateFile, JSON.stringify({ cookies: [{ name: "sessionid", value: "stale" }], origins: [] }));
  fs.writeFileSync(envFile, "IG_USERNAME=scraper\nIG_PASSWORD=hunter2\n");
  const files = { dir, stateFile, autologinStateFile, envFile };
  try {
    await withServer(
      behaviour,
      async ({ port, calls }) => fn({ port, calls, files }),
      {
        storageStateFile: stateFile,
        sessionKeepalive,
        logger,
        autoLogin: manager ? manager(files) : undefined,
      }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("keep-alive: successful sessioned render writes context.storageState() back to disk", async () => {
  const freshState = { cookies: [{ name: "sessionid", value: "rolled-forward" }], origins: [] };
  await withAutoRefreshServer(
    {
      behaviour: { html: PROFILE_HTML, contextStorageState: freshState },
      manager: () => null,
    },
    async ({ port, calls, files }) => {
      const res = await request(port, {
        method: "POST",
        path: "/render",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: { url: "https://www.instagram.com/someprofile/", useSession: true },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.result, PROFILE_HTML);
      assert.equal(calls.storageStateCalls, 1);
      const onDisk = JSON.parse(fs.readFileSync(files.stateFile, "utf-8"));
      assert.deepEqual(onDisk, freshState, "storage state file must hold the rolled-forward cookies");
      assert.equal(fs.statSync(files.stateFile).mode & 0o777, 0o600);
    }
  );
});

test("keep-alive: SESSION_KEEPALIVE=false (option) disables the write-back", async () => {
  await withAutoRefreshServer(
    {
      behaviour: { html: PROFILE_HTML, contextStorageState: { cookies: [], origins: [] } },
      manager: () => null,
      sessionKeepalive: false,
    },
    async ({ port, calls, files }) => {
      const before = fs.readFileSync(files.stateFile, "utf-8");
      const res = await request(port, {
        method: "POST",
        path: "/render",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: { url: "https://www.instagram.com/someprofile/", useSession: true },
      });
      assert.equal(res.status, 200);
      assert.equal(calls.storageStateCalls, 0, "must not serialize the context when disabled");
      assert.equal(fs.readFileSync(files.stateFile, "utf-8"), before, "file must be untouched");
    }
  );
});

test("keep-alive: a wall-detected render never writes back (would persist logged-out cookies)", async () => {
  await withAutoRefreshServer(
    {
      behaviour: { html: WALL_HTML },
      manager: () => null, // auto-login disabled — isolate the keep-alive gate
    },
    async ({ port, calls, files }) => {
      const before = fs.readFileSync(files.stateFile, "utf-8");
      const res = await request(port, {
        method: "POST",
        path: "/render",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: { url: "https://www.instagram.com/someprofile/", useSession: true },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.result, WALL_HTML, "wall HTML must be served unchanged");
      assert.equal(calls.storageStateCalls, 0);
      assert.equal(fs.readFileSync(files.stateFile, "utf-8"), before);
    }
  );
});

test("keep-alive: anonymous (non-session) renders never write back", async () => {
  await withAutoRefreshServer(
    { behaviour: { html: PROFILE_HTML }, manager: () => null },
    async ({ port, calls, files }) => {
      const before = fs.readFileSync(files.stateFile, "utf-8");
      const res = await request(port, {
        method: "POST",
        path: "/render",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: { url: "https://www.instagram.com/someprofile/" },
      });
      assert.equal(res.status, 200);
      assert.equal(calls.storageStateCalls, 0);
      assert.equal(fs.readFileSync(files.stateFile, "utf-8"), before);
    }
  );
});

test("auto-login: wall + autorefresh OFF returns the wall untouched, no login attempted", async () => {
  let loginCalls = 0;
  await withAutoRefreshServer(
    {
      behaviour: { html: WALL_HTML },
      manager: (files) =>
        createAutoLoginManager({
          storageStateFile: files.stateFile,
          stateFile: files.autologinStateFile,
          envFile: files.envFile,
          logger: silentLogger,
          enabled: false, // the STORAGE_STATE_AUTOREFRESH default
          loginFn: async () => {
            loginCalls += 1;
            return { cookies: [], origins: [] };
          },
        }),
    },
    async ({ port, calls }) => {
      const res = await request(port, {
        method: "POST",
        path: "/render",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: { url: "https://www.instagram.com/someprofile/", useSession: true },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true, "wall is a SUCCESS response — worker detects it");
      assert.equal(res.json.result, WALL_HTML);
      assert.equal(loginCalls, 0);
      assert.equal(calls.newContextArgs.length, 1, "no retry render without recovery");
    }
  );
});

test("auto-login: wall + enabled + stubbed login success → retried render result returned, state saved", async () => {
  const loginState = { cookies: [{ name: "sessionid", value: "fresh-after-login" }], origins: [] };
  await withAutoRefreshServer(
    {
      // First render serves the wall; the post-login retry serves content.
      behaviour: { htmlQueue: [WALL_HTML, PROFILE_HTML] },
      manager: (files) =>
        createAutoLoginManager({
          storageStateFile: files.stateFile,
          stateFile: files.autologinStateFile,
          envFile: files.envFile,
          logger: silentLogger,
          enabled: true,
          loginFn: async () => loginState,
        }),
    },
    async ({ port, calls, files }) => {
      const res = await request(port, {
        method: "POST",
        path: "/render",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: { url: "https://www.instagram.com/someprofile/", useSession: true },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.result, PROFILE_HTML, "must return the retried render, not the wall");

      // Fresh session was persisted by the manager...
      const onDisk = JSON.parse(fs.readFileSync(files.stateFile, "utf-8"));
      assert.deepEqual(onDisk, loginState);
      // ...the failure counter reset...
      assert.equal(readAutologinState(files.autologinStateFile).consecutiveFailures, 0);
      // ...and the retry happened in a fresh context seeded from that file.
      assert.equal(calls.newContextArgs.length, 2);
      assert.equal(calls.newContextArgs[1].storageState, files.stateFile);
      // Stealth applies to the retry context too.
      assert.equal(calls.initScripts.length, 2);
    }
  );
});

test("auto-login: stubbed login failure → wall HTML served, failure recorded, no credentials in logs", async () => {
  const lines = [];
  const captureLogger = pino({ level: "trace" }, { write: (line) => lines.push(line) });
  await withAutoRefreshServer(
    {
      behaviour: { html: WALL_HTML },
      logger: captureLogger,
      manager: (files) =>
        createAutoLoginManager({
          storageStateFile: files.stateFile,
          stateFile: files.autologinStateFile,
          envFile: files.envFile,
          logger: captureLogger,
          enabled: true,
          loginFn: async () => {
            throw new Error("login blew up after typing hunter2");
          },
        }),
    },
    async ({ port, calls, files }) => {
      const before = fs.readFileSync(files.stateFile, "utf-8");
      const res = await request(port, {
        method: "POST",
        path: "/render",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: { url: "https://www.instagram.com/someprofile/", useSession: true },
      });
      // Failure-mode contract: the wall comes back as a NORMAL success
      // response so the worker-side detector sees it and backs off.
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.result, WALL_HTML);

      assert.equal(readAutologinState(files.autologinStateFile).consecutiveFailures, 1);
      assert.equal(fs.readFileSync(files.stateFile, "utf-8"), before, "stale state must not be overwritten on failure");
      assert.equal(calls.newContextArgs.length, 1, "no retry render after failed recovery");

      // Acceptance criterion: credentials never appear in logs, even at
      // trace level. The capture logger saw both the request logger and the
      // manager's own logging.
      const output = lines.join("");
      assert.ok(output.length > 0);
      assert.ok(!output.includes("scraper"), "username must not be logged");
      assert.ok(!output.includes("hunter2"), "password must not be logged");
    }
  );
});

test("auto-login: rendering the login page itself never triggers recovery or write-back", async () => {
  let loginCalls = 0;
  await withAutoRefreshServer(
    {
      // The login page legitimately contains every wall marker.
      behaviour: { html: WALL_HTML },
      manager: (files) =>
        createAutoLoginManager({
          storageStateFile: files.stateFile,
          stateFile: files.autologinStateFile,
          envFile: files.envFile,
          logger: silentLogger,
          enabled: true,
          loginFn: async () => {
            loginCalls += 1;
            return { cookies: [], origins: [] };
          },
        }),
    },
    async ({ port, calls, files }) => {
      const before = fs.readFileSync(files.stateFile, "utf-8");
      const res = await request(port, {
        method: "POST",
        path: "/render",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: {
          url: "https://www.instagram.com/accounts/login/?next=%2Fsomeprofile%2F",
          useSession: true,
        },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.result, WALL_HTML);
      assert.equal(loginCalls, 0, "login-page render must not trigger auto-login");
      // Wall markers present → keep-alive also stays away (logged-out cookies).
      assert.equal(calls.storageStateCalls, 0);
      assert.equal(fs.readFileSync(files.stateFile, "utf-8"), before);
    }
  );
});

test("POST /render with useSession:false (or omitted) never reads storageState", async () => {
  // Use a non-existent path on purpose — proves we never even check.
  const stateFile = "/nonexistent/never-read.json";
  await withServer(
    {},
    async ({ port, calls }) => {
      // Default (omitted)
      const r1 = await request(port, {
        method: "POST",
        path: "/render",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: { url: "https://example.com" },
      });
      assert.equal(r1.status, 200);
      // Explicit false
      const r2 = await request(port, {
        method: "POST",
        path: "/render",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: { url: "https://example.com", useSession: false },
      });
      assert.equal(r2.status, 200);
      // Neither context request carried `storageState` — confirms we
      // never read the file when the client didn't opt in.
      for (const args of calls.newContextArgs) {
        assert.equal(args.storageState, undefined);
      }
    },
    { storageStateFile: stateFile }
  );
});
