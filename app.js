/**
 * Launches Ruffle and connects it to the in-browser HMI backend.
 *
 * Open the page with:
 *
 *     ?app=/hmi/main.xml   (default)
 *
 * `?url=` works as an alias for `?app=`. The URL may point at an AIR
 * descriptor (`.xml`) or directly at a SWF.
 */

import { createBackend, loadSeed, mergePersistency } from "./backend/index.js";
import { registerHandlers } from "./backend/handlers.js";
import {
    audioStatus,
    installAudioUnlock,
    onAudioStatus,
} from "./backend/lib/audio.js";

const DEFAULT_APP = "/hmi/main.xml";
const PERSISTENCY_KEY = "air-browser-port:persistency";
const MAX_LOG_LINES = 500;
const TABS = ["flash", "backend"];

const params = new URLSearchParams(window.location.search);
const appUrl = params.get("app") ?? params.get("url") ?? DEFAULT_APP;
const vehicleModel = params.get("vehicle");

const hud = document.getElementById("hud");
const hudTabs = document.getElementById("hud-tabs");
const hudApp = document.getElementById("hud-app");
const hudConnections = document.getElementById("hud-connections");
const hudFrames = document.getElementById("hud-frames");
const hudTraces = document.getElementById("hud-traces");
const hudAudio = document.getElementById("hud-audio");
const hudMusic = document.getElementById("hud-music");
const errorBox = document.getElementById("error");

const panes = {
    flash: document.getElementById("log-flash"),
    backend: document.getElementById("log-backend"),
};
const paneWraps = Object.fromEntries(
    TABS.map((tab) => [
        tab,
        hudTabs.parentElement.querySelector(`[data-pane="${tab}"]`),
    ]),
);
const jumpButtons = Object.fromEntries(
    [...hudTabs.parentElement.querySelectorAll(".hud-jump")].map((button) => [
        button.dataset.jump,
        button,
    ]),
);
const tabButtons = [...hudTabs.querySelectorAll(".hud-tab")];

hudApp.textContent = appUrl;

let activeTab = "flash";
let framesIn = 0;
let framesOut = 0;
let traces = 0;
let hudDirty = true;

/** Total lines ever appended per tab (used for trimming). */
const logCounts = { flash: 0, backend: 0 };
/** Autoscroll: `true` while the view is pinned to the newest line. */
const stick = { flash: true, backend: true };
/** Monotonic line counter per tab, used to count lines seen while paused. */
const appended = { flash: 0, backend: 0 };
/** `appended` at the moment autoscroll was paused. */
const pausedAt = { flash: 0, backend: 0 };
/** Last known scroll offset, restored when a tab is shown again. */
const scrollPos = { flash: 0, backend: 0 };

/** Distance from the bottom (in px) that still counts as "at the bottom". */
const STICK_SLACK = 8;

/**
 * Shows or hides the "jump to latest" pill of a tab, including the number of
 * lines that arrived while autoscroll was paused.
 *
 * @param {"flash" | "backend"} tab
 */
function updateJump(tab) {
    const button = jumpButtons[tab];
    if (!button) {
        return;
    }

    const count = stick[tab] ? 0 : appended[tab] - pausedAt[tab];
    button.textContent =
        count > 99
            ? "↓ 99+ new"
            : count > 0
              ? `↓ ${count} new`
              : "↓ latest";
    button.classList.toggle("visible", !stick[tab]);
}

/**
 * Pins a tab to the newest line again and drops the pending counter.
 *
 * @param {"flash" | "backend"} tab
 */
function scrollToBottom(tab) {
    const pane = panes[tab];
    stick[tab] = true;
    pausedAt[tab] = appended[tab];
    pane.scrollTop = pane.scrollHeight;
    scrollPos[tab] = pane.scrollTop;
    updateJump(tab);
}

/**
 * Appends one line to a log tab, trimming old lines and following the tail
 * unless the user scrolled up (then a "jump to latest" pill appears).
 *
 * @param {"flash" | "backend"} tab
 * @param {string} className
 * @param {string} text
 */
