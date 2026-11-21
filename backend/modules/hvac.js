/**
 * HVAC / climate.
 *
 * Port of the reference `emulator/handlers.py:242-388`: the climate module
 * owns the zone state, the HMI sends button presses as `setControlProperties`
 * and receives full snapshots (`getZoneProperties`, `getControlProperties`) or
 * partial `zone` signals after a change.
 *
 * Temperatures are stored in °F, exactly like the reference. The HMI talks in
 * the unit configured in `PersonalConfig.temperatureUnits`:
 *
 *     US:     59..85  (the slider ends map to lo/hi, stored range 60..84)
 *     METRIC: 13..31  (stored range 14..30)
 *
 * `_to_ui` converts a stored value for every outgoing message; `_from_ui`
 * converts an incoming slider value before storing it. Changing the unit
 * system re-broadcasts both front temperatures so the Climate screen can
 * reformat them (`settings.py:202`).
 *
 * Shapes: `com/nfuzion/moduleLink/Hvac.as` (`hvacMessageHandler`).
 */

/** handlers.py:250 - fan steps; 0 is off, 1..7 are manual speeds. */
const FAN_STEPS = Object.freeze(["off", "1", "2", "3", "4", "5", "6", "7"]);

/** handlers.py:254 - slider range per unit (lo/hi are the ends). */
const RANGE = Object.freeze({
    us: Object.freeze({ lo: 60, hi: 84 }),
    metric: Object.freeze({ lo: 14, hi: 30 }),
});

/** handlers.py:253 - initial zone state. */
function initialState() {
    return {
        front: {
            climate: "on",
            ac: "on",
            maxAC: "off",
            auto: "off",
            recirc: "off",
            rearDefrost: "off",
            sync: "off",
            fan: "3",
            airflowMode: "vent",
            temp: "72",
        },
        frontLeft: { temp: "72" },
        frontRight: { temp: "72" },
    };
}

/** handlers.py:335-337. */
const TOGGLES = new Set([
    "climate",
    "ac",
    "maxAC",
    "recirc",
    "auto",
    "rearDefrost",
    "sync",
    "lock",
    "airquality",
]);

/** handlers.py:336. */
const VENT_MODES = new Set([
    "vent",
    "floor",
    "mix",
    "defrostMix",
    "defrost",
]);

/** handlers.py:338 - any of these wakes the system after OFF. */
const WAKES = new Set([
    "fan",
    "fanUp",
    "fanDown",
    "temp",
    "tempUp",
    "tempDown",
    "ac",
    "maxAC",
    "auto",
    ...VENT_MODES,
]);

/**
 * Python's `int(value)` for the values the HMI sends. Returns `null` when the
 * value is not numeric, so callers can mirror the reference fallbacks.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function toInt(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : null;
}

/**
 * `_props`-style unwrapping, shared with the Settings port.
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
 * Registers the climate module.
 *
 * @param {import("../index.js").HmiBackend} backend
 */
