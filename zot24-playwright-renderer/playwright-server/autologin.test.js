"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pino = require("pino");

const {
  looksLikeLoginWall,
  isLoginPageUrl,
  parseEnvFile,
  loadCredentials,
  atomicWriteFile,
  readAutologinState,
  writeAutologinState,
  base32Decode,
  totp,
  createAutoLoginManager,
  categorizeLoginError,
  LoginError,
} = require("./autologin.js");

const silentLogger = pino({ level: "silent" });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Minimal expired-session shell — mirrors what IG actually serves: a login
// form posting to /accounts/login/ajax/ plus canonical/redirect markers.
const WALL_HTML = `<!DOCTYPE html><html><head>
<link rel="canonical" href="https://www.instagram.com/accounts/login/" />
</head><body>
<form method="post" action="/accounts/login/ajax/" id="loginForm">
  <input name="username" /><input name="password" type="password" />
</form>
<a href="/accounts/login/?next=%2Fsomeprofile%2F">Log in</a>
</body></html>`;

// A populated profile snippet — must NOT trip the detector.
const PROFILE_HTML = `<!DOCTYPE html><html><head>
<meta property="og:title" content="Some Profile (@someprofile)" />
</head><body>
<main><a href="/p/AbC123xyz/"><img alt="post" /></a>
<a href="/p/DeF456uvw/"><img alt="post" /></a></main>
</body></html>`;

// Empty-but-valid page: zero posts, zero markers. The detector matching this
// would be the false positive that burns login attempts — pinned below.
const EMPTY_HTML = `<!DOCTYPE html><html><head><title>ok</title></head><body><main></main></body></html>`;

