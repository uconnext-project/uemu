/**
 * AM/FM tuner: tuning, seek, presets and station info.
 *
 * Port of `handlers.py:413-542`. Frequencies are kHz exactly as the HMI
 * expects them (`101100` is shown as `101.1`, `880` as `880`). The reference
 * module keeps its state in a module-global `TUNER` dict rather than in
 * `state.json`, so this port seeds the signal store from the same constants.
 *
 * The HMI drives the tuner in two ways:
 *
 *   - the Radio screen's FM/AM buttons go through `AudioManager.setSource`,
 *     which sends `Audio.setAudioSource`; the hook at the bottom retunes to the
 *     last frequency of that band (`handlers.py:401-402`),
 *   - seek buttons send `seekPress` (auto seek, one station after ~0.6 s) and
 *     the tune knob sends `seekUpDown` (one band step).
 *
 * Presets are the only mutable state that has to survive a reload: they are
 * mirrored into the persistency store under `__tuner` (the reference backend
 * keeps them in memory; the browser has no long-running process).
 *
 * Shapes: `com/nfuzion/moduleLink/Tuner.as` (`tunerMessageHandler`) and
 * `PresetPersistencyManager.as`.
 */

import { after } from "../lib/timer.js";

/** handlers.py:414-418 - station names per frequency. */
const STATIONS = Object.freeze({
    FM: Object.freeze({
        88500: "KQED",
        89300: "KPCC",
        93100: "WXRT",
        95500: "WPLJ",
        97100: "KLOS",
        98700: "WFAN",
        100300: "WHTZ",
        101100: "WCBS",
        102700: "KIIS",
        104300: "WAXQ",
        105100: "WWPR",
        106700: "KROQ",
    }),
    AM: Object.freeze({
        570: "KLAC",
        660: "WFAN",
        710: "WOR",
        880: "WCBS",
        1010: "WINS",
        1130: "WBBR",
    }),
});

/** handlers.py:419 - `[min, max, step]` in kHz. */
const BANDS = Object.freeze({
    FM: Object.freeze([87900, 107900, 200]),
    AM: Object.freeze([530, 1710, 10]),
});

/** handlers.py:522 - the reference waits this long before landing on a station. */
const SEEK_DELAY_MS = 600;

/** handlers.py:420-422 - default band, last frequency per band and presets. */
function initialState() {
    return {
        band: "FM",
        last: { FM: 101100, AM: 880 },
        presets: {
            FM: [88500, 93100, 95500, 98700, 101100, 102700, 104300, 106700, 0, 0, 0, 0],
            AM: [570, 660, 710, 880, 1010, 1130, 0, 0, 0, 0, 0, 0],
        },
    };
}

/**
 * Python's `int(value)`: truncate, tolerate numeric strings.
 *
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
function toInt(value, fallback = 0) {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }

    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

/**
 * Clamps a frequency to the band limits.
 *
 * @param {string} band
 * @param {number} frequency
 * @returns {number}
 */
function clampFrequency(band, frequency) {
    const [lo, hi] = BANDS[band];
    return Math.max(lo, Math.min(hi, frequency));
}

/**
 * Validates a preset position (`0..11`).
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function toPosition(value) {
    const position = toInt(value, -1);
    return position >= 0 && position < 12 ? position : null;
}

/**
 * Registers the tuner module.
 *
 * @param {import("../index.js").HmiBackend} backend
 */
