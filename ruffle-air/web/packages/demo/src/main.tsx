import React from "react";
import ReactDOM from "react-dom/client";
import "./common.css";
import "./lato.css";
import "./index.css";
import { App } from "./App.tsx";
import { Config, Setup } from "ruffle-core";

Setup.installRuffle("local");

/**
 * Ruffle can't open raw TCP sockets in the browser, so `flash.net.Socket` and
 * `flash.net.XMLSocket` connect to a WebSocket proxy instead.
 *
 * The default points at `tools/ws_tcp_bridge.py`, which bridges
 * `ws://<page host>:4402/` to `tcp://127.0.0.1:4400` (the HMI gateway used by
 * the test application). Override it with a query parameter, for example:
 *
 * `?socketProxy=127.0.0.1:4400=ws://127.0.0.1:9001/,other:1234=ws://host:5678/`
 */
function socketProxies(): Config.SocketProxy[] {
    const raw = new URLSearchParams(window.location.search).get("socketProxy");
    if (raw !== null) {
        return raw
            .split(",")
            .filter((entry) => entry.length > 0)
            .map((entry) => {
                const [target, proxyUrl] = entry.split("=");
                const [host, port] = target.split(":");
                return { host, port: Number(port), proxyUrl };
            });
    }

    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    return [
        {
            host: "127.0.0.1",
            port: 4400,
            proxyUrl: `${scheme}://${window.location.hostname}:4402/`,
        },
    ];
}

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <App
            ruffleBaseConfig={{
                autoplay: Config.AutoPlay.On,
                unmuteOverlay: Config.UnmuteOverlay.Hidden,
                logLevel: Config.LogLevel.Warn,
                letterbox: Config.Letterbox.On,
                forceScale: true,
                forceAlign: true,
                socketProxy: socketProxies(),
            }}
            allowSampleSwfs={true}
            allowUrlLoading={true}
        />
    </React.StrictMode>,
);
