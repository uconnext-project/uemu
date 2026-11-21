/**
 * Text-to-speech (`TextToSpeech`) and the voice-recognition stub
 * (`UISpeechService`).
 *
 * The stock HMI asks the module link to read back button presses, SMS bodies
 * and navigation prompts. The reference emulator only answered an empty
 * `getProperties`; here the browser's Web Speech API is used when it is
 * available, so readouts are actually audible, and an acknowledgement is sent
 * either way (no `??` in the backend log).
 *
 * Protocol shapes come from `com/nfuzion/moduleLink/TextToSpeech.as`:
 *
 *   - `ttsReadout   { readoutType, data, dataIsFile }`
 *   - `ttsReadoutAdv{ readoutType, data, dataIsFile, respondWithHandle }`
 *   - `ttsAbort     { readoutType }`
 *   - `setTtsDomainParams { language, readoutType }`
 *   - `getProperties { props: ["ttsAvailable" | "ttsPlayState"] }`
 *
 * The HMI listens for `ttsPlayState` and expects the sequence
 * `playStart` → `playEnd` → `notPlaying`; `SMSManager.as:631-661` uses those
 * transitions to advance through a list of messages. Both state signals are
 * objects (`{ state: ... }`), exactly like the car.
 */

import { after, stop } from "../lib/timer.js";

/** `TextToSpeech.as:20` - the module's DBus name. */
const MODULE = "TextToSpeech";

/** Voice prompt languages used by the HMI (`READOUT_TYPE_*` constants). */
const READOUT_TYPES = Object.freeze({
    ACCFR: "ACCFR",
    EMAIL: "EMAIL",
    NAVI: "NAVI",
    SMS: "SMS",
    TMC: "TMC",
    PLAIN: "PLAIN",
    PMSG: "PMSG",
});

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Turns `ttsReadout.data` into a single sentence.
 *
 * `readout()` sends a string; `readoutAdv()` sends an array of strings (the
 * SMS manager passes the whole inbox). Non-string entries are ignored rather
 * than rendered as `[object Object]`.
 *
 * @param {unknown} data
 * @returns {string}
 */
export function readoutText(data) {
    if (typeof data === "string") {
        return data.trim();
    }

    if (Array.isArray(data)) {
        return data
            .map((item) => (typeof item === "string" ? item.trim() : ""))
            .filter(Boolean)
            .join(". ");
    }

    if (isObject(data)) {
        const text = data.text ?? data.data ?? data.message ?? data.value;
        if (typeof text === "string") {
            return text.trim();
        }
    }

    return "";
}

/**
 * Creates a Web Speech adapter.
 *
 * Returns `null` when the page has no speech synthesis (some headless builds
 * and older browsers). Voice lists can be empty during the first few hundred
 * milliseconds; `available()` stays optimistic until the browser reports the
 * final list, then reflects whether any voices exist.
 *
 * @returns {{
 *   available: () => boolean,
 *   onVoicesChanged: (callback: (voices: SpeechSynthesisVoice[]) => void) => () => void,
 *   speak: (text: string, callbacks: {onEnd?: () => void, onError?: () => void}) =>
 *     ({cancel: () => void} | null),
 * } | null}
 */
export function createBrowserSpeech() {
    const synth =
        typeof window !== "undefined" ? window.speechSynthesis : null;
    const Utterance =
        typeof window !== "undefined"
            ? window.SpeechSynthesisUtterance
            : null;
    if (!synth || typeof Utterance !== "function") {
        return null;
    }

    /** @type {SpeechSynthesisVoice[]} */
    let voices = [];
    let voicesKnown = false;
    const listeners = new Set();

    const refreshVoices = () => {
        try {
            voices = synth.getVoices() ?? [];
        } catch {
            voices = [];
        }
        voicesKnown = true;
        for (const listener of listeners) {
            listener(voices);
        }
    };

    // Chrome reports an empty list until the voices have loaded.
    try {
        voices = synth.getVoices() ?? [];
        voicesKnown = voices.length > 0;
        synth.addEventListener?.("voiceschanged", refreshVoices);
    } catch {
        voices = [];
    }

    const preferredVoice = () =>
        voices.find((voice) => /^en(-|_|$)/i.test(voice.lang)) ?? voices[0];

    return {
        available() {
            // Before the list is known, try anyway: Chrome loads voices just
            // before the first utterance. Once known, only voices mean sound.
            return voicesKnown ? voices.length > 0 : true;
        },

        onVoicesChanged(callback) {
            listeners.add(callback);
            return () => listeners.delete(callback);
        },

        speak(text, { onEnd, onError } = {}) {
            if (!text) {
                return null;
            }

            const utterance = new Utterance(text);
            utterance.lang = "en-US";
            utterance.rate = 1;
            utterance.pitch = 1;
            const voice = preferredVoice();
            if (voice) {
                utterance.voice = voice;
            }

            let finished = false;
            const finish = (callback) => {
                if (finished) {
                    return;
                }
                finished = true;
                callback?.();
            };
            utterance.onend = () => finish(onEnd);
            utterance.onerror = () => finish(onError ?? onEnd);

            try {
                synth.speak(utterance);
            } catch {
                finish(onError ?? onEnd);
            }

            return {
                cancel() {
                    finished = true;
                    try {
                        synth.cancel();
                    } catch {
                        // Nothing else to do: the fallback timer ends the state.
                    }
                },
            };
        },
    };
}