function withTmpDir(fn) {
  return async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-autologin-"));
    try {
      await fn(t, dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

// ---------------------------------------------------------------------------
// looksLikeLoginWall / isLoginPageUrl
// ---------------------------------------------------------------------------

test("looksLikeLoginWall detects the expired-session wall fixture", () => {
  assert.equal(looksLikeLoginWall(WALL_HTML), true);
});

test("looksLikeLoginWall matches each marker independently, case-insensitively", () => {
  assert.equal(looksLikeLoginWall('<form ACTION="/accounts/login/ajax/">'), true);
  assert.equal(looksLikeLoginWall('<a href="/x">go</a> /accounts/login/?next=%2Ffoo'), true);
  assert.equal(
    looksLikeLoginWall('<link href="HTTPS://WWW.INSTAGRAM.COM/accounts/login/" rel="x">'),
    true
  );
  assert.equal(looksLikeLoginWall('<a HREF="/accounts/login/">Log in</a>'), true);
});

test("looksLikeLoginWall is false on a populated profile snippet", () => {
  assert.equal(looksLikeLoginWall(PROFILE_HTML), false);
});

test("looksLikeLoginWall NEVER matches emptiness (empty-but-valid page, empty string, non-string)", () => {
  // Positive markers only — an empty page is a hydration/content problem,
  // not an expired session. False positives here would trigger pointless
  // logins and risk flagging the account.
  assert.equal(looksLikeLoginWall(EMPTY_HTML), false);
  assert.equal(looksLikeLoginWall(""), false);
  assert.equal(looksLikeLoginWall(null), false);
  assert.equal(looksLikeLoginWall(undefined), false);
});

test("isLoginPageUrl identifies login-page renders (markers there are legitimate)", () => {
  assert.equal(isLoginPageUrl("https://www.instagram.com/accounts/login/"), true);
  assert.equal(isLoginPageUrl("https://www.instagram.com/accounts/login/?next=%2Ffoo%2F"), true);
  assert.equal(isLoginPageUrl("https://www.instagram.com/accounts/login/ajax/"), true);
  assert.equal(isLoginPageUrl("https://www.instagram.com/someprofile/"), false);
  assert.equal(isLoginPageUrl("https://example.com/accounts/other"), false);
  assert.equal(isLoginPageUrl("not a url"), false);
});

// ---------------------------------------------------------------------------
// TOTP — RFC 6238 Appendix B vectors (SHA-1 rows). The appendix's SHA-1
// secret is the ASCII string "12345678901234567890", which base32-encodes to
// GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ. Vectors use 8 digits.
// ---------------------------------------------------------------------------

const RFC_SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("base32Decode round-trips the RFC 6238 SHA-1 secret", () => {
  assert.equal(base32Decode(RFC_SECRET_B32).toString("ascii"), "12345678901234567890");
});

test("base32Decode tolerates lowercase, whitespace, dashes and padding", () => {
  assert.equal(base32Decode("gezd gnbv-GY3T QOJQ gezd gnbv gy3t qojq").toString("ascii"), "12345678901234567890");
  // "MZXW6===" is the RFC 4648 vector for "foo"
  assert.equal(base32Decode("MZXW6===").toString("ascii"), "foo");
  assert.equal(base32Decode("MZXW6YTBOI======").toString("ascii"), "foobar");
});

test("base32Decode throws on invalid input", () => {
  assert.throws(() => base32Decode("AB1!"), /invalid base32/);
  assert.throws(() => base32Decode(""), /empty/);
  assert.throws(() => base32Decode(undefined), /string/);
});

test("totp matches the RFC 6238 Appendix B SHA-1 test vectors", () => {
  const vectors = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(
      totp(RFC_SECRET_B32, { timeMs: seconds * 1000, digits: 8 }),
      expected,
      `T=${seconds}`
    );
  }
});

test("totp defaults to 6 digits / 30s step (Instagram's parameters)", () => {
  const code = totp(RFC_SECRET_B32, { timeMs: 59_000 });
  assert.match(code, /^\d{6}$/);
  // 6-digit codes are the 8-digit vectors' last 6 digits (mod 10^6).
  assert.equal(code, "287082");
  // Same 30s window → same code; next window → (almost surely) different.
  assert.equal(totp(RFC_SECRET_B32, { timeMs: 31_000 }), totp(RFC_SECRET_B32, { timeMs: 59_000 }));
});

// ---------------------------------------------------------------------------
// parseEnvFile / loadCredentials
// ---------------------------------------------------------------------------

test(
  "parseEnvFile returns a map without mutating process.env",
  withTmpDir(async (_t, dir) => {
    const envFile = path.join(dir, ".env");
    fs.writeFileSync(envFile, "RENDERER_TOKEN=tok\nIG_USERNAME=scraper\nnot a line\nlower=case\n");
    const before = process.env.IG_USERNAME;
    const vars = parseEnvFile(envFile);
    assert.deepEqual(vars, { RENDERER_TOKEN: "tok", IG_USERNAME: "scraper" });
    assert.equal(process.env.IG_USERNAME, before, "must not touch process.env");
  })
);

test("parseEnvFile returns {} for a missing file", () => {
  assert.deepEqual(parseEnvFile("/nonexistent/.env"), {});
});

test(
  "loadCredentials reads the env file fresh, falls back to process.env, TOTP optional",
  withTmpDir(async (_t, dir) => {
    const envFile = path.join(dir, ".env");

    // Missing entirely → null (auto-login can't run without credentials).
    assert.equal(loadCredentials({ envFile, env: {} }), null);

    // Username alone is not enough.
    fs.writeFileSync(envFile, "IG_USERNAME=scraper\n");
    assert.equal(loadCredentials({ envFile, env: {} }), null);

    // Username + password, no TOTP secret → valid (account may have no 2FA).
    fs.writeFileSync(envFile, "IG_USERNAME=scraper\nIG_PASSWORD=hunter2\n");
    assert.deepEqual(loadCredentials({ envFile, env: {} }), {
      username: "scraper",
      password: "hunter2",
      totpSecret: undefined,
    });

    // File wins over process.env; env fills gaps the file leaves.
    const env = { IG_USERNAME: "from-env", IG_TOTP_SECRET: "GEZDGNBV" };
    assert.deepEqual(loadCredentials({ envFile, env }), {
      username: "scraper", // file beats env
      password: "hunter2",
      totpSecret: "GEZDGNBV", // env fills the gap
    });
  })
);

// ---------------------------------------------------------------------------
// Attempt-state persistence
// ---------------------------------------------------------------------------

test(
  "readAutologinState treats missing and malformed files as fresh state",
  withTmpDir(async (_t, dir) => {
    const stateFile = path.join(dir, "autologin-state.json");
    assert.deepEqual(readAutologinState(stateFile), { lastAttemptAt: 0, consecutiveFailures: 0 });

    fs.writeFileSync(stateFile, "not json {{{");
    assert.deepEqual(readAutologinState(stateFile), { lastAttemptAt: 0, consecutiveFailures: 0 });

    fs.writeFileSync(stateFile, JSON.stringify([1, 2, 3]));
    assert.deepEqual(readAutologinState(stateFile), { lastAttemptAt: 0, consecutiveFailures: 0 });

    fs.writeFileSync(stateFile, JSON.stringify({ lastAttemptAt: "nope", consecutiveFailures: 2 }));
    assert.deepEqual(readAutologinState(stateFile), { lastAttemptAt: 0, consecutiveFailures: 2 });
  })
);

test(
  "writeAutologinState writes atomically with mode 600 and no tmp leftovers",
  withTmpDir(async (_t, dir) => {
    const stateFile = path.join(dir, "autologin-state.json");
    writeAutologinState(stateFile, { lastAttemptAt: 123, consecutiveFailures: 1 });
    assert.deepEqual(readAutologinState(stateFile), { lastAttemptAt: 123, consecutiveFailures: 1 });
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
    // Atomic write = tmp file renamed over the original; nothing left behind.
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.includes(".tmp")),
      []
    );
  })
);

