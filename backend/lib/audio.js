/**
 * Web Audio output for the HMI.
 *
 * The reference `emulator/audio.py:74-160` turns the stock DSP tone tables
 * (`beeps.json`) into PCM WAV files and lets MCI/mpv/paplay play them. The
 * browser can synthesise and play the same wave directly, so this module keeps
 * one `AudioContext`, a master `GainNode` and a cache of rendered buffers.
 *
 * The segment tables are ported from `audio.py:_segment_wave`:
 *
 *   - frequencies are Hz (the stock .conf labels them kHz, but 600 kHz is
 *     inaudible and the DSP's beeps are 50-1200 Hz),
 *   - duration is milliseconds at 22050 Hz,
 *   - level 254 ramps up, 255 ramps down, -100 (and below) is silence and any
 *     other value is dB relative to full scale.
 *
 * Autoplay: browsers start an `AudioContext` suspended. `installAudioUnlock()`
 * resumes it on the first pointer/key event; until then the HUD shows
 * `audio: off` and tones are dropped.
 */

/** audio.py:78 - the stock tones are 22050 Hz, 16-bit mono. */
export const TONE_RATE = 22050;

/** audio.py:79 - peak sample in a 16-bit frame. */
export const TONE_PEAK = 9000;

/** Master gain for everything this module plays (media joins it in stage 6). */
const MASTER_GAIN = 1;

/** Where the tone tables live, relative to this module. */
const BEEPS_URL = new URL("../data/beeps.json", import.meta.url);

/** @type {AudioContext | null} */
let context = null;

/** @type {GainNode | null} */
let master = null;

/** @type {Map<string, AudioBuffer>} */
const buffers = new Map();

/** @type {Promise<Record<string, any>> | null} */
let beeps = null;

/** @type {Set<(status: string) => void>} */
const statusListeners = new Set();

let lastStatus = "off";

/**
 * The current output status shown in the HUD.
 *
 * @returns {"on" | "off"}
 */
export function audioStatus() {
    return context?.state === "running" ? "on" : "off";
}

/**
 * Subscribes to status changes (the HUD uses it to refresh lazily).
 *
 * @param {(status: string) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onAudioStatus(listener) {
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
}

function notifyStatus() {
    const status = audioStatus();
    if (status === lastStatus) {
        return;
    }

    lastStatus = status;
    for (const listener of statusListeners) {
        listener(status);
    }
}

/**
 * Creates the shared context on first use. `AudioContext` is missing in Node,
 * which keeps the module importable for tests.
 *
 * @returns {AudioContext | null}
 */
function ensureContext() {
    if (context) {
        return context;
    }

    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Ctor) {
        return null;
    }

    context = new Ctor();
    master = context.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(context.destination);
    context.addEventListener?.("statechange", notifyStatus);

    return context;
}

/**
 * The shared output bus: everything the emulator plays (beeps, media, ...)
 * ends up on this `master` gain node.
 *
 * @returns {{context: AudioContext, master: GainNode} | null} `null` in Node,
 *   where there is no Web Audio API.
 */
export function getAudioOutput() {
    const ctx = ensureContext();
    if (!ctx || !master) {
        return null;
    }

    return { context: ctx, master };
}

/**
 * Resumes the context from a user gesture (Chrome/Firefox autoplay policy).
 *
 * @returns {boolean} Whether audio is running right away.
 */
export function unlockAudio() {
    const ctx = ensureContext();
    if (!ctx) {
        return false;
    }

    if (ctx.state !== "running") {
        ctx.resume().then(notifyStatus, () => {});
    }

    return ctx.state === "running";
}

/**
 * Installs the one-time gesture listeners that unlock audio.
 *
 * @param {Window | null} [target]
 * @returns {() => void} removes the listeners
 */
export function installAudioUnlock(
    target = typeof window === "undefined" ? null : window,
) {
    if (!target) {
        return () => {};
    }

    const events = ["pointerdown", "keydown", "touchstart"];
    const onGesture = () => {
        unlockAudio();
        if (audioStatus() === "on") {
            cleanup();
        }
    };
    const cleanup = () => {
        for (const event of events) {
            target.removeEventListener(event, onGesture, true);
        }
    };

    for (const event of events) {
        target.addEventListener(event, onGesture, true);
    }

    return cleanup;
}

/**
 * Loads `data/beeps.json` once.
 *
 * @returns {Promise<Record<string, any>>}
 */
