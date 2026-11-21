#!/usr/bin/env python3
"""Static file server for the AIR/Ruffle page.

The repository root is served as-is, so the page can reference:

  * ``/index.html``                                     - the launcher
  * ``/backend/*.js``                                   - the emulated backend
  * ``/ruffle-air/web/packages/selfhosted/dist/*``      - the Ruffle build
  * ``/hmi/...``                                        - the local AIR application

Python's ``http.server`` does not know about ``.wasm`` (Ruffle refuses to
instantiate the module when it is served as ``text/plain``), so the MIME table
is extended below.
"""

from __future__ import annotations

import argparse
import http.server
import socket
import sys
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".swf": "application/x-shockwave-flash",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".xml": "application/xml; charset=utf-8",
        ".data": "application/octet-stream",
    }

    def end_headers(self) -> None:
        # Ruffle is rebuilt often; never let the browser cache a stale wasm/js.
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt: str, *args: object) -> None:
        # Keep the terminal for the important bits (the server URL and errors).
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1", help="address to bind")
    parser.add_argument("--port", type=int, default=8000, help="port to bind")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    handler = partial(Handler, directory=str(ROOT))

    try:
        server = http.server.ThreadingHTTPServer((args.host, args.port), handler)
    except OSError as error:
        print(f"cannot listen on {args.host}:{args.port}: {error}", file=sys.stderr)
        return 1

    host = args.host
    if host in ("0.0.0.0", "::"):
        host = socket.gethostname()

    print(f"serving {ROOT}", flush=True)
    print(f"open http://{host}:{args.port}/", flush=True)
    print("press Ctrl+C to stop", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
