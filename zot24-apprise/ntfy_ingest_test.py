#!/usr/bin/env python3
"""Tests for ntfy ingest. Stdlib only."""

from __future__ import annotations

import json
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import ntfy_ingest
from ntfy_ingest import Handler, parse_publish


class ParsePublishTest(unittest.TestCase):
    def test_ntfy_plain_text_topic_path(self) -> None:
        key, payload = parse_publish(
            "/alerts",
            {"Title": "disk"},
            b"root is 92% full",
        )
        self.assertEqual(key, "alerts")
        self.assertEqual(payload["title"], "disk")
        self.assertEqual(payload["body"], "root is 92% full")
        self.assertEqual(payload["type"], "info")

    def test_ntfy_json_with_topic(self) -> None:
        key, payload = parse_publish(
            "/",
            {},
            json.dumps(
                {"topic": "uptime", "title": "down", "message": "nas is unreachable"}
            ).encode(),
        )
        self.assertEqual(key, "uptime")
        self.assertEqual(payload["title"], "down")
        self.assertEqual(payload["body"], "nas is unreachable")

    def test_json_title_body_uses_path_as_key(self) -> None:
        key, payload = parse_publish(
            "/home",
            {},
            json.dumps({"title": "door", "body": "front opened"}).encode(),
        )
        self.assertEqual(key, "home")
        self.assertEqual(payload["title"], "door")
        self.assertEqual(payload["body"], "front opened")

    def test_komodo_custom_json_still_maps(self) -> None:
        key, payload = parse_publish(
            "/alerts",
            {},
            json.dumps(
                {
                    "level": "OK",
                    "resolved": True,
                    "data": {
                        "type": "StackAutoUpdated",
                        "data": {
                            "name": "medivault",
                            "images": ["ghcr.io/zot24/medivault:0.4.1"],
                        },
                    },
                }
            ).encode(),
        )
        self.assertEqual(key, "alerts")
        self.assertEqual(payload["title"], "[OK] StackAutoUpdated")
        self.assertIn("updated ghcr.io/zot24/medivault:0.4.1", payload["body"])

    def test_missing_body_rejected(self) -> None:
        with self.assertRaises(ValueError):
            parse_publish("/alerts", {}, b"")


class IngestHttpTest(unittest.TestCase):
    def setUp(self) -> None:
        self.received: list[dict] = []
        parent = self

        class FakeApprise(BaseHTTPRequestHandler):
            def log_message(self, fmt: str, *args: object) -> None:
                return

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(length)
                parent.received.append(
                    {"path": self.path, "body": json.loads(raw.decode("utf-8"))}
                )
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"error": null}')

        self.apprise = ThreadingHTTPServer(("127.0.0.1", 0), FakeApprise)
        threading.Thread(target=self.apprise.serve_forever, daemon=True).start()
        host, port = self.apprise.server_address[:2]
        ntfy_ingest.APPRISE_URL = f"http://{host}:{port}"

        self.ingest = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.ingest.serve_forever, daemon=True).start()
        ahost, aport = self.ingest.server_address[:2]
        self.base = f"http://{ahost}:{aport}"

    def tearDown(self) -> None:
        self.ingest.shutdown()
        self.apprise.shutdown()

    def test_healthz(self) -> None:
        with urllib.request.urlopen(self.base + "/healthz", timeout=2) as resp:
            self.assertEqual(resp.status, 200)

    def test_forwards_ntfy_post_to_matching_apprise_key(self) -> None:
        req = urllib.request.Request(
            self.base + "/alerts",
            data=b"stack medivault auto-updated",
            method="POST",
            headers={"Title": "Komodo Alert"},
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            self.assertEqual(resp.status, 204)
        self.assertEqual(self.received[0]["path"], "/notify/alerts")
        self.assertEqual(self.received[0]["body"]["title"], "Komodo Alert")
        self.assertEqual(self.received[0]["body"]["body"], "stack medivault auto-updated")


if __name__ == "__main__":
    unittest.main()
