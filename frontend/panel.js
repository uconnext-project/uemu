import "./panel.css";

/**
 * Right-hand control panel.
 *
 * The panel talks to the same controllers the console exposes (`airBackend`,
 * `airMedia`, `airPhone`, ...). Buttons that represent a physical head-unit
 * input are sent as `ICS` signals, exactly like the Python panel:
 *
 *   - volume: `{ "UpdateVolume": { "vol": ±1 } }`
 *   - keys:   `{ "key": { "key": "<name>", "pressed": true/false } }`
 *   - tune:   `{ "knob": { "knob": 2, "value": ±1 } }`
 *
 * Everything else calls the module controllers directly.
 */

const THEME_KEY = "air-browser-port:theme";
const PANEL_KEY = "air-browser-port:panel-expanded";
const SCREEN_WIDTH = 640;
const SCREEN_HEIGHT = 480;
const MOBILE_QUERY = "(max-width: 980px)";

const html = document.documentElement;
const panel = document.getElementById("control-panel");
const stage = document.getElementById("player");
const collapseButton = document.getElementById("panel-collapse");
const fab = document.getElementById("panel-fab");
const backdrop = document.getElementById("panel-backdrop");
const statusLine = document.getElementById("panel-status");
const panelAudio = document.getElementById("panel-audio");

const themeButtons = [...document.querySelectorAll("[data-theme-set]")];
const statAudio = document.getElementById("stat-audio");
const statSockets = document.getElementById("stat-sockets");
const statFrames = document.getElementById("stat-frames");
const statFlash = document.getElementById("stat-flash");
const statMedia = document.getElementById("stat-media");

const vehicleSelect = document.getElementById("vehicle-model");
const vehicleInfo = document.getElementById("vehicle-info");
const vehicleApply = document.getElementById("vehicle-apply");

const rawInput = document.getElementById("raw-frame");

const isMobile = () => window.matchMedia(MOBILE_QUERY).matches;

let expanded = true;
let mobileOpen = false;
let statusTimer = null;

/* ------------------------------------------------------------------ misc */

function setStatus(message, tone = "") {
    if (!statusLine) {
        return;
    }

    statusLine.textContent = message;
    statusLine.dataset.tone = tone;
    clearTimeout(statusTimer);
    if (tone) {
        statusTimer = setTimeout(() => {
            statusLine.textContent = "Ready";
            statusLine.dataset.tone = "";
        }, 4500);
    }
}

function backend() {
    return window.airBackend ?? null;
}

function requireBackend() {
    const instance = backend();
    if (!instance) {
        setStatus("Backend is still starting…", "error");
        return null;
    }
    return instance;
}

function remember(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Private mode / disabled storage: the panel still works for this tab.
    }
}

