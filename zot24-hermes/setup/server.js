const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const QRCode = require("qrcode");

const VOLUME_DIR = process.env.CONFIG_DIR || "/config";
const CONFIG_DIR = path.join(VOLUME_DIR, ".hermes");
const WEB_CONTAINER = process.env.WEB_CONTAINER || "zot24-hermes_web_1";
const PORT = parseInt(process.env.SETUP_PORT || "8080");
const SETUP_SENTINEL = path.join(VOLUME_DIR, ".setup-complete");
const ENV_FILE = path.join(CONFIG_DIR, ".env");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.yaml");
const STATE_FILE = path.join(CONFIG_DIR, "gateway_state.json");
const STATE_DB = path.join(CONFIG_DIR, "state.db");
const SKILLS_DIR = path.join(CONFIG_DIR, "skills");
const MEMORIES_DIR = path.join(CONFIG_DIR, "memories");
const PROFILES_DIR = path.join(CONFIG_DIR, "profiles");

// Pre-load static files with version injection
const APP_VERSION = process.env.APP_VERSION || "dev";
const WIZARD_HTML = fs.readFileSync(path.join(__dirname, "wizard.html"), "utf8").replaceAll("__APP_VERSION__", APP_VERSION);
const DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf8").replaceAll("__APP_VERSION__", APP_VERSION);
const AVATARS_DIR = path.join(__dirname, "avatars");

// ── SQLite helpers ──────────────────────────────────────────────────────────

let Database;
try {
  Database = require("better-sqlite3");
} catch (e) {
  console.warn("better-sqlite3 not available, dashboard endpoints will return empty data");
}

function openStateDb(profileName) {
  const dbPath = profileName && profileName !== "all"
    ? path.join(getProfileDir(profileName), "state.db")
    : STATE_DB;
  if (!Database || !fs.existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("journal_mode = WAL");
    return db;
  } catch (e) {
    console.error("Failed to open state.db:", e.message);
    return null;
  }
}

// ── Model pricing (subset of hermes-agent usage_pricing.py) ─────────────────

const MODEL_PRICING = {
  "claude-opus-4-20250514":       { input: 15.00, output: 75.00, cache_read: 1.50, cache_write: 18.75 },
  "claude-sonnet-4-20250514":     { input: 3.00,  output: 15.00, cache_read: 0.30, cache_write: 3.75 },
  "claude-3-5-sonnet-20241022":   { input: 3.00,  output: 15.00, cache_read: 0.30, cache_write: 3.75 },
  "claude-3-5-haiku-20241022":    { input: 0.80,  output: 4.00,  cache_read: 0.08, cache_write: 1.00 },
  "claude-3-opus-20240229":       { input: 15.00, output: 75.00, cache_read: 1.50, cache_write: 18.75 },
  "claude-3-haiku-20240307":      { input: 0.25,  output: 1.25,  cache_read: 0.03, cache_write: 0.30 },
  "gpt-4o":                       { input: 2.50,  output: 10.00, cache_read: 1.25 },
  "gpt-4o-mini":                  { input: 0.15,  output: 0.60,  cache_read: 0.075 },
  "gpt-4.1":                      { input: 2.00,  output: 8.00,  cache_read: 0.50 },
  "gpt-4.1-mini":                 { input: 0.40,  output: 1.60,  cache_read: 0.10 },
  "gpt-4.1-nano":                 { input: 0.10,  output: 0.40,  cache_read: 0.025 },
  "o3":                           { input: 10.00, output: 40.00, cache_read: 2.50 },
  "o3-mini":                      { input: 1.10,  output: 4.40,  cache_read: 0.55 },
  "deepseek-chat":                { input: 0.27,  output: 1.10,  cache_read: 0.07 },
  "deepseek-reasoner":            { input: 0.55,  output: 2.19,  cache_read: 0.14 },
};

function getModelPricing(modelName) {
  if (!modelName) return null;
  // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-20250514" → "claude-sonnet-4-20250514")
  const short = modelName.includes("/") ? modelName.split("/").pop() : modelName;
  return MODEL_PRICING[short] || null;
}

function estimateCost(session) {
  // Use stored cost if available
  if (session.estimated_cost_usd != null && session.estimated_cost_usd > 0) {
    return session.estimated_cost_usd;
  }
  const pricing = getModelPricing(session.model);
  if (!pricing) return 0;
  const M = 1_000_000;
  return (
    ((session.input_tokens || 0) * pricing.input / M) +
    ((session.output_tokens || 0) * pricing.output / M) +
    ((session.cache_read_tokens || 0) * (pricing.cache_read || 0) / M) +
    ((session.cache_write_tokens || 0) * (pricing.cache_write || 0) / M)
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isConfigured() {
  return fs.existsSync(SETUP_SENTINEL);
}

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function readGatewayState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Error reading gateway state:", e.message);
  }
  return null;
}

function readCurrentConfig() {
  const config = {};
  try {
    if (fs.existsSync(ENV_FILE)) {
      const content = fs.readFileSync(ENV_FILE, "utf8");
      content.split("\n").forEach((line) => {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (match) {
          config[match[1]] = match[2];
        }
      });
    }
  } catch (e) {
    console.error("Error reading config:", e.message);
  }
  return config;
}

function maskSecret(value) {
  if (!value || value.length < 8) return "****";
  return value.slice(0, 4) + "****" + value.slice(-4);
}

function writeEnvFile(config) {
  const lines = [
    "# Hermes Agent Configuration",
    "# Generated by hermes-umbrel setup wizard",
    "",
  ];

  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined && value !== null && value !== "") {
      lines.push(`${key}=${value}`);
    }
  }

  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n", { mode: 0o600 });
}

function writeConfigYaml(config) {
  const model = config.HERMES_MODEL || "anthropic/claude-sonnet-4-20250514";
  const provider = config.HERMES_PROVIDER || "auto";

  let platforms = "";

  if (config.TELEGRAM_BOT_TOKEN) {
    platforms += `
    telegram:
      enabled: true`;
    if (config.TELEGRAM_HOME_CHAT_ID) {
      platforms += `
      home_channel: "${config.TELEGRAM_HOME_CHAT_ID}"`;
    }
  }

  if (config.WHATSAPP_ENABLED === "true") {
    platforms += `
    whatsapp:
      enabled: true`;
  }

  const yaml = `# Hermes Agent Configuration
# Generated by hermes-umbrel setup wizard

model:
  default: "${model}"
  provider: "${provider}"

gateway:
  streaming: true
  platforms:${platforms || "\n    # No platforms configured"}

session_reset:
  mode: both
  at_hour: 4
  idle_minutes: 1440

update:
  checkOnStart: false

context_compression:
  enabled: true

memory:
  enabled: true
`;

  fs.writeFileSync(CONFIG_FILE, yaml, { mode: 0o600 });
}

function restartWebContainer() {
  try {
    const socketPath = "/var/run/docker.sock";
    if (!fs.existsSync(socketPath)) {
      console.error("Docker socket not available");
      return false;
    }

    // Use curl to talk to Docker socket
    execSync(
      `curl -s --unix-socket ${socketPath} -X POST "http://localhost/containers/${WEB_CONTAINER}/restart?t=10"`,
      { timeout: 30000 }
    );
    console.log(`Restarted container: ${WEB_CONTAINER}`);
    return true;
  } catch (e) {
    console.error("Failed to restart web container:", e.message);
    return false;
  }
}

// ── Profile helpers ──────────────────────────────────────────────────────────

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,19}$/;
const COMMS_FILE = path.join(CONFIG_DIR, "agent-comms.json");
const BASE_API_PORT = 8642;
const BASE_WEBHOOK_PORT = 8644;

function getProfileDir(name) {
  if (name === "default") return CONFIG_DIR;
  return path.join(PROFILES_DIR, name);
}

function readProfileEnv(profileDir) {
  const env = {};
  try {
    const envFile = path.join(profileDir, ".env");
    if (fs.existsSync(envFile)) {
      fs.readFileSync(envFile, "utf8").split("\n").forEach(l => {
        const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) env[m[1]] = m[2];
      });
    }
  } catch (e) {}
  return env;
}

function readProfileConfig(profileDir) {
  const result = { model: null, provider: null, platforms: [], apiPort: null, webhookPort: null };
  try {
    const env = readProfileEnv(profileDir);
    if (env.HERMES_MODEL) result.model = env.HERMES_MODEL;
    if (env.HERMES_PROVIDER) result.provider = env.HERMES_PROVIDER;
    if (env.TELEGRAM_BOT_TOKEN) result.platforms.push("telegram");
    if (env.WHATSAPP_ENABLED === "true") result.platforms.push("whatsapp");
    if (env.DISCORD_BOT_TOKEN) result.platforms.push("discord");
    if (env.SLACK_BOT_TOKEN) result.platforms.push("slack");
    if (env.API_SERVER_PORT) result.apiPort = parseInt(env.API_SERVER_PORT);
    if (env.WEBHOOK_PORT) result.webhookPort = parseInt(env.WEBHOOK_PORT);
    // Fallback to config.yaml for model
    if (!result.model) {
      const cfgFile = path.join(profileDir, "config.yaml");
      if (fs.existsSync(cfgFile)) {
        const yaml = fs.readFileSync(cfgFile, "utf8");
        const modelMatch = yaml.match(/default:\s*"?([^"\n]+)"?/);
        if (modelMatch) result.model = modelMatch[1].trim();
        const provMatch = yaml.match(/provider:\s*"?([^"\n]+)"?/);
        if (provMatch && !result.provider) result.provider = provMatch[1].trim();
      }
    }
  } catch (e) {}
  return result;
}

function readProfileGatewayState(profileDir) {
  try {
    const stateFile = path.join(profileDir, "gateway_state.json");
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    }
  } catch (e) {}
  return null;
}

function listProfiles() {
  const profiles = [];

  // Default profile
  const defaultConfig = readProfileConfig(CONFIG_DIR);
  const defaultState = readProfileGatewayState(CONFIG_DIR);
  profiles.push({
    name: "default",
    ...defaultConfig,
    gateway: defaultState?.gateway_state || "unknown",
    pid: defaultState?.pid || null,
  });

  // Named profiles
  try {
    if (fs.existsSync(PROFILES_DIR)) {
      for (const name of fs.readdirSync(PROFILES_DIR)) {
        const dir = path.join(PROFILES_DIR, name);
        if (!fs.statSync(dir).isDirectory()) continue;
        const config = readProfileConfig(dir);
        const state = readProfileGatewayState(dir);
        profiles.push({
          name,
          ...config,
          gateway: state?.gateway_state || "stopped",
          pid: state?.pid || null,
        });
      }
    }
  } catch (e) {}

  return profiles;
}

