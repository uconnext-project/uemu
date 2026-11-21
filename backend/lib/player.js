/**
 * Media playback (the browser counterpart of `audio.py:494-548`).
 *
 * The reference backend keeps one external player alive and feeds it a `want`
 * object every 200 ms:
 *
 *     {path, playing, start, seek: (generation, seconds), volume, ring}
 *
 * A new `seek` generation means "jump to seconds", while a plain `playing`
 * toggle pauses/resumes without restarting the song. This module does the same
 * with one `HTMLAudioElement`, routed through the shared Web Audio bus:
 *
 *     <audio> -> MediaElementAudioSourceNode -> GainNode -> StereoPannerNode
 *             -> audio.js masterGain
 *
 * `onLoaded`/`onPosition`/`onEnded`/`onFailed` mirror `audio_report()`.
 * Nothing is created at import time, so the module is safe to import in Node.
 */

import { getAudioOutput } from "./audio.js";

/** audio.py:89 - `_run_player()` polls the playback position. */
const TICK_MS = 200;

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * handlers.py:897-904 - media gain from the volume knob (0..cap).
 *
 * The reference scales a 0..1000 value for both channels; the browser only
 * needs the 0..1 fraction, so the left/right result is averaged there.
 *
 * @param {number} level
 * @param {number} cap
 * @param {boolean} [muted]
 * @returns {number} 0..1
 */
export function mediaGain(level, cap, muted = false) {
    if (muted) {
        return 0;
    }

    const maximum = Number(cap);
    if (!Number.isFinite(maximum) || maximum <= 0) {
        return 0;
    }

    return clamp(Number(level) / maximum, 0, 1);
}

/**
 * handlers.py:897-904 - Audio settings balance (-10 left .. +10 right) mapped
 * to StereoPanner's -1..1 range.
 *
 * @param {number} balance
 * @returns {number}
 */
export function mediaPan(balance) {
    return clamp(Number(balance) / 10 || 0, -1, 1);
}

/**
 * @param {object} [callbacks]
 * @param {(path: string, duration: number) => void} [callbacks.onLoaded]
 * @param {(path: string, seconds: number) => void} [callbacks.onPosition]
 * @param {(path: string) => void} [callbacks.onEnded]
 * @param {(path: string) => void} [callbacks.onFailed]
 * @param {(message: string) => void} [callbacks.onLog]
 */
