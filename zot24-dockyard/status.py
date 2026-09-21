#!/usr/bin/env python3
"""Dockyard status page: is the nested Docker healthy, and what's running.

Reads the dind daemon's socket (Engine API over a unix socket, stdlib only)
and renders one small HTML page. No external dependencies, no framework.
"""
import http.server, socket, http.client, json, os, html

DOCKER_SOCK = os.environ.get("DOCKER_SOCK", "/data/docker.sock")
PORT = int(os.environ.get("PORT", "8080"))


class UnixConn(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost")
        self._path = path
    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(5)
        s.connect(self._path)
        self.sock = s


def docker(path):
    """GET the Engine API over the unix socket; return (status, raw bytes)."""
    c = UnixConn(DOCKER_SOCK)
    c.request("GET", path)
    r = c.getresponse()
    data = r.read()
    c.close()
    return r.status, data


def docker_json(path):
    status, data = docker(path)
    if status != 200:
        raise RuntimeError(f"docker {path} -> HTTP {status}: {data[:200]!r}")
    return json.loads(data)


def snapshot():
    status, _ = docker("/_ping")  # raises (connection error) if daemon is down
    if status != 200:
        raise RuntimeError(f"ping -> HTTP {status}")
    all_c = docker_json("/containers/json?all=1")
    running = [c for c in all_c if c.get("State") == "running"]
    return all_c, running


def page():
    try:
        all_c, running = snapshot()
    except Exception as e:
        return 503, render_error(e)
    rows = ""
    for c in sorted(all_c, key=lambda x: (x.get("State") != "running", x.get("Names", [""])[0])):
        name = html.escape((c.get("Names") or ["?"])[0].lstrip("/"))
        state = c.get("State", "?")
        status = html.escape(c.get("Status", ""))
        image = html.escape((c.get("Image") or "").split("@")[0])
        dot = "#5eead4" if state == "running" else "#f59e0b" if state in ("created", "restarting", "paused") else "#ef4444"
        rows += f'<tr><td><span class="dot" style="background:{dot}"></span>{name}</td><td>{html.escape(state)}</td><td>{status}</td><td class="img">{image}</td></tr>'
    return 200, render(len(running), len(all_c), rows)


def render(running, total, rows):
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Dockyard</title>
<style>
:root{{color-scheme:dark}}
body{{margin:0;background:#0e1613;color:#d4e0d8;font:15px/1.5 system-ui,sans-serif}}
.wrap{{max-width:760px;margin:0 auto;padding:40px 20px}}
h1{{font-size:26px;margin:0 0 2px;color:#eafff6}}
.sub{{color:#7a8e82;margin:0 0 28px}}
.cards{{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:28px}}
.card{{flex:1;min-width:150px;background:#16211d;border:1px solid #24352f;border-radius:14px;padding:18px}}
.card .n{{font-size:34px;font-weight:700;color:#5eead4}}
.card .l{{color:#7a8e82;font-size:13px;text-transform:uppercase;letter-spacing:.05em}}
.ok{{color:#5eead4}}
table{{width:100%;border-collapse:collapse;background:#16211d;border:1px solid #24352f;border-radius:14px;overflow:hidden}}
th,td{{text-align:left;padding:10px 14px;border-bottom:1px solid #1d2b26;font-size:14px}}
th{{color:#7a8e82;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em}}
tr:last-child td{{border-bottom:none}}
.dot{{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:9px;vertical-align:middle}}
.img{{color:#7a8e82;font-size:12px}}
.foot{{color:#4a5a52;font-size:12px;margin-top:22px}}
</style></head><body><div class="wrap">
<h1>Dockyard</h1>
<p class="sub">Isolated Docker host · <span class="ok">healthy</span></p>
<div class="cards">
  <div class="card"><div class="n">{running}</div><div class="l">Running</div></div>
  <div class="card"><div class="n">{total}</div><div class="l">Total containers</div></div>
</div>
<table><thead><tr><th>Container</th><th>State</th><th>Status</th><th>Image</th></tr></thead>
<tbody>{rows or '<tr><td colspan=4 style="color:#7a8e82">Nothing deployed yet.</td></tr>'}</tbody></table>
<p class="foot">Auto-refreshes every 15s · reads the isolated daemon, not the host.</p>
</div><script>setTimeout(()=>location.reload(),15000)</script></body></html>"""


def render_error(e):
    return f"""<!doctype html><meta charset="utf-8"><title>Dockyard</title>
<body style="margin:0;background:#0e1613;color:#d4e0d8;font:15px system-ui,sans-serif">
<div style="max-width:600px;margin:60px auto;padding:20px">
<h1 style="color:#ef4444">Dockyard: daemon unreachable</h1>
<p style="color:#7a8e82">The nested Docker isn't answering yet. It may be starting.</p>
<pre style="color:#7a8e82;font-size:12px">{html.escape(str(e))}</pre>
<script>setTimeout(()=>location.reload(),10000)</script></div></body>"""


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        code, body = page()
        b = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def log_message(self, *a):  # quiet
        pass


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