function appendLine(tab, className, text) {
    const pane = panes[tab];

    // Check the position before appending: the user may have scrolled up, and
    // scroll events are delivered too late to prevent a jump to the tail.
    // A hidden pane has no layout (`clientHeight` 0), so its position is
    // meaningless and must not resume autoscroll.
    if (tab === activeTab && pane.clientHeight > 0) {
        const atBottom =
            pane.scrollHeight - pane.scrollTop - pane.clientHeight <=
            STICK_SLACK;
        if (atBottom && !stick[tab]) {
            stick[tab] = true;
            pausedAt[tab] = appended[tab];
        } else if (!atBottom && stick[tab]) {
            stick[tab] = false;
            pausedAt[tab] = appended[tab];
        }
    }

    const line = document.createElement("span");
    if (className) {
        line.className = className;
    }
    line.textContent = text + "\n";
    pane.appendChild(line);
    appended[tab] += 1;

    logCounts[tab] += 1;
    let trimmed = 0;
    while (logCounts[tab] > MAX_LOG_LINES && pane.firstChild) {
        trimmed += pane.firstChild.offsetHeight;
        pane.removeChild(pane.firstChild);
        logCounts[tab] -= 1;
    }

    if (tab === activeTab) {
        if (stick[tab]) {
            pane.scrollTop = pane.scrollHeight;
            scrollPos[tab] = pane.scrollTop;
        } else {
            // Keep the visible lines in place when old ones are trimmed away.
            if (trimmed > 0) {
                pane.scrollTop = Math.max(0, pane.scrollTop - trimmed);
                scrollPos[tab] = pane.scrollTop;
            }
            updateJump(tab);
        }
    }

}

/**
 * @param {"flash" | "backend"} tab
 */
function selectTab(tab) {
    activeTab = tab;

    for (const button of tabButtons) {
        const selected = button.dataset.tab === tab;
        button.classList.toggle("active", selected);
        button.setAttribute("aria-selected", String(selected));
    }

    for (const name of TABS) {
        paneWraps[name].classList.toggle("active", name === tab);
    }

    if (stick[tab]) {
        scrollToBottom(tab);
    } else {
        // Restore where the user was reading; autoscroll stays paused.
        panes[tab].scrollTop = scrollPos[tab];
        updateJump(tab);
    }
}

for (const tab of TABS) {
    const pane = panes[tab];
    pane.addEventListener(
        "scroll",
        () => {
            if (pane.clientHeight === 0) {
                // Hidden pane: the offsets do not describe a real viewport.
                return;
            }
            scrollPos[tab] = pane.scrollTop;
            const atBottom =
                pane.scrollHeight - pane.scrollTop - pane.clientHeight <=
                STICK_SLACK;

            if (atBottom && !stick[tab]) {
                // The user scrolled back to the newest line: resume following.
                stick[tab] = true;
                pausedAt[tab] = appended[tab];
            } else if (!atBottom && stick[tab]) {
                // Scrolling up pauses autoscroll so older lines stay readable.
                stick[tab] = false;
                pausedAt[tab] = appended[tab];
            }
            updateJump(tab);
        },
        { passive: true },
    );
}

for (const button of Object.values(jumpButtons)) {
    button.addEventListener("click", () => scrollToBottom(button.dataset.jump));
}

/**
 * Receives `trace()` output from the movie.
 *
 * @param {string} message
 */
function appendTrace(message) {
    traces += 1;
    hudDirty = true;
    appendLine("flash", "trace", message);
    console.debug(`[trace] ${message}`);
}

/** Single frames longer than this are truncated to keep the pane responsive. */
const MAX_FRAME_CHARS = 1200;

/**
 * Renders one protocol log entry. Frames are shown in full so that payloads can
 * be inspected while implementing handlers.
 *
 * @param {string} direction
 * @param {string} text
 */
function describeFrame(direction, text) {
    const line =
        text.length > MAX_FRAME_CHARS
            ? `${text.slice(0, MAX_FRAME_CHARS)}… (+${
                  text.length - MAX_FRAME_CHARS
              } chars)`
            : text;
    return `${direction} ${line}`;
}

/**
 * @param {string} direction
 * @param {string} text
 */
