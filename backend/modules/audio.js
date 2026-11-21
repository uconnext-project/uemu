/**
 * Audio source, mute and the touch-screen confirmation tones.
 *
 * Port of `handlers.py:389-412` (source/mute) and `handlers.py:921-924`
 * (`AudioMixerManager.confirmationTone`). The replies that unblock
 * `AudioManager` during boot live here too - they were stage 1's only job.
 *
 * `AudioManager.as:808-860` treats `getAudioSource` as the readiness gate: the
 * module stays "not ready" until a reply with a `source` field arrives. The
 * values come from the `_replies.Audio` seed in `state.json`.
 *
 * The reference backend retunes the tuner / selects the media device when the
 * source changes; those modules arrive in stages 5-6 and will hook this signal.
 */

import { playTone as playBeep } from "../lib/audio.js";

/**
 * @param {import("../index.js").HmiBackend} backend
 * @param {{playTone?: (name: string) => unknown}} [options]
 */
export function registerAudio(backend, { playTone = playBeep } = {}) {
    const replies = () => backend.state._replies?.Audio ?? {};

    backend.on("Audio", "getAudioSource", (dest, args, connection) => {
        const reply = replies().getAudioSource;
        if (reply) {
            backend.send(dest, { getAudioSource: reply }, connection);
            return;
        }

        // Fallback when the seed is missing: keep the gate satisfiable.
        const store = backend.moduleStore("Audio");
        const source = store.audioSource?.source ?? "fm";
        backend.send(dest, { getAudioSource: { source } }, connection);
    });

    backend.on("Audio", "getAvailableAudioSources", (dest, args, connection) => {
        const reply =
            replies().getAvailableAudioSources ??
            backend.moduleStore("Audio").availableAudioSources ??
            {};
        backend.send(dest, { getAvailableAudioSources: reply }, connection);
    });

    // handlers.py:390-403. The source change is broadcast (not just replied to)
    // and the canned `getAudioSource` reply follows it, so a later gate check
    // reports the new source.
    backend.on("Audio", "setAudioSource", (dest, args) => {
        const source = String(args?.source ?? "fm");
        const store = backend.moduleStore("Audio");
        const signal = { source, service: "hmi" };

        // handlers.py:394-395 - the HMI expects the media device's id and name
        // next to the source (state.json's availableAudioSources carries both).
        const device = store.availableAudioSources?.[source];
        if (device && device.id !== undefined && device.id !== null) {
            signal[source] = { id: device.id, name: device.name };
        }

        store.audioSource = signal;
        (backend.state._replies ??= {}).Audio ??= {};
        backend.state._replies.Audio.getAudioSource = { source };
        backend.send("Audio", { audioSource: signal });
    });

    // handlers.py:406-410.
    backend.on("Audio", "setMute", (dest, args) => {
        const raw = args?.state ?? args?.mute ?? true;
        const state = raw === true || ["true", "on", "mute"].includes(raw);
        backend.moduleStore("Audio").userMuteState = { state };
        backend.send("Audio", { userMuteState: { state } });
    });

    // handlers.py:921-924 - the DSP beep for a touch; the HMI only sends it
    // when "touch screen beep" is enabled. There is no reply.
    backend.on("AudioMixerManager", "confirmationTone", (dest, args) => {
        void playTone(String(args?.type ?? "CONF_1"));
    });
}