export function createPlayer(callbacks = {}) {
    /** @type {HTMLAudioElement | null} */
    let element = null;
    /** @type {MediaElementAudioSourceNode | null} */
    let sourceNode = null;
    /** @type {GainNode | null} */
    let gainNode = null;
    /** @type {StereoPannerNode | null} */
    let pannerNode = null;

    /**
     * Ringtone channel (`handlers.py:915`): a second, looped element, separate
     * from the song. The reference backend opens it as the MCI alias `ring`
     * only while a call is in the `ringing` state.
     *
     * @type {HTMLAudioElement | null}
     */
    let ringElement = null;
    /** @type {GainNode | null} */
    let ringGainNode = null;
    /** @type {string | null} */
    let ringUrl = null;
    let ringActive = false;
    let ringLastAttempt = 0;

    let want = {
        path: null,
        file: null,
        playing: false,
        start: 0,
        seek: { gen: 0, sec: 0 },
        gain: 1,
        pan: 0,
        ring: false,
    };

    /** @type {string | null} Currently loaded path (library path, not URL). */
    let currentPath = null;
    /** @type {string | null} Blob URL for `currentPath`. */
    let objectUrl = null;
    /** @type {{gen: number, sec: number} | null} */
    let appliedSeek = null;
    let loadedPath = null;
    let failedPath = null;
    /** @type {Set<string>} Files the browser could not decode. */
    const failed = new Set();
    let timer = null;
    let lastPosition = -1;
    let lastPlayAttempt = 0;
    let destroyed = false;

    function log(message) {
        callbacks.onLog?.(message);
    }

    function ensureElement() {
        if (element || destroyed) {
            return element;
        }

        if (typeof Audio === "undefined" || typeof document === "undefined") {
            return null;
        }

        element = new Audio();
        element.preload = "auto";
        element.autoplay = false;

        const output = getAudioOutput();
        if (output) {
            try {
                sourceNode = output.context.createMediaElementSource(element);
                gainNode = output.context.createGain();
                pannerNode = output.context.createStereoPanner();
                sourceNode
                    .connect(gainNode)
                    .connect(pannerNode)
                    .connect(output.master);
            } catch (error) {
                // A context created before the element still works; without
                // an element source the browser plays it directly.
                log(`media: no Web Audio route (${error?.message ?? error})`);
                sourceNode = null;
                gainNode = null;
                pannerNode = null;
            }
        }

        element.addEventListener("loadedmetadata", () => {
            if (!element || currentPath === null) {
                return;
            }

            let duration = Number(element.duration);
            if (!Number.isFinite(duration) || duration < 0) {
                duration = 0;
            }

            const start = clamp(Number(want.start) || 0, 0, duration || 0);
            if (start > 0) {
                try {
                    element.currentTime = start;
                } catch {
                    // Metadata can still reject a seek for broken files.
                }
            }

            appliedSeek = { ...want.seek };
            loadedPath = currentPath;
            lastPosition = -1;
            callbacks.onLoaded?.(currentPath, Math.round(duration));
            if (want.playing) {
                play();
            }
        });

        element.addEventListener("timeupdate", () => {
            if (!element || currentPath === null || loadedPath !== currentPath) {
                return;
            }

            const seconds = Math.floor(element.currentTime || 0);
            if (seconds !== lastPosition) {
                lastPosition = seconds;
                callbacks.onPosition?.(currentPath, seconds);
            }
        });

        element.addEventListener("ended", () => {
            if (currentPath !== null) {
                callbacks.onEnded?.(currentPath);
            }
        });

        element.addEventListener("error", () => {
            if (currentPath !== null) {
                failed.add(currentPath);
                const path = currentPath;
                failedPath = path;
                loadedPath = null;
                log(`audio: cannot play ${path}`);
                callbacks.onFailed?.(path);
            }
        });

        if (!timer && typeof window !== "undefined") {
            timer = window.setInterval(tick, TICK_MS);
        }

        return element;
    }

    function play() {
        if (!element) {
            return;
        }

        const now = Date.now();
        if (element.paused && now - lastPlayAttempt > 500) {
            lastPlayAttempt = now;
            const promise = element.play();
            promise?.catch?.((error) => {
                log(`media: play blocked (${error?.message ?? error})`);
            });
        }
    }

    /**
     * Creates the ringtone element on first use.
     *
     * @returns {HTMLAudioElement | null}
     */
    function ensureRing() {
        if (ringElement || destroyed) {
            return ringElement;
        }

        if (typeof Audio === "undefined" || typeof document === "undefined") {
            return null;
        }

        ringElement = new Audio();
        ringElement.preload = "auto";
        ringElement.autoplay = false;
        ringElement.loop = true;

        const output = getAudioOutput();
        if (output) {
            try {
                ringGainNode = output.context.createGain();
                ringGainNode.gain.value = 0.7;
                ringGainNode.connect(output.master);
                output.context.createMediaElementSource(ringElement).connect(
                    ringGainNode,
                );
            } catch (error) {
                log(`ring: no Web Audio route (${error?.message ?? error})`);
                ringGainNode = null;
                ringElement.volume = 0.7;
            }
        } else {
            ringElement.volume = 0.7;
        }

        ringElement.addEventListener("error", () => {
            log(`ring: cannot play ${ringUrl ?? ""}`);
        });

        return ringElement;
    }

    /** Starts or stops the looped ringtone. */
    function applyRing() {
        if (!ringActive) {
            if (ringElement && !ringElement.paused) {
                ringElement.pause();
            }
            return;
        }

        const audio = ensureRing();
        if (!audio || !ringUrl) {
            return;
        }

        if (audio.src !== ringUrl) {
            audio.src = ringUrl;
            audio.load();
        }

        const now = Date.now();
        if (audio.paused && now - ringLastAttempt > 500) {
            ringLastAttempt = now;
            audio.play()?.catch?.((error) => {
                log(`ring: play blocked (${error?.message ?? error})`);
            });
        }
    }

    /**
     * Sets the ringtone URL (`null` disables the channel).
     *
     * @param {string | null} url
     */
    function setRingtone(url) {
        ringUrl = url ?? null;
        if (ringActive) {
            applyRing();
        }
    }

    /**
     * Turns the ringtone on or off.
     *
     * @param {boolean} active
     */
    function setRing(active) {
        ringActive = Boolean(active);
        if (ringActive && !ringUrl) {
            return;
        }
        applyRing();
    }

    function load(path, file) {
        if (!element) {
            return;
        }

        if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
        }

        currentPath = path;
        appliedSeek = null;
        loadedPath = null;
        lastPosition = -1;
        failedPath = null;

        if (!path || !file) {
            element.removeAttribute("src");
            element.load();
            return;
        }

        if (failed.has(path)) {
            failedPath = path;
            loadedPath = null;
            callbacks.onFailed?.(path);
            return;
        }

        objectUrl = URL.createObjectURL(file);
        element.src = objectUrl;
        element.load();
    }

    /**
     * Applies a new `want` object. Safe to call as often as once per frame.
     *
     * @param {object} next
     */
    function update(next) {
        if (destroyed) {
            return;
        }

        ensureElement();
        if (!element) {
            return;
        }

        const previous = want;
        want = {
            ...want,
            ...next,
            seek: { ...(next.seek ?? want.seek) },
        };

        const pathChanged = want.path !== previous.path;
        const fileChanged = want.file !== previous.file;
        if (pathChanged || fileChanged) {
            load(want.path ?? null, want.file ?? null);
        } else if (
            want.path &&
            element.readyState >= 1 &&
            want.seek.gen !== (appliedSeek?.gen ?? -1)
        ) {
            const duration = Number(element.duration);
            const target = Number(want.seek.sec) || 0;
            try {
                element.currentTime = Number.isFinite(duration) && duration > 0
                    ? clamp(target, 0, duration)
                    : target;
            } catch {
                // A seek on a broken file fires `error` instead.
            }
            appliedSeek = { ...want.seek };
            lastPosition = -1;
        }

        const gain = clamp(Number(want.gain), 0, 1);
        if (gainNode) {
            gainNode.gain.value = Number.isFinite(gain) ? gain : 1;
        }
        if (pannerNode) {
            pannerNode.pan.value = clamp(Number(want.pan) || 0, -1, 1);
        }
        // No Web Audio route (or it failed): fall back to the element volume.
        if (!gainNode) {
            element.volume = Number.isFinite(gain) ? gain : 1;
        }

        if (want.playing && !failedPath && element.readyState >= 1) {
            play();
        } else if (!want.playing && !element.paused) {
            element.pause();
        }

        setRing(Boolean(want.ring));
    }

    function tick() {
        if (ringActive && ringElement?.paused) {
            applyRing();
        }

        if (!element || !want.playing || document.hidden) {
            return;
        }

        // `timeupdate` is throttled in background tabs; keep the clock moving
        // so the 1 s media ticker sees a fresh position.
        if (
            loadedPath !== null &&
            loadedPath === currentPath &&
            !element.paused
        ) {
            const seconds = Math.floor(element.currentTime || 0);
            if (seconds !== lastPosition) {
                lastPosition = seconds;
                callbacks.onPosition?.(currentPath, seconds);
            }
        }

        if (!element.paused) {
            return;
        }

        if (want.playing && !failedPath && element.readyState >= 1) {
            play();
        }
    }

    /** Forgets the current file (new library) without stopping playback first. */
    function reset() {
        failed.clear();
        failedPath = null;
        loadedPath = null;
        lastPosition = -1;
        appliedSeek = null;
        if (element) {
            element.pause();
        }
        if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
        }
        if (element) {
            element.removeAttribute("src");
            element.load();
        }
        currentPath = null;
    }

    function stop() {
        destroyed = true;
        ringActive = false;
        if (timer !== null) {
            window.clearInterval(timer);
            timer = null;
        }
        if (ringElement) {
            ringElement.pause();
            ringElement.removeAttribute("src");
        }
        reset();
    }

    return {
        update,
        reset,
        stop,
        setRingtone,
        setRing,
        /** @returns {Readonly<object>} */
        get want() {
            return want;
        },
        /** @returns {HTMLAudioElement | null} */
        get element() {
            return element;
        },
        /** @returns {HTMLAudioElement | null} */
        get ringElement() {
            return ringElement;
        },
        /** @returns {Set<string>} */
        get failed() {
            return failed;
        },
    };
}
