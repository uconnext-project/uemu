/**
 * `readPPS` property replies.
 *
 * Reference: modules/nav_apps.py:81-88. The HMI retries `getPPSValue` for
 * `can/vehcfg` / `DEST` every three seconds until it gets a non-zero value;
 * 221 means North America (VehicleMarkets). `ECUPartNo` is asked for separately.
 */

const PPS_VALUES = Object.freeze({
    DEST: 221,
    ECUPartNo: "68263423AE",
});

/**
 * @param {import("../index.js").HmiBackend} backend
 */
export function registerPps(backend) {
    backend.on("readPPS", "getPPSValue", (dest, args, connection) => {
        const attribute = args?.attribute;
        if (!Object.hasOwn(PPS_VALUES, attribute)) {
            return;
        }

        backend.send(
            dest,
            { getPPSValue: { [attribute]: PPS_VALUES[attribute] } },
            connection,
        );
    });
}
