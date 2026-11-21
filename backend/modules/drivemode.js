/**
 * SRT Drive Modes: the car side of the stock DriveMode screens
 * (reference `modules/drivemode.py`, HMI `DriveMode.as`).
 *
 * L-series cars (Challenger/Charger/300) use the "legacy" table mode: one
 * settings table per drive mode. The Jeep Grand Cherokee SRT (WK,
 * Selec-Track) is non-legacy: the mode comes from the console dial, the HMI's
 * Set-Up edits one custom set (the `*DriveMode` / `*Cfg` signals) that Custom,
 * and partly Auto/Snow/Tow, use.
 *
 * The HMI only offers Drive Modes when `VehicleConfig` has
 * `driveModePresent` + `SRTPresent`; then it asks this module for every
 * signal. A mode change sends `globalDriveModeStatus`; the HMI expects each
 * subsystem's status signal back (it times out into an error otherwise), so
 * every change replies with the whole picture. Values on the wire are the Lua
 * names (`"street"`, `"red"`, `"paddles_enabled"`).
 */

/** `drivemode.py:16-17`. */
const SUBSYS = Object.freeze([
    "transmissionDriveMode",
    "HPDriveModeCfg",
    "EPSDriveMode",
    "ESCDriveMode",
    "activeDampingDriveMode",
    "paddlesDriveMode",
    "terrainDriveMode",
    "engineDriveModeCfg",
]);

/** `drivemode.py:19-23`: subsystem setting -> live status signal it drives. */
const STATUS = Object.freeze({
    transmissionDriveMode: "transmissionMode",
    HPDriveModeCfg: "enginePowerMode",
    EPSDriveMode: "EPSModeStatus",
    ESCDriveMode: "ESCButtonStatus",
    activeDampingDriveMode: "activeDampingStatus",
    paddlesDriveMode: "paddlesDriveModeStatus",
    terrainDriveMode: "terrainMode",
    engineDriveModeCfg: "engineDriveMode",
});

/**
 * `drivemode.py:25-34`: factory tables. Terrain (AWD torque split) only shows
 * on the Jeep. The last column is the engine/throttle setting of non-SRT
 * "Performance Control" cars (manual: no transmission row).
 */
const TABLES = Object.freeze({
    default: [
        "street",
        "black",
        "street",
        "street",
        "street",
        "paddles_disabled",
        "auto",
        "street",
    ],
    sport: [
        "sport",
        "red",
        "sport",
        "sport",
        "sport",
        "paddles_enabled",
        "sport",
        "sport",
    ],
    track: [
        "track",
        "red",
        "track",
        "track",
        "track",
        "paddles_enabled",
        "track",
        "sport",
    ],
    snow: [
        "snow",
        "black",
        "street",
        "snow",
        "street",
        "paddles_disabled",
        "snow",
        "street",
    ],
    tow: [
        "tow",
        "black",
        "street",
        "street",
        "street",
        "paddles_disabled",
        "tow",
        "street",
    ],
    custom: [
        "sport",
        "red",
        "street",
        "sport",
        "street",
        "paddles_enabled",
        "sport",
        "sport",
    ],
});

/**
 * `drivemode.py:36-38`: Jeep Set-Up fields come from the one custom set.
 */
const WK_FROM_CUSTOM = Object.freeze({
    default: ["paddlesDriveMode", "EPSDriveMode", "activeDampingDriveMode"],
    snow: ["paddlesDriveMode"],
    tow: ["paddlesDriveMode"],
    custom: SUBSYS,
});

/** `drivemode.py:39-42`. */
const FIXED = Object.freeze({
    ready: "true",
    isLegacyDriveMode: "true",
    redKeyFeaturePresent: "true",
    redKeyPresent: "true",
    powerSteeringType: "EPS",
    EPSWarnDisplayRequest: "none",
    throttlePosition: "released",
    valetLockOut: "false",
    SRTButtonStatus: "off",
    tractionControlIndicator: "on",
    maxShiftRPM: "6200",
    gear1RPMSetPoint: "6000",
    gear2RPMSetPoint: "6000",
    gear3RPMSetPoint: "6000",
    gear4RPMSetPoint: "6000",
    gear5RPMSetPoint: "6000",
    shiftIndicatorRPMReset: "false",
    driveModeIndicator1: "false",
    driveModeIndicator2: "false",
    driveModeIndicator3: "false",
    driveModeIndicator4: "false",
    ErrSys_1: "false",
    ErrSys_2: "false",
    ErrSys_3: "false",
    ErrSys_4: "false",
    ErrSys_5: "false",
    ErrSys_6: "false",
    ErrSys_7: "false",
    ErrSys_8: "false",
});

