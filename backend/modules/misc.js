/**
 * Small `Camera` / `Rse` / `AnnouncementMaster` / `DriverAB` / `HEV` / `SWC`
 * acks (stage 9).
 *
 * These modules mostly receive unsolicited car signals. The stock HMI only
 * needs them to answer cleanly, otherwise `getStartUpStatus`,
 * `requestExitFullScreen` and friends end up as `??` lines and, for the
 * modules that gate a screen on a getter, can leave the UI waiting.
 *
 * Reference shapes:
 *
 *   CameraUpdate.as      - subscribes `prndstatus`; `getStartUpStatus`
 *   Rse.as               - `requestExitFullScreen`, `getAccessibilitySupport`,
 *                          `getFullScreenButtonStat`
 *   AnnouncementMaster.as- switch signals are `{enable: bool}`, the advisory
 *                          signal is `{category: uint}` (getProperties returns
 *                          the raw category), categories are `{categories:[...]}`
 *   DriverAB.as          - `getProperties.driverType`
 *   HEV.as               - `getAllProperties`, `getHEVLoggingConfig`
 *   SWC.as               - subscriptions only (steering-wheel buttons)
 */

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

/**
 * @param {import("../index.js").HmiBackend} backend
 * @param {Record<string, any>} [config] Parsed `backend/data/config.json`.
 */