export function registerHvac(backend) {
    // handlers.py:243-247 - mutable module state (not part of state.json,
    // because the reference module never publishes it as a signal store).
    const HVAC = initialState();

    /** handlers.py:268-270 - `PersonalConfig.temperatureUnits` decides the unit. */
    function isMetric() {
        const units = backend.propStore("PersonalConfig").temperatureUnits;
        const name =
            units && typeof units === "object"
                ? units.temperatureUnits
                : units;
        return String(name ?? "US").toUpperCase() === "METRIC";
    }

    /** handlers.py:257-262 - stored value -> HMI value. */
    function toUi(value) {
        if (value === "lo" || value === "hi") {
            return value;
        }

        const metric = isMetric();
        const stored = toInt(value);
        if (stored === null) {
            return String(value);
        }

        const number = metric ? Math.round((stored - 32) / 1.8) : stored;
        const { lo, hi } = metric ? RANGE.metric : RANGE.us;
        if (number < lo) {
            return "lo";
        }
        if (number > hi) {
            return "hi";
        }

        return String(number);
    }

    /** handlers.py:273-285 - HMI value -> stored °F (or lo/hi). */
    function fromUi(value) {
        const text = String(value).toLowerCase();
        if (text === "lo" || text === "hi") {
            return text;
        }

        const number = toInt(text);
        if (number === null) {
            return "72";
        }

        const metric = isMetric();
        const { lo, hi } = metric ? RANGE.metric : RANGE.us;
        if (number < lo) {
            return "lo";
        }
        if (number > hi) {
            return "hi";
        }

        return metric ? String(Math.round(number * 1.8 + 32)) : String(number);
    }

    /** handlers.py:288-293 - one step up/down in the user's unit. */
    function tempStep(current, delta) {
        const metric = isMetric();
        const { lo, hi } = metric ? RANGE.metric : RANGE.us;
        const order = ["lo"];
        for (let value = lo; value <= hi; value += 1) {
            order.push(String(value));
        }
        order.push("hi");

        const ui = toUi(current);
        let index = order.indexOf(ui);
        if (index < 0) {
            index = order.indexOf(toUi("72"));
        }
        const next = Math.max(0, Math.min(order.length - 1, index + delta));

        return fromUi(order[next]);
    }

    /** handlers.py:295-297 - outgoing controls are always in the HMI unit. */
    function ui(controls) {
        const result = {};
        for (const [key, value] of Object.entries(controls)) {
            result[key] = key === "temp" ? toUi(value) : value;
        }

        return result;
    }

    /** handlers.py:308-310 - `{"zone": {zone, controls}}`, not nested. */
    function emitZone(zone, controls, connection) {
        backend.send(
            "HVAC",
            { zone: { zone, controls: ui(controls) } },
            connection,
        );
    }

    /** handlers.py:301-306 - the unit system changed. */
    function publishTemps() {
        for (const zone of ["frontLeft", "frontRight"]) {
            emitZone(zone, { temp: HVAC[zone].temp });
        }
    }

    // ------------------------------------------------------------ getters
    // handlers.py:312-316.
    backend.on("HVAC", "getZoneProperties", (dest, args, connection) => {
        const zones = Object.entries(HVAC).map(([zone, controls]) => ({
            zone,
            controls: ui(controls),
        }));

        backend.send(
            dest,
            { getZoneProperties: { zones } },
            connection,
        );
    });

    // handlers.py:318-323.
    backend.on("HVAC", "getControlProperties", (dest, args, connection) => {
        const zone = args?.zone ?? "front";
        const current = HVAC[zone] ?? {};
        const wanted = Array.isArray(args?.controls)
            ? args.controls
            : Object.keys(current);
        const controls = {};
        for (const key of wanted) {
            if (Object.hasOwn(current, key)) {
                controls[key] = current[key];
            }
        }

        backend.send(
            dest,
            { getControlProperties: { zone, controls: ui(controls) } },
            connection,
        );
    });

    // ------------------------------------------------------------ setter
    // handlers.py:326-386.
    backend.on("HVAC", "setControlProperties", (dest, args, connection) => {
        const zoneName = args?.zone ?? "front";
        const front = HVAC.front;
        const zone = (HVAC[zoneName] ??= {});
        /** @type {Record<string, Record<string, any>>} */
        const changed = {};

        const put = (name, key, value) => {
            const store = (HVAC[name] ??= {});
            if (store[key] !== value) {
                store[key] = value;
                (changed[name] ??= {})[key] = value;
            }
        };

        const controls =
            args?.controls &&
            typeof args.controls === "object" &&
            !Array.isArray(args.controls)
                ? args.controls
                : {};

        for (const [key, rawValue] of Object.entries(controls)) {
            if (rawValue === "release") {
                continue;
            }

            if (
                WAKES.has(key) &&
                front.climate !== "on" &&
                key !== "climate"
            ) {
                put("front", "climate", "on");
                if (front.fan === "off") {
                    put("front", "fan", "1");
                }
            }

            if (TOGGLES.has(key)) {
                const on = front[key] !== "on";
                put("front", key, on ? "on" : "off");
                if (key === "maxAC" && on) {
                    put("front", "ac", "on");
                    put("front", "recirc", "on");
                }
                if (key === "auto" && on) {
                    put("front", "ac", "on");
                }
                if (key === "sync" && on) {
                    put("frontRight", "temp", HVAC.frontLeft.temp ?? "72");
                }
            } else if (VENT_MODES.has(key)) {
                put("front", "airflowMode", key);
            } else if (key === "tempUp" || key === "tempDown" || key === "temp") {
                const value =
                    key === "temp"
                        ? fromUi(rawValue)
                        : tempStep(
                              zone.temp ?? "72",
                              key === "tempUp" ? 1 : -1,
                          );
                put(zoneName, "temp", value);
                if (zoneName === "frontRight") {
                    put("front", "sync", "off");
                } else if (zoneName === "frontLeft" && front.sync === "on") {
                    put("frontRight", "temp", value);
                }
            } else if (key === "fanUp" || key === "fanDown" || key === "fan") {
                let fan;
                if (key === "fan") {
                    fan = rawValue;
                } else {
                    const index = FAN_STEPS.includes(front.fan)
                        ? FAN_STEPS.indexOf(front.fan)
                        : 3;
                    const next = Math.max(
                        1,
                        Math.min(7, index + (key === "fanUp" ? 1 : -1)),
                    );
                    fan = FAN_STEPS[next];
                }
                put("front", "fan", fan);
                put("front", "auto", "off"); // manual fan cancels AUTO
            } else {
                put(zoneName, key, rawValue);
            }
        }

        for (const [name, controlsChanged] of Object.entries(changed)) {
            emitZone(name, controlsChanged, connection);
        }
    });

    // handlers.py via settings.py:202 - Settings rewrites the unit table and
    // calls `hvac_publish_temps()`. `alsoOn` keeps the two modules independent:
    // the Settings hook runs first, then this observer broadcasts the temps.
    backend.alsoOn("PersonalConfig", "setProperties", (dest, args) => {
        const props = propsOf(args);
        if ("units" in props || "temperatureUnits" in props) {
            publishTemps();
        }
    });
}
