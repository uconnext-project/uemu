#!/usr/bin/env python3
"""Temporary WebSocket <-> TCP bridge for Ruffle's `flash.net.Socket`/`XMLSocket`.

Browsers cannot open raw TCP connections, so Ruffle's web navigator implements
sockets by connecting to a WebSocket proxy instead. This script is such a proxy:
every WebSocket client gets its own TCP connection to the configured backend,
and bytes are forwarded in both directions without any framing changes.

The matching Ruffle config entry looks like this:

    socketProxy: [
        { host: "127.0.0.1", port: 4400, proxyUrl: "ws://127.0.0.1:4402/" },
    ]

`host`/`port` are what the SWF connects to, `proxyUrl` is where this script
listens. The demo app already sets this up for 127.0.0.1:4400; see
`ruffle-air/web/packages/demo/src/main.tsx`.

Examples:

    # WebSocket on :4402, TCP backend on 127.0.0.1:4400
    python3 tools/ws_tcp_bridge.py

    # Different ports / a remote backend
    python3 tools/ws_tcp_bridge.py --ws-port 9001 --tcp-host 10.0.0.5 --tcp-port 5000

    # No backend yet: echo everything back (useful to smoke-test the WebSocket)
    python3 tools/ws_tcp_bridge.py --echo
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import signal
import sys
from typing import Any

try:
    from websockets.asyncio.server import ServerConnection, serve
except ImportError:  # pragma: no cover - helpful message for older versions
    sys.exit(
        "This script requires the 'websockets' package (>= 13.0):\n"
        "    python3 -m pip install websockets"
    )

LOG = logging.getLogger("ws-tcp-bridge")

# XMLSocket terminates every XML document with a NUL byte, and HMI payloads can
# be a few dozen KiB, so don't let websockets reject large messages.
MAX_MESSAGE_SIZE = 16 * 1024 * 1024


def preview(data: bytes, limit: int = 160) -> str:
    """Return a readable one-line representation of a payload."""
    chunk = data[:limit]
    try:
        text = chunk.decode("utf-8")
    except UnicodeDecodeError:
        return chunk.hex(" ") + (" ..." if len(data) > limit else "")

    if all(char.isprintable() or char in "\r\n\t" for char in text):
        return repr(text) + (" ..." if len(data) > limit else "")
    return chunk.hex(" ") + (" ..." if len(data) > limit else "")


def log_payload(direction: str, data: bytes) -> None:
    LOG.info("[%s] %d bytes: %s", direction, len(data), preview(data))


class Bridge:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.clients = 0

    async def handle(self, ws: ServerConnection) -> None:
        self.clients += 1
        peer = ws.remote_address
        LOG.info("[+] ws client %s:%s connected (clients: %d)", peer[0], peer[1], self.clients)

        try:
            if self.args.echo:
                await self.echo(ws)
            else:
                await self.forward(ws)
        finally:
            self.clients -= 1
            LOG.info("[+] ws client %s:%s disconnected", peer[0], peer[1])

    async def echo(self, ws: ServerConnection) -> None:
        async for message in ws:
            data = message.encode() if isinstance(message, str) else message
            log_payload("ws -> ws (echo)", data)
            await ws.send(data)

    async def forward(self, ws: ServerConnection) -> None:
        try:
            reader, writer = await asyncio.open_connection(
                self.args.tcp_host, self.args.tcp_port
            )
        except OSError as error:
            LOG.error(
                "[-] cannot connect to tcp %s:%s: %s",
                self.args.tcp_host,
                self.args.tcp_port,
                error,
            )
            await ws.close(code=1011, reason="tcp connect failed")
            return

        LOG.info("[+] tcp connected to %s:%s", self.args.tcp_host, self.args.tcp_port)

        tasks = {
            asyncio.create_task(self.tcp_to_ws(reader, ws)),
            asyncio.create_task(self.ws_to_tcp(ws, writer)),
        }
        try:
            done, pending = await asyncio.wait(
                tasks, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            for task in done | pending:
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                except Exception as error:  # report, but keep the bridge alive
                    LOG.debug("pump task ended with %r", error)
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()
            LOG.info("[+] tcp connection closed")

    async def tcp_to_ws(self, reader: asyncio.StreamReader, ws: ServerConnection) -> None:
        while True:
            data = await reader.read(65536)
            if not data:
                LOG.info("[-] tcp eof")
                return
            log_payload("tcp -> ws", data)
            await ws.send(data)

    async def ws_to_tcp(self, ws: ServerConnection, writer: asyncio.StreamWriter) -> None:
        try:
            async for message in ws:
                data = message.encode() if isinstance(message, str) else message
                log_payload("ws -> tcp", data)
                writer.write(data)
                await writer.drain()
        except Exception as error:  # ConnectionClosed etc.
            LOG.debug("ws read ended: %r", error)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Temporary WebSocket <-> TCP bridge for Ruffle sockets.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--ws-host", default="127.0.0.1", help="address to listen on")
    parser.add_argument("--ws-port", type=int, default=4402, help="WebSocket port")
    parser.add_argument(
        "--tcp-host", default="127.0.0.1", help="TCP backend address"
    )
    parser.add_argument("--tcp-port", type=int, default=4400, help="TCP backend port")
    parser.add_argument(
        "--echo",
        action="store_true",
        help="do not use TCP; echo every WebSocket message back",
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true", help="enable debug logging"
    )
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    bridge = Bridge(args)
    if args.echo:
        LOG.info("echo mode: no TCP backend, ws://%s:%d/", args.ws_host, args.ws_port)
    else:
        LOG.info(
            "bridging ws://%s:%d/ <-> tcp://%s:%d",
            args.ws_host,
            args.ws_port,
            args.tcp_host,
            args.tcp_port,
        )

    stop: asyncio.Future[Any] = asyncio.get_running_loop().create_future()

    def request_stop(*_: Any) -> None:
        if not stop.done():
            stop.set_result(None)

    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            asyncio.get_running_loop().add_signal_handler(sig, request_stop)

    async with serve(
        bridge.handle,
        args.ws_host,
        args.ws_port,
        compression=None,
        max_size=MAX_MESSAGE_SIZE,
    ):
        LOG.info("listening, press Ctrl+C to stop")
        await stop

    LOG.info("bye")


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