export function registerMisc(backend, config = {}) {
    // ------------------------------------------------------------ Camera
    // `CameraUpdate.as:57,74-80`: 1 = reverse, everything else = camera off.
    backend.defineModule("Camera", {
        state: { prndstatus: { prndstatus: "0" } },
        properties: { prndstatus: { prndstatus: "0" } },
    });
    backend.on("Camera", "getStartUpStatus", (dest, args, connection) => {
        backend.send(
            dest,
            { getStartUpStatus: { status: "success" } },
            connection,
        );
    });

    // ------------------------------------------------------------ Rse
    // `Rse.as:126` subscribes these on connect. A false/empty value means "no
    // rear-seat entertainment unit", so the RSE tile stays out of the way.
    backend.defineModule("Rse", {
        state: {
            externalSourceStatus: { cd: "", cam: "false", vrm: "false" },
            cdSyncComplete: { cdSyncComplete: false },
            fullScreenButton: { fullScreenButton: false, source: "" },
            accessibilitySupport: { status: false },
            exitFullScreen: { exitFullScreen: false },
            rearVideoStatus: { rearVideoStatus: false },
            startingRdc2Video: { status: "" },
            rdc2ModeStarted: { rdc2Mode: "" },
        },
    });

    backend.on("Rse", "getAccessibilitySupport", (dest, args, connection) => {
        backend.send(
            dest,
            { getAccessibilitySupport: { status: false } },
            connection,
        );
    });

    backend.on("Rse", "getFullScreenButtonStat", (dest, args, connection) => {
        backend.send(
            dest,
            {
                getFullScreenButtonStat: {
                    fullScreenButton: false,
                    source: String(args.source ?? ""),
                },
            },
            connection,
        );
    });

    backend.on("Rse", "requestExitFullScreen", (dest, args, connection) => {
        // The car answers with an `exitFullScreen` signal; false keeps the HMI
        // on its current branch (true would branch on exit).
        backend.send(
            dest,
            { exitFullScreen: { exitFullScreen: false } },
            connection,
        );
    });

    // RSE transport commands are harmless no-ops here; ack them so a DVD /
    // VRM-less head unit does not fill the log with `??`.
    for (const command of [
        "selectItem",
        "getItems",
        "nextTrack",
        "previousTrack",
        "seeknext",
        "seekback",
        "buttonRelease",
        "fastforward",
        "fastrewind",
        "discstop",
        "startRdc2Video",
        "switchToVrmParentalControls",
        "muteExternalModule",
        "requestICSTuning",
    ]) {
        backend.on("Rse", command, (dest, args, connection) => {
            backend.send(dest, { [command]: {} }, connection);
        });
    }

    // --------------------------------------------------- AnnouncementMaster
    const categoryStates = {
        categories: Array.from({ length: 11 }, (_, category) => ({
            category,
            enable: false,
        })),
    };

    backend.defineModule("AnnouncementMaster", {
        state: {
            tunerAnnouncementSwitch: { enable: false },
            dabAnnouncementSwitch: { enable: false },
            advisoryMessage: { category: 65535 },
            dabAnnCategoryStates: clone(categoryStates),
        },
    });

    const announcements = () => backend.moduleStore("AnnouncementMaster");

    /**
     * `AnnouncementMaster.as:273-283`: switches come back as `{enable}`, the
     * advisory category is raw, and the category list is `{categories}`.
     */
    function announcementProps() {
        const store = announcements();
        return {
            tunerAnnouncementSwitch: store.tunerAnnouncementSwitch,
            dabAnnouncementSwitch: store.dabAnnouncementSwitch,
            advisoryMessage:
                store.advisoryMessage?.category ??
                store.advisoryMessage ??
                65535,
            dabAnnCategoryStates: store.dabAnnCategoryStates,
        };
    }

    backend.on(
        "AnnouncementMaster",
        "getProperties",
        (dest, args, connection) => {
            const values = announcementProps();
            const requested = Array.isArray(args.props) ? args.props : [];
            const props = {};
            for (const key of requested) {
                if (Object.hasOwn(values, key)) {
                    props[key] = values[key];
                }
            }
            backend.send(dest, { getProperties: props }, connection);
        },
    );

    const asBool = (value) => value === true || value === "true";

    backend.on(
        "AnnouncementMaster",
        "setTunerAnnouncementSwitch",
        (dest, args, connection) => {
            backend.setProperty(
                "AnnouncementMaster",
                "tunerAnnouncementSwitch",
                { enable: asBool(args.enable) },
                connection,
            );
        },
    );

    backend.on(
        "AnnouncementMaster",
        "setDabAnnouncementSwitch",
        (dest, args, connection) => {
            backend.setProperty(
                "AnnouncementMaster",
                "dabAnnouncementSwitch",
                { enable: asBool(args.enable) },
                connection,
            );
        },
    );

    function setCategories(enable, category = null) {
        const store = announcements();
        const categories = clone(
            store.dabAnnCategoryStates?.categories ?? categoryStates.categories,
        );
        for (const item of categories) {
            if (category === null || item.category === category) {
                item.enable = enable;
            }
        }
        backend.setProperty(
            "AnnouncementMaster",
            "dabAnnCategoryStates",
            { categories },
        );
    }

    backend.on(
        "AnnouncementMaster",
        "setDabCategory",
        (dest, args, connection) => {
            setCategories(asBool(args.enable), Number(args.category));
        },
    );

    backend.on(
        "AnnouncementMaster",
        "setAllDabCategories",
        (dest, args, connection) => {
            setCategories(asBool(args.enable));
        },
    );

    backend.on(
        "AnnouncementMaster",
        "requestAbortAnnouncement",
        () => {},
    );

    // ------------------------------------------------------------ DriverAB
    // `DriverAB.as:72-79`: -1 = no driver profile, so no recall/save popup.
    backend.defineModule("DriverAB", {
        state: {
            driverType: -1,
            driverSettingsAB: { driver: -1, driverSetting: "" },
        },
        properties: { driverType: -1 },
    });

    // ------------------------------------------------------------ HEV
    // Present enough that `getAllProperties` / `getHEVLoggingConfig` answer
    // without a `??`; `VehicleConfig.hybridControlPresent` decides whether the
    // HMI shows anything.
    backend.defineModule("HEV", {
        state: { ready: "true" },
        properties: { ready: "true" },
    });
    backend.on("HEV", "getHEVLoggingConfig", (dest, args, connection) => {
        backend.send(dest, { getHEVLoggingConfig: {} }, connection);
    });
    for (const command of ["configureHEVLogging", "copyHEVLogToUSB", "deleteHEVLog"]) {
        backend.on("HEV", command, () => {});
    }

    // ------------------------------------------------------------ SWC
    // Subscriptions only (volume/seek/phone buttons); the HMI does not send
    // commands to this module.
    backend.defineModule("SWC", {
        state: {
            volume: { volume: 0 },
            UpdateVolume: { vol: 0 },
        },
    });

    // ------------------------------------------------------------ simulator

    /** `handlers.py:989-991`: panel gear selector. */
    function setGear(gear) {
        const status = String(gear);
        backend.moduleStore("Camera").prndstatus = { prndstatus: status };
        backend.propStore("Camera").prndstatus = { prndstatus: status };
        backend.send("Camera", { prndstatus: { prndstatus: status } });
    }

    return { setGear };
}