export function registerTuner(backend) {
    // handlers.py:420-422 - mutable module state, restored from the browser
    // store when the page was reloaded after storing presets.
    const TUNER = initialState();
    const saved = backend.persistency.__tuner;

    if (saved && typeof saved === "object") {
        if (BANDS[saved.band]) {
            TUNER.band = saved.band;
        }

        for (const band of Object.keys(BANDS)) {
            const last = saved.last?.[band];
            if (Number.isFinite(Number(last))) {
                TUNER.last[band] = clampFrequency(band, Math.trunc(Number(last)));
            }

            if (Array.isArray(saved.presets?.[band])) {
                TUNER.presets[band] = Array.from(
                    { length: 12 },
                    (_, index) => toInt(saved.presets[band][index], 0),
                );
            }
        }
    }

    /** handlers.py:425-427. */
    function stationInfo(band, frequency) {
        const known = Object.hasOwn(STATIONS[band], frequency);
        return {
            frequency,
            waveband: band,
            senderName: STATIONS[band][frequency] ?? "",
            pi: 0,
            rxQual: known ? 5 : 1,
            pty: "",
        };
    }

    /** handlers.py:429-436 - a preset as both persistence manager and tuner see it. */
    function presetObject(band, position, frequency) {
        const onAir =
            frequency === TUNER.last[band] && band === TUNER.band;
        const name = STATIONS[band][frequency] ?? "";

        return {
            Position: position,
            Band: band.toLowerCase(),
            Freq_Channel: frequency,
            SubChannel: 0,
            StationName: name,
            Genre: "",
            Active: Boolean(frequency),
            EnsembID: [0, 0, 0],
            PID: 0,
            presetId: position,
            waveband: band,
            frequency,
            senderName: name,
            selected: onAir ? "true" : "false",
            pi: 0,
        };
    }

    /** handlers.py:438-441. */
    function presetList() {
        const list = {};
        for (const [band, frequencies] of Object.entries(TUNER.presets)) {
            list[band.toLowerCase()] = frequencies.map((frequency, position) =>
                presetObject(band, position, frequency),
            );
        }

        return list;
    }

    /** handlers.py:443-449. */
    function presetPositions() {
        const positions = {};
        for (const [band, frequencies] of Object.entries(TUNER.presets)) {
            const index = frequencies.indexOf(TUNER.last[band]);
            positions[band.toLowerCase()] = index >= 0 ? index : 255;
        }

        return positions;
    }

    function save() {
        backend.persistency.__tuner = {
            band: TUNER.band,
            last: { ...TUNER.last },
            presets: {
                FM: [...TUNER.presets.FM],
                AM: [...TUNER.presets.AM],
            },
        };
        backend.onPersistencyChange(backend.persistency);
    }

    /** handlers.py:451-461. */
    function publish() {
        const tuner = backend.moduleStore("Tuner");
        tuner.presetList = presetList();
        tuner.presetPositions = presetPositions();
        backend.send("Tuner", { presetList: tuner.presetList });
        backend.send("Tuner", { presetPositions: tuner.presetPositions });
    }

    /** handlers.py:463-471. */
    function tune(band, frequency) {
        const clamped = clampFrequency(band, toInt(frequency, TUNER.last[band]));
        TUNER.band = band;
        TUNER.last[band] = clamped;

        const tuner = backend.moduleStore("Tuner");
        tuner.waveband = { waveband: band };
        tuner.stationInfo = stationInfo(band, clamped);
        backend.send("Tuner", { waveband: tuner.waveband });
        backend.send("Tuner", { stationInfo: tuner.stationInfo });
        publish();
        save();
    }

    /** handlers.py:473-477 - next known station, wrapping at the band edges. */
    function nextStation(band, frequency, up) {
        const stations = Object.keys(STATIONS[band])
            .map(Number)
            .sort((a, b) => a - b);
        const candidates = stations.filter((station) =>
            up ? station > frequency : station < frequency,
        );

        if (candidates.length > 0) {
            return up ? candidates[0] : candidates[candidates.length - 1];
        }

        return up ? stations[0] : stations[stations.length - 1];
    }

    /** handlers.py:517-525 - the "searching" pause, then the next station. */
    function seek(seekType) {
        const up = String(seekType).toUpperCase().includes("UP");
        sendSeekStatus(seekType);

        after(SEEK_DELAY_MS, () => {
            const band = TUNER.band;
            tune(band, nextStation(band, TUNER.last[band], up));
            sendSeekStatus("SEEK_STOP");
        });
    }

    function sendSeekStatus(seekType) {
        const tuner = backend.moduleStore("Tuner");
        tuner.seekStatus = { seekType };
        backend.send("Tuner", { seekStatus: tuner.seekStatus });
    }

    // ------------------------------------------------------------ commands
    // handlers.py:479-483.
    backend.on("Tuner", "setWaveband", (dest, args) => {
        const requested = String(args?.waveband ?? "FM").toUpperCase();
        const band = BANDS[requested] ? requested : "FM";
        tune(band, TUNER.last[band]);
    });

    // handlers.py:485-489.
    backend.on("Tuner", "setFrequency", (dest, args) => {
        const band = TUNER.band;
        tune(band, toInt(args?.frequency, TUNER.last[band]));
    });

    // handlers.py:492-505. The reference runs this on a thread; the browser
    // equivalent is a one-shot timer.
    backend.on("Tuner", "seekPress", (dest, args) => {
        seek(String(args?.seekType ?? "SEEK_UP_AUTO"));
    });

    // The HMI sends this on mouse-up while a seek is still running. The
    // reference has no handler either, so the seek timer keeps running and
    // lands on the station after ~0.6 s; swallowing it here only keeps the
    // backend log clean.
    backend.on("Tuner", "seekRelease", () => {});

    // handlers.py:507-514 - one band step for the tune knob / arrows.
    backend.on("Tuner", "seekUpDown", (dest, args) => {
        const band = TUNER.band;
        const value = args?.seekUpDown ?? args?.direction ?? args?.value ?? 0;
        const up =
            value === 0 ||
            value === "0" ||
            String(value).toLowerCase() === "up";
        tune(band, TUNER.last[band] + (up ? BANDS[band][2] : -BANDS[band][2]));
    });

    // handlers.py:516-520.
    backend.on("Tuner", "requestRecallPreset", (dest, args) => {
        const position = toPosition(args?.Position);
        if (position === null) {
            return;
        }

        const frequency = TUNER.presets[TUNER.band][position];
        if (frequency) {
            tune(TUNER.band, frequency);
        }
    });

    // handlers.py:522-530.
    backend.on("Tuner", "requestStorePreset", (dest, args) => {
        const position = toPosition(args?.Position);
        if (position === null) {
            return;
        }

        const band = TUNER.band;
        const frequency = TUNER.last[band];
        TUNER.presets[band][position] = frequency;
        const presetData = presetObject(band, position, frequency);
        backend.send("Tuner", {
            presetUpdate: { wb: band, presetId: position, presetData },
        });
        publish();
        save();
    });

    // handlers.py:532-535.
    backend.on("Tuner", "requestClearPreset", (dest, args) => {
        const position = toPosition(args?.Position);
        if (position === null) {
            return;
        }

        TUNER.presets[TUNER.band][position] = 0;
        publish();
        save();
    });

    // handlers.py:537-540 - reply only to the asking connection.
    backend.on("Tuner", "requestPresetPosition", (dest, args, connection) => {
        backend.send(
            "Tuner",
            { presetPositions: presetPositions() },
            connection,
        );
    });

    // ------------------------------------------------------------ boot seed
    // handlers.py:64-67 seeds these before the first client connects; the
    // generics replay them from the module store on subscribe.
    const tuner = backend.moduleStore("Tuner");
    tuner.presetList = presetList();
    tuner.presetPositions = presetPositions();
    tuner.stationInfo = stationInfo(TUNER.band, TUNER.last[TUNER.band]);
    tuner.waveband = { waveband: TUNER.band };
    // state.json ships a lowercase "stop"; the HMI compares seek status with
    // TunerSeek.sSTOP ("SEEK_STOP"), so a stale seed leaves it thinking a seek
    // is always running (long-press never stores, preset clicks send
    // seekInterrupt). Publish the real idle value instead.
    tuner.seekStatus = { seekType: "SEEK_STOP" };

    // handlers.py:401-402 - picking FM/AM on the Radio screen retunes the
    // tuner to the last frequency of that band. Runs after `Audio`'s own
    // handler, which has already broadcast the new source.
    backend.alsoOn("Audio", "setAudioSource", (dest, args) => {
        const source = String(args?.source ?? "fm").toLowerCase();
        const band = source.toUpperCase();
        if (BANDS[band]) {
            tune(band, TUNER.last[band]);
        }
    });
}
