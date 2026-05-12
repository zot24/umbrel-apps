# Playwright Renderer

A project-agnostic residential headless-browser HTTP service for
[Umbrel](https://umbrel.com). It wraps Playwright + Chromium in a tiny
Express server and exposes a `POST /render` endpoint via a Cloudflare Tunnel,
so any client with the right bearer token can fetch fully rendered HTML from
your home Internet connection.

It's a drop-in alternative to Cloudflare Browser Rendering or paid scraping
APIs for sites that fingerprint or block datacenter IPs.

## How it's wired

```
   client (e.g. a Cloudflare Worker)
              |
              v   https://playwright.<your-domain>/render
   Cloudflare Tunnel  ──► cloudflared (in this app)
                          |
                          v
                       playwright service  ──► chromium
                       (Express on :3030)
```

The `app_proxy` Umbrel sidecar fronts the service for the Umbrel dashboard,
and `cloudflared` exposes it to the public Internet via a Cloudflare Tunnel.
The renderer itself enforces bearer-token auth on every `/render` call.

## Prerequisites

- Umbrel installed (this community app store added).
- A domain managed by Cloudflare (free plan is fine).
- The ability to create a Tunnel in
  [Cloudflare Zero Trust](https://one.dash.cloudflare.com).

## One-time Cloudflare setup

1. In the Cloudflare Zero Trust dashboard, go to **Networks → Tunnels →
   Create a tunnel** (cloudflared connector).
2. Name it `playwright-renderer` (or anything you like) and copy the
   **Tunnel token** Cloudflare shows you (it's a long opaque string starting
   with `eyJ...`). Save this; you'll paste it into the Umbrel app config.
3. On the next screen, add a **Public Hostname**:
   - Subdomain: `playwright`
   - Domain: your domain
   - Service type: `HTTP`
   - URL: `playwright:3030`
4. Save. Cloudflare will create the DNS record automatically.

## Generate a renderer token

The bearer token clients must send on every `/render` call. Generate one:

```bash
openssl rand -hex 32
```

Save the output — both this Umbrel app and any client (e.g. your scraper
Worker) need it. Treat it like any other secret.

## Installing on Umbrel

Add this community app store to Umbrel (`App Store → Community App Stores →
Add → https://github.com/zot24/umbrel-apps`), then install **Playwright
Renderer**. During install you'll be prompted for two env values:

| Env var          | What to paste                                        |
|------------------|------------------------------------------------------|
| `RENDERER_TOKEN` | The token from `openssl rand -hex 32` above          |
| `TUNNEL_TOKEN`   | The Cloudflare Tunnel token from step 2 above        |

## Verifying it works

From any machine on the Internet:

```bash
curl -sS -X POST https://playwright.<your-domain>/render \
  -H "Authorization: Bearer $RENDERER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}' | jq
```

Expected output (truncated):

```json
{
  "success": true,
  "result": "<!doctype html>\n<html>\n<head>\n    <title>Example Domain</title>...",
  "finalUrl": "https://example.com/",
  "statusCode": 200
}
```

Health check (no auth required):

```bash
curl https://playwright.<your-domain>/health
# {"ok":true}
```

## API reference

### `POST /render`

Auth: `Authorization: Bearer <RENDERER_TOKEN>` (required).

**Request body** (JSON):

```jsonc
{
  "url": "https://example.com",            // required, http(s) URL
  "gotoOptions": {                          // optional
    "waitUntil": "networkidle0",           // load | domcontentloaded | networkidle0 | networkidle2
    "timeout": 30000                        // ms, clamped to 5000-60000
  },
  "waitForSelector": ".some-el",            // optional CSS selector to await
  "viewport": { "width": 1280, "height": 800 },  // optional
  "userAgent": "Mozilla/5.0 ..."            // optional
}
```

`waitUntil` accepts both Puppeteer-style (`networkidle0`, `networkidle2`) and
Playwright-style (`networkidle`, `load`, `domcontentloaded`) values. Aliases
map to Playwright's `networkidle`.

**Response body** (JSON):

```jsonc
{
  "success": true,
  "result": "<rendered html string>",
  "finalUrl": "https://example.com/after-redirects",
  "statusCode": 200
}
```

**Error responses**:

| Status | When                                          | Body                                       |
|--------|-----------------------------------------------|--------------------------------------------|
| `401`  | Missing or wrong bearer token                 | `{ "success": false, "error": "unauthorized" }` |
| `422`  | Invalid JSON body or missing/invalid `url`    | `{ "success": false, "error": "..." }`     |
| `502`  | Chromium failed to launch                     | `{ "success": false, "error": "renderer unavailable" }` |
| `504`  | Page load or `waitForSelector` timed out      | `{ "success": false, "error": "render timeout: ..." }`  |
| `500`  | Any other render error                        | `{ "success": false, "error": "..." }`     |

### `GET /health`

No auth. Returns `{ "ok": true }`. Used by Umbrel and Cloudflare for liveness
probes.

## Local development

You can run just the renderer (no Cloudflare Tunnel) for quick iteration:

```bash
cd zot24-playwright-renderer
RENDERER_TOKEN=dev-token-change-me docker-compose -f docker-compose.local.yml up --build

# in another terminal
curl -X POST http://localhost:3030/render \
  -H "Authorization: Bearer dev-token-change-me" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

The unit tests stub Playwright and run in milliseconds (no Chromium needed):

```bash
cd zot24-playwright-renderer/playwright-server
npm install
npm test
```

## Security notes

- **The bearer token is the only thing between the public Internet and a
  full Chromium instance running on your home network.** Use a long, random
  value (`openssl rand -hex 32`), rotate it if it leaks, and never commit it.
- The renderer can fetch arbitrary URLs — anyone who has the token can ask it
  to load a URL. This is mostly fine (Cloudflare won't let you `file://`,
  there's no SSRF into your local LAN by default because the container is
  not on the host network), but if you need stricter controls consider:
  - Putting **Cloudflare Access** in front of the Tunnel hostname with a
    service-token policy, so a missing service token is rejected at the
    edge before traffic ever reaches your home.
  - An allowlist of target hostnames in the renderer itself (not implemented
    in v0.1 — open an issue if you want it).
- A persistent Docker volume is mounted at `/data` for future
  `storageState.json` cookie persistence (e.g. a one-time login flow on a
  site that's gone login-gated). It's empty in v0.1.

## Troubleshooting

- **`401 unauthorized`** — the bearer token sent doesn't match `RENDERER_TOKEN`
  in the app config. Check both ends.
- **`502 renderer unavailable`** — Chromium couldn't launch. Check the
  `playwright` container logs in the Umbrel app's logs view.
- **`504 render timeout`** — the page didn't reach `networkidle` (or your
  `waitForSelector` didn't match) within the timeout. Increase
  `gotoOptions.timeout` (max 60s) or simplify your selector.
- **Tunnel down** — check `cloudflared` container logs and the Tunnel status
  in the Cloudflare Zero Trust dashboard.