/** Rough speech duration, used only as a watchdog for silent engines. */
function estimateDuration(text) {
    const words = text.split(/\s+/).filter(Boolean).length;
    return Math.max(2000, words * 420 + 1500);
}

/**
 * Registers the speech modules.
 *
 * @param {import("../index.js").HmiBackend} backend
 * @param {object} [options]
 * @param {ReturnType<typeof createBrowserSpeech>} [options.speech]
 *   Speech adapter. Tests inject a fake one; the page uses Web Speech.
 * @param {(ms: number, callback: () => void) => unknown} [options.schedule]
 * @param {(handle: unknown) => void} [options.cancelTimer]
 * @returns {object} Controller exposed on `window.airSpeech`.
 */
export function registerSpeech(backend, options = {}) {
    const speech = options.speech ?? createBrowserSpeech();
    const schedule = options.schedule ?? after;
    const cancelTimer = options.cancelTimer ?? stop;

    const state = () => backend.moduleStore(MODULE);
    const available = () => Boolean(speech?.available?.());

    const store = state();
    store.ttsAvailable = { state: available() };
    store.ttsPlayState = { state: "notPlaying" };

    /** Increments on every new readout/abort so stale callbacks are ignored. */
    let generation = 0;
    /** @type {{cancel: () => void} | null} */
    let current = null;

    function publishPlayState(next, extra = {}) {
        const payload = { state: next, ...extra };
        state().ttsPlayState = payload;
        backend.send(MODULE, { ttsPlayState: payload });
    }

    function publishAvailable() {
        const payload = { state: available() };
        state().ttsAvailable = payload;
        backend.send(MODULE, { ttsAvailable: payload });
    }

    if (speech?.onVoicesChanged) {
        speech.onVoicesChanged(() => publishAvailable());
    }

    function cancelCurrent() {
        generation += 1;
        const handle = current;
        current = null;
        handle?.cancel?.();
    }

    function finish(gen) {
        if (gen !== generation) {
            return;
        }
        current = null;
        publishPlayState("playEnd");
        // Give the HMI one turn to process `playEnd` (SMSManager marks the
        // message read there) before reporting that nothing is playing.
        schedule(30, () => {
            if (gen === generation) {
                publishPlayState("notPlaying");
            }
        });
    }

    function speak(text, extra = {}) {
        cancelCurrent();
        const gen = generation;

        if (!text || !speech || !available()) {
            // Ack-only path: still move the HMI back to idle so a "play all
            // messages" loop does not stall.
            publishPlayState("notPlaying");
            return false;
        }

        publishPlayState("playStart", extra);

        let done = false;
        let handle = null;
        const end = () => {
            if (done) {
                return;
            }
            done = true;
            cancelTimer(watchdog);
            finish(gen);
        };
        // A browser without an audio device may accept `speak()` and never
        // fire `onend`; the watchdog keeps `isTTSPlaying` from sticking on.
        const watchdog = schedule(estimateDuration(text), end);

        handle = speech.speak(text, { onEnd: end, onError: end });
        if (handle) {
            current = {
                cancel() {
                    done = true;
                    cancelTimer(watchdog);
                    handle.cancel?.();
                },
            };
        } else {
            // `speak()` refused (empty text/engine error): fall through to the
            // normal end-of-speech transition immediately.
            end();
        }

        return true;
    }

    function acknowledge(command, connection) {
        backend.send(MODULE, { [command]: { description: "success" } }, connection);
    }

    backend.on(MODULE, "ttsReadout", (dest, args, connection) => {
        acknowledge("ttsReadout", connection);
        const text = readoutText(args?.data);
        speak(text, args?.msgID ? { msgID: args.msgID } : {});
    });

    backend.on(MODULE, "ttsReadoutAdv", (dest, args, connection) => {
        acknowledge("ttsReadoutAdv", connection);
        const text = readoutText(args?.data);
        speak(text, args?.msgID ? { msgID: args.msgID } : {});
    });

    backend.on(MODULE, "ttsAbort", (dest, args, connection) => {
        acknowledge("ttsAbort", connection);
        cancelCurrent();
        publishPlayState("notPlaying");
    });

    backend.on(MODULE, "setTtsDomainParams", (dest, args, connection) => {
        // The car stores the voice domain/language. Web Speech uses the
        // utterance language, so there is nothing to persist; the hook keeps
        // the command out of the "unhandled" log.
        void connection;
        void args;
    });

    // Some builds/tools call the plain `speak` command from the protocol
    // documentation; accept it as a readout as well.
    backend.on(MODULE, "speak", (dest, args, connection) => {
        backend.send(MODULE, { speak: { res: "success" } }, connection);
        speak(readoutText(args?.data ?? args?.text ?? args?.value));
    });

    // ------------------------------------------------------ UISpeechService
    // Voice recognition is not emulated. The stub publishes a "not available"
    // state so `VoiceRecognition.as` does not wait for an answer, and it keeps
    // its additional subscriptions quiet (they have no signal values).
    backend.defineModule("UISpeechService", {
        state: {
            vrAvailable: { state: false, reason: "" },
            vrDialogActive: { state: false },
            vrBusyProcessing: { state: false },
        },
    });

    return {
        readout: (text, readoutType = READOUT_TYPES.PLAIN) =>
            speak(readoutText(text), { readoutType }),
        abort: () => {
            cancelCurrent();
            publishPlayState("notPlaying");
        },
        available,
        playState: () => state().ttsPlayState?.state ?? "notPlaying",
        READOUT_TYPES,
    };
}