export function loadBeeps() {
    beeps ??= fetch(BEEPS_URL)
        .then((response) => {
            if (!response.ok) {
                throw new Error(
                    `Could not load ${BEEPS_URL.pathname} (${response.status})`,
                );
            }
            return response.json();
        })
        .then((data) => data.beeps ?? data)
        .catch((error) => {
            console.warn("[audio] no beep tables", error);
            return {};
        });

    return beeps;
}

/**
 * Renders one beep segment table to mono float samples.
 *
 * Port of `audio.py:_segment_wave`, kept pure so the tone tables can be
 * checked against the reference PCM without a browser.
 *
 * @param {Record<string, any>} spec
 * @param {number} [rate]
 * @returns {Float32Array}
 */
export function synthesize(spec, rate = TONE_RATE) {
    const freq = spec?.freq?.value ?? [];
    const freq2 = spec?.freq2?.value ?? [];
    const duration = spec?.duration?.value ?? [];
    const level = spec?.level?.value ?? [];
    const square = String(spec?.waveform ?? "sine").toLowerCase() === "square";
    const count = Math.min(freq.length, duration.length, level.length);

    let total = 0;
    for (let index = 0; index < count; index += 1) {
        total += Math.max(0, Math.trunc((rate * Number(duration[index])) / 1000));
    }

    const samples = new Float32Array(total);
    const scale = TONE_PEAK / 32768;
    let phase = 0;
    let phase2 = 0;
    let out = 0;

    for (let index = 0; index < count; index += 1) {
        const f1 = Number(freq[index]) || 0;
        const f2 = index < freq2.length ? Number(freq2[index]) || 0 : 0;
        const frames = Math.max(
            0,
            Math.trunc((rate * Number(duration[index])) / 1000),
        );
        const db = Number(level[index]);
        const step1 = (Math.PI * 2 * f1) / rate;
        const step2 = (Math.PI * 2 * f2) / rate;

        for (let frame = 0; frame < frames; frame += 1) {
            let envelope;
            if (db >= 254) {
                const ramp = frame / Math.max(1, frames - 1);
                envelope = db === 254 ? ramp : 1 - ramp;
            } else if (db <= -99) {
                envelope = 0;
            } else {
                envelope = Math.min(1, 10 ** (db / 20));
            }

            let a = f1 ? Math.sin(phase) : 0;
            let b = f2 ? Math.sin(phase2) : 0;
            if (square) {
                a = f1 ? (a >= 0 ? 1 : -1) : 0;
                b = f2 ? (b >= 0 ? 1 : -1) : 0;
            }
            const mix = f1 && f2 ? (a + b) / 2 : a + b;

            samples[out] = envelope * mix * scale;
            out += 1;
            phase += step1;
            phase2 += step2;
        }
    }

    return samples;
}

/**
 * Plays one stock tone, e.g. `CONF_1`.
 *
 * Silently does nothing before the first user gesture (the context is
 * suspended) or when the name is not in `beeps.json`.
 *
 * @param {string} name
 * @param {number} [volume]
 * @returns {Promise<boolean>} Whether a tone was scheduled.
 */
export async function playTone(name, volume = 1) {    const ctx = ensureContext();
    if (!ctx) {
        return false;
    }

    if (ctx.state !== "running") {
        try {
            await ctx.resume();
        } catch {
            return false;
        }
        notifyStatus();
    }

    if (ctx.state !== "running") {
        return false;
    }

    let buffer = buffers.get(name);
    if (!buffer) {
        const table = await loadBeeps();
        const spec = table[name];
        if (!spec) {
            return false;
        }

        const samples = synthesize(spec);
        if (samples.length === 0) {
            return false;
        }

        buffer = ctx.createBuffer(1, samples.length, TONE_RATE);
        buffer.copyToChannel(samples, 0);
        buffers.set(name, buffer);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    if (volume === 1) {
        source.connect(master);
    } else {
        const gain = ctx.createGain();
        gain.gain.value = volume;
        source.connect(gain).connect(master);
    }
    source.start();

    return true;
}

// Create the (suspended) context while the page loads. Constructing an
// AudioContext inside the first pointerdown handler can take long enough that
// the HMI never sees that click (down and up arrive together), so the gesture
// only has to resume an existing context.
if (typeof window !== "undefined") {
    ensureContext();
}