function execInWebContainer(cmd) {
  const socketPath = "/var/run/docker.sock";
  if (!fs.existsSync(socketPath)) throw new Error("Docker socket not available");
  // Create exec instance
  const createPayload = JSON.stringify({
    AttachStdout: true, AttachStderr: true, Detach: false,
    Cmd: ["sh", "-c", cmd],
  });
  const createResp = execSync(
    `curl -s --unix-socket ${socketPath} -X POST ` +
    `-H "Content-Type: application/json" ` +
    `-d '${createPayload.replace(/'/g, "'\\''")}' ` +
    `"http://localhost/containers/${WEB_CONTAINER}/exec"`,
    { encoding: "utf8", timeout: 10000 }
  );
  const execId = JSON.parse(createResp).Id;
  if (!execId) throw new Error("Failed to create exec instance");
  // Start and wait
  execSync(
    `curl -s --unix-socket ${socketPath} -X POST ` +
    `-H "Content-Type: application/json" ` +
    `-d '{"Detach":false}' ` +
    `"http://localhost/exec/${execId}/start"`,
    { timeout: 10000 }
  );
}

function assignProfilePorts(name) {
  if (name === "default") return { apiPort: BASE_API_PORT, webhookPort: BASE_WEBHOOK_PORT };
  // Stable hash of profile name → unique port offset (avoids collisions when profiles are added/removed)
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  const offset = (Math.abs(hash) % 90 + 1) * 10; // 10-900 range, avoids 0 (default)
  return { apiPort: BASE_API_PORT + offset, webhookPort: BASE_WEBHOOK_PORT + offset };
}

function getProfileApiPort(name) {
  const profileDir = getProfileDir(name);
  const env = readProfileEnv(profileDir);
  return parseInt(env.API_SERVER_PORT || BASE_API_PORT);
}

function readCommsLog() {
  try {
    if (fs.existsSync(COMMS_FILE)) return JSON.parse(fs.readFileSync(COMMS_FILE, "utf8"));
  } catch (e) {}
  return [];
}

function appendCommsLog(entry) {
  const log = readCommsLog();
  log.push(entry);
  // Keep last 200 entries
  const trimmed = log.slice(-200);
  fs.writeFileSync(COMMS_FILE, JSON.stringify(trimmed, null, 2));
}

async function sendMessageToProfile(name, input, fromName) {
  const port = getProfileApiPort(name);
  const start = Date.now();
  const resp = await fetch(`http://${WEB_CONTAINER}:${port}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  const data = await resp.json();
  const duration = Date.now() - start;
  // Extract text from Responses API output
  let responseText = "";
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === "output_text" || c.type === "text") responseText += (responseText ? "\n" : "") + (c.text || "");
        }
      } else if (typeof item === "string") {
        responseText += (responseText ? "\n" : "") + item;
      }
    }
  }
  if (!responseText) responseText = typeof data.output === "string" ? data.output : JSON.stringify(data);

  appendCommsLog({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    from: fromName || "dashboard",
    to: name,
    input,
    response: typeof responseText === "string" ? responseText.slice(0, 2000) : String(responseText).slice(0, 2000),
    timestamp: Math.floor(Date.now() / 1000),
    duration_ms: duration,
  });

  return { response: responseText, duration_ms: duration };
}

// Translate a path from the setup container's view (/config/...) to the web container's view (/data/...)
function webContainerPath(localPath) {
  return localPath.replace(/^\/config\//, "/data/");
}

function startProfileGateway(name) {
  const profileDir = getProfileDir(name);
  const webProfileDir = webContainerPath(profileDir);
  const { apiPort, webhookPort } = assignProfilePorts(name);

  // Persist port assignments in the profile's .env so getProfileApiPort() can find them
  const envFile = path.join(profileDir, ".env");
  let envContent = "";
  try { if (fs.existsSync(envFile)) envContent = fs.readFileSync(envFile, "utf8"); } catch (e) {}
  // Update or append port settings
  const setEnvVar = (content, key, val) => {
    const re = new RegExp(`^${key}=.*$`, "m");
    return re.test(content) ? content.replace(re, `${key}=${val}`) : content.trimEnd() + `\n${key}=${val}`;
  };
  envContent = setEnvVar(envContent, "API_SERVER_PORT", apiPort);
  envContent = setEnvVar(envContent, "WEBHOOK_PORT", webhookPort);
  fs.writeFileSync(envFile, envContent.trim() + "\n");

  const cmd = `HERMES_HOME=${webProfileDir} API_SERVER_ENABLED=true API_SERVER_HOST=0.0.0.0 API_SERVER_PORT=${apiPort} WEBHOOK_PORT=${webhookPort} /app/venv/bin/hermes gateway run --replace &`;
  // Create exec instance and start it
  const socketPath = "/var/run/docker.sock";
  const createPayload = JSON.stringify({
    AttachStdout: false, AttachStderr: false, Detach: true, Tty: false,
    Cmd: ["sh", "-c", cmd],
  });
  const createResp = execSync(
    `curl -s --unix-socket ${socketPath} -X POST ` +
    `-H "Content-Type: application/json" ` +
    `-d '${createPayload.replace(/'/g, "'\\''")}' ` +
    `"http://localhost/containers/${WEB_CONTAINER}/exec"`,
    { encoding: "utf8", timeout: 10000 }
  );
  const execId = JSON.parse(createResp).Id;
  if (!execId) throw new Error("Failed to create exec instance");
  execSync(
    `curl -s --unix-socket ${socketPath} -X POST ` +
    `-H "Content-Type: application/json" ` +
    `-d '{"Detach":true}' ` +
    `"http://localhost/exec/${execId}/start"`,
    { timeout: 10000 }
  );
  console.log(`Started gateway for profile: ${name}`);
}

function stopProfileGateway(name) {
  const profileDir = getProfileDir(name);
  if (name === "default") {
    throw new Error("Cannot stop the default profile gateway");
  }
  // Kill the gateway process for this profile using multiple strategies
  const webProfileDir = webContainerPath(profileDir);
  const port = getProfileApiPort(name);
  // Strategy 1: Find PID from gateway_state.json
  // Strategy 2: Kill by HERMES_HOME in /proc/*/environ
  // Strategy 3: Kill process listening on the profile's API port
  const cmd = [
    // Read PID from state file and kill it
    `PID=$(python3 -c "import json; print(json.load(open('${webProfileDir}/gateway_state.json')).get('pid',''))" 2>/dev/null) && [ -n "$PID" ] && kill "$PID" 2>/dev/null`,
    // Kill by matching HERMES_HOME in process environment
    `for p in /proc/[0-9]*/environ; do grep -qz "HERMES_HOME=${webProfileDir}" "$p" 2>/dev/null && kill $(echo "$p" | cut -d/ -f3) 2>/dev/null; done`,
    // Kill by API port
    `fuser -k ${port}/tcp 2>/dev/null`,
    // Clean up state file
    `rm -f "${webProfileDir}/gateway_state.json"`,
  ].join("; ");
  const socketPath = "/var/run/docker.sock";
  const createPayload = JSON.stringify({
    AttachStdout: true, AttachStderr: true, Detach: false, Tty: false,
    Cmd: ["sh", "-c", cmd],
  });
  const createResp = execSync(
    `curl -s --unix-socket ${socketPath} -X POST ` +
    `-H "Content-Type: application/json" ` +
    `-d '${createPayload.replace(/'/g, "'\\''")}' ` +
    `"http://localhost/containers/${WEB_CONTAINER}/exec"`,
    { encoding: "utf8", timeout: 10000 }
  );
  const execId = JSON.parse(createResp).Id;
  if (execId) {
    execSync(
      `curl -s --unix-socket ${socketPath} -X POST ` +
      `-H "Content-Type: application/json" ` +
      `-d '{"Detach":false}' ` +
      `"http://localhost/exec/${execId}/start"`,
      { timeout: 10000 }
    );
  }
  // Clear gateway state
  const stateFile = path.join(profileDir, "gateway_state.json");
  try { fs.unlinkSync(stateFile); } catch (e) {}
  console.log(`Stopped gateway for profile: ${name}`);
}

// ── Telegram API helpers ─────────────────────────────────────────────────────

async function telegramGetMe(token) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  return resp.json();
}

async function telegramSendMessage(token, chatId, text) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return resp.json();
}

