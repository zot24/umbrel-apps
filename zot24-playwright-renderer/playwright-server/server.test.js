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
} = require("./server.js");

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
