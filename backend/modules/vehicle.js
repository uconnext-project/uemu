/**
 * Vehicle profile -> `VehicleConfig` (reference `modules/vehicle.py`).
 *
 * Which car the head unit is in decides, in the stock HMI, whether SRT Drive
 * Modes / Performance Pages exist, the SRT theme list, the Hellcat launch
 * dial, the Performance Pages car pictures and gauges, and so on.
 *
 * The browser build has no panel process, so the profile normally comes from
 * `backend/data/config.json`. A `?vehicle=<model>` query parameter overrides
 * it once, which is handy for checking model-dependent tiles:
 *
 *     index.html?vehicle=grand_cherokee_srt
 *     index.html?vehicle=charger_rt
 *     index.html?vehicle=viper
 *
 * Like the car, the HMI reads `VehicleConfig` once at boot.
 */

/**
 * `vehicle.py:14-66`. `line` is the HMI's vehicle platform (LA Challenger,
 * LD Charger, LX 300, WK Grand Cherokee, ZD Viper); `brand` is the
 * `VehicleConfig.vehicleBrand` byte.
 */
export const PROFILES = Object.freeze({
    challenger_hellcat: {
        name: "Dodge Challenger SRT Hellcat",
        line: "LA",
        brand: 2,
        trim: "hellcat",
        hp: 707,
        tq: 650,
        redline: 6200,
        mass: 2000,
        theme: "SRT/157_SRT.swf",
        splash: "SRT.png",
    },
    challenger_srt: {
        name: "Dodge Challenger SRT 392",
        line: "LA",
        brand: 2,
        trim: "srt",
        hp: 485,
        tq: 475,
        redline: 6400,
        mass: 1900,
        theme: "SRT/156_SRT.swf",
        splash: "SRT.png",
    },
    charger_hellcat: {
        name: "Dodge Charger SRT Hellcat",
        line: "LD",
        brand: 2,
        trim: "hellcat",
        hp: 707,
        tq: 650,
        redline: 6200,
        mass: 2075,
        theme: "SRT/157_SRT.swf",
        splash: "SRT.png",
    },
    charger_srt: {
        name: "Dodge Charger SRT 392",
        line: "LD",
        brand: 2,
        trim: "srt",
        hp: 485,
        tq: 475,
        redline: 6400,
        mass: 1950,
        theme: "SRT/156_SRT.swf",
        splash: "SRT.png",
    },
    "300_srt": {
        name: "Chrysler 300 SRT",
        line: "LX",
        brand: 1,
        trim: "srt",
        hp: 470,
        tq: 470,
        redline: 6400,
        mass: 1950,
        theme: "SRT/160_SRT.swf",
        splash: "chrysler.png",
    },
    grand_cherokee_srt: {
        name: "Jeep Grand Cherokee SRT",
        line: "WK",
        brand: 3,
        trim: "srt",
        hp: 475,
        tq: 470,
        redline: 6400,
        mass: 2350,
        autoOnly: true,
        theme: "SRT/161_SRT.swf",
        splash: "Jeep.png",
    },
    viper: {
        name: "Dodge Viper SRT",
        line: "ZD",
        brand: 2,
        trim: "srt",
        hp: 645,
        tq: 600,
        redline: 6200,
        mass: 1500,
        manualOnly: true,
        noDriveModes: true,
        theme: "Viper/146_Viper.swf",
        splash: "SRT.png",
    },
    dodge: {
        name: "Dodge (non-SRT)",
        line: "LD",
        brand: 2,
        trim: "base",
        hp: 300,
        tq: 300,
        redline: 6000,
        mass: 1900,
        srt: false,
        noSrtApps: true,
        theme: "Dodge/006_Dodge.swf",
        splash: "dodge.png",
    },
    chrysler: {
        name: "Chrysler (non-SRT)",
        line: "LX",
        brand: 1,
        trim: "base",
        hp: 300,
        tq: 300,
        redline: 6000,
        mass: 1900,
        srt: false,
        noSrtApps: true,
        theme: "Chrysler/106_Chrysler.swf",
        splash: "chrysler.png",
    },
    jeep: {
        name: "Jeep (non-SRT)",
        line: "WK",
        brand: 3,
        trim: "base",
        hp: 300,
        tq: 300,
        redline: 6000,
        mass: 1900,
        srt: false,
        noSrtApps: true,
        theme: "Jeep/056_Jeep.swf",
        splash: "Jeep.png",
    },
    ram: {
        name: "Ram",
        line: "DS",
        brand: 12,
        trim: "base",
        hp: 300,
        tq: 300,
        redline: 6000,
        mass: 1900,
        srt: false,
        noSrtApps: true,
        theme: "Ram/136_Ram.swf",
        splash: "RAM.png",
    },
    fiat: {
        name: "Fiat",
        line: "",
        brand: 9,
        trim: "base",
        hp: 300,
        tq: 300,
        redline: 6000,
        mass: 1900,
        srt: false,
        noSrtApps: true,
        theme: "Fiat/176_Fiat.swf",
        splash: "fiat.png",
    },
    maserati: {
        name: "Maserati",
        line: "",
        brand: 11,
        trim: "base",
        hp: 300,
        tq: 300,
        redline: 6000,
        mass: 1900,
        srt: false,
        noSrtApps: true,
        theme: "Maserati/186_Maserati.swf",
        splash: "Maserati.png",
    },
    lancia: {
        name: "Lancia",
        line: "",
        brand: 10,
        trim: "base",
        hp: 300,
        tq: 300,
        redline: 6000,
        mass: 1900,
        srt: false,
        noSrtApps: true,
        theme: "Lancia/216_Lancia.swf",
        splash: "lancia.png",
    },
    challenger_rt: {
        name: "Dodge Challenger R/T",
        line: "LA",
        brand: 2,
        trim: "rt",
        hp: 375,
        tq: 410,
        redline: 6200,
        mass: 1900,
        srt: false,
        theme: "Dodge/006_Dodge.swf",
        splash: "dodge.png",
    },
    challenger_scatpack: {
        name: "Dodge Challenger R/T Scat Pack",
        line: "LA",
        brand: 2,
        trim: "rt",
        hp: 485,
        tq: 475,
        redline: 6200,
        mass: 1900,
        srt: false,
        theme: "Dodge/007_Dodge.swf",
        splash: "dodge.png",
    },
    charger_rt: {
        name: "Dodge Charger R/T",
        line: "LD",
        brand: 2,
        trim: "rt",
        hp: 370,
        tq: 395,
        redline: 6200,
        mass: 1900,
        srt: false,
        theme: "Dodge/006_Dodge.swf",
        splash: "dodge.png",
    },
    charger_scatpack: {
        name: "Dodge Charger R/T Scat Pack",
        line: "LD",
        brand: 2,
        trim: "rt",
        hp: 485,
        tq: 475,
        redline: 6200,
        mass: 1900,
        srt: false,
        theme: "Dodge/007_Dodge.swf",
        splash: "dodge.png",
    },
    "300s": {
        name: "Chrysler 300S",
        line: "LX",
        brand: 1,
        trim: "rt",
        hp: 363,
        tq: 394,
        redline: 6200,
        mass: 1900,
        srt: false,
        theme: "Chrysler/106_Chrysler.swf",
        splash: "chrysler.png",
    },
});