function recall(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function option(value, label, selected = false) {
    return new Option(label, value, selected, selected);
}

/* ----------------------------------------------------------------- theme */

function applyTheme(mode, persist = true) {
    const next = ["light", "dark", "oled"].includes(mode) ? mode : "dark";
    html.classList.toggle("dark", next !== "light");
    html.classList.toggle("oled", next === "oled");
    html.dataset.theme = next;

    for (const button of themeButtons) {
        button.setAttribute(
            "aria-pressed",
            String(button.dataset.themeSet === next),
        );
    }

    const meta = document.getElementById("meta-theme-color");
    if (meta) {
        meta.content =
            next === "light" ? "#f3faf8" : next === "oled" ? "#000000" : "#0b1215";
    }

    if (persist) {
        remember(THEME_KEY, next);
        // Basecoat's own theme switcher reads this key; keep it in sync.
        remember("themeMode", next === "light" ? "light" : "dark");
    }
}

for (const button of themeButtons) {
    button.addEventListener("click", () => {
        applyTheme(button.dataset.themeSet);
        setStatus(`Theme: ${button.dataset.themeSet}`, "ok");
    });
}

/** Theme to restore when fullscreen is left; `null` when nothing was swapped. */
let themeBeforeFullscreen = null;

/**
 * Fullscreen shows only the HMI, so the OLED palette is the sensible default.
 * The theme chosen before entering fullscreen is restored on exit.
 */
function syncFullscreenTheme() {
    if (document.fullscreenElement) {
        if (html.dataset.theme !== "oled") {
            themeBeforeFullscreen = html.dataset.theme ?? "dark";
            applyTheme("oled");
        }
        return;
    }

    if (themeBeforeFullscreen) {
        applyTheme(themeBeforeFullscreen);
        themeBeforeFullscreen = null;
    }
}

applyTheme(html.dataset.theme ?? recall(THEME_KEY) ?? "dark", false);

/* -------------------------------------------------------------- panel UI */

function updatePanelState() {
    panel.dataset.expanded = String(expanded);
    panel.dataset.mobileOpen = String(mobileOpen);
    backdrop.dataset.visible = String(isMobile() && mobileOpen);

    if (collapseButton) {
        collapseButton.setAttribute("aria-expanded", String(expanded));
        collapseButton.setAttribute(
            "aria-label",
            expanded ? "Collapse control panel" : "Expand control panel",
        );
        collapseButton.title = expanded
            ? "Collapse control panel"
            : "Expand control panel";
    }

    if (fab) {
        fab.setAttribute("aria-expanded", String(mobileOpen));
    }
}

function setExpanded(next, persist = true) {
    expanded = Boolean(next);
    if (persist && !isMobile()) {
        remember(PANEL_KEY, String(expanded));
    }
    updatePanelState();
}

function setMobileOpen(next) {
    mobileOpen = Boolean(next);
    if (mobileOpen) {
        expanded = true;
    }
    updatePanelState();
    if (!mobileOpen) {
        setStatus("Ready");
    }
}

const storedExpanded = recall(PANEL_KEY);
if (storedExpanded === "true" || storedExpanded === "false") {
    expanded = storedExpanded === "true";
}

collapseButton?.addEventListener("click", () => {
    if (isMobile()) {
        setMobileOpen(false);
    } else {
        setExpanded(!expanded);
    }
});

fab?.addEventListener("click", () => {
    setMobileOpen(!mobileOpen);
});

backdrop?.addEventListener("click", () => setMobileOpen(false));

window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mobileOpen) {
        setMobileOpen(false);
    }
});

const mobileMedia = window.matchMedia(MOBILE_QUERY);
const onViewportChange = () => {
    if (!isMobile()) {
        mobileOpen = false;
    }
    updatePanelState();
    requestAnimationFrame(fitStage);
};
mobileMedia.addEventListener?.("change", onViewportChange);
window.addEventListener("resize", onViewportChange);

updatePanelState();

/* ---------------------------------------------------------- Ruffle sizing */

/**
 * Fits the 640×480 HMI into the free stage area by scaling its wrapper.
 *
 * The Ruffle player itself is never resized: the AIR movie requests
 * `noScale` at 640×480, so changing the player box would change
 * `Stage.stageWidth/Height` and reflow the UI. Only the CSS transform and the
 * slot's layout size change.
 */
function fitStage() {
    const slot = document.getElementById("screen-slot");
    const screen = document.getElementById("screen");
    if (!slot || !screen || !stage) {
        return;
    }

    const style = getComputedStyle(stage);
    const availableWidth =
        stage.clientWidth -
        parseFloat(style.paddingLeft || "0") -
        parseFloat(style.paddingRight || "0");
    const availableHeight =
        stage.clientHeight -
        parseFloat(style.paddingTop || "0") -
        parseFloat(style.paddingBottom || "0");

    if (availableWidth <= 0 || availableHeight <= 0) {
        return;
    }

    const scale = Math.min(
        availableWidth / SCREEN_WIDTH,
        availableHeight / SCREEN_HEIGHT,
    );

    slot.style.width = `${SCREEN_WIDTH * scale}px`;
    slot.style.height = `${SCREEN_HEIGHT * scale}px`;
    screen.style.setProperty("--air-screen-scale", String(scale));
}

if (stage) {
    new ResizeObserver(fitStage).observe(stage);
    new ResizeObserver(fitStage).observe(document.getElementById("hud"));
}
window.addEventListener("air:player", fitStage);
window.addEventListener("resize", fitStage);
requestAnimationFrame(fitStage);

/* ----------------------------------------------------------- ICS actions */

function ics(payload) {
    const instance = requireBackend();
    if (!instance) {
        return false;
    }
    instance.send("ICS", payload);
    return true;
}