test(
  "atomicWriteFile cleans up its tmp file when the rename fails",
  withTmpDir(async (_t, dir) => {
    // Renaming over an existing DIRECTORY fails on every platform.
    const target = path.join(dir, "target");
    fs.mkdirSync(target);
    assert.throws(() => atomicWriteFile(target, "data"));
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.includes(".tmp")),
      [],
      "failed write must not leave credential-bearing tmp files behind"
    );
  })
);

// ---------------------------------------------------------------------------
// categorizeLoginError — the only failure detail that ever reaches the logs
// ---------------------------------------------------------------------------

test("categorizeLoginError maps errors to short credential-free categories", () => {
  assert.equal(categorizeLoginError(new LoginError("totp_required_but_no_secret")), "totp_required_but_no_secret");
  const timeoutErr = new Error("Timeout 30000ms exceeded");
  timeoutErr.name = "TimeoutError";
  assert.equal(categorizeLoginError(timeoutErr), "timeout");
  assert.equal(categorizeLoginError(new Error("net::ERR_CONNECTION_REFUSED at ...")), "network");
  assert.equal(categorizeLoginError(new Error("anything else with hunter2 inside")), "unknown");
  assert.equal(categorizeLoginError(undefined), "unknown");
});

// ---------------------------------------------------------------------------
// Manager — rate limiting, fail-stop, success reset, single-flight
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;

function managerFixture(dir, overrides = {}) {
  const storageStateFile = path.join(dir, "storageState.json");
  const stateFile = path.join(dir, "autologin-state.json");
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, "IG_USERNAME=scraper\nIG_PASSWORD=hunter2\n");
  let t = 1_000_000_000_000; // arbitrary epoch-ms base
  const clock = {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
  let loginCalls = 0;
  const manager = createAutoLoginManager({
    storageStateFile,
    stateFile,
    envFile,
    logger: silentLogger,
    enabled: true,
    now: clock.now,
    loginFn: async (args) => {
      loginCalls += 1;
      if (overrides.loginImpl) return overrides.loginImpl(args);
      return { cookies: [{ name: "sessionid", value: "fresh" }], origins: [] };
    },
    ...overrides.managerOpts,
  });
  return {
    manager,
    clock,
    storageStateFile,
    stateFile,
    envFile,
    loginCalls: () => loginCalls,
  };
}

