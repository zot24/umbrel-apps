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
    gotoArgs: [],
    waitForSelectorArgs: [],
  };

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
        return behaviour.html ?? "<html><body>ok</body></html>";
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
        async newPage() {
          return makePage(behaviour.finalUrl);
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

async function withServer(behaviour, fn) {
  const { getBrowser, calls } = makeGetBrowser(behaviour);
  const app = createApp({
    getBrowser,
    token: TOKEN,
    logger: silentLogger,
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
  "loadEnvFile parses KEY=VALUE lines without overwriting existing env",
  withTokenFixture(async ({ tokenFile }) => {
    fs.writeFileSync(tokenFile, "FOO=bar\nRENDERER_TOKEN=from-file\nBAZ=qux\n");
    process.env.FOO = "preset"; // should NOT be overwritten
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