function appendBackendLog(direction, text) {
    framesIn += direction === "<<" ? 1 : 0;
    framesOut += direction === ">>" ? 1 : 0;
    hudDirty = true;

    const className =
        direction === "<<"
            ? "in"
            : direction === ">>"
              ? "out"
              : direction === "!!" || direction === "??"
                ? "warn"
                : "";
    appendLine("backend", className, describeFrame(direction, text));

    if (direction === "!!" || direction === "??") {
        console.warn(`[air] ${direction} ${text}`);
    }
}

let backend;
/** @type {ReturnType<typeof registerHandlers>["media"] | null} */
let mediaController = null;
/** @type {ReturnType<typeof registerHandlers>["phone"] | null} */
let phoneController = null;
/** @type {ReturnType<typeof registerHandlers>["vehicle"] | null} */
let vehicleController = null;
/** @type {ReturnType<typeof registerHandlers>["driveMode"] | null} */
let driveModeController = null;
/** @type {ReturnType<typeof registerHandlers>["misc"] | null} */
let miscController = null;
/** @type {ReturnType<typeof registerHandlers>["sxm"] | null} */
let sxmController = null;
/** @type {ReturnType<typeof registerHandlers>["speech"] | null} */
let speechController = null;

try {
    const seed = await loadSeed();
    backend = createBackend({
        state: seed.state,
        persistency: mergePersistency(
            seed.state._persist,
            seed.persistency,
            loadPersistency(),
        ),
        onPersistencyChange: savePersistency,
        log: appendBackendLog,
    });
    const modules = registerHandlers(
        backend,
        seed.settings,
        seed.media,
        seed.navfs,
        seed.phones,
        seed.config,
        { vehicleModel },
    );
    mediaController = modules.media;
    phoneController = modules.phone;
    vehicleController = modules.vehicle;
    driveModeController = modules.driveMode;
    miscController = modules.misc;
    sxmController = modules.sxm;
    speechController = modules.speech;
} catch (error) {
    showError(`Could not create the HMI backend: ${error}`);
}

// Exposed for experiments from the devtools console:
//   airBackend.on("Module", "command", ...)
//   airPlayer.ruffle().load("/hmi/main.xml")
//   airMedia.useDemo() / airMedia.pickFolder()
//   airPhone.incomingCall() / airPhone.incomingSms() / airPhone.remoteHangup()
//   airDriveMode.push() / airDriveMode.selec("track")
//   airCamera.setGear("1")   // 1 = reverse
//   airSxm.tune(2)           // jump straight to SiriusXM Hits 1
//   airSpeech.readout("Hello") / airSpeech.abort()
window.airBackend = backend;
window.airMedia = mediaController;
window.airPhone = phoneController;
window.airVehicle = vehicleController;
window.airDriveMode = driveModeController;
window.airCamera = miscController;
window.airSxm = sxmController;
window.airSpeech = speechController;

/**
 * Commands the head unit would send to a module. Used by the control panel
 * for things that are not physical inputs (HVAC knob presses, and so on).
 *
 * @param {string} dest
 * @param {Record<string, any>} packet
 */
window.airCommand = (dest, packet) => {
    backend?.handleCommand(dest, packet, null);
};

/**
 * Injects a raw frame from the panel. Mirrors the Python `B.send(mod, payload)`
 * for every top-level module key.
 *
 * @param {string | Record<string, any>} input
 * @returns {number} number of modules sent
 */
window.airInject = (input) => {
    const frame = typeof input === "string" ? JSON.parse(input) : input;
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
        throw new Error("the frame must be a JSON object keyed by module");
    }
    let count = 0;
    for (const [dest, payload] of Object.entries(frame)) {
        backend?.send(dest, payload);
        count += 1;
    }
    return count;
};

window.airToggleLogs = () => togglePanel();

if (mediaController) {
    updateMusicHud(mediaController.status());
    mediaController.onStatus(updateMusicHud);
}

/**
 * @param {{mode: string, folderName: string, trackCount: number,
 *   needsPermission: boolean, busy: boolean, scanning: object | null}} status
 */
function updateMusicHud(status) {
    if (!status) {
        return;
    }

    let label;
    if (status.busy && status.scanning) {
        label = `music: scanning ${status.scanning.files} files…`;
    } else if (status.mode === "folder") {
        label = `music: ${status.trackCount} tracks`;
    } else if (status.needsPermission) {
        label = "music: demo (folder needs permission)";
    } else {
        label = "music: demo";
    }

    if (hudMusic) {
        hudMusic.textContent = label;
        hudMusic.title = status.folderName
            ? `Folder: ${status.folderName}`
            : "Built-in demo library";
    }
}

