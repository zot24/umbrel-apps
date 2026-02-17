const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const net = require('net');

const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'zot24-openclaw_web_1';
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT || '28639', 10);
const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const WEB_CONTAINER = process.env.WEB_CONTAINER || 'zot24-openclaw_web_1';
const PORT = 8080;

const ENV_FILE = path.join(CONFIG_DIR, 'openclaw.env');
const CONFIG_JSON = path.join(CONFIG_DIR, 'openclaw.json');
const SENTINEL = path.join(CONFIG_DIR, '.setup-complete');
const WIZARD_PATH = '/app/wizard.html';

// Ensure config dir and empty env file exist (bootstrap for docker-compose env_file)
try {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(ENV_FILE)) {
    fs.writeFileSync(ENV_FILE, '# OpenClaw configuration\n');
  }
} catch (e) {
  console.error('Failed to bootstrap config:', e.message);
}

function isConfigured() {
  return fs.existsSync(SENTINEL);
}

function readConfig() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
  const cfg = {};
  for (const line of lines) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) cfg[match[1]] = match[2];
  }
  // Map env vars back to form fields
  const provider = cfg.OPENCLAW_PROVIDER || 'anthropic';
  return {
    provider,
    apiKey: cfg.ANTHROPIC_API_KEY || cfg.OPENAI_API_KEY || cfg.OPENROUTER_API_KEY || '',
    model: cfg.OPENCLAW_MODEL || '',
    baseUrl: cfg.OLLAMA_BASE_URL || '',
    telegramToken: cfg.TELEGRAM_BOT_TOKEN || '',
    discordToken: cfg.DISCORD_BOT_TOKEN || '',
    embeddingsKey: provider !== 'openai' ? (cfg.OPENAI_API_KEY || '') : ''
  };
}

function readGatewayToken() {
  // First try openclaw.env (set by setup wizard)
  if (fs.existsSync(ENV_FILE)) {
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^OPENCLAW_GATEWAY_TOKEN=(.+)$/);
      if (match) return match[1];
    }
  }
  // Fallback: read token persisted by OpenClaw itself
  const tokenFile = path.join(CONFIG_DIR, '.gateway_token');
  if (fs.existsSync(tokenFile)) {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  }
  return '';
}

function buildEnvFile(data, gatewayToken) {
  const lines = ['# OpenClaw configuration (managed by setup wizard)'];
  lines.push(`OPENCLAW_PROVIDER=${data.provider}`);
  lines.push(`OPENCLAW_MODEL=${data.model}`);

  switch (data.provider) {
    case 'anthropic':
      lines.push(`ANTHROPIC_API_KEY=${data.apiKey}`);
      break;
    case 'openai':
      lines.push(`OPENAI_API_KEY=${data.apiKey}`);
      break;
    case 'openrouter':
      lines.push(`OPENROUTER_API_KEY=${data.apiKey}`);
      break;
    case 'ollama':
      if (data.baseUrl) lines.push(`OLLAMA_BASE_URL=${data.baseUrl}`);
      break;
  }

  // Embeddings key (only if provider isn't OpenAI)
  if (data.provider !== 'openai' && data.embeddingsKey) {
    lines.push(`OPENAI_API_KEY=${data.embeddingsKey}`);
  }

  if (data.telegramToken) lines.push(`TELEGRAM_BOT_TOKEN=${data.telegramToken}`);
  if (data.discordToken) lines.push(`DISCORD_BOT_TOKEN=${data.discordToken}`);

  lines.push(`OPENCLAW_GATEWAY_TOKEN=${gatewayToken}`);

  return lines.join('\n') + '\n';
}

function writeOpenclawConfig(data, gatewayToken) {
  // Build the model primary string in provider/model format
  const modelPrimary = `${data.provider}/${data.model}`;

  const config = {
    browser: {
      headless: true,
      noSandbox: true,
      defaultProfile: 'openclaw'
    },
    agents: {
      defaults: {
        model: {
          primary: modelPrimary
        }
      }
    },
    ...(data.provider === 'ollama' ? {
      models: {
        mode: 'merge',
        providers: {
          ollama: {
            baseUrl: data.baseUrl || 'http://host.docker.internal:11434/v1',
            apiKey: 'ollama-local',
            api: 'openai-completions',
            models: []
          }
        }
      }
    } : {}),
    gateway: {
      mode: 'local',
      bind: 'lan',
      controlUi: {
        allowInsecureAuth: true
      },
      auth: {
        mode: 'token',
        token: gatewayToken
      }
    }
  };

  fs.writeFileSync(CONFIG_JSON, JSON.stringify(config, null, 2));
}

