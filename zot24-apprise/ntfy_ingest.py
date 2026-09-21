#!/usr/bin/env python3
"""ntfy-compatible ingest in front of Apprise.

Anything that can POST like ntfy (Komodo's Ntfy alerter, curl, Uptime Kuma,
Home Assistant, …) hits this sidecar. The path is the Apprise config key:

    POST http://apprise-ntfy/<key>
    Title: optional
    body: plain text, or JSON {title, body} / {title, message}

Then this process POSTs {title, body} to Apprise /notify/<key>. Telegram and
every other backend stay configured in Apprise, not in the source app.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


APPRISE_URL = os.environ.get("APPRISE_URL", "http://zot24-apprise_web_1:8000").rstrip(
    "/"
)
DEFAULT_KEY = os.environ.get("DEFAULT_KEY", "notify")
LISTEN_HOST = os.environ.get("LISTEN_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "8080"))

LEVEL_TO_TYPE = {
    "OK": "info",
    "WARNING": "warning",
    "CRITICAL": "failure",
}


def _header(headers: Any, *names: str) -> str:
    for name in names:
        value = headers.get(name) if hasattr(headers, "get") else None
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(headers, dict):
            for key, item in headers.items():
                if str(key).lower() == name.lower() and str(item).strip():
                    return str(item).strip()
    return ""


def _path_key(path: str) -> str:
    raw = urllib.parse.urlparse(path).path
    parts = [p for p in raw.split("/") if p and p not in {"healthz"}]
    if not parts:
        return ""
    return parts[0]


def _is_komodo_alert(obj: dict[str, Any]) -> bool:
    data = obj.get("data")
    return isinstance(data, dict) and "type" in data and "level" in obj


def _event(alert: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    data = alert.get("data")
    if not isinstance(data, dict):
        return "Unknown", {}
    event = data.get("type") or "Unknown"
    payload = data.get("data")
    if not isinstance(payload, dict):
        payload = {}
    return str(event), payload


def _version(value: Any) -> str | None:
    if isinstance(value, dict) and {"major", "minor", "patch"} <= value.keys():
        return f"{value['major']}.{value['minor']}.{value['patch']}"
    if value is None:
        return None
    return str(value)


def format_komodo_alert(alert: dict[str, Any]) -> dict[str, str]:
    """Optional: Komodo Custom JSON still works if something POSTs that."""
    level = str(alert.get("level") or "OK")
    resolved = bool(alert.get("resolved"))
    event, payload = _event(alert)

    title_parts = [f"[{level}]", event]
    body_parts: list[str] = []
    if resolved:
        body_parts.append("resolved")

    name = payload.get("name")
    if isinstance(name, str) and name:
        body_parts.append(f"for {name}")
    server_name = payload.get("server_name")
    if isinstance(server_name, str) and server_name:
        body_parts.append(f"on {server_name}")
    swarm_name = payload.get("swarm_name")
    if isinstance(swarm_name, str) and swarm_name:
        body_parts.append(f"swarm {swarm_name}")

    if event == "ServerCpu" and "percentage" in payload:
        body_parts.append(f"CPU {payload['percentage']}%")
    elif event == "ServerMem" and "used_gb" in payload and "total_gb" in payload:
        body_parts.append(f"memory {payload['used_gb']}/{payload['total_gb']} GiB")
    elif event == "ServerDisk":
        path = payload.get("path", "")
        body_parts.append(
            f"disk {path} {payload.get('used_gb')}/{payload.get('total_gb')} GiB"
        )
    elif event in {"StackImageUpdateAvailable", "DeploymentImageUpdateAvailable"}:
        if payload.get("service"):
            body_parts.append(f"service {payload['service']}")
        if payload.get("image"):
            body_parts.append(f"image {payload['image']}")
    elif event in {"StackAutoUpdated", "DeploymentAutoUpdated"}:
        images = payload.get("images")
        if isinstance(images, list) and images:
            body_parts.append("updated " + ", ".join(str(x) for x in images))
        elif payload.get("image"):
            body_parts.append(f"updated {payload['image']}")
    elif event == "Test":
        body_parts.append("alerter test")
    else:
        if "from" in payload and "to" in payload:
            body_parts.append(f"{payload['from']} -> {payload['to']}")
        version = _version(payload.get("version"))
        if version:
            body_parts.append(f"version {version}")
        err = payload.get("err")
        if isinstance(err, dict) and err.get("error"):
            body_parts.append(str(err["error"]))
        elif isinstance(err, str) and err:
            body_parts.append(err)
        message = payload.get("message")
        if (
            isinstance(message, str)
            and message
            and event != "AwsBuilderTerminationFailed"
        ):
            body_parts.append(message)
        details = payload.get("details")
        if isinstance(details, str) and details.strip():
            body_parts.append(details.strip())

    body = "\n".join(part for part in body_parts if part).strip()
    if not body:
        body = event
    return {
        "title": " ".join(title_parts),
        "body": body,
        "type": LEVEL_TO_TYPE.get(level, "info"),
    }


def parse_publish(
    path: str, headers: Any, raw: bytes
) -> tuple[str, dict[str, str]]:
    """Return (apprise_key, {title, body, type}) from an ntfy-shaped request."""
    path_key = _path_key(path)
    title = _header(headers, "X-Title", "Title", "ti", "t")
    header_body = _header(headers, "X-Message", "Message", "m")
    text = raw.decode("utf-8", errors="replace") if raw else ""

    obj: Any = None
    stripped = text.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError:
            obj = None

    if isinstance(obj, dict) and _is_komodo_alert(obj):
        payload = format_komodo_alert(obj)
        key = path_key or str(obj.get("topic") or "") or DEFAULT_KEY
        return key, payload

    if isinstance(obj, dict):
        key = (
            path_key
            or str(obj.get("topic") or "")
            or DEFAULT_KEY
        )
        body = (
            obj.get("body")
            or obj.get("message")
            or obj.get("text")
            or header_body
            or ""
        )
        title = str(obj.get("title") or title)
        ntype = str(obj.get("type") or "info")
        body_s = str(body).strip()
        if not body_s:
            raise ValueError("missing body")
        return key, {
            "title": title or key,
            "body": body_s,
            "type": ntype,
        }

    key = path_key or DEFAULT_KEY
    body = (text or header_body).strip()
    if not body:
        raise ValueError("missing body")
    return key, {
        "title": title or key,
        "body": body,
        "type": "info",
    }


def post_apprise(key: str, payload: dict[str, str]) -> tuple[int, str]:
    url = f"{APPRISE_URL}/notify/{urllib.parse.quote(key, safe='')}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return exc.code, body


class Handler(BaseHTTPRequestHandler):
    server_version = "apprise-ntfy-ingest/1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _write(self, status: int, body: bytes, content_type: str = "text/plain") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] in {"/", "/healthz"}:
            self._write(200, b"ok\n")
            return
        self._write(404, b"not found\n")

    def do_POST(self) -> None:  # noqa: N802
        self._publish()

    def do_PUT(self) -> None:  # noqa: N802
        self._publish()

    def _publish(self) -> None:
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length) if length else b""
        try:
            key, payload = parse_publish(self.path, self.headers, raw)
        except ValueError as exc:
            self._write(400, str(exc).encode("utf-8") + b"\n")
            return
        status, body = post_apprise(key, payload)
        if 200 <= status < 300:
            self._write(204, b"")
            return
        msg = f"apprise {status}: {body}\n".encode("utf-8")
        self._write(502, msg)


def main() -> None:
    httpd = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    sys.stderr.write(
        f"ntfy ingest listening on {LISTEN_HOST}:{LISTEN_PORT} -> {APPRISE_URL}/notify/<key>\n"
    )
    httpd.serve_forever()


if __name__ == "__main__":
    main()