/** `vehicle.py:68`. */
export const THEME_BRANDS = Object.freeze({
    1: "Chrysler",
    2: "Dodge",
    3: "Jeep",
    8: "AlfaRomeo",
    9: "Fiat",
    10: "Lancia",
    11: "Maserati",
    12: "Ram",
});

/** `vehicle.py:80`. */
const DEFAULT = Object.freeze({
    model: "challenger_hellcat",
    trans: "Automatic",
    perfPages: true,
    driveModes: true,
});

/**
 * @typedef {typeof DEFAULT & Record<string, any>} VehicleSettings
 */

function bool(value) {
    return value ? "true" : "false";
}

/**
 * Reads `config.vehicle`, applies `?vehicle=` and returns a controller whose
 * `current()` mirrors `vehicle.current()`.
 *
 * @param {import("../index.js").HmiBackend} backend
 * @param {Record<string, any>} [config] Parsed `backend/data/config.json`.
 * @param {{model?: string|null}} [options]
 */
export function registerVehicle(backend, config = {}, options = {}) {
    const file = config?.vehicle ?? {};

    /** `vehicle.py:81-87`. */
    function settings() {
        const settings = { ...DEFAULT, ...file };
        const wanted = options.model ?? settings.model;
        settings.model =
            typeof wanted === "string" && Object.hasOwn(PROFILES, wanted)
                ? wanted
                : DEFAULT.model;
        return settings;
    }

    /** `vehicle.py:89-101`. */
    function current() {
        const v = settings();
        const profile = { ...PROFILES[v.model], ...v };
        if (profile.autoOnly) {
            profile.trans = "Automatic";
        }
        if (profile.manualOnly) {
            profile.trans = "Manual";
        }
        if (profile.noSrtApps) {
            profile.perfPages = false;
            profile.driveModes = false;
        }
        if (profile.noDriveModes) {
            profile.driveModes = false;
        }
        return profile;
    }

    /** `vehicle.py:103-120`: write the `VehicleConfig` properties. */
    function apply() {
        const v = current();
        const hellcat = v.trim === "hellcat";
        const automatic = v.trans === "Automatic";

        Object.assign(backend.propStore("VehicleConfig"), {
            vehiclePlatform: v.line,
            vehicleBrand: String(v.brand),
            SRTPresent: bool(v.srt ?? true),
            driveModePresent: bool(v.driveModes),
            // Non-SRT cars get Drive Modes as "<brand> Performance Control"
            // (sport mode + perf pages, and with legacy tables the Super Track
            // Pack flag).
            sportModePresent: bool(v.driveModes),
            superTrackPackPresent: bool(v.driveModes && !(v.srt ?? true)),
            performancePagesPresent: bool(v.perfPages),
            engPowerDrvMdPresent: bool(hellcat),
            redKeyPresent: bool(hellcat),
            transEquipped: v.trans,
            transDrvMdPresent: bool(automatic),
            paddlesModePresent: bool(automatic),
            // Manual cars get the shift light (Race Options).
            shiftIndicatorType: automatic ? "" : "PSI",
            ESCDrvMdPresent: "true",
            // Adaptive dampers: SRT only.
            ADCM_Present: bool(v.srt ?? true),
            // The 300 SRT keeps hydraulic steering.
            EPS_Present: bool(v.line !== "LX"),
            // Jeep: Selec-Track dial (TSBM), drive mode version 2,
            // Quadra-Trac SRT transfer case (AWD row).
            TSBMPresent: bool(v.line === "WK"),
            driveModeVersion: v.line === "WK" ? "Version_2" : "",
            TcaseType: v.line === "WK" ? "Tcase_156" : "",
        });

        // The HMI only reads getAllProperties, but keeping the signal store in
        // sync makes subscriptions and diagnostics behave like the car.
        Object.assign(
            backend.moduleStore("VehicleConfig"),
            backend.propStore("VehicleConfig"),
        );
    }

    /** `vehicle.py:70-75`. */
    function themeBrand(v = null) {
        const profile = v ?? current();
        if ((profile.srt ?? true) && profile.line !== "ZD") {
            return "SRT";
        }
        if (profile.line === "ZD") {
            return "Viper";
        }
        return THEME_BRANDS[profile.brand] ?? "Default";
    }

    apply();

    return {
        profiles: PROFILES,
        settings,
        current,
        apply,
        themeBrand,
    };
}
