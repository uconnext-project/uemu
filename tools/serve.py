#!/usr/bin/env python3
"""Static file server for the AIR/Ruffle page.

The repository root is served as-is, so the page can reference:

  * ``/index.html``                                     - the launcher
  * ``/backend/*.js``                                   - the emulated backend
  * ``/ruffle-air/web/packages/selfhosted/dist/*``      - the Ruffle build
  * ``/hmi/...``                                        - the local AIR application
  * ``/xlets/...`` and ``/seed/...``                    - KIM1 xlets + CheerpJ seeds

Python's ``http.server`` does not know about ``.wasm`` (Ruffle refuses to
instantiate the module when it is served as ``text/plain``), so the MIME table
is extended below.  CheerpJ also loads its runtime JARs with HTTP ``Range``
requests, hence the small ``206 Partial Content`` implementation.
"""

from __future__ import annotations

import argparse
import http.server
import os
import socket
import sys
import urllib.parse
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class RangeFile:
    """Read at most ``length`` bytes from an already-seeked file object."""

    def __init__(self, file, length: int) -> None:
        self._file = file
        self._left = length

    def read(self, size: int = -1) -> bytes:
        if self._left <= 0:
            return b""
        if size is None or size < 0 or size > self._left:
            size = self._left
        data = self._file.read(size)
        self._left -= len(data)
        return data

    def close(self) -> None:
        self._file.close()

    def __getattr__(self, name):
        return getattr(self._file, name)


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
        ".jar": "application/java-archive",
        ".png": "image/png",
        ".properties": "text/plain; charset=utf-8",
    }

    def end_headers(self) -> None:
        # Ruffle/xlets are rebuilt often; never let the browser cache stale
        # wasm/js/jars.
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt: str, *args: object) -> None:
        # Keep the terminal for the important bits (the server URL and errors).
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)

    def send_head(self):
        """Like ``SimpleHTTPRequestHandler.send_head`` + single byte ranges."""
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            parts = urllib.parse.urlsplit(self.path)
            if not parts.path.endswith("/"):
                parts = (parts[0], parts[1], parts[2] + "/", parts[3], parts[4])
                self.send_response(301)
                self.send_header("Location", urllib.parse.urlunsplit(parts))
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None
            for index in ("index.html", "index.htm"):
                candidate = os.path.join(path, index)
                if os.path.isfile(candidate):
                    path = candidate
                    break
            else:
                return self.list_directory(path)

        content_type = self.guess_type(path)
        try:
            file = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        try:
            stat = os.fstat(file.fileno())
            size = stat.st_size
            start, end = 0, size - 1
            status = 200

            parsed = self._parse_range(size)
            if parsed == "invalid":
                file.close()
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None
            if parsed is not None:
                start, end = parsed
                status = 206

            length = max(0, end - start + 1) if size else 0
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Accept-Ranges", "bytes")
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(length))
            self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
            self.end_headers()

            if status == 206:
                file.seek(start)
                return RangeFile(file, length)
            return file
        except Exception:
            file.close()
            raise

    def _parse_range(self, size: int):
        """Return ``(start, end)``, ``None`` or ``"invalid"``.

        Only the first range of a multi-range request is honoured; CheerpJ and
        browsers only use single ranges for media/JAR loading.
        """
        header = self.headers.get("Range")
        if not header or not header.startswith("bytes="):
            return None
        spec = header[6:].split(",", 1)[0].strip()
        if "-" not in spec:
            return "invalid"
        first, _, last = spec.partition("-")
        try:
            if first == "":
                # suffix-byte-range-spec: last N bytes
                suffix = int(last)
                if suffix <= 0 or size == 0:
                    return "invalid"
                start = max(0, size - suffix)
                end = size - 1
            else:
                start = int(first)
                end = int(last) if last else size - 1
        except ValueError:
            return "invalid"
        if start < 0 or start >= size or end < start:
            return "invalid"
        return start, min(end, size - 1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1", help="address to bind")
    parser.add_argument("--port", type=int, default=8000, help="port to bind")
    parser.add_argument(
        "--directory",
        default=str(ROOT),
        help="directory to serve (default: the repository root)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    directory = Path(args.directory).expanduser().resolve()
    if not directory.is_dir():
        print(f"not a directory: {directory}", file=sys.stderr)
        return 1
    handler = partial(Handler, directory=str(directory))

    try:
        server = http.server.ThreadingHTTPServer((args.host, args.port), handler)
    except OSError as error:
        print(f"cannot listen on {args.host}:{args.port}: {error}", file=sys.stderr)
        return 1

    host = args.host
    if host in ("0.0.0.0", "::"):
        host = socket.gethostname()

    print(f"serving {directory}", flush=True)
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
