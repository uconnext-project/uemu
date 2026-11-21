/**
 * Navigation, NDR (GPS) and the nav trail file service.
 *
 * Port of `modules/nav_apps.py` plus the `NavTrailInfo` file listing the
 * reference backend leaves unanswered. The map is drawn natively by
 * NaviServer on the real unit, so the HMI only needs enough replies to reach
 * "nav ready" and to draw the menus:
 *
 *   - `Navigation.JSON_GetProperties` reports activation/operability and the
 *     software/database versions. Both versions must arrive in one frame:
 *     `Navigation.parseDbVersions` replaces the whole version object, and
 *     `UpdateCheck` otherwise never sees a complete pair and keeps the
 *     database-update check pending (`nav_apps.py:22-26`).
 *   - `NDR.JSON_GetProperties` answers the GPS/calibration subscriptions with
 *     a fixed Detroit position (`nav_apps.py:9-20`).
 *   - `NavigationPersistency` uses its own read/write format: records are
 *     stored under `Nav_<key>` with a `verify_key` field and read back whole.
 *     The generic `{key, value}` persistency store would make every nav read
 *     look empty (`nav_apps.py:29-61`).
 *   - Answering `Nav_ActGuidance` ends the guidance restarter and makes nav
 *     "ready". `MainBackgroundScreen` only gives the map a configuration on a
 *     screen or display-layer change, and boot's last screen change happens
 *     before nav is ready, so a delayed `DisplayManager.requestDisplay` for
 *     the (absent) map layer triggers that refresh once.
 *   - `NavTrailInfo` lists a small VFS from `backend/data/navfs.json`.
 *
 * The HMI retries `ETC_IsActivated` every 3 s until it gets `true`, then asks
 * `ETC_IsOperable`, starts the 20 s guidance restarter and only then creates
 * its managers. Until all of that happens the nav tile reports "not ready".
 */

import { after } from "../lib/timer.js";

/** nav_apps.py:10 - Detroit, MI. */
const HOME = Object.freeze({ latitude: 42.3314, longitude: -83.0458 });

/** nav_apps.py:13-16 - `outprop` of Navigation.JSON_GetProperties. */
const NAV_PROPS = Object.freeze({
    ETC_IsActivated: true,
    ETC_IsOperable: true,
});

/** nav_apps.py:26 - both versions are always sent together. */
const NAV_VERSIONS = Object.freeze({
    ETC_SoftwareVersion: "NNG 9.12.3",
    ETC_DatabaseVersion: "NA_HERE;NAFTA 2015 Q1;",
});

/** nav_apps.py:52-58 - the map refresh follows this read. */
const ACTIVE_GUIDANCE_KEY = "Nav_ActGuidance";
const MAP_REFRESH_DELAY_MS = 2000;

/**
 * nav_apps.py:12-20 - the property table NDR serves.
 *
 * @returns {Record<string, any>}
 */
function ndrProperties() {
    const { latitude, longitude } = HOME;

    return {
        POS_Position: {
            DR_latitude: latitude,
            DR_longitude: longitude,
            DR_speed: 0,
            DR_heading: 90,
            DR_distance: 0,
        },
        // >= 3 keeps the HMI from showing "low calibration".
        POS_CalibrationLevel: { level: 3 },
        SEN_GPSInfo: {
            latitude,
            longitude,
            height: 183,
            heading: 90,
            fix: 3,
            antennaState: 0,
            satsUsed: 9,
            satsVisible: 12,
            signalQuality: 5,
            hdop: 1,
            pdop: 1,
            vdop: 1,
            speed: 0,
        },
        SEN_GPSSatInfo: [],
        SEN_ReverseGear: { reverseValue: 0 },
        POS_VehicleSpeed: { vehicleSpeed: 0 },
    };
}

/**
 * nav_apps.py:90-96 - MediaHomeScreen compares the audio source type with
 * the media device type ("usb"); without it the source name `usb1` is used
 * and the track metadata is blanked.
 *
 * @param {import("../index.js").HmiBackend} backend
 */