// ── Request body parser ──────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// ── Route handlers ───────────────────────────────────────────────────────────

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── Static pages ──
  if (req.method === "GET" && url.pathname === "/") {
    sendHtml(res, isConfigured() ? DASHBOARD_HTML : WIZARD_HTML);
    return;
  }

  if (req.method === "GET" && url.pathname === "/dashboard") {
    sendHtml(res, DASHBOARD_HTML.replace('/*__AUTOOPEN__*/', 'window.__DASHBOARD_AUTOOPEN__=true;'));
    return;
  }

  if (req.method === "GET" && url.pathname === "/setup") {
    sendHtml(res, WIZARD_HTML);
    return;
  }

  // ── Static: Serve avatar PNGs ──
  if (req.method === "GET" && url.pathname.startsWith("/avatars/")) {
    const filename = url.pathname.replace("/avatars/", "");
    if (!/^[a-z0-9_-]+\.png$/.test(filename)) {
      res.writeHead(404); res.end("Not Found"); return;
    }
    const filePath = path.join(AVATARS_DIR, filename);
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
          "Content-Length": data.length,
        });
        res.end(data);
      } else {
        res.writeHead(404); res.end("Not Found");
      }
    } catch (e) {
      res.writeHead(500); res.end("Error");
    }
    return;
  }

  // ── API: Get current config (masked) ──
  if (req.method === "GET" && url.pathname === "/api/setup") {
    const config = readCurrentConfig();
    const masked = {};
    for (const [key, value] of Object.entries(config)) {
      masked[key] = key.includes("KEY") || key.includes("TOKEN") || key.includes("SECRET")
        ? maskSecret(value)
        : value;
    }
    sendJson(res, 200, { configured: isConfigured(), config: masked });
    return;
  }

  // ── API: Save setup ──
  if (req.method === "POST" && url.pathname === "/api/setup") {
    try {
      const data = await parseBody(req);

      // Validate: need at least one LLM key
      const hasLlmKey = data.OPENROUTER_API_KEY || data.ANTHROPIC_API_KEY ||
                        data.OLLAMA_BASE_URL || data.OPENAI_BASE_URL ||
                        data.GLM_API_KEY || data.KIMI_API_KEY ||
                        data.MINIMAX_API_KEY || data.MINIMAX_CN_API_KEY ||
                        data.DEEPSEEK_API_KEY || data.DASHSCOPE_API_KEY ||
                        data.OPENCODE_ZEN_API_KEY || data.OPENCODE_GO_API_KEY ||
                        data.HF_TOKEN || data.GITHUB_TOKEN ||
                        data.AI_GATEWAY_API_KEY;
      if (!hasLlmKey) {
        sendJson(res, 400, { error: "At least one LLM provider API key is required" });
        return;
      }

      // Validate: need at least one platform
      const hasPlatform = data.TELEGRAM_BOT_TOKEN || data.WHATSAPP_ENABLED === "true";
      if (!hasPlatform) {
        sendJson(res, 400, { error: "At least one messaging platform must be configured" });
        return;
      }

      ensureConfigDir();

      // Build the env config
      const envConfig = {};
      const envKeys = [
        "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY",
        "GLM_API_KEY", "KIMI_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY",
        "DEEPSEEK_API_KEY", "DASHSCOPE_API_KEY",
        "OPENCODE_ZEN_API_KEY", "OPENCODE_GO_API_KEY",
        "HF_TOKEN", "GITHUB_TOKEN", "AI_GATEWAY_API_KEY",
        "OPENAI_BASE_URL", "OPENAI_API_KEY",
        "OLLAMA_BASE_URL", "HERMES_MODEL", "HERMES_PROVIDER",
        "TELEGRAM_BOT_TOKEN", "TELEGRAM_HOME_CHAT_ID",
        "WHATSAPP_ENABLED", "WHATSAPP_ALLOWED_USERS", "WHATSAPP_MODE",
        "DISCORD_BOT_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN",
      ];

      for (const key of envKeys) {
        if (data[key]) {
          envConfig[key] = data[key];
        }
      }

      // WhatsApp: default to self-chat mode (only your own messages trigger the bot)
      if (envConfig.WHATSAPP_ENABLED === "true" && !envConfig.WHATSAPP_MODE) {
        envConfig.WHATSAPP_MODE = "self-chat";
      }

      // Set HERMES_REGEN_CONFIG to force config regeneration
      envConfig.HERMES_REGEN_CONFIG = "true";

      writeEnvFile(envConfig);
      writeConfigYaml(envConfig);

      // Mark as configured
      fs.writeFileSync(SETUP_SENTINEL, new Date().toISOString(), { mode: 0o644 });

      // Restart the web container
      const restarted = restartWebContainer();

      sendJson(res, 200, {
        success: true,
        restarted,
        message: restarted
          ? "Configuration saved. Gateway is restarting..."
          : "Configuration saved. Please restart the app manually.",
      });
    } catch (e) {
      console.error("Setup error:", e);
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: Test Telegram ──
  if (req.method === "POST" && url.pathname === "/api/test-telegram") {
    try {
      const data = await parseBody(req);
      const { token, chatId } = data;

      if (!token || !chatId) {
        sendJson(res, 400, { error: "Bot token and chat ID are required" });
        return;
      }

      // First verify the token
      const me = await telegramGetMe(token);
      if (!me.ok) {
        sendJson(res, 400, {
          error: `Invalid bot token: ${me.description || "unknown error"}`,
        });
        return;
      }

      // Send test message
      const result = await telegramSendMessage(
        token,
        chatId,
        `Hermes is connected! Your AI agent is ready to chat.\n\nBot: @${me.result.username}`
      );

      if (!result.ok) {
        sendJson(res, 400, {
          error: `Failed to send message: ${result.description || "unknown error"}. Make sure you've started a chat with the bot and the chat ID is correct.`,
        });
        return;
      }

      sendJson(res, 200, {
        success: true,
        botName: me.result.first_name,
        botUsername: me.result.username,
      });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: WhatsApp QR code ──
  // The bridge writes the raw QR string to whatsapp/qr.txt on the shared volume.
  // Once paired, it deletes the file. The status page polls this endpoint.
  // Returns a data URL (base64 PNG) so no client-side QR library is needed.
  if (req.method === "GET" && url.pathname === "/api/whatsapp-qr") {
    const qrFile = path.join(CONFIG_DIR, "whatsapp", "qr.txt");
    const sessionFile = path.join(CONFIG_DIR, "whatsapp", "session", "creds.json");
    const paired = fs.existsSync(sessionFile);

    if (paired) {
      sendJson(res, 200, { status: "paired", qrImage: null });
      return;
    }

    try {
      if (fs.existsSync(qrFile)) {
        const qr = fs.readFileSync(qrFile, "utf8").trim();
        const dataUrl = await QRCode.toDataURL(qr, {
          width: 280,
          margin: 2,
          color: { dark: "#000000", light: "#ffffff" },
        });
        sendJson(res, 200, { status: "pending", qrImage: dataUrl });
      } else {
        sendJson(res, 200, { status: "waiting", qrImage: null, message: "Waiting for WhatsApp bridge to generate QR code..." });
      }
    } catch (e) {
      console.error("QR generation error:", e.message);
      sendJson(res, 200, { status: "waiting", qrImage: null, message: "Waiting for QR code..." });
    }
    return;
  }

  // ── API: Gateway status ──
  if (req.method === "GET" && url.pathname === "/api/status") {
    const state = readGatewayState();
    const config = readCurrentConfig();

    const platforms = [];
    if (config.TELEGRAM_BOT_TOKEN) {
      platforms.push({ name: "Telegram", enabled: true });
    }
    if (config.WHATSAPP_ENABLED === "true") {
      const whatsappAuth = path.join(CONFIG_DIR, "whatsapp", "session", "creds.json");
      const qrFile = path.join(CONFIG_DIR, "whatsapp", "qr.txt");
      platforms.push({
        name: "WhatsApp",
        enabled: true,
        paired: fs.existsSync(whatsappAuth),
        hasQr: fs.existsSync(qrFile),
      });
    }
    if (config.DISCORD_BOT_TOKEN) {
      platforms.push({ name: "Discord", enabled: true });
    }
    if (config.SLACK_BOT_TOKEN) {
      platforms.push({ name: "Slack", enabled: true });
    }

    sendJson(res, 200, {
      configured: isConfigured(),
      gateway: state,
      platforms,
      model: config.HERMES_MODEL || "anthropic/claude-sonnet-4-20250514",
      provider: config.HERMES_PROVIDER || "auto",
    });
    return;
  }

  // ── API: Health check ──
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, configured: isConfigured() });
    return;
  }

  // ── API: Restart gateway ──
  if (req.method === "POST" && url.pathname === "/api/restart") {
    const restarted = restartWebContainer();
    sendJson(res, 200, { success: restarted });
    return;
  }

  // ── API: Relink WhatsApp (delete session, restart to get new QR) ──
  if (req.method === "POST" && url.pathname === "/api/whatsapp-relink") {
    try {
      const sessionDir = path.join(CONFIG_DIR, "whatsapp", "session");
      const qrFile = path.join(CONFIG_DIR, "whatsapp", "qr.txt");

      // Delete session credentials
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        console.log("Deleted WhatsApp session for relinking");
      }
      // Delete stale QR file
      if (fs.existsSync(qrFile)) {
        fs.unlinkSync(qrFile);
      }

      // Restart the web container so bridge generates a new QR
      const restarted = restartWebContainer();

      sendJson(res, 200, {
        success: true,
        restarted,
        message: restarted
          ? "WhatsApp session cleared. A new QR code will appear shortly."
          : "Session cleared. Please restart the app manually.",
      });
    } catch (e) {
      console.error("WhatsApp relink error:", e.message);
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: Disconnect a platform ──
  if (req.method === "POST" && url.pathname === "/api/disconnect") {
    try {
      const data = await parseBody(req);
      const { platform } = data;
      if (!platform) {
        sendJson(res, 400, { error: "Platform is required" });
        return;
      }

      // Keys to remove per platform
      const platformKeys = {
        telegram: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_HOME_CHAT_ID"],
        whatsapp: ["WHATSAPP_ENABLED", "WHATSAPP_ALLOWED_USERS", "WHATSAPP_MODE"],
      };

      const keysToRemove = platformKeys[platform];
      if (!keysToRemove) {
        sendJson(res, 400, { error: `Unknown platform: ${platform}` });
        return;
      }

      // Read current env, remove platform keys, write back
      const config = readCurrentConfig();
      for (const key of keysToRemove) {
        delete config[key];
      }
      writeEnvFile(config);
      writeConfigYaml(config);

      // WhatsApp: also delete session and QR
      if (platform === "whatsapp") {
        const sessionDir = path.join(CONFIG_DIR, "whatsapp", "session");
        const qrFile = path.join(CONFIG_DIR, "whatsapp", "qr.txt");
        if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
        if (fs.existsSync(qrFile)) fs.unlinkSync(qrFile);
      }

      const restarted = restartWebContainer();
      sendJson(res, 200, { success: true, restarted });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: List pending pairing requests ──
  if (req.method === "GET" && url.pathname === "/api/pairing") {
    const pairingDir = path.join(CONFIG_DIR, "pairing");
    const results = [];
    try {
      if (fs.existsSync(pairingDir)) {
        const files = fs.readdirSync(pairingDir).filter(f => f.endsWith("-pending.json"));
        for (const file of files) {
          const platform = file.replace("-pending.json", "");
          const pending = JSON.parse(fs.readFileSync(path.join(pairingDir, file), "utf8"));
          const now = Date.now() / 1000;
          for (const [code, info] of Object.entries(pending)) {
            // Skip expired codes (1 hour TTL)
            if (now - info.created_at > 3600) continue;
            results.push({
              platform,
              code,
              user_id: info.user_id,
              user_name: info.user_name || "",
              age_minutes: Math.floor((now - info.created_at) / 60),
            });
          }
        }
      }
    } catch (e) {
      console.error("Error reading pairing data:", e.message);
    }
    sendJson(res, 200, { pending: results });
    return;
  }

  // ── API: Approve a pairing code ──
  if (req.method === "POST" && url.pathname === "/api/pairing/approve") {
    try {
      const data = await parseBody(req);
      const { platform, code } = data;
      if (!platform || !code) {
        sendJson(res, 400, { error: "Platform and code are required" });
        return;
      }

      const pairingDir = path.join(CONFIG_DIR, "pairing");
      const pendingFile = path.join(pairingDir, `${platform}-pending.json`);
      const approvedFile = path.join(pairingDir, `${platform}-approved.json`);

      if (!fs.existsSync(pendingFile)) {
        sendJson(res, 404, { error: "No pending requests for this platform" });
        return;
      }

      const pending = JSON.parse(fs.readFileSync(pendingFile, "utf8"));
      const upperCode = code.toUpperCase().trim();

      if (!pending[upperCode]) {
        sendJson(res, 404, { error: "Code not found or expired" });
        return;
      }

      const entry = pending[upperCode];
      delete pending[upperCode];
      fs.writeFileSync(pendingFile, JSON.stringify(pending, null, 2), { mode: 0o600 });

      // Add to approved list
      let approved = {};
      try {
        if (fs.existsSync(approvedFile)) {
          approved = JSON.parse(fs.readFileSync(approvedFile, "utf8"));
        }
      } catch (e) {}

      approved[entry.user_id] = {
        user_name: entry.user_name || "",
        approved_at: Date.now() / 1000,
        approved_via: "umbrel-ui",
      };
      fs.writeFileSync(approvedFile, JSON.stringify(approved, null, 2), { mode: 0o600 });

      // Send confirmation message to the user via the gateway's bridge
      try {
        const webHost = process.env.WEB_CONTAINER || "zot24-hermes_web_1";
        // WhatsApp bridge runs on port 3000 inside the web container
        if (data.platform === "whatsapp") {
          await fetch(`http://${webHost}:3000/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chatId: entry.user_id,
              message: `You're approved! Welcome to Hermes Agent. You can now chat with me anytime.`,
            }),
          }).catch(() => {});
        }
        // Telegram: use Bot API directly
        if (data.platform === "telegram") {
          const tgToken = readCurrentConfig().TELEGRAM_BOT_TOKEN;
          if (tgToken) {
            await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: entry.user_id,
                text: `You're approved! Welcome to Hermes Agent. You can now chat with me anytime.`,
              }),
            }).catch(() => {});
          }
        }
      } catch (e) {
        console.error("Failed to send approval message:", e.message);
      }

      sendJson(res, 200, {
        success: true,
        user_id: entry.user_id,
        user_name: entry.user_name || "",
      });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: Export backup ──
  if (req.method === "GET" && url.pathname === "/api/export") {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        sendJson(res, 404, { error: "No Hermes data found" });
        return;
      }

      // Export as "default" profile (compatible with `hermes profile import`)
      // Create a symlink so tar archives .hermes as "default/"
      const symlinkPath = path.join(VOLUME_DIR, "default");
      try { fs.unlinkSync(symlinkPath); } catch (e) {}
      fs.symlinkSync(".hermes", symlinkPath);

      const tmpFile = `/tmp/hermes-backup-${Date.now()}.tar.gz`;
      try {
        execSync(
          `tar czfh ${tmpFile} -C ${VOLUME_DIR}` +
          ` --exclude='*/hermes-agent'` +
          ` --exclude='*/checkpoints'` +
          ` --exclude='*/bin'` +
          ` --exclude='*/logs'` +
          ` --exclude='*/image_cache'` +
          ` --exclude='*/audio_cache'` +
          ` --exclude='*/document_cache'` +
          ` --exclude='*/browser_screenshots'` +
          ` --exclude='*/pastes'` +
          ` --exclude='*/node_modules'` +
          ` --exclude='*/gateway_state.json'` +
          ` --exclude='*/*-shm'` +
          ` --exclude='*/*-wal'` +
          ` default`,
          { timeout: 120000 }
        );
      } finally {
        try { fs.unlinkSync(symlinkPath); } catch (e) {}
      }

      const stat = fs.statSync(tmpFile);
      const dateStr = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="hermes-backup-${dateStr}.tar.gz"`,
        "Content-Length": stat.size,
      });

      const stream = fs.createReadStream(tmpFile);
      stream.pipe(res);
      stream.on("end", () => {
        try { fs.unlinkSync(tmpFile); } catch (e) {}
      });
      stream.on("error", (err) => {
        console.error("Stream error:", err);
        try { fs.unlinkSync(tmpFile); } catch (e) {}
        if (!res.headersSent) sendJson(res, 500, { error: "Stream failed" });
      });
    } catch (e) {
      console.error("Export error:", e.message);
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: Import backup ──
  if (req.method === "POST" && url.pathname === "/api/import") {
    const tmpFile = `/tmp/hermes-import-${Date.now()}.tar.gz`;
    const cleanup = () => { try { fs.unlinkSync(tmpFile); } catch (e) {} };

    // Clean up if client aborts
    req.on("aborted", cleanup);

    try {
      const MAX_SIZE = 2 * 1024 * 1024 * 1024; // 2GB limit
      let size = 0;

      // Stream upload to disk instead of buffering in memory
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmpFile);
        req.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_SIZE) {
            ws.destroy();
            req.destroy();
            reject(new Error("Upload too large (max 2GB)"));
            return;
          }
          if (!ws.write(chunk)) req.pause();
        });
        ws.on("drain", () => req.resume());
        req.on("end", () => { ws.end(); resolve(); });
        req.on("error", (e) => { ws.destroy(); reject(e); });
        ws.on("error", reject);
      });

      // Detect archive format: find the top-level profile directory
      let archivePrefix = null;
      try {
        const listing = execSync(`tar tzf ${tmpFile}`, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
        const entries = listing.split("\n").filter(Boolean);
        const firstEntry = entries[0] || "";
        const topDir = firstEntry.replace(/\/$/, "").split("/")[0];

        if (!topDir) {
          cleanup();
          sendJson(res, 400, { error: "Invalid backup: archive is empty" });
          return;
        }

        // Check if it looks like a hermes profile (has config.yaml, state.db, or sessions/)
        const hasProfileData = entries.some(e =>
          e.includes("/config.yaml") || e.includes("/state.db") ||
          e.includes("/sessions/") || e.includes("/.env") ||
          e.includes("/SOUL.md")
        );

        if (hasProfileData) {
          archivePrefix = topDir;
        } else if (entries.length === 1 && firstEntry.endsWith("/")) {
          // Single empty directory (e.g. broken hermes profile export default)
          cleanup();
          sendJson(res, 400, { error: "Invalid backup: archive contains an empty profile directory. Use our export script instead: curl -fsSL https://raw.githubusercontent.com/zot24/umbrel-apps/main/zot24-hermes/hermes-export.sh | bash" });
          return;
        } else {
          cleanup();
          sendJson(res, 400, { error: "Invalid backup: no Hermes profile data found in archive" });
          return;
        }
        console.log(`Import: detected profile "${archivePrefix}" (${entries.length} entries)`);
      } catch (e) {
        cleanup();
        sendJson(res, 400, { error: "Invalid archive format" });
        return;
      }

      // Stop the web container to release SQLite locks before replacing data
      try {
        execSync(
          `curl -s --unix-socket /var/run/docker.sock -X POST "http://localhost/containers/${WEB_CONTAINER}/stop?t=10"`,
          { timeout: 30000 }
        );
        console.log("Stopped web container for safe import");
      } catch (e) {
        console.warn("Could not stop web container (may not be running):", e.message);
      }

      // Remove existing .hermes to prevent directory merge (especially skills duplication)
      const hermesDir = path.join(VOLUME_DIR, ".hermes");
      if (fs.existsSync(hermesDir)) {
        fs.rmSync(hermesDir, { recursive: true, force: true });
        console.log("Cleared existing .hermes directory");
      }

      // Extract and rename profile dir to .hermes/
      execSync(`tar xzf ${tmpFile} -C ${VOLUME_DIR}`, { timeout: 300000 });
      // Clean macOS resource fork files that can interfere with rename
      execSync(`find ${VOLUME_DIR} -name '._*' -delete 2>/dev/null || true`, { timeout: 10000 });
      if (archivePrefix !== ".hermes") {
        const extractedDir = path.join(VOLUME_DIR, archivePrefix);
        if (fs.existsSync(extractedDir)) {
          execSync(`mv "${extractedDir}" "${hermesDir}"`, { timeout: 10000 });
          console.log(`Renamed ${archivePrefix}/ to .hermes/`);
        }
      }
      cleanup();

      // Remove stale SQLite WAL files (they reference the old DB state)
      // Clean default profile and any imported named profiles
      const walCleanDirs = [CONFIG_DIR];
      const profilesDir = path.join(CONFIG_DIR, "profiles");
      try {
        if (fs.existsSync(profilesDir)) {
          for (const p of fs.readdirSync(profilesDir)) {
            walCleanDirs.push(path.join(profilesDir, p));
          }
        }
      } catch (e) {}
      for (const dir of walCleanDirs) {
        const db = path.join(dir, "state.db");
        try { fs.unlinkSync(db + "-shm"); } catch (e) {}
        try { fs.unlinkSync(db + "-wal"); } catch (e) {}
      }

      // Clear gateway_state.json (excluded from export, stale if leftover)
      try { fs.unlinkSync(STATE_FILE); } catch (e) {}

      // Remove HERMES_REGEN_CONFIG from .env so the imported config.yaml is preserved
      try {
        if (fs.existsSync(ENV_FILE)) {
          const envContent = fs.readFileSync(ENV_FILE, "utf8");
          const cleaned = envContent.split("\n").filter(l => !l.startsWith("HERMES_REGEN_CONFIG=")).join("\n");
          fs.writeFileSync(ENV_FILE, cleaned, { mode: 0o600 });
        }
      } catch (e) {
        console.error("Warning: could not clean HERMES_REGEN_CONFIG from .env:", e.message);
      }

      // Fix permissions — backup may have been created by a different user
      try {
        execSync(`chmod -R u+rw "${hermesDir}"`, { timeout: 30000 });
        if (fs.existsSync(ENV_FILE)) execSync(`chmod 600 "${ENV_FILE}"`, { timeout: 5000 });
        const envLocal = path.join(CONFIG_DIR, ".env.local");
        if (fs.existsSync(envLocal)) execSync(`chmod 600 "${envLocal}"`, { timeout: 5000 });
      } catch (e) {
        console.warn("Warning: could not fix permissions after import:", e.message);
      }

      // Mark as configured (import implies prior setup)
      fs.writeFileSync(SETUP_SENTINEL, new Date().toISOString(), { mode: 0o644 });

      // Restart the web container
      const restarted = restartWebContainer();

      sendJson(res, 200, {
        success: true,
        restarted,
        message: restarted
          ? "Backup restored. Gateway is restarting..."
          : "Backup restored. Please restart the app manually.",
      });
    } catch (e) {
      cleanup();
      console.error("Import error:", e.message);
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: Dashboard insights ──
  if (req.method === "GET" && url.pathname === "/api/insights") {
    const days = parseInt(url.searchParams.get("days") || "30");
    const sourceFilter = url.searchParams.get("source") || null;
    const profileFilter = url.searchParams.get("profile") || null;
    const cutoff = Date.now() / 1000 - days * 86400;

    const db = openStateDb(profileFilter);
    if (!db) {
      sendJson(res, 200, { empty: true, days, overview: {}, models: [], platforms: [], tools: [], activity: {}, top_sessions: [] });
      return;
    }

    try {
      // Fetch sessions
      let sessions;
      if (sourceFilter) {
        sessions = db.prepare(
          `SELECT id, source, model, started_at, ended_at, message_count, tool_call_count,
                  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                  estimated_cost_usd, actual_cost_usd, cost_status, end_reason, title
           FROM sessions WHERE started_at >= ? AND source = ? ORDER BY started_at DESC`
        ).all(cutoff, sourceFilter);
      } else {
        sessions = db.prepare(
          `SELECT id, source, model, started_at, ended_at, message_count, tool_call_count,
                  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                  estimated_cost_usd, actual_cost_usd, cost_status, end_reason, title
           FROM sessions WHERE started_at >= ? ORDER BY started_at DESC`
        ).all(cutoff);
      }

      if (!sessions.length) {
        db.close();
        sendJson(res, 200, { empty: true, days, overview: {}, models: [], platforms: [], tools: [], activity: {}, top_sessions: [] });
        return;
      }

      // Overview
      let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0;
      let totalToolCalls = 0, totalMessages = 0, totalCost = 0;
      const durations = [];
      for (const s of sessions) {
        totalInput += s.input_tokens || 0;
        totalOutput += s.output_tokens || 0;
        totalCacheRead += s.cache_read_tokens || 0;
        totalCacheWrite += s.cache_write_tokens || 0;
        totalToolCalls += s.tool_call_count || 0;
        totalMessages += s.message_count || 0;
        totalCost += estimateCost(s);
        if (s.started_at && s.ended_at && s.ended_at > s.started_at) {
          durations.push(s.ended_at - s.started_at);
        }
      }
      const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheWrite;
      const totalHours = durations.reduce((a, b) => a + b, 0) / 3600;
      const avgDuration = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

      const overview = {
        total_sessions: sessions.length,
        total_messages: totalMessages,
        total_tool_calls: totalToolCalls,
        total_input_tokens: totalInput,
        total_output_tokens: totalOutput,
        total_cache_read_tokens: totalCacheRead,
        total_cache_write_tokens: totalCacheWrite,
        total_tokens: totalTokens,
        estimated_cost_usd: Math.round(totalCost * 100) / 100,
        total_hours: Math.round(totalHours * 10) / 10,
        avg_session_duration: Math.round(avgDuration),
        avg_messages_per_session: Math.round(totalMessages / sessions.length * 10) / 10,
      };

      // Model breakdown
      const modelMap = {};
      for (const s of sessions) {
        const model = s.model ? (s.model.includes("/") ? s.model.split("/").pop() : s.model) : "unknown";
        if (!modelMap[model]) modelMap[model] = { model, sessions: 0, tokens: 0, cost: 0, tool_calls: 0 };
        modelMap[model].sessions++;
        modelMap[model].tokens += (s.input_tokens || 0) + (s.output_tokens || 0) + (s.cache_read_tokens || 0) + (s.cache_write_tokens || 0);
        modelMap[model].cost += estimateCost(s);
        modelMap[model].tool_calls += s.tool_call_count || 0;
      }
      const models = Object.values(modelMap).sort((a, b) => b.tokens - a.tokens);
      models.forEach(m => { m.cost = Math.round(m.cost * 100) / 100; });

      // Platform breakdown
      const platMap = {};
      for (const s of sessions) {
        const src = s.source || "unknown";
        if (!platMap[src]) platMap[src] = { platform: src, sessions: 0, messages: 0, tokens: 0 };
        platMap[src].sessions++;
        platMap[src].messages += s.message_count || 0;
        platMap[src].tokens += (s.input_tokens || 0) + (s.output_tokens || 0);
      }
      const platforms = Object.values(platMap).sort((a, b) => b.sessions - a.sessions);

      // Tool usage from messages
      let tools = [];
      try {
        let toolRows;
        if (sourceFilter) {
          toolRows = db.prepare(
            `SELECT m.tool_name, COUNT(*) as count
             FROM messages m JOIN sessions s ON s.id = m.session_id
             WHERE s.started_at >= ? AND s.source = ? AND m.role = 'tool' AND m.tool_name IS NOT NULL
             GROUP BY m.tool_name ORDER BY count DESC LIMIT 20`
          ).all(cutoff, sourceFilter);
        } else {
          toolRows = db.prepare(
            `SELECT m.tool_name, COUNT(*) as count
             FROM messages m JOIN sessions s ON s.id = m.session_id
             WHERE s.started_at >= ? AND m.role = 'tool' AND m.tool_name IS NOT NULL
             GROUP BY m.tool_name ORDER BY count DESC LIMIT 20`
          ).all(cutoff);
        }
        const totalToolCount = toolRows.reduce((a, r) => a + r.count, 0);
        tools = toolRows.map(r => ({
          tool: r.tool_name,
          count: r.count,
          percentage: totalToolCount ? Math.round(r.count / totalToolCount * 1000) / 10 : 0,
        }));
      } catch (e) {
        console.error("Tool usage query failed:", e.message);
      }

      // Activity patterns
      const dayCounts = [0, 0, 0, 0, 0, 0, 0]; // Mon-Sun
      const hourCounts = new Array(24).fill(0);
      const dailyCounts = {};
      for (const s of sessions) {
        if (!s.started_at) continue;
        const dt = new Date(s.started_at * 1000);
        const dow = (dt.getDay() + 6) % 7; // Convert Sun=0 to Mon=0
        dayCounts[dow]++;
        hourCounts[dt.getHours()]++;
        const dateKey = dt.toISOString().slice(0, 10);
        dailyCounts[dateKey] = (dailyCounts[dateKey] || 0) + 1;
      }
      const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      const byDay = dayNames.map((d, i) => ({ day: d, count: dayCounts[i] }));
      const byHour = hourCounts.map((c, i) => ({ hour: i, count: c }));

      // Streak calculation
      const sortedDates = Object.keys(dailyCounts).sort();
      let maxStreak = sortedDates.length ? 1 : 0;
      let curStreak = 1;
      for (let i = 1; i < sortedDates.length; i++) {
        const d1 = new Date(sortedDates[i - 1]);
        const d2 = new Date(sortedDates[i]);
        if ((d2 - d1) === 86400000) { curStreak++; maxStreak = Math.max(maxStreak, curStreak); }
        else { curStreak = 1; }
      }

      // Daily breakdown (last 14 days for sparkline)
      const daily = [];
      const now = new Date();
      for (let i = 13; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        daily.push({ date: key, label: d.toLocaleDateString("en", { month: "short", day: "numeric" }), count: dailyCounts[key] || 0 });
      }

      const activity = {
        by_day: byDay,
        by_hour: byHour,
        daily: daily,
        active_days: sortedDates.length,
        max_streak: maxStreak,
      };

      // Top sessions
      const topSessions = [];
      const withDuration = sessions.filter(s => s.started_at && s.ended_at && s.ended_at > s.started_at);
      if (withDuration.length) {
        const longest = withDuration.reduce((a, b) => (b.ended_at - b.started_at) > (a.ended_at - a.started_at) ? b : a);
        const dur = longest.ended_at - longest.started_at;
        topSessions.push({ label: "Longest", session_id: longest.id.slice(0, 16), value: formatDuration(dur), date: fmtDate(longest.started_at) });
      }
      const mostMsgs = sessions.reduce((a, b) => (b.message_count || 0) > (a.message_count || 0) ? b : a);
      if ((mostMsgs.message_count || 0) > 0) {
        topSessions.push({ label: "Most messages", session_id: mostMsgs.id.slice(0, 16), value: `${mostMsgs.message_count} msgs`, date: fmtDate(mostMsgs.started_at) });
      }
      const mostTokens = sessions.reduce((a, b) => ((b.input_tokens || 0) + (b.output_tokens || 0)) > ((a.input_tokens || 0) + (a.output_tokens || 0)) ? b : a);
      const tokenTotal = (mostTokens.input_tokens || 0) + (mostTokens.output_tokens || 0);
      if (tokenTotal > 0) {
        topSessions.push({ label: "Most tokens", session_id: mostTokens.id.slice(0, 16), value: `${tokenTotal.toLocaleString()} tok`, date: fmtDate(mostTokens.started_at) });
      }
      const mostTools = sessions.reduce((a, b) => (b.tool_call_count || 0) > (a.tool_call_count || 0) ? b : a);
      if ((mostTools.tool_call_count || 0) > 0) {
        topSessions.push({ label: "Most tool calls", session_id: mostTools.id.slice(0, 16), value: `${mostTools.tool_call_count} calls`, date: fmtDate(mostTools.started_at) });
      }

      db.close();
      sendJson(res, 200, { empty: false, days, overview, models, platforms, tools, activity, top_sessions: topSessions });
    } catch (e) {
      try { db.close(); } catch (_) {}
      console.error("Insights error:", e.message);
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: Sessions list ──
  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
    const offset = parseInt(url.searchParams.get("offset") || "0");
    const sourceFilter = url.searchParams.get("source") || null;
    const profileFilter = url.searchParams.get("profile") || null;

    const db = openStateDb(profileFilter);
    if (!db) {
      sendJson(res, 200, { sessions: [], total: 0 });
      return;
    }

    try {
      let total, rows;
      if (sourceFilter) {
        total = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE source = ?").get(sourceFilter).c;
        rows = db.prepare(
          `SELECT id, source, model, started_at, ended_at, message_count, tool_call_count,
                  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                  estimated_cost_usd, end_reason, title
           FROM sessions WHERE source = ? ORDER BY started_at DESC LIMIT ? OFFSET ?`
        ).all(sourceFilter, limit, offset);
      } else {
        total = db.prepare("SELECT COUNT(*) as c FROM sessions").get().c;
        rows = db.prepare(
          `SELECT id, source, model, started_at, ended_at, message_count, tool_call_count,
                  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                  estimated_cost_usd, end_reason, title
           FROM sessions ORDER BY started_at DESC LIMIT ? OFFSET ?`
        ).all(limit, offset);
      }

      const sessions = rows.map(s => ({
        ...s,
        estimated_cost_usd: Math.round(estimateCost(s) * 10000) / 10000,
      }));

      db.close();
      sendJson(res, 200, { sessions, total });
    } catch (e) {
      try { db.close(); } catch (_) {}
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: Session messages ──
  if (req.method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/messages")) {
    const parts = url.pathname.replace("/api/sessions/", "").replace("/messages", "").split("?");
    const sessionId = parts[0];
    const profileFilter = url.searchParams.get("profile") || null;
    const db = openStateDb(profileFilter);
    if (!db) { sendJson(res, 200, { messages: [] }); return; }

    try {
      const messages = db.prepare(
        `SELECT role, content, tool_name, tool_calls, timestamp, token_count, finish_reason
         FROM messages WHERE session_id = ? ORDER BY timestamp ASC LIMIT 500`
      ).all(sessionId);

      db.close();
      sendJson(res, 200, {
        messages: messages.map(m => ({
          role: m.role,
          content: m.content ? m.content.slice(0, 2000) : null, // Truncate large content
          tool_name: m.tool_name,
          tool_calls: m.tool_calls ? (() => { try { return JSON.parse(m.tool_calls); } catch { return null; } })() : null,
          timestamp: m.timestamp,
          token_count: m.token_count,
        })),
      });
    } catch (e) {
      try { db.close(); } catch (_) {}
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: Skills listing ──
  if (req.method === "GET" && url.pathname === "/api/skills") {
    const profileFilter = url.searchParams.get("profile") || null;
    const skillsDir = profileFilter && profileFilter !== "all"
      ? path.join(getProfileDir(profileFilter), "skills")
      : SKILLS_DIR;
    const categories = [];
    let total = 0;
    try {
      if (fs.existsSync(skillsDir)) {
        const dirs = fs.readdirSync(skillsDir, { withFileTypes: true });
        for (const d of dirs) {
          if (!d.isDirectory() || d.name.startsWith(".")) continue;
          const catPath = path.join(skillsDir, d.name);
          // Look for skill subdirectories containing SKILL.md
          const skillEntries = [];
          const subDirs = fs.readdirSync(catPath, { withFileTypes: true });
          for (const sd of subDirs) {
            if (sd.isDirectory()) {
              const skillFile = path.join(catPath, sd.name, "SKILL.md");
              if (fs.existsSync(skillFile)) {
                const content = fs.readFileSync(skillFile, "utf8");
                // Parse YAML frontmatter
                const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                const meta = {};
                if (fmMatch) {
                  for (const line of fmMatch[1].split("\n")) {
                    const kv = line.match(/^(\w[\w-]*):\s*(.+)/);
                    if (kv) meta[kv[1]] = kv[2].trim();
                  }
                }
                skillEntries.push({
                  name: meta.name || sd.name,
                  description: (meta.description || "").slice(0, 200),
                  author: meta.author || null,
                  version: meta.version || null,
                  platforms: meta.platforms ? meta.platforms.replace(/[\[\]]/g, "").split(",").map(s => s.trim()) : null,
                  has_prerequisites: !!meta.prerequisites || content.includes("## Prerequisites"),
                  category: d.name,
                });
                total++;
              }
            } else if (sd.isFile() && sd.name.endsWith(".md") && sd.name !== "DESCRIPTION.md") {
              skillEntries.push({ name: sd.name.replace(".md", "") });
              total++;
            }
          }
          if (skillEntries.length > 0) {
            // Get category description if available
            const descFile = path.join(catPath, "DESCRIPTION.md");
            const catDesc = fs.existsSync(descFile) ? fs.readFileSync(descFile, "utf8").split("\n")[0].slice(0, 100) : null;
            categories.push({ name: d.name, count: skillEntries.length, skills: skillEntries, description: catDesc });
          }
        }
        categories.sort((a, b) => b.count - a.count);
      }
    } catch (e) {
      console.error("Skills listing error:", e.message);
    }
    // Flatten all skills for easy frontend filtering
    const allSkills = categories.flatMap(c => c.skills);
    const withPrereqs = allSkills.filter(s => s.has_prerequisites).length;
    sendJson(res, 200, { categories, total, allSkills, withPrereqs });
    return;
  }

  // ── API: Tools listing ──
  if (req.method === "GET" && url.pathname === "/api/tools") {
    // Read configured toolsets from config.yaml
    let configuredToolsets = [];
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const yaml = fs.readFileSync(CONFIG_FILE, "utf8");
        const match = yaml.match(/toolsets:\s*\n((?:\s+-\s+.+\n?)*)/);
        if (match) {
          configuredToolsets = match[1].match(/- (.+)/g)?.map(m => m.replace("- ", "").trim()) || [];
        }
      }
    } catch (e) {}

    // Get tool usage from DB
    let toolsUsed = [];
    const db = openStateDb();
    if (db) {
      try {
        toolsUsed = db.prepare(
          `SELECT tool_name as name, COUNT(*) as calls
           FROM messages WHERE role = 'tool' AND tool_name IS NOT NULL
           GROUP BY tool_name ORDER BY calls DESC LIMIT 30`
        ).all();
        db.close();
      } catch (e) { try { db.close(); } catch (_) {} }
    }

    sendJson(res, 200, { configured_toolsets: configuredToolsets, tools_used: toolsUsed });
    return;
  }

  // ── API: Memory files ──
  if (req.method === "GET" && url.pathname === "/api/memory") {
    const profileFilter = url.searchParams.get("profile") || null;
    const memDir = profileFilter && profileFilter !== "all"
      ? path.join(getProfileDir(profileFilter), "memories")
      : MEMORIES_DIR;
    const result = { soul: null, memory: null, has_user_profile: false };
    try {
      const soulFile = path.join(memDir, "SOUL.md");
      const memoryFile = path.join(memDir, "MEMORY.md");
      const userFile = path.join(memDir, "USER.md");
      if (fs.existsSync(soulFile)) result.soul = fs.readFileSync(soulFile, "utf8");
      if (fs.existsSync(memoryFile)) result.memory = fs.readFileSync(memoryFile, "utf8");
      result.has_user_profile = fs.existsSync(userFile);
    } catch (e) {
      console.error("Memory read error:", e.message);
    }
    sendJson(res, 200, result);
    return;
  }

  // ── API: Memory file browser — list all files ──
  if (req.method === "GET" && url.pathname === "/api/memory/files") {
    const profileFilter = url.searchParams.get("profile") || null;
    const memDir = profileFilter && profileFilter !== "all"
      ? path.join(getProfileDir(profileFilter), "memories")
      : MEMORIES_DIR;
    const files = [];
    try {
      if (fs.existsSync(memDir)) {
        const entries = fs.readdirSync(memDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isFile() && e.name.endsWith(".md")) {
            const stat = fs.statSync(path.join(memDir, e.name));
            files.push({ name: e.name, size: stat.size, modified: Math.floor(stat.mtimeMs / 1000) });
          }
        }
        // Also check memory/ subdirectory (Claude-style memory)
        const memSubDir = path.join(memDir, "memory");
        if (fs.existsSync(memSubDir)) {
          const subEntries = fs.readdirSync(memSubDir, { withFileTypes: true });
          for (const e of subEntries) {
            if (e.isFile() && e.name.endsWith(".md")) {
              const stat = fs.statSync(path.join(memSubDir, e.name));
              files.push({ name: "memory/" + e.name, size: stat.size, modified: Math.floor(stat.mtimeMs / 1000) });
            }
          }
        }
        files.sort((a, b) => b.modified - a.modified);
      }
    } catch (e) {
      console.error("Memory list error:", e.message);
    }
    sendJson(res, 200, { files });
    return;
  }

  // ── API: Memory read single file ──
  if (req.method === "GET" && url.pathname === "/api/memory/read") {
    const profileFilter = url.searchParams.get("profile") || null;
    const file = url.searchParams.get("file");
    if (!file || file.includes("..")) {
      sendJson(res, 400, { error: "Invalid file" });
      return;
    }
    const memDir = profileFilter && profileFilter !== "all"
      ? path.join(getProfileDir(profileFilter), "memories")
      : MEMORIES_DIR;
    const filePath = path.join(memDir, file);
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf8");
        const stat = fs.statSync(filePath);
        sendJson(res, 200, { file, content, size: stat.size, modified: Math.floor(stat.mtimeMs / 1000) });
      } else {
        sendJson(res, 404, { error: "File not found" });
      }
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: Memory write file ──
  if (req.method === "POST" && url.pathname === "/api/memory/write") {
    const profileFilter = url.searchParams.get("profile") || null;
    try {
      const data = await parseBody(req);
      if (!data.file || data.file.includes("..") || !data.file.endsWith(".md")) {
        sendJson(res, 400, { error: "Invalid file name" });
        return;
      }
      const memDir = profileFilter && profileFilter !== "all"
        ? path.join(getProfileDir(profileFilter), "memories")
        : MEMORIES_DIR;
      const filePath = path.join(memDir, data.file);
      // Ensure parent dir exists
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, data.content || "");
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: Memory search across files ──
  if (req.method === "GET" && url.pathname === "/api/memory/search") {
    const profileFilter = url.searchParams.get("profile") || null;
    const query = (url.searchParams.get("q") || "").toLowerCase();
    if (!query) {
      sendJson(res, 200, { results: [] });
      return;
    }
    const memDir = profileFilter && profileFilter !== "all"
      ? path.join(getProfileDir(profileFilter), "memories")
      : MEMORIES_DIR;
    const results = [];
    try {
      function searchDir(dir, prefix) {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory() && !e.name.startsWith(".")) {
            searchDir(path.join(dir, e.name), prefix ? prefix + "/" + e.name : e.name);
          } else if (e.isFile() && e.name.endsWith(".md")) {
            const content = fs.readFileSync(path.join(dir, e.name), "utf8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(query)) {
                const fileName = prefix ? prefix + "/" + e.name : e.name;
                results.push({ file: fileName, line: i + 1, text: lines[i].slice(0, 200) });
                if (results.length >= 50) return;
              }
            }
          }
        }
      }
      searchDir(memDir, "");
    } catch (e) {
      console.error("Memory search error:", e.message);
    }
    sendJson(res, 200, { results });
    return;
  }

  // ── API: Cron jobs ──
  if (req.method === "GET" && url.pathname === "/api/cron") {
    const profileFilter = url.searchParams.get("profile") || null;
    const cronDir = profileFilter && profileFilter !== "all"
      ? path.join(getProfileDir(profileFilter), "cron")
      : path.join(CONFIG_DIR, "cron");
    let jobs = [];
    try {
      if (fs.existsSync(cronDir)) {
        // Primary format: jobs.json with { "jobs": [...] } structure
        const jobsFile = path.join(cronDir, "jobs.json");
        if (fs.existsSync(jobsFile)) {
          const content = JSON.parse(fs.readFileSync(jobsFile, "utf8"));
          if (Array.isArray(content.jobs)) {
            jobs = content.jobs;
          } else if (Array.isArray(content)) {
            jobs = content;
          }
        }
        // Also check for individual job files (legacy format)
        for (const file of fs.readdirSync(cronDir)) {
          if (file === "jobs.json" || file.startsWith(".") || file === "output") continue;
          if (!file.endsWith(".json")) continue;
          try {
            const content = JSON.parse(fs.readFileSync(path.join(cronDir, file), "utf8"));
            if (content.id || content.name) jobs.push(content);
          } catch (e) {}
        }
        // Enrich with output logs
        const outputDir = path.join(cronDir, "output");
        if (fs.existsSync(outputDir)) {
          for (const job of jobs) {
            const id = job.id || job.name || "";
            for (const suffix of [id, job.name || ""]) {
              if (!suffix) continue;
              const outFile = path.join(outputDir, suffix + ".log");
              if (fs.existsSync(outFile)) {
                const stat = fs.statSync(outFile);
                const content = fs.readFileSync(outFile, "utf8");
                job._last_output = content.split("\n").slice(-10).join("\n");
                if (!job.last_run_at) job._last_run_at = Math.floor(stat.mtimeMs / 1000);
                break;
              }
            }
          }
        }
      }
    } catch (e) {
      console.error("Cron listing error:", e.message);
    }
    sendJson(res, 200, { jobs });
    return;
  }

  // ── API: Settings (read/write config.yaml + .env) ──
  if (req.method === "GET" && url.pathname === "/api/settings") {
    const profileFilter = url.searchParams.get("profile") || null;
    const cfgDir = profileFilter && profileFilter !== "all"
      ? getProfileDir(profileFilter)
      : CONFIG_DIR;
    const result = { model: null, provider: null, personality: null, reasoning: null, streaming: true, memory: true, context_compression: true, compression_threshold: null, session_reset_mode: null, session_idle_minutes: null, session_reset_hour: null, timezone: null, max_turns: null };
    try {
      const cfgFile = path.join(cfgDir, "config.yaml");
      if (fs.existsSync(cfgFile)) {
        const yaml = fs.readFileSync(cfgFile, "utf8");
        const get = (pattern) => { const m = yaml.match(pattern); return m ? m[1].trim().replace(/^["']|["']$/g, "") : null; };
        result.model = get(/default:\s*"?([^"\n]+)"?/);
        result.provider = get(/provider:\s*"?([^"\n]+)"?/);
        result.personality = get(/personality:\s*"?([^"\n]+)"?/);
        result.reasoning = get(/reasoning:\s*"?([^"\n]+)"?/);
        result.streaming = yaml.includes("streaming: false") ? false : true;
        result.memory = !yaml.includes("memory:") || !yaml.includes("enabled: false");
        result.context_compression = !yaml.includes("context_compression:") || !yaml.match(/context_compression:[\s\S]*?enabled:\s*false/);
        result.compression_threshold = get(/threshold:\s*"?([^"\n]+)"?/);
        result.session_reset_mode = get(/mode:\s*"?([^"\n]+)"?/);
        result.session_idle_minutes = get(/idle_minutes:\s*(\d+)/);
        result.session_reset_hour = get(/at_hour:\s*(\d+)/);
        result.timezone = get(/timezone:\s*"?([^"\n]+)"?/);
        result.max_turns = get(/max_turns:\s*(\d+)/);
      }
      const env = readProfileEnv(cfgDir);
      if (env.HERMES_MODEL) result.model = env.HERMES_MODEL;
      if (env.HERMES_PROVIDER) result.provider = env.HERMES_PROVIDER;
    } catch (e) {
      console.error("Settings read error:", e.message);
    }
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings") {
    try {
      const data = await parseBody(req);
      const profileFilter = url.searchParams.get("profile") || null;
      const cfgDir = profileFilter && profileFilter !== "all"
        ? getProfileDir(profileFilter)
        : CONFIG_DIR;
      const webCfgDir = webContainerPath(cfgDir);

      // Use hermes config set via the web container for each changed key
      const configMap = {
        model: "model.default",
        provider: "model.provider",
        personality: "display.personality",
        reasoning: "display.reasoning",
        max_turns: "model.max_turns",
        timezone: "timezone",
      };

      for (const [key, cfgKey] of Object.entries(configMap)) {
        if (data[key] !== undefined && data[key] !== null) {
          try {
            execInWebContainer(`HERMES_HOME=${webCfgDir} /app/venv/bin/hermes config set "${cfgKey}" "${String(data[key]).replace(/"/g, '\\"')}"`);
          } catch (e) {
            console.error(`Config set failed for ${cfgKey}:`, e.message);
          }
        }
      }

      // Toggle settings need special handling in config.yaml
      const cfgFile = path.join(cfgDir, "config.yaml");
      if (fs.existsSync(cfgFile)) {
        let yaml = fs.readFileSync(cfgFile, "utf8");

        if (data.streaming !== undefined) {
          yaml = yaml.includes("streaming:")
            ? yaml.replace(/streaming:\s*(true|false)/, `streaming: ${data.streaming}`)
            : yaml.replace(/gateway:/, `gateway:\n  streaming: ${data.streaming}`);
        }
        if (data.memory !== undefined) {
          yaml = yaml.includes("memory:")
            ? yaml.replace(/memory:\s*\n\s*enabled:\s*(true|false)/, `memory:\n  enabled: ${data.memory}`)
            : yaml + `\nmemory:\n  enabled: ${data.memory}\n`;
        }
        if (data.context_compression !== undefined) {
          yaml = yaml.includes("context_compression:")
            ? yaml.replace(/context_compression:\s*\n\s*enabled:\s*(true|false)/, `context_compression:\n  enabled: ${data.context_compression}`)
            : yaml + `\ncontext_compression:\n  enabled: ${data.context_compression}\n`;
        }
        if (data.session_idle_minutes !== undefined) {
          yaml = yaml.replace(/idle_minutes:\s*\d+/, `idle_minutes: ${data.session_idle_minutes}`);
        }
        if (data.session_reset_hour !== undefined) {
          yaml = yaml.replace(/at_hour:\s*\d+/, `at_hour: ${data.session_reset_hour}`);
        }

        fs.writeFileSync(cfgFile, yaml);
      }

      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: Available providers and models ──
  if (req.method === "GET" && url.pathname === "/api/providers") {
    try {
      const providersJson = execSync(
        `curl -s --unix-socket /var/run/docker.sock -X POST ` +
        `-H "Content-Type: application/json" ` +
        `-d '{"AttachStdout":true,"AttachStderr":true,"Detach":false,"Cmd":["python3","-c","from hermes_cli.models import list_available_providers; import json; print(json.dumps(list_available_providers()))"]}' ` +
        `"http://localhost/containers/${WEB_CONTAINER}/exec"`,
        { encoding: "utf8", timeout: 10000 }
      );
      const execId = JSON.parse(providersJson).Id;
      const output = execSync(
        `curl -s --unix-socket /var/run/docker.sock -X POST ` +
        `-H "Content-Type: application/json" ` +
        `-d '{"Detach":false}' ` +
        `"http://localhost/exec/${execId}/start"`,
        { encoding: "utf8", timeout: 10000 }
      );
      // Output may have docker stream header bytes — find the JSON array
      const jsonMatch = output.match(/\[[\s\S]*\]/);
      const providers = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
      sendJson(res, 200, { providers });
    } catch (e) {
      console.error("Providers fetch error:", e.message);
      // Fallback static list
      sendJson(res, 200, { providers: [
        {id:"openrouter",label:"OpenRouter"},{id:"anthropic",label:"Anthropic"},{id:"minimax",label:"MiniMax"},
        {id:"deepseek",label:"DeepSeek"},{id:"nous",label:"Nous Portal"},{id:"openai-codex",label:"OpenAI Codex"},
        {id:"copilot",label:"GitHub Copilot"},{id:"alibaba",label:"Alibaba"},{id:"custom",label:"Custom"},
      ]});
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/models") {
    const provider = url.searchParams.get("provider") || "";
    try {
      const cmd = `python3 -c "from hermes_cli.models import curated_models_for_provider; import json; print(json.dumps([{'id':m[0],'desc':m[1]} for m in curated_models_for_provider('${provider.replace(/'/g, "")}')]))"`;
      const createResp = execSync(
        `curl -s --unix-socket /var/run/docker.sock -X POST ` +
        `-H "Content-Type: application/json" ` +
        `-d '${JSON.stringify({AttachStdout:true,AttachStderr:true,Detach:false,Cmd:["sh","-c",cmd]}).replace(/'/g, "'\\''")}' ` +
        `"http://localhost/containers/${WEB_CONTAINER}/exec"`,
        { encoding: "utf8", timeout: 10000 }
      );
      const execId = JSON.parse(createResp).Id;
      const output = execSync(
        `curl -s --unix-socket /var/run/docker.sock -X POST ` +
        `-H "Content-Type: application/json" ` +
        `-d '{"Detach":false}' ` +
        `"http://localhost/exec/${execId}/start"`,
        { encoding: "utf8", timeout: 10000 }
      );
      const jsonMatch = output.match(/\[[\s\S]*\]/);
      const models = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
      sendJson(res, 200, { models });
    } catch (e) {
      console.error("Models fetch error:", e.message);
      sendJson(res, 200, { models: [] });
    }
    return;
  }

  // ── API: List profiles ──
  if (req.method === "GET" && url.pathname === "/api/profiles") {
    const profiles = listProfiles();
    // Enrich with session counts from each profile's state.db
    for (const p of profiles) {
      const profileDir = getProfileDir(p.name);
      const stateDb = path.join(profileDir, "state.db");
      p.activeSessions = 0;
      p.totalSessions = 0;
      try {
        if (Database && fs.existsSync(stateDb)) {
          const db = new Database(stateDb, { readonly: true, fileMustExist: true });
          db.pragma("journal_mode = WAL");
          const cutoff24h = Date.now() / 1000 - 86400;
          p.activeSessions = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE ended_at IS NULL OR ended_at > ?").get(cutoff24h).c;
          p.totalSessions = db.prepare("SELECT COUNT(*) as c FROM sessions").get().c;
          db.close();
        }
      } catch (e) {}
    }
    sendJson(res, 200, { profiles });
    return;
  }

  // ── API: Create profile ──
  if (req.method === "POST" && url.pathname === "/api/profiles") {
    try {
      const data = await parseBody(req);
      const name = (data.name || "").trim().toLowerCase();

      if (!name || !PROFILE_NAME_RE.test(name)) {
        sendJson(res, 400, { error: "Invalid profile name. Use lowercase letters, numbers, hyphens. Max 20 characters." });
        return;
      }
      if (name === "default") {
        sendJson(res, 400, { error: "Cannot create a profile named 'default'." });
        return;
      }

      const profileDir = getProfileDir(name);
      if (fs.existsSync(profileDir)) {
        sendJson(res, 409, { error: `Profile '${name}' already exists.` });
        return;
      }

      fs.mkdirSync(profileDir, { recursive: true });

      // Create required subdirs
      for (const dir of ["sessions", "logs", "pairing", "hooks", "image_cache", "audio_cache", "memories", "skills", "whatsapp", "cron"]) {
        fs.mkdirSync(path.join(profileDir, dir), { recursive: true });
      }

      // Clone from default based on mode
      const cloneMode = data.cloneMode || (data.clone ? "full" : "blank");

      if (cloneMode === "keys" || cloneMode === "full") {
        // Copy config.yaml (strip platform-specific settings — no messaging channels)
        const cfgSrc = path.join(CONFIG_DIR, "config.yaml");
        if (fs.existsSync(cfgSrc)) {
          let yaml = fs.readFileSync(cfgSrc, "utf8");
          yaml = yaml.replace(/gateway:[\s\S]*?(?=\n\w|\n$|$)/, "gateway:\n  streaming: true\n  platforms:\n    # Configure platforms for this profile\n");
          fs.writeFileSync(path.join(profileDir, "config.yaml"), yaml);
        }
        // Copy .env — keep model + provider + API keys, strip platform tokens
        const envSrc = path.join(CONFIG_DIR, ".env");
        if (fs.existsSync(envSrc)) {
          const envContent = fs.readFileSync(envSrc, "utf8");
          const skipKeys = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_HOME_CHAT_ID", "WHATSAPP_ENABLED", "DISCORD_BOT_TOKEN", "SLACK_BOT_TOKEN", "HERMES_REGEN_CONFIG"];
          const filtered = envContent.split("\n").filter(line => {
            const key = line.split("=")[0].trim();
            return !skipKeys.includes(key);
          }).join("\n");
          fs.writeFileSync(path.join(profileDir, ".env"), filtered);
        }
      }

      if (cloneMode === "full") {
        // Also copy personality and instruction files
        for (const file of ["SOUL.md", "USER.md", "instructions.md"]) {
          const src = path.join(CONFIG_DIR, file);
          if (fs.existsSync(src)) {
            try { fs.copyFileSync(src, path.join(profileDir, file)); } catch (e) {
              console.error(`Failed to copy ${file} to profile ${name}:`, e.message);
            }
          }
        }
      }

      console.log(`Created profile '${name}' (mode: ${cloneMode})`);

      sendJson(res, 201, { success: true, name });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: Profile actions (start/stop/restart/delete) ──
  const profileMatch = url.pathname.match(/^\/api\/profiles\/([a-z0-9][a-z0-9_-]*)\/(start|stop|restart)$/);
  if (req.method === "POST" && profileMatch) {
    const [, name, action] = profileMatch;
    try {
      const profileDir = getProfileDir(name);
      if (!fs.existsSync(profileDir)) {
        sendJson(res, 404, { error: `Profile '${name}' not found.` });
        return;
      }

      if (action === "start") {
        startProfileGateway(name);
        sendJson(res, 200, { success: true, message: `Gateway starting for ${name}...` });
      } else if (action === "stop") {
        stopProfileGateway(name);
        sendJson(res, 200, { success: true, message: `Gateway stopped for ${name}.` });
      } else if (action === "restart") {
        try { stopProfileGateway(name); } catch (e) {}
        setTimeout(() => {
          try { startProfileGateway(name); } catch (e) { console.error(`Restart failed for ${name}:`, e.message); }
        }, 2000);
        sendJson(res, 200, { success: true, message: `Gateway restarting for ${name}...` });
      }
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: Delete profile ──
  const deleteMatch = url.pathname.match(/^\/api\/profiles\/([a-z0-9][a-z0-9_-]*)$/);
  if (req.method === "DELETE" && deleteMatch) {
    const name = deleteMatch[1];
    try {
      if (name === "default") {
        sendJson(res, 400, { error: "Cannot delete the default profile." });
        return;
      }
      const profileDir = getProfileDir(name);
      if (!fs.existsSync(profileDir)) {
        sendJson(res, 404, { error: `Profile '${name}' not found.` });
        return;
      }
      // Stop gateway if running
      try { stopProfileGateway(name); } catch (e) {}
      // Remove profile directory — try locally first, then via web container for permission issues
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch (e) {
        console.error(`Local rmSync failed for ${name}:`, e.message);
      }
      // Also remove via web container (handles bind mount permission differences)
      const webProfileDir = webContainerPath(profileDir);
      try {
        execInWebContainer(`rm -rf "${webProfileDir}"`);
      } catch (e) {
        console.error(`Web container rm failed for ${name}:`, e.message);
      }
      // Verify deletion
      if (fs.existsSync(profileDir)) {
        console.error(`Profile directory still exists after delete: ${profileDir}`);
        sendJson(res, 500, { error: "Failed to delete profile directory" });
        return;
      }
      console.log(`Deleted profile: ${name}`);
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: Send message to profile agent ──
  const messageMatch = url.pathname.match(/^\/api\/profiles\/([a-z0-9][a-z0-9_-]*)\/message$/);
  if (req.method === "POST" && messageMatch) {
    const name = messageMatch[1];
    try {
      const data = await parseBody(req);
      if (!data.input) {
        sendJson(res, 400, { error: "Message input is required" });
        return;
      }
      const profileDir = getProfileDir(name);
      if (!fs.existsSync(profileDir)) {
        sendJson(res, 404, { error: `Profile '${name}' not found.` });
        return;
      }
      const result = await sendMessageToProfile(name, data.input, data.from || "dashboard");
      sendJson(res, 200, { success: true, ...result });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: Profile health check (pings the profile's gateway) ──
  const healthMatch = url.pathname.match(/^\/api\/profiles\/([a-z0-9][a-z0-9_-]*)\/health$/);
  if (req.method === "GET" && healthMatch) {
    const name = healthMatch[1];
    const port = getProfileApiPort(name);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const resp = await fetch(`http://${WEB_CONTAINER}:${port}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await resp.json().catch(() => ({}));
      sendJson(res, 200, { healthy: resp.ok, port, ...data });
    } catch (e) {
      sendJson(res, 200, { healthy: false, port, error: e.message });
    }
    return;
  }

  // ── API: Direct chat with a profile (dashboard chat interface) ──
  const chatMatch = url.pathname.match(/^\/api\/profiles\/([a-z0-9][a-z0-9_-]*)\/chat$/);
  if (req.method === "POST" && chatMatch) {
    const name = chatMatch[1];
    try {
      const data = await parseBody(req);
      if (!data.message) {
        sendJson(res, 400, { error: "Message is required" });
        return;
      }
      const port = getProfileApiPort(name);
      const start = Date.now();
      // Support conversation threading via previous_response_id
      const body = { input: data.message };
      if (data.previous_response_id) {
        body.previous_response_id = data.previous_response_id;
      }
      const resp = await fetch(`http://${WEB_CONTAINER}:${port}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      const duration = Date.now() - start;
      // Extract text from Responses API output — handles multiple output items with tool calls
      let responseText = "";
      if (Array.isArray(result.output)) {
        for (const item of result.output) {
          if (item.type === "message" && Array.isArray(item.content)) {
            for (const c of item.content) {
              if (c.type === "output_text" || c.type === "text") responseText += (responseText ? "\n" : "") + (c.text || "");
            }
          } else if (typeof item === "string") {
            responseText += (responseText ? "\n" : "") + item;
          }
        }
      }
      if (!responseText) responseText = typeof result.output === "string" ? result.output : JSON.stringify(result);
      sendJson(res, 200, {
        response: responseText,
        response_id: result.id || null,
        duration_ms: duration,
      });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: Get inter-agent comms log ──
  if (req.method === "GET" && url.pathname === "/api/profiles/comms") {
    const limit = parseInt(url.searchParams.get("limit") || "50");
    const log = readCommsLog().slice(-limit);
    sendJson(res, 200, { messages: log });
    return;
  }

  // ── 404 ──
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

// ── Dashboard helpers ────────────────────────────────────────────────────────

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function fmtDate(ts) {
  if (!ts) return "?";
  const dt = new Date(ts * 1000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[dt.getMonth()]} ${dt.getDate()}`;
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("Request error:", err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error" });
    }
  });
});

ensureConfigDir();

// Clean up stale temp files from interrupted imports/exports
try {
  for (const f of fs.readdirSync("/tmp")) {
    if (/^hermes-(import|backup)-\d+\.tar\.gz$/.test(f)) {
      fs.unlinkSync(path.join("/tmp", f));
      console.log(`Cleaned up stale temp file: ${f}`);
    }
  }
} catch (e) {}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Hermes setup server listening on port ${PORT}`);
  console.log(`Configured: ${isConfigured()}`);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  server.close();
  process.exit(0);
});