function loadPersistency() {
    try {
        const raw = window.localStorage.getItem(PERSISTENCY_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (error) {
        console.warn("[air] could not read persistency", error);
        return {};
    }
}

function savePersistency(persistency) {
    try {
        window.localStorage.setItem(
            PERSISTENCY_KEY,
            JSON.stringify(persistency),
        );
    } catch (error) {
        console.warn("[air] could not write persistency", error);
    }
}

function showError(message) {
    errorBox.textContent =
        typeof message === "string" ? message : String(message?.stack ?? message);
    errorBox.style.display = "block";
}

function updateHud() {
    if (!hudDirty) {
        return;
    }
    hudDirty = false;
    const connections = backend?.connections.size ?? 0;
    const audio = audioStatus();
    hudConnections.textContent = `sockets: ${connections}`;
    hudFrames.textContent = `in: ${framesIn} / out: ${framesOut}`;
    hudTraces.textContent = `flash: ${traces}`;
    hudAudio.textContent = `audio: ${audio}`;

    window.dispatchEvent(
        new CustomEvent("air:status", {
            detail: {
                app: appUrl,
                audio,
                connections,
                framesIn,
                framesOut,
                traces,
            },
        }),
    );
}

function tick() {
    updateHud();
    window.requestAnimationFrame(tick);
}

function togglePanel() {
    const open = hud.classList.toggle("open");
    if (!open) {
        return;
    }

    // A hidden pane has no layout, so its scroll offset is only meaningful now.
    window.requestAnimationFrame(() => {
        if (stick[activeTab]) {
            scrollToBottom(activeTab);
        } else {
            panes[activeTab].scrollTop = scrollPos[activeTab];
        }
    });
}

hudTabs.addEventListener("click", (event) => {
    const button = event.target.closest?.(".hud-tab");
    if (button) {
        selectTab(button.dataset.tab);
    }
});

async function main() {
    if (!backend) {
        showError("The in-browser HMI backend is not available.");
        return;
    }

    if (!window.RufflePlayer) {
        showError(
            "Ruffle did not load. Build it first with `./run.sh --build` " +
                "(expected ruffle-air/web/packages/selfhosted/dist/ruffle.js).",
        );
        return;
    }

    const ruffle = window.RufflePlayer.newest();
    if (!ruffle) {
        showError("Ruffle loaded, but no player source is registered.");
        return;
    }

    window.RufflePlayer.config = {
        ...window.RufflePlayer.config,
        autoplay: "on",
        unmuteOverlay: "hidden",
        logLevel: "warn",
    };

    const player = ruffle.createPlayer();
    player.id = "ruffle-player";
    document.getElementById("screen").appendChild(player);
    window.airPlayer = player;

    // The panel fits the 4:3 stage around the player; let it know the element
    // exists (ResizeObserver alone misses the first layout).
    window.dispatchEvent(new CustomEvent("air:player"));

    // Capture ActionScript `trace()` output. Ruffle stores the observer and
    // applies it once the player instance is built, so this also includes
    // traces emitted while the movie is loading.
    player.ruffle().traceObserver = appendTrace;

    try {
        await player.ruffle().load({
            url: appUrl,
            localSocketProvider: backend.localSocketProvider,
            // The HMI is pinned to 640×480 (`noScale`). Keep the player at
            // that native size and let the panel scale the whole element with
            // CSS, so the movie's stage never changes dimensions.
            letterbox: "on",
        });
    } catch (error) {
        showError(`Could not load ${appUrl}: ${error?.message ?? error}`);
        console.error(error);
    }
}

selectTab(activeTab);
window.requestAnimationFrame(tick);

// Browsers keep an AudioContext suspended until a user gesture; the first
// click/key press resumes it and the HUD flips to `audio: on`.
onAudioStatus(() => {
    hudDirty = true;
});
installAudioUnlock();

window.addEventListener("beforeunload", () => backend?.closeAll());

main();