function markUsbSourceType(backend) {
    const tables = [
        backend.moduleStore("Audio").availableAudioSources,
        backend.state._replies?.Audio?.getAvailableAudioSources,
    ];

    for (const table of tables) {
        const usb = table?.usb1;
        if (usb && typeof usb === "object") {
            usb.type = "usb";
        }
    }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Registers the Navigation, NDR and NavTrailInfo handlers.
 *
 * @param {import("../index.js").HmiBackend} backend
 * @param {{navfs?: Record<string, any>, schedule?: (ms: number, fn: () => void) => unknown}} [options]
 *   `navfs` is `backend/data/navfs.json`; `schedule` is only overridden in
 *   tests.
 */
export function registerNav(backend, { navfs = {}, schedule = after } = {}) {
    markUsbSourceType(backend);

    // nav_apps.py:63-69. `distribute_JSON_Prop` keeps only the first property
    // of a frame, hence one frame per value (and the two versions together).
    backend.on("Navigation", "JSON_GetProperties", (dest, args, connection) => {
        const requested = Array.isArray(args?.inprop) ? args.inprop : [];

        if (requested.some((name) => Object.hasOwn(NAV_VERSIONS, name))) {
            backend.send(
                dest,
                { JSON_GetProperties: { outprop: { ...NAV_VERSIONS } } },
                connection,
            );
        }

        for (const name of requested) {
            if (Object.hasOwn(NAV_PROPS, name)) {
                backend.send(
                    dest,
                    { JSON_GetProperties: { outprop: { [name]: NAV_PROPS[name] } } },
                    connection,
                );
            }
        }
    });

    // nav_apps.py:71-75.
    backend.on("NDR", "JSON_GetProperties", (dest, args, connection) => {
        const requested = Array.isArray(args?.inprop) ? args.inprop : [];
        const properties = ndrProperties();
        const outprop = {};

        for (const name of requested) {
            if (Object.hasOwn(properties, name)) {
                outprop[name] = properties[name];
            }
        }

        backend.send(dest, { JSON_GetProperties: { outprop } }, connection);
    });

    // nav_apps.py:29-36. `packet.write` already is `{"Nav_X": {verify_key...}}`.
    backend.on("NavigationPersistency", "write", (dest, args, connection) => {
        const store = (backend.persistency[dest] ??= {});
        Object.assign(store, args);
        backend.onPersistencyChange(backend.persistency);
        backend.send(dest, { write: { res: "success" } }, connection);
    });

    // nav_apps.py:39-61. An unknown key must not reply "Empty": the HMI then
    // reports "no data" for it. `{}` is the "empty read" it counts and later
    // resolves to null, which is what ends the guidance restarter.
    backend.on("NavigationPersistency", "read", (dest, args, connection) => {
        const record = backend.persistency[dest]?.[args?.key];
        backend.send(
            dest,
            { read: { res: isObject(record) ? record : {} } },
            connection,
        );

        if (args?.key === ACTIVE_GUIDANCE_KEY) {
            // No map engine, so the layer is genuinely hidden. The reply
            // makes MainBackgroundScreen refresh the map configuration.
            schedule(MAP_REFRESH_DELAY_MS, () => {
                backend.send("DisplayManager", {
                    requestDisplay: {
                        layer: "map",
                        visible: "false",
                        granted: "true",
                    },
                });
            });
        }
    });

    // NavTrailInfo: TrailManager polls `ls_userTracks`/`getTracksFolder` and
    // every `/fs/...` flag directory until it gets a listing; the reference
    // Python backend leaves these unanswered, so the trail service never
    // becomes ready and every retry shows up as `?? NavTrailInfo.ls`.
    const listings = isObject(navfs.listings) ? navfs.listings : {};
    const tracksFolder =
        typeof navfs.tracksFolder === "string"
            ? navfs.tracksFolder
            : "/fs/mmc0/nav/tracks/";

    /** Entries are file names mapped to metadata; the HMI only reads keys. */
    const listingFor = (path) => {
        const listing = listings[path];
        return isObject(listing) ? { ...listing } : {};
    };

    backend.on("NavTrailInfo", "ls", (dest, args) => {
        backend.send(dest, { ls: { listing: listingFor(args?.path) } });
    });

    backend.on("NavTrailInfo", "ls_userTracks", (dest) => {
        backend.send(dest, {
            ls_userTracks: { listing: listingFor(tracksFolder) },
        });
    });

    backend.on("NavTrailInfo", "getTracksFolder", (dest) => {
        backend.send(dest, { getTracksFolder: { result: tracksFolder } });
    });

    // The VFS is read-only. The HMI only needs an acknowledgement to refresh
    // its list; there is nothing to move, delete or create on the browser
    // side (trail files are never opened).
    for (const command of ["mkUserTracksFolder", "mvTrack", "rmTrack"]) {
        backend.on("NavTrailInfo", command, (dest) => {
            backend.send(dest, { [command]: { result: 0 } });
        });
    }
}
