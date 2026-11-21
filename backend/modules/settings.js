/**
 * Settings + Controls.
 *
 * Port of the reference `emulator/modules/settings.py` (plus
 * `get_variantinfo` from `modules/sxm.py`): `PersonalConfig` (vehicle, display
 * and unit preferences), `VehSetting` (heated/vented seats, heated wheel),
 * `VehicleStatus` (park / speed lockout), `AudioSettings` (EQ, balance/fade,
 * speed-adjusted volume, surround), `Clock` (manual time, 12/24h) and the
 * `platform` service (System Information versions, restore defaults).
 *
 * Shapes come from `com/nfuzion/moduleLink/{PersonalConfig,VehSettings,
 * AudioSettings,Clock}.as` and `com/harman/moduleLink/{VehicleStatus,
 * VersionInfo}.as` in MainSupplement.
 *
 * Defaults and unit tables live in `data/settings.json` (generated from the
 * reference module) so this file stays behaviour, not data.
 *
 * Persistence: Python writes `settings.json` next to the emulator; the browser
 * keeps the same snapshot in the persistency store under `__settings`, which
 * the launcher mirrors into `localStorage`.
 */

import {
    clockOffsetSeconds,
    currentDate,
    sendClockTime,
    setClockOffsetSeconds,
} from "./clock.js";

/** A seat cannot heat and cool at once (settings.py:100-101). */
const SEAT_PARTNER = Object.freeze({
    heatSeatFrontLeft: "ventSeatFrontLeft",
    ventSeatFrontLeft: "heatSeatFrontLeft",
    heatSeatFrontRight: "ventSeatFrontRight",
    ventSeatFrontRight: "heatSeatFrontRight",
});

/** Signals republished whenever an audio setting changes (settings.py:263). */
const AUDIO_SIGNALS = Object.freeze([
    "equalizer",
    "balanceFade",
    "loudness",
    "speedAdjustedVolume",
    "surroundSoundStatus",
]);

/**
 * `true`/`"true"` -> true; everything else -> false (Python
 * `value in (True, "true")`).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isTrue(value) {
    return value === true || value === "true";
}

/**
 * Python's `int(value)`: truncate, tolerate strings.
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
 * The reference module's `_props()` helper: `setProperties` arguments are
 * either flat or wrapped in a `props` object.
 *
 * @param {Record<string, any>} args
 * @returns {Record<string, any>}
 */
function propsOf(args) {
    return args?.props &&
        typeof args.props === "object" &&
        !Array.isArray(args.props)
        ? args.props
        : args;
}

/**
 * Registers every Settings/Controls handler and seeds the module stores.
 *
 * @param {import("../index.js").HmiBackend} backend
 * @param {Record<string, any>} data Parsed `backend/data/settings.json`.
 */