/** `drivemode.py:110`: survives an ignition cycle; the mode itself does not. */
const KEEP = Object.freeze(["tables", "launchRPM", "shift"]);

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function factoryTables() {
    return Object.fromEntries(
        Object.entries(TABLES).map(([mode, values]) => [
            mode,
            Object.fromEntries(
                SUBSYS.map((key, index) => [key, values[index]]),
            ),
        ]),
    );
}

/**
 * @param {import("../index.js").HmiBackend} backend
 * @param {Record<string, any>} config Parsed `backend/data/config.json`.
 * @param {ReturnType<typeof import("./vehicle.js").registerVehicle>} vehicle
 */
export function registerDriveMode(backend, config, vehicle) {
    const file = config?.driveMode ?? {};

    /** `drivemode.py:39-42`. */
    const car = {
        mode: "default",
        eco: false,
        launch: "off",
        launchRPM: file.launchRPM ?? null,
        shift: file.shift ?? "enabled",
        tables: factoryTables(),
    };

    // config.json's saved tables go over the factory tables (older saves may
    // lack newer columns), exactly like `drivemode.py:132-136`.
    for (const [mode, table] of Object.entries(file.tables ?? {})) {
        if (!table || typeof table !== "object") {
            continue;
        }
        car.tables[mode] ??= {};
        Object.assign(car.tables[mode], table);
    }

    /** `drivemode.py:39-46`. */
    const fixed = { ...FIXED };
    Object.assign(fixed, file.gearRPM ?? {});

    const saved = backend.persistency?.DriveMode;

    /** `drivemode.py:128-136`. */
    function load() {
        if (!saved || typeof saved !== "object") {
            return;
        }
        for (const key of KEEP) {
            if (key !== "tables" && Object.hasOwn(saved, key)) {
                car[key] = saved[key];
            }
        }
        for (const [mode, table] of Object.entries(saved.tables ?? {})) {
            if (!table || typeof table !== "object") {
                continue;
            }
            car.tables[mode] ??= {};
            Object.assign(car.tables[mode], table);
        }
        Object.assign(fixed, saved.gearRPM ?? {});
    }

    load();

    function wk() {
        return vehicle.current().line === "WK";
    }

    /** `drivemode.py:116-127`. */
    function props() {
        const profile = vehicle.current();
        const hellcat = profile.trim === "hellcat";

        fixed.isLegacyDriveMode = wk() ? "false" : "true";
        fixed.redKeyFeaturePresent = hellcat ? "true" : "false";
        if (!hellcat) {
            fixed.redKeyPresent = "false";
        }

        const drop = profile.srt === false
            ? "HPDriveModeCfg"
            : "engineDriveModeCfg";
        const mode = car.mode;
        const live = {
            ...(car.tables[mode === "valet" ? "default" : mode] ??
                car.tables.default),
        };
        if (wk()) {
            for (const key of WK_FROM_CUSTOM[mode] ?? []) {
                live[key] = car.tables.custom[key];
            }
        }

        const p = {
            ...fixed,
            globalDriveModeStatus: mode,
            ecoModeActive: String(car.eco).toLowerCase(),
            launchButtonStatus: car.launch,
            launchRPMSetPoint:
                car.launchRPM ||
                (profile.trans === "Automatic" ? "1500" : "2500"),
            shiftIndicatorStatus: car.shift,
            driveModeIndicator3: String(car.launch === "on").toLowerCase(),
            // Both power columns land on the HORSE_POWER slot
            // (DriveMode.createTable): send only this car's one.
            globalDriveModeConfigs: Object.fromEntries(
                Object.entries(car.tables).map(([tableMode, table]) => [
                    tableMode,
                    {
                        values: Object.fromEntries(
                            Object.entries(table).filter(
                                ([key]) => key !== drop,
                            ),
                        ),
                    },
                ]),
            ),
        };

        for (const key of SUBSYS) {
            p[key] = car.tables.custom[key];
            p[STATUS[key]] = live[key];
        }
        if (mode === "valet") {
            // Valet: 500 hp, street everything, no paddles.
            p.enginePowerMode = "valet";
            p.transmissionMode = "street";
            p.paddlesDriveModeStatus = "paddles_disabled";
        }

        return p;
    }

    /** Keep the signal store usable for subscriptions and diagnostics. */
    function remember(values) {
        Object.assign(backend.moduleStore("DriveMode"), values);
    }

    /** `drivemode.py:129-132`. */
    function push(connection, keys) {
        const p = props();
        remember(p);
        const values = keys
            ? Object.fromEntries(
                  keys.filter((key) => Object.hasOwn(p, key)).map((key) => [
                      key,
                      p[key],
                  ]),
              )
            : p;
        // `getProperties` is the one reply shape `processProperties` takes as
        // `{signal: raw value}`.
        backend.send("DriveMode", { getProperties: values }, connection);
    }

    /** `drivemode.py:120-124`: what the car keeps across an ignition cycle. */
    function save() {
        backend.persistency.DriveMode = {
            tables: clone(car.tables),
            launchRPM: car.launchRPM,
            shift: car.shift,
            gearRPM: Object.fromEntries(
                Object.entries(fixed).filter(([key]) =>
                    key.endsWith("RPMSetPoint"),
                ),
            ),
        };
        backend.onPersistencyChange(backend.persistency);
    }

    /** `drivemode.py:138-171`. */
    function setProp(key, value) {
        // Subsystem requests arrive as `{type: <global mode>, value: <setting>}`
        // (DriveMode.convertReq*).
        let mode = car.mode;
        let val = value;
        if (value && typeof value === "object" && !Array.isArray(value)) {
            mode = value.type || car.mode;
            val = value.value;
        }

        if (key === "globalDriveModeStatus") {
            car.mode =
                val === "valet" && car.mode === "valet" ? "default" : val;
            if (car.mode === "valet") {
                car.launch = "off";
            }
            if (val === "sport" || val === "track") {
                car.eco = false;
            }
        } else if (
            Object.values(STATUS).includes(key) ||
            SUBSYS.includes(key)
        ) {
            const sub = SUBSYS.includes(key)
                ? key
                : Object.keys(STATUS).find((name) => STATUS[name] === key);
            const table = (car.tables[wk() ? "custom" : mode] ??= {});
            table[sub] = val;
        } else if (key === "launchButtonStatus") {
            // A button press: the same "on" arms and cancels.
            car.launch =
                car.launch === "on" || car.mode === "valet" ? "off" : "on";
        } else if (key === "launchRPMSetPoint") {
            car.launchRPM = String(val);
        } else if (key === "shiftIndicatorStatus") {
            if (val === "enabled" || val === "disabled") {
                car.shift = val;
            }
        } else if (key === "shiftIndicatorRPMReset") {
            for (let gear = 1; gear <= 5; gear += 1) {
                fixed[`gear${gear}RPMSetPoint`] = "6000";
            }
        } else if (key.endsWith("RPMSetPoint")) {
            fixed[key] = String(val);
        } else {
            backend.log("DM", `unhandled setProperties ${key}=${value}`);
        }
    }

    /** `drivemode.py:173-178`: Eco button on the main screen. */
    backend.onEmitSignal((packet) => {
        if (!Object.hasOwn(packet, "ecoModeActiveRequest")) {
            return;
        }
        car.eco = packet.ecoModeActiveRequest?.value === "true";
        if (car.eco) {
            car.mode = "default";
        }
        push();
    });

    // ------------------------------------------------------------ commands

    backend.on("DriveMode", "getAllProperties", (dest, args, connection) => {
        const p = props();
        remember(p);
        backend.send(dest, { getAllProperties: p }, connection);
    });

    backend.on("DriveMode", "getProperties", (dest, args, connection) => {
        const requested = Array.isArray(args.props) ? args.props : [];
        push(connection, requested);
    });

    backend.on("DriveMode", "getDriveModeVersion", (dest, args, connection) => {
        backend.send(
            dest,
            { getDriveModeVersion: { version: "DM 2.0" } },
            connection,
        );
    });

    backend.on("DriveMode", "getLoggingEnable", (dest, args, connection) => {
        backend.send(
            dest,
            { getLoggingEnable: { enableLogging: "false" } },
            connection,
        );
    });

    backend.on("DriveMode", "setLoggingEnable", (dest, args, connection) => {
        backend.send(
            dest,
            {
                getLoggingEnable: {
                    enableLogging: String(args.value ?? "false"),
                },
            },
            connection,
        );
    });

    // No USB stick in the browser; the HMI shows no result for this.
    backend.on("DriveMode", "copyDriveModeLogToUSB", () => {});

    backend.on("DriveMode", "setProperties", (dest, args, connection) => {
        const values =
            args.props &&
            typeof args.props === "object" &&
            !Array.isArray(args.props)
                ? args.props
                : args;
        for (const [key, value] of Object.entries(values)) {
            setProp(key, value);
        }
        save();
        push();
    });

    remember(props());

    // ------------------------------------------------------------ simulator

    /** Panel actions from `drivemode.py:180-205`, exposed for the HUD/devtools. */
    function selec(position) {
        if (
            !["auto", "sport", "track", "snow", "tow"].includes(position)
        ) {
            throw new Error(`unknown Selec-Track position ${position}`);
        }
        car.mode = position === "auto" ? "default" : position;
        car.launch = "off";
        push();
    }

    function reset() {
        car.tables = factoryTables();
        Object.assign(car, {
            mode: "default",
            eco: false,
            launch: "off",
            launchRPM: null,
        });
        save();
        push();
    }

    return {
        get mode() {
            return car.mode;
        },
        get eco() {
            return car.eco;
        },
        get tables() {
            return car.tables;
        },
        props,
        push,
        setProp,
        selec,
        reset,
    };
}