/** Press then release, like the faceplate controller does. */
function pressKey(key) {
    if (!ics({ key: { key, pressed: true } })) {
        return;
    }
    setTimeout(() => ics({ key: { key, pressed: false } }), 110);
}

function setVolume(delta) {
    if (ics({ UpdateVolume: { vol: delta } })) {
        setStatus(delta > 0 ? "Volume up" : "Volume down", "ok");
    }
}

function tune(delta) {
    if (ics({ knob: { knob: 2, value: delta } })) {
        setStatus(delta > 0 ? "Tune right" : "Tune left", "ok");
    }
}

/** Commands the *head unit* normally sends to the backend. */
function internalCommand(dest, packet) {
    if (typeof window.airCommand === "function") {
        window.airCommand(dest, packet);
        return true;
    }

    const instance = requireBackend();
    if (!instance) {
        return false;
    }
    instance.handleCommand(dest, packet, null);
    return true;
}

/* -------------------------------------------------------------- actions */

async function pickMusicFolder() {
    if (!window.airMedia) {
        setStatus("Media controller is still starting…", "error");
        return;
    }

    try {
        setStatus("Waiting for the folder picker…");
        await window.airMedia.pickFolder();
    } catch (error) {
        setStatus(`Music folder: ${error?.message ?? error}`, "error");
    }
}

function updateMediaStatus(status) {
    if (!status || !statMedia) {
        return;
    }

    if (status.busy && status.scanning) {
        statMedia.textContent = `scanning ${status.scanning.files} files…`;
    } else if (status.mode === "folder") {
        statMedia.textContent = status.folderName
            ? `${status.trackCount} tracks`
            : `${status.trackCount} tracks`;
    } else if (status.needsPermission) {
        statMedia.textContent = "folder needs permission";
    } else {
        statMedia.textContent = "demo library";
    }
}

function updateVehicleInfo() {
    const vehicle = window.airVehicle;
    if (!vehicle || !vehicleInfo) {
        return;
    }

    const profile = vehicle.current();
    if (!profile) {
        vehicleInfo.textContent = "";
        return;
    }

    vehicleInfo.textContent = `${profile.name} · ${profile.hp} hp · ${profile.tq} lb-ft · ${profile.trans}`;
}

function populateVehicles() {
    const vehicle = window.airVehicle;
    if (!vehicle || !vehicleSelect) {
        return;
    }

    const profiles = vehicle.profiles ?? {};
    const current = vehicle.settings?.().model ?? "";
    vehicleSelect.replaceChildren(
        ...Object.entries(profiles).map(([key, profile]) =>
            option(key, profile.name ?? key, key === current),
        ),
    );
    updateVehicleInfo();
}

function applyVehicle() {
    if (!vehicleSelect?.value) {
        return;
    }

    const url = new URL(window.location.href);
    url.searchParams.set("vehicle", vehicleSelect.value);
    setStatus("Applying vehicle profile and restarting…", "ok");
    window.location.assign(url);
}

function restartHeadUnit() {
    setStatus("Restarting head unit…", "ok");
    window.location.reload();
}

async function sendRawFrame() {
    if (!rawInput) {
        return;
    }

    try {
        const count =
            typeof window.airInject === "function"
                ? window.airInject(rawInput.value)
                : 0;
        setStatus(
            `Sent ${count} frame${count === 1 ? "" : "s"} to the HMI`,
            "ok",
        );
    } catch (error) {
        setStatus(`Frame error: ${error.message}`, "error");
    }
}

function toggleLogs() {
    if (typeof window.airToggleLogs === "function") {
        window.airToggleLogs();
        return;
    }
    document.getElementById("hud-bar")?.click();
}

