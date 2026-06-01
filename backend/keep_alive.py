"""
Render free-tier keep-alive service.

Keeps the service warm by pinging the public /api/health endpoint from a
background daemon thread. This is intentionally lightweight and only enables
itself on Render when a public URL is configured.
"""

from __future__ import annotations

import os
import threading
import time
from datetime import datetime
from urllib.error import URLError, HTTPError
from urllib.request import Request, urlopen


DEFAULT_INTERVAL_SECONDS = 14 * 60
INITIAL_DELAY_SECONDS = 60

_keep_alive_service = None


class KeepAliveService:
    def __init__(self, app_url: str | None = None, interval: int = DEFAULT_INTERVAL_SECONDS):
        self.app_url = (app_url or os.getenv("RENDER_EXTERNAL_URL") or "").rstrip("/")
        self.interval = max(60, int(interval))
        self.running = False
        self.thread: threading.Thread | None = None

    def ping(self) -> bool:
        if not self.app_url:
            print("Keep-alive: no RENDER_EXTERNAL_URL configured; skipping ping")
            return False

        url = f"{self.app_url}/api/health"
        req = Request(url, headers={"User-Agent": "dcw-siop-keepalive/1.0"})

        try:
            with urlopen(req, timeout=10) as response:
                ok = 200 <= getattr(response, "status", 0) < 300
                if ok:
                    print(f"Keep-alive ping successful at {datetime.now().isoformat(timespec='seconds')}")
                    return True
                print(f"Keep-alive ping returned status {getattr(response, 'status', 'unknown')}")
                return False
        except HTTPError as exc:
            print(f"Keep-alive ping failed with HTTP {exc.code}")
            return False
        except URLError as exc:
            print(f"Keep-alive ping failed: {exc}")
            return False
        except Exception as exc:  # pylint: disable=broad-except
            print(f"Keep-alive ping error: {exc}")
            return False

    def _run(self) -> None:
        print(f"Keep-alive service started. Pinging {self.app_url or '<unset>'} every {self.interval / 60:.1f} minutes")
        time.sleep(INITIAL_DELAY_SECONDS)
        while self.running:
            self.ping()
            time.sleep(self.interval)

    def start(self) -> None:
        if self.running:
            print("Keep-alive service already running")
            return
        if not self.app_url:
            print("Keep-alive service not started: set RENDER_EXTERNAL_URL to the public Render URL")
            return

        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True, name="render-keep-alive")
        self.thread.start()
        print("Keep-alive service thread started")


def init_keep_alive(app_url: str | None = None, interval: int = DEFAULT_INTERVAL_SECONDS):
    global _keep_alive_service

    if not os.getenv("RENDER"):
        print("Keep-alive disabled: not running on Render")
        return None

    if _keep_alive_service is None:
        _keep_alive_service = KeepAliveService(app_url=app_url, interval=interval)
        _keep_alive_service.start()

    return _keep_alive_service


def get_keep_alive_service():
    return _keep_alive_service
