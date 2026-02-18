<!-- Source: https://getopenclaw.ai/help/dashboard-web-ui-guide, https://getopenclaw.ai/docs/configuration -->

# OpenClaw Web Interfaces

Guide to OpenClaw's web-based interfaces: Control Panel, WebChat, TUI, and remote access.

## Control Panel / Dashboard

The OpenClaw web dashboard is served by the Gateway process at `http://127.0.0.1:18789`.

Features: Channel status monitoring, message history, agent configuration, real-time logs, user management, session inspection.

### Starting

```bash
openclaw gateway start    # Dashboard included by default on gateway port
openclaw gateway          # Run in foreground; dashboard at http://127.0.0.1:18789
```

### Configuration

```json
{
  "web": {
    "control": {
      "enabled": true,
      "auth": { "type": "password", "password": "secure-password" }
    }
  }
}
```

### Checking Connectivity

```bash
openclaw gateway status          # Check if gateway is running
lsof -i :18789                   # macOS/Linux: verify port is listening
netstat -an | grep 18789         # Alternative port check
Get-NetTCPConnection -LocalPort 18789  # Windows PowerShell
```

---

## Webchat

Browser-based chat interface served directly by the Gateway.

**Access**: `http://localhost:18789/chat`

**Important**: WebChat runs on the Gateway port (18789), NOT a separate port. Port 18790 is the Bridge for mobile nodes.

```bash
openclaw gateway              # webchat included by default
openclaw gateway --port 8080  # access at http://localhost:8080/chat
```

### Configuration

```json
{
  "web": {
    "webchat": {
      "enabled": true,
      "title": "My Assistant",
      "theme": "dark",
      "welcomeMessage": "Hello! How can I help?"
    }
  }
}
```

### Docker Access

For Docker, use `bind: "lan"` with authentication:

```json
{
  "gateway": {
    "bind": "lan",
    "auth": { "mode": "token", "token": "your-token" }
  }
}
```

### Embedding

**iframe:**
```html
<iframe src="http://localhost:18789/chat" width="400" height="600"></iframe>
```

**Widget:**
```html
<script src="http://localhost:18789/widget.js"></script>
<script>OpenClawChat.init({ position: 'bottom-right', theme: 'dark' });</script>
```

---

## Terminal UI (TUI)

```bash
openclaw tui
```

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+C` | Exit |
| `Ctrl+L` | Clear screen |
| `Tab` | Switch channel |
| `Up/Down` | Navigate history |
| `?` | Show help |

### Theme Issues

The TUI assumes a dark terminal background. For white-on-white text:
- iTerm2: Preferences > Profiles > Colors (switch to dark)
- Windows Terminal: Settings > Color schemes > One Half Dark
- macOS Terminal: Preferences > Profiles (switch to dark theme)

---

## Remote Access

### SSH Tunnel (Recommended for VMs)

Keep Gateway on loopback in the VM, tunnel from your host:

```bash
ssh -L 18789:127.0.0.1:18789 user@vm-ip
# Then access http://localhost:18789 on your local machine
```

### Tailscale Serve (Recommended for Direct Access)

```bash
openclaw gateway --tailscale serve
# Access via Tailscale MagicDNS URL: https://machine-name.tailnet/
```

Tailscale Serve provides automatic identity-based authentication for tailnet clients. No additional auth configuration needed.

### Tailscale Funnel (Public Access)

```bash
openclaw gateway --tailscale funnel  # Public internet access
```

**Warning**: Requires password authentication for Funnel mode. Use with strong auth!

### Cloudflare Tunnel

```bash
cloudflared tunnel create openclaw
cloudflared tunnel route dns openclaw openclaw.yourdomain.com
cloudflared tunnel run openclaw
```

---

## Security

### HTTPS/TLS

Browsers require HTTPS for remote access due to WebCrypto security constraints. Non-localhost HTTP connections are blocked by browsers.

Solutions:
- Use Tailscale Serve (provides HTTPS automatically)
- Use SSH tunnel (keeps connection as localhost)
- Configure TLS certificates:

```json
{
  "web": {
    "tls": { "enabled": true, "cert": "/path/to/cert.pem", "key": "/path/to/key.pem" }
  }
}
```

### Insecure Auth Mode

For trusted networks only (significantly reduces security):

```json
{
  "gateway": {
    "allowInsecureAuth": true
  }
}
```

### CORS

```json
{
  "web": {
    "cors": { "enabled": true, "origins": ["https://mysite.com"] }
  }
}
```

ClawProxy includes built-in CORS support for browser-based clients.

### Rate Limiting

```json
{
  "web": {
    "rateLimit": { "enabled": true, "windowMs": 60000, "max": 100 }
  }
}
```

### Device Pairing for Remote UI

When accessing the Control UI remotely (via Tailscale, LAN IP, etc.), the browser needs device pairing approval:
- Local `127.0.0.1` connections auto-approve
- Remote connections need explicit approval

```bash
openclaw devices list          # List pending pairing requests
openclaw devices approve <id>  # Approve a remote device
```

---

## WebSocket Issues

### 1006 Abnormal Closure

Indicates unexpected disconnection. Solutions:
1. Restart the Gateway: `openclaw gateway restart`
2. Temporarily disable firewalls for testing
3. Handle usernames with non-ASCII characters
4. Disable antivirus interference

### 1008 Token Mismatch

```
unauthorized: gateway token mismatch (set gateway.remote.token to match gateway.auth.token)
```

Align tokens:
```bash
openclaw config get gateway.auth.token
# Set gateway.remote.token to match
openclaw gateway restart
```

---

## API Keys & Model Configuration

```bash
openclaw config get agents.defaults.model   # Check current model
openclaw auth list                          # List configured API keys
openclaw auth add PROVIDER API_KEY          # Add an API key
```

---

## Upstream Sources

- https://getopenclaw.ai/help/dashboard-web-ui-guide
- https://getopenclaw.ai/docs/configuration
- https://deepwiki.com/openclaw/openclaw/13-deployment
- https://github.com/openclaw/openclaw (README)