async function runAction(action, value = "") {
    switch (action) {
        case "volume":
            setVolume(Number(value) || 0);
            break;

        case "tune":
            tune(Number(value) || 0);
            break;

        case "key":
            pressKey(value);
            setStatus(`Key: ${value}`, "ok");
            break;

        case "hvac": {
            const [zone, control] = value.split(":");
            if (zone && control) {
                internalCommand("HVAC", {
                    setControlProperties: {
                        zone,
                        controls: { [control]: "press" },
                    },
                });
                setStatus(`Climate: ${zone} ${control}`, "ok");
            }
            break;
        }

        case "drive":
            if (value === "srt") {
                pressKey("srt");
                setStatus("Drive Modes button pressed", "ok");
            } else if (value === "reset") {
                window.airDriveMode?.reset();
                setStatus("Drive modes reset to factory", "ok");
            } else if (value.startsWith("selec:")) {
                const position = value.slice(6);
                try {
                    window.airDriveMode?.selec(position);
                    setStatus(`Selec-Track: ${position}`, "ok");
                } catch (error) {
                    setStatus(String(error?.message ?? error), "error");
                }
            }
            break;

        case "media":
            if (value === "folder") {
                await pickMusicFolder();
            } else if (value === "demo") {
                await window.airMedia?.useDemo();
                setStatus("Using the built-in demo library", "ok");
            }
            break;

        case "phone":
            if (value === "call") {
                const call = window.airPhone?.incomingCall();
                setStatus(
                    call ? "Incoming call…" : "Phone is not connected",
                    call ? "ok" : "error",
                );
            } else if (value === "sms") {
                window.airPhone?.incomingSms();
                setStatus("Incoming SMS", "ok");
            } else if (value === "hangup") {
                window.airPhone?.remoteHangup();
                setStatus("Call ended", "ok");
            }
            break;

        case "raw":
            await sendRawFrame();
            break;

        case "logs":
            toggleLogs();
            break;

        case "restart":
            restartHeadUnit();
            break;

        case "expand":
            setExpanded(!expanded);
            break;

        case "fullscreen": {
            const target = document.getElementById("stage");
            if (document.fullscreenElement) {
                document.exitFullscreen?.();
            } else {
                target?.requestFullscreen?.().catch(() => {
                    setStatus("Fullscreen was blocked.", "error");
                });
            }
            break;
        }

        default:
            setStatus(`Unknown action: ${action}`, "error");
    }
}

panel?.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-air-action]");
    if (!button || !panel.contains(button)) {
        return;
    }
    event.preventDefault();
    runAction(button.dataset.airAction, button.dataset.value ?? "");
});

/* Keyboard shortcuts mirror the hardware panel from the Python build. */
const shortcuts = {
    "+": ["volume", "1"],
    "=": ["volume", "1"],
    "-": ["volume", "-1"],
    m: ["key", "audioOnOff"],
    ArrowLeft: ["tune", "-1"],
    ArrowRight: ["tune", "1"],
    Enter: ["key", "enter"],
    Backspace: ["key", "back"],
};

document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
        return;
    }

    const tag = event.target?.tagName;
    if (
        ["INPUT", "TEXTAREA", "SELECT"].includes(tag) ||
        event.target?.isContentEditable
    ) {
        return;
    }

    const shortcut = shortcuts[event.key];
    if (!shortcut) {
        return;
    }

    event.preventDefault();
    runAction(shortcut[0], shortcut[1]);
});

/* ---------------------------------------------------------- live wiring */

vehicleApply?.addEventListener("click", applyVehicle);

window.addEventListener("air:status", (event) => {
    const detail = event.detail ?? {};
    if (statAudio) {
        statAudio.textContent = detail.audio ?? "off";
    }
    if (statSockets) {
        statSockets.textContent = String(detail.connections ?? 0);
    }
    if (statFrames) {
        statFrames.textContent = `${detail.framesIn ?? 0} / ${detail.framesOut ?? 0}`;
    }
    if (statFlash) {
        statFlash.textContent = String(detail.traces ?? 0);
    }
    if (panelAudio) {
        panelAudio.textContent = `audio ${detail.audio ?? "off"}`;
    }
});

function startLiveUpdates() {
    populateVehicles();

    if (window.airMedia?.onStatus) {
        updateMediaStatus(window.airMedia.status?.());
        window.airMedia.onStatus(updateMediaStatus);
    }

    setInterval(() => {
        updateVehicleInfo();
    }, 700);
}

// `app.js` creates the controllers after loading the seed data. Poll briefly
// so the panel does not race the boot sequence.
let readyTries = 0;
(function waitForBackend() {
    if (window.airBackend && window.airVehicle) {
        startLiveUpdates();
        return;
    }

    readyTries += 1;
    if (readyTries > 200) {
        setStatus("Backend did not start — check the log.", "error");
        return;
    }
    setTimeout(waitForBackend, 100);
})();

document.addEventListener("fullscreenchange", () => {
    syncFullscreenTheme();
    requestAnimationFrame(fitStage);
});