function restartContainer(callback) {
  const payload = '';
  const reqOptions = {
    socketPath: '/var/run/docker.sock',
    path: `/containers/${WEB_CONTAINER}/restart?t=10`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  };

  const req = http.request(reqOptions, (res) => {
    let body = '';
    res.on('data', (d) => body += d);
    res.on('end', () => {
      if (res.statusCode === 204 || res.statusCode === 200) {
        callback(null);
      } else {
        callback(new Error(`Docker restart returned ${res.statusCode}: ${body}`));
      }
    });
  });
  req.on('error', callback);
  req.end(payload);
}

function proxyRequest(req, res) {
  const token = readGatewayToken();

  // For the root path, redirect to include token if not present
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (token && url.pathname === '/' && !url.searchParams.has('token')) {
    res.writeHead(302, { Location: `/?token=${token}` });
    res.end();
    return;
  }

  const headers = { ...req.headers };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const proxyReq = http.request({
    hostname: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    path: req.url,
    method: req.method,
    headers: headers
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('OpenClaw is not available yet. Try refreshing in a moment.');
  });

  req.pipe(proxyReq, { end: true });
}

function serveWizard(res) {
  fs.readFile(WIZARD_PATH, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Could not load wizard page');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req, callback) {
  let body = '';
  req.on('data', (chunk) => body += chunk);
  req.on('end', () => {
    try {
      callback(null, JSON.parse(body));
    } catch (e) {
      callback(new Error('Invalid JSON'));
    }
  });
}

function checkUpstream(callback) {
  const sock = net.createConnection({ host: UPSTREAM_HOST, port: UPSTREAM_PORT }, () => {
    sock.destroy();
    callback(true);
  });
  sock.on('error', () => callback(false));
  sock.setTimeout(2000, () => { sock.destroy(); callback(false); });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // API: save configuration
  if (url.pathname === '/api/setup' && req.method === 'POST') {
    readBody(req, (err, data) => {
      if (err) return sendJson(res, 400, { error: 'Invalid request body' });

      const validProviders = ['anthropic', 'openai', 'openrouter', 'ollama'];
      if (!validProviders.includes(data.provider)) {
        return sendJson(res, 400, { error: 'Invalid provider' });
      }
      if (data.provider !== 'ollama' && !data.apiKey) {
        return sendJson(res, 400, { error: 'API key is required' });
      }
      if (!data.model) {
        return sendJson(res, 400, { error: 'Model is required' });
      }

      try {
        const gatewayToken = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(ENV_FILE, buildEnvFile(data, gatewayToken));
        writeOpenclawConfig(data, gatewayToken);
        fs.writeFileSync(SENTINEL, new Date().toISOString());
      } catch (e) {
        return sendJson(res, 500, { error: 'Failed to save configuration' });
      }

      restartContainer((restartErr) => {
        if (restartErr) {
          console.error('Container restart error:', restartErr.message);
          return sendJson(res, 500, { error: 'Config saved but failed to restart: ' + restartErr.message });
        }
        sendJson(res, 200, { ok: true });
      });
    });
    return;
  }

  // API: get current config (for pre-filling the form)
  if (url.pathname === '/api/setup' && req.method === 'GET') {
    return sendJson(res, 200, readConfig());
  }

  // API: health check (is upstream ready?)
  if (url.pathname === '/api/health') {
    checkUpstream((ready) => {
      sendJson(res, 200, { ready });
    });
    return;
  }

  // Setup wizard page (always accessible for reconfiguration)
  if (url.pathname === '/setup') {
    return serveWizard(res);
  }

  // Main routing: configured -> proxy, not configured -> wizard
  if (isConfigured()) {
    proxyRequest(req, res);
  } else {
    serveWizard(res);
  }
});

// WebSocket upgrade proxy (critical for Control UI)
server.on('upgrade', (req, socket, head) => {
  if (!isConfigured()) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    return;
  }

  const token = readGatewayToken();

  const proxySocket = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    // Rebuild the upgrade request with auth header
    let requestLine = `${req.method} ${req.url} HTTP/1.1\r\n`;

    const headers = { ...req.headers };
    if (token) {
      headers['authorization'] = `Bearer ${token}`;
    }

    let headerLines = '';
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        value.forEach((v) => (headerLines += `${key}: ${v}\r\n`));
      } else {
        headerLines += `${key}: ${value}\r\n`;
      }
    }

    proxySocket.write(requestLine + headerLines + '\r\n');
    if (head && head.length) {
      proxySocket.write(head);
    }

    // Pipe data between client and upstream
    socket.pipe(proxySocket);
    proxySocket.pipe(socket);
  });

  proxySocket.on('error', (err) => {
    console.error('WebSocket proxy error:', err.message);
    socket.end();
  });

  socket.on('error', (err) => {
    console.error('Client socket error:', err.message);
    proxySocket.end();
  });

  socket.on('close', () => {
    proxySocket.end();
  });

  proxySocket.on('close', () => {
    socket.end();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Setup server listening on port ${PORT}`);
  console.log(`Configured: ${isConfigured()}`);
  console.log(`Upstream: ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