test(
  "recover succeeds: persists storage state, resets failure counter, returns true",
  withTmpDir(async (_t, dir) => {
    const fx = managerFixture(dir);
    // Pre-seed a prior failure to prove success RESETS the counter.
    writeAutologinState(fx.stateFile, { lastAttemptAt: 0, consecutiveFailures: 2 });

    const ok = await fx.manager.recover({ browser: {}, log: silentLogger });
    assert.equal(ok, true);
    assert.equal(fx.loginCalls(), 1);

    const saved = JSON.parse(fs.readFileSync(fx.storageStateFile, "utf-8"));
    assert.equal(saved.cookies[0].name, "sessionid");
    assert.equal(fs.statSync(fx.storageStateFile).mode & 0o777, 0o600);

    const state = readAutologinState(fx.stateFile);
    assert.equal(state.consecutiveFailures, 0, "success must reset the failure counter");
    assert.equal(state.lastAttemptAt, fx.clock.now());
  })
);

test(
  "recover respects the minimum interval between attempts",
  withTmpDir(async (_t, dir) => {
    const fx = managerFixture(dir, {
      loginImpl: async () => {
        throw new LoginError("no_session_cookie");
      },
    });

    assert.equal(await fx.manager.recover({ browser: {}, log: silentLogger }), false);
    assert.equal(fx.loginCalls(), 1);

    // 1 hour later — inside the default 6h window → no attempt.
    fx.clock.advance(1 * HOUR);
    assert.equal(await fx.manager.recover({ browser: {}, log: silentLogger }), false);
    assert.equal(fx.loginCalls(), 1, "must not attempt again inside the min interval");

    // 6+ hours after the first attempt → allowed again.
    fx.clock.advance(5.5 * HOUR);
    assert.equal(await fx.manager.recover({ browser: {}, log: silentLogger }), false);
    assert.equal(fx.loginCalls(), 2);
  })
);

test(
  "recover fail-stops after max consecutive failures until the state file is deleted",
  withTmpDir(async (_t, dir) => {
    const fx = managerFixture(dir, {
      loginImpl: async () => {
        throw new LoginError("no_session_cookie");
      },
    });

    for (let i = 0; i < 3; i += 1) {
      await fx.manager.recover({ browser: {}, log: silentLogger });
      fx.clock.advance(7 * HOUR);
    }
    assert.equal(fx.loginCalls(), 3);
    assert.equal(readAutologinState(fx.stateFile).consecutiveFailures, 3);

    // Interval has passed, but the breaker is open: no further attempts.
    assert.equal(await fx.manager.recover({ browser: {}, log: silentLogger }), false);
    fx.clock.advance(100 * HOUR);
    assert.equal(await fx.manager.recover({ browser: {}, log: silentLogger }), false);
    assert.equal(fx.loginCalls(), 3, "fail-stop must refuse further attempts");

    // Operator ritual: refresh session manually, delete the state file → re-armed.
    fs.unlinkSync(fx.stateFile);
    assert.equal(await fx.manager.recover({ browser: {}, log: silentLogger }), false);
    assert.equal(fx.loginCalls(), 4, "deleting the state file re-arms auto-login");
  })
);

test(
  "recover is single-flight: concurrent calls skip while a login is in progress",
  withTmpDir(async (_t, dir) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const fx = managerFixture(dir, {
      loginImpl: async () => {
        await gate;
        return { cookies: [{ name: "sessionid", value: "fresh" }], origins: [] };
      },
    });

    const first = fx.manager.recover({ browser: {}, log: silentLogger });
    // Give the first call a tick to reach the login and set the flag.
    await new Promise((r) => setImmediate(r));
    const second = await fx.manager.recover({ browser: {}, log: silentLogger });
    assert.equal(second, false, "concurrent request must skip and serve its wall HTML");
    assert.equal(fx.loginCalls(), 1);

    release();
    assert.equal(await first, true);
  })
);