export function registerSettings(backend, data) {
    if (!data?.personalConfig || !data?.unitSets) {
        throw new Error("backend/data/settings.json is missing or incomplete");
    }

    const saved = backend.persistency.__settings ?? {};
    const savedObject = (value) =>
        value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const savedConfig = {
        market: saved.market ?? data.market ?? "NA",
        languageId: toInt(saved.languageId, data.languageId ?? 3),
    };
    const config = {
        market: Object.hasOwn(data.markets, savedConfig.market)
            ? savedConfig.market
            : data.market ?? "NA",
        languageId: savedConfig.languageId,
    };

    // `AUDIO` in settings.py:114-116 - mutable runtime values.
    const audio = {
        ...data.audioDefaults,
        ...savedObject(saved.AudioSettings),
    };

    // handlers.py:866-873 - the volume knob is a separate runtime value in the
    // reference backend (it is not part of `AUDIO` and is not persisted).
    const volumeState = backend.moduleStore("AudioSettings").volume ?? {};
    const volume = {
        level: toInt(volumeState.volume, 14),
        cap: toInt(volumeState.cap, 38),
    };

    // ------------------------------------------------------------ helpers
    const pcStore = () => backend.propStore("PersonalConfig");

    /** settings.py:119-123 - snapshot the user-editable values. */
    function save() {
        backend.persistency.__settings = {
            PersonalConfig: { ...pcStore() },
            Clock: { ...backend.propStore("Clock") },
            clockOffset: clockOffsetSeconds(),
            AudioSettings: { ...audio },
            market: config.market,
            languageId: config.languageId,
        };
        backend.onPersistencyChange(backend.persistency);
    }

    /** settings.py:187-188. */
    function pcSet(key, value) {
        backend.setProperty("PersonalConfig", key, value);
    }

    /**
     * settings.py:177-184 - VehicleStatus.language is what actually switches
     * the HMI texts; it is confirmed back to the car and kept for next start.
     */
    function setLanguage(locale) {
        const index = data.langIds.indexOf(locale);
        if (index >= 0) {
            config.languageId = index;
        }

        backend.propStore("VehicleStatus").language = locale;
        backend.moduleStore("VehicleStatus").language = { language: locale };
        backend.send("VehicleStatus", { language: { language: locale } });
    }

    /** settings.py:197-200 - the service rewrites every unit on a unit change. */
    function setUnits(units) {
        const table =
            units === "custom"
                ? data.customUnits
                : data.unitSets[units] ?? data.unitSets.us;
        for (const [key, value] of Object.entries(table)) {
            pcSet(key, value);
        }
    }

    /** settings.py:217-220 - VehSetting signals are nested, like PersonalConfig. */
    function vehSet(key, value) {
        backend.propStore("VehSetting")[key] = value;
        backend.moduleStore("VehSetting")[key] = { [key]: value };
        backend.send("VehSetting", { [key]: { [key]: value } });
    }

    /** settings.py:244-250. */
    function audioSignals() {
        return {
            equalizer: {
                bass: audio.bass,
                mid: audio.mid,
                treble: audio.treble,
            },
            balanceFade: { balance: audio.balance, fade: audio.fade },
            loudness: { loudness: audio.loudness },
            speedAdjustedVolume: { on: audio.speedOn, variance: audio.variance },
            surroundSoundStatus: { on: audio.surround },
        };
    }

    /** settings.py:253-260 - keep the canned `get*` replies in step. */
    function audioStore() {
        const signals = audioSignals();
        backend.state._replies ??= {};
        const replies = (backend.state._replies.AudioSettings ??= {});
        Object.assign(replies, {
            getEqualizer: signals.equalizer,
            getBalanceFade: signals.balanceFade,
            getLoudness: signals.loudness,
            getSpeedAdjustedVolume: signals.speedAdjustedVolume,
            getSurroundSoundStatus: signals.surroundSoundStatus,
            getSurroundSoundAvailable: { on: true },
        });
        return signals;
    }

    /** settings.py:263-267. */
    function audioPublish(changed = AUDIO_SIGNALS) {
        const signals = audioStore();
        const store = backend.moduleStore("AudioSettings");
        for (const signal of changed) {
            store[signal] = signals[signal];
            backend.send("AudioSettings", { [signal]: signals[signal] });
        }
    }

    /** settings.py:308-311 - move the emulated clock to an absolute instant. */
    function clockMoveTo(targetMs) {
        setClockOffsetSeconds(Math.trunc((targetMs - Date.now()) / 1000));
        sendClockTime(backend);
        save();
    }

    /** @param {number} year @param {number} monthIndex 0-based. */
    function daysInMonth(year, monthIndex) {
        return new Date(year, monthIndex + 1, 0).getDate();
    }

    /** settings.py:314-319 - shift the current date, clamping the day. */
    function shifted(years = 0, months = 0) {
        const now = currentDate();
        const total = now.getMonth() + months;
        const year = now.getFullYear() + years + Math.floor(total / 12);
        const month = ((total % 12) + 12) % 12;
        const day = Math.min(now.getDate(), daysInMonth(year, month));

        return new Date(
            year,
            month,
            day,
            now.getHours(),
            now.getMinutes(),
            now.getSeconds(),
        ).getTime();
    }

    // ------------------------------------------------------------ init
    // settings.py:451-485.

    // PersonalConfig: defaults, then whatever the user saved last.
    const pc = pcStore();
    Object.assign(pc, data.personalConfig, savedObject(saved.PersonalConfig));
    const pcSignals = backend.moduleStore("PersonalConfig");
    for (const [key, value] of Object.entries(pc)) {
        pcSignals[key] = { [key]: value };
    }

    // VehicleConfig flags this area needs, plus the market name the HMI knows
    // (state.json's old "NAFTA" matched no market and produced an empty
    // language list).
    const vehicleConfig = backend.propStore("VehicleConfig");
    Object.assign(vehicleConfig, data.vehicleConfig);
    vehicleConfig.variant_market = config.market;

    // VehicleStatus: parked, not speed-locked, language from the saved byte.
    const status = { ...data.vehicleStatus };
    const locale = data.langIds[config.languageId];
    status.language =
        config.languageId >= 2 && locale ? locale : "en_US";
    Object.assign(backend.propStore("VehicleStatus"), status);
    const statusSignals = backend.moduleStore("VehicleStatus");
    for (const [key, value] of Object.entries(status)) {
        statusSignals[key] = { [key]: value };
    }

    // VehSetting: key presence enables the matching Controls button.
    Object.assign(backend.propStore("VehSetting"), data.vehSetting);
    const vehSignals = backend.moduleStore("VehSetting");
    for (const [key, value] of Object.entries(data.vehSetting)) {
        vehSignals[key] = { [key]: value };
    }

    // Clock: real booleans, not state.json's "true"/"false" strings -
    // Clock.as negates timeFormat24, so a string would flip 12/24h.
    const clock = backend.propStore("Clock");
    Object.assign(clock, data.clockDefaults, savedObject(saved.Clock));
    const clockSignals = backend.moduleStore("Clock");
    for (const [key, value] of Object.entries(clock)) {
        clockSignals[key] = { [key]: value };
    }
    setClockOffsetSeconds(saved.clockOffset ?? 0);

    audioStore();

    // Publish the restored time at once; the minute ticker only pushes on a
    // minute change, so a saved offset would otherwise show up one tick late.
    sendClockTime(backend);

    // ------------------------------------------------------------ PersonalConfig
    // settings.py:191-213.
    backend.on("PersonalConfig", "setProperties", (dest, args, connection) => {
        const props = propsOf(args);

        for (const [key, value] of Object.entries(props)) {
            pcSet(key, value);

            if (key === "lang" && data.langIds.includes(value)) {
                setLanguage(value);
            }

            if (key === "units") {
                setUnits(value);
            }
        }

        save();
    });

    backend.on("PersonalConfig", "getCustomUnitProperties", (dest, args, connection) => {
        backend.send(
            dest,
            { getCustomUnitProperties: { ...data.customUnits } },
            connection,
        );
    });

    // settings.py:211-213 - display-off bookkeeping only; no reply.
    backend.on("PersonalConfig", "screenTurnedOff", () => {});

    // ------------------------------------------------------------ VehSetting
    // settings.py:223-228.
    backend.on("VehSetting", "setProperties", (dest, args, connection) => {
        for (const [key, value] of Object.entries(propsOf(args))) {
            const partner = SEAT_PARTNER[key];
            if (
                partner &&
                value !== "off" &&
                backend.propStore("VehSetting")[partner] !== "off"
            ) {
                vehSet(partner, "off");
            }

            vehSet(key, value);
        }
    });

    // ------------------------------------------------------------ VehicleStatus
    // settings.py:232-240.
    backend.on("VehicleStatus", "getKeySenseSecurityPIN", (dest, args, connection) => {
        backend.send(
            dest,
            { getKeySenseSecurityPIN: { KeySensePIN: "FFFF" } },
            connection,
        );
    });

    backend.on("VehicleStatus", "setSpeedLockOutFeature", (dest, args, connection) => {
        const setting = args?.setting ?? "on";
        backend.propStore("VehicleStatus").speedLockOutFeature = setting;
        backend.send(
            dest,
            { setSpeedLockOutFeature: { setting } },
            connection,
        );
    });

    // ------------------------------------------------------------ AudioSettings
    // settings.py:278-293. Each setter updates `AUDIO`, republishes its signal
    // and saves - exactly like the reference `_audio_cmd` closure.
    backend.on("AudioSettings", "setEqualizer", (dest, args, connection) => {
        for (const key of ["bass", "mid", "treble"]) {
            if (Object.hasOwn(args, key)) {
                audio[key] = toInt(args[key]);
            }
        }
        audioPublish(["equalizer"]);
        save();
    });

    backend.on("AudioSettings", "setBalanceFade", (dest, args, connection) => {
        for (const key of ["balance", "fade"]) {
            if (Object.hasOwn(args, key)) {
                audio[key] = toInt(args[key]);
            }
        }
        audioPublish(["balanceFade"]);
        save();
    });

    backend.on("AudioSettings", "setLoudness", (dest, args, connection) => {
        audio.loudness = isTrue(args.loudness);
        audioPublish(["loudness"]);
        save();
    });

    backend.on("AudioSettings", "setSpeedAdjustedVolume", (dest, args, connection) => {
        audio.speedOn = isTrue(args.on);
        audio.variance = toInt(args.variance, 0);
        audioPublish(["speedAdjustedVolume"]);
        save();
    });

    backend.on("AudioSettings", "setSurroundSoundStatus", (dest, args, connection) => {
        audio.surround = isTrue(args.on);
        audioPublish(["surroundSoundStatus"]);
        save();
    });

    // settings.py:291-293 - the car answers with the plain signal name.
    backend.on("AudioSettings", "setSurroundSoundAvailable", (dest, args, connection) => {
        backend.send(dest, { surroundSoundAvailable: { on: true } }, connection);
    });

    // handlers.py:866-873 - volume knob. Broadcast like the reference
    // (`B.send` without a connection), and keep `getVolume` in step so a
    // reload/reconnect starts at the last level.
    backend.on("AudioSettings", "setVolume", (dest, args) => {
        volume.level = Math.max(
            0,
            Math.min(volume.cap, toInt(args?.volume, volume.level)),
        );
        const signal = { volume: volume.level, cap: volume.cap };
        backend.moduleStore("AudioSettings").volume = signal;
        backend.state._replies.AudioSettings.getVolume = {
            volume: volume.level,
        };
        backend.send("AudioSettings", { volume: signal });
    });

    // ------------------------------------------------------------ Clock
    // settings.py:322-355.
    backend.on("Clock", "setTime", (dest, args, connection) => {
        const now = currentDate();
        const target = new Date(
            toInt(args.year, now.getFullYear()),
            toInt(args.month, now.getMonth() + 1) - 1,
            toInt(args.day, now.getDate()),
            toInt(args.hour, now.getHours()),
            toInt(args.minute, now.getMinutes()),
            now.getSeconds(),
        );
        clockMoveTo(target.getTime());
    });

    backend.on("Clock", "adjustManualOffset", (dest, args, connection) => {
        const delta = toInt(args.offset, 0);
        clockMoveTo(Date.now() + clockOffsetSeconds() * 1000 + delta * 1000);
    });

    backend.on("Clock", "adjustMonth", (dest, args, connection) => {
        clockMoveTo(shifted(0, toInt(args.month, 0)));
    });

    backend.on("Clock", "adjustYear", (dest, args, connection) => {
        clockMoveTo(shifted(toInt(args.year, 0), 0));
    });

    backend.on("Clock", "getOffsetValues", (dest, args, connection) => {
        backend.send(
            dest,
            {
                getOffsetValues: {
                    timeZoneOffset: 0,
                    daylightOffset: 0,
                    manualOffset: clockOffsetSeconds(),
                    timeZone: "EST",
                },
            },
            connection,
        );
    });

    backend.on("Clock", "setProperties", (dest, args, connection) => {
        for (const [key, value] of Object.entries(propsOf(args))) {
            backend.setProperty("Clock", key, value);
        }
        save();
    });

    // ------------------------------------------------------------ platform
    // settings.py:386-433 (versions/partnumber/serial/service flags) and
    // sxm.py:13-17 (`get_variantinfo`).
    backend.on("platform", "get_all_versions", (dest, args, connection) => {
        backend.send(
            dest,
            { get_all_versions: { ...data.platform.versions } },
            connection,
        );
    });

    backend.on("platform", "get_eq_version", (dest, args, connection) => {
        backend.send(
            dest,
            { get_eq_version: { eq_version: data.platform.versions.eq_version } },
            connection,
        );
    });

    backend.on("platform", "get_translation_version", (dest, args, connection) => {
        backend.send(
            dest,
            {
                get_translation_version: {
                    translation_version: data.platform.versions.translation_version,
                },
            },
            connection,
        );
    });

    backend.on("platform", "get_partnumber", (dest, args, connection) => {
        backend.send(
            dest,
            { get_partnumber: { partnumber: data.platform.partnumber } },
            connection,
        );
    });

    backend.on("platform", "get_serialnumber", (dest, args, connection) => {
        backend.send(
            dest,
            { get_serialnumber: { serialnumber: data.platform.serialnumber } },
            connection,
        );
    });

    backend.on("platform", "get_service_flags", (dest, args, connection) => {
        backend.send(
            dest,
            { get_service_flags: { ...data.platform.serviceFlags } },
            connection,
        );
    });

    backend.on("platform", "get_variantinfo", (dest, args, connection) => {
        backend.send(
            dest,
            { get_variantinfo: { ...data.platform.variant } },
            connection,
        );
    });

    // settings.py:418-428 - every user-editable value back to factory state.
    function restoreDefaults() {
        for (const [key, value] of Object.entries(data.personalConfig)) {
            if (pcStore()[key] !== value) {
                pcSet(key, value);
            }
        }

        for (const [key, value] of Object.entries(data.clockDefaults)) {
            backend.setProperty("Clock", key, value);
        }

        Object.assign(audio, data.audioDefaults);
        audioPublish();
        setClockOffsetSeconds(0);
        sendClockTime(backend);
        save();
    }

    backend.on("platform", "clearCustRadioSettings", () => {
        restoreDefaults();
    });

    backend.on("platform", "do_factory_reset", () => {
        restoreDefaults();
    });

    // settings.py:441-448 - phone book / favourites / touchscreen calibration
    // belong to the phone, nav and display modules; nothing to answer here.
    backend.on("platform", "clearPersonalData", () => {});
    backend.on("platform", "calibrate_touchscreen", () => {});
}