test(
  "recover refuses to run without credentials and records nothing",
  withTmpDir(async (_t, dir) => {
    const fx = managerFixture(dir);
    fs.writeFileSync(fx.envFile, "RENDERER_TOKEN=tok\n"); // no IG_* lines
    const prevUser = process.env.IG_USERNAME;
    const prevPass = process.env.IG_PASSWORD;
    delete process.env.IG_USERNAME;
    delete process.env.IG_PASSWORD;
    try {
      assert.equal(await fx.manager.recover({ browser: {}, log: silentLogger }), false);
      assert.equal(fx.loginCalls(), 0);
      // No attempt was made, so nothing should be burned against the rate limit.
      assert.deepEqual(readAutologinState(fx.stateFile), {
        lastAttemptAt: 0,
        consecutiveFailures: 0,
      });
    } finally {
      if (prevUser !== undefined) process.env.IG_USERNAME = prevUser;
      if (prevPass !== undefined) process.env.IG_PASSWORD = prevPass;
    }
  })
);

test(
  "recover is gated on STORAGE_STATE_AUTOREFRESH (opt-in, read fresh from the env file)",
  withTmpDir(async (_t, dir) => {
    const storageStateFile = path.join(dir, "storageState.json");
    const stateFile = path.join(dir, "autologin-state.json");
    const envFile = path.join(dir, ".env");
    fs.writeFileSync(envFile, "IG_USERNAME=scraper\nIG_PASSWORD=hunter2\n");
    let loginCalls = 0;
    // No `enabled` override → resolves from the env file / process.env.
    const manager = createAutoLoginManager({
      storageStateFile,
      stateFile,
      envFile,
      logger: silentLogger,
      loginFn: async () => {
        loginCalls += 1;
        return { cookies: [{ name: "sessionid", value: "v" }], origins: [] };
      },
    });

    const prev = process.env.STORAGE_STATE_AUTOREFRESH;
    delete process.env.STORAGE_STATE_AUTOREFRESH;
    try {
      // Default: off (opt-in is an acceptance criterion of #119).
      assert.equal(await manager.recover({ browser: {}, log: silentLogger }), false);
      assert.equal(loginCalls, 0);

      // Operator appends the flag to /data/.env — picked up WITHOUT restart.
      fs.appendFileSync(envFile, "STORAGE_STATE_AUTOREFRESH=true\n");
      assert.equal(await manager.recover({ browser: {}, log: silentLogger }), true);
      assert.equal(loginCalls, 1);
    } finally {
      if (prev !== undefined) process.env.STORAGE_STATE_AUTOREFRESH = prev;
    }
  })
);

test(
  "recover tolerates a malformed state file (treated as fresh)",
  withTmpDir(async (_t, dir) => {
    const fx = managerFixture(dir);
    fs.writeFileSync(fx.stateFile, "{{{corrupt");
    assert.equal(await fx.manager.recover({ browser: {}, log: silentLogger }), true);
    assert.equal(fx.loginCalls(), 1);
    assert.equal(readAutologinState(fx.stateFile).consecutiveFailures, 0);
  })
);

test(
  "recover never logs credential material, even at trace level",
  withTmpDir(async (_t, dir) => {
    const lines = [];
    const captureLogger = pino({ level: "trace" }, { write: (line) => lines.push(line) });
    const fx = managerFixture(dir, {
      loginImpl: async () => {
        // Worst case: a raw error whose message embeds typed input.
        throw new Error("typed hunter2 into input then saw sessionid=abc123 cookie");
      },
    });

    assert.equal(await fx.manager.recover({ browser: {}, log: captureLogger }), false);
    const output = lines.join("");
    assert.ok(output.length > 0, "expected some log output");
    assert.ok(!output.includes("scraper"), "username must not appear in logs");
    assert.ok(!output.includes("hunter2"), "password must not appear in logs");
    assert.ok(!output.includes("sessionid=abc123"), "cookie material must not appear in logs");
    assert.match(output, /unknown/, "category should be logged instead");
  })
);
