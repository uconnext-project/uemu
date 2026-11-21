/**
 * Minimal `AntiTheft` replies.
 *
 * Reference: handlers.py:230-238. The reference module is small and mostly
 * belongs to a later stage, but `AppSettings.as:refresh()` needs
 * `antiTheftState == "unlocked"` before the Settings icon becomes clickable:
 *
 *     this.button.setEnabled(Peripheral.antiTheft.antiTheftState == "unlocked"
 *         && Peripheral.antiTheft.ignitionState != "accessory" && ...)
 *
 * Without these two replies the icon stays greyed out and pressing it shows
 * the `PERSONALIZATION_LOCKOUT` popup.
 *
 * The unsolicited-signal shape is `{antiTheftState: {value: "unlocked"}}`;
 * `getProperties` carries raw values (`AntiTheft.as:178-204`).
 */

const PROPERTIES = Object.freeze({
    ignState: "on",
    powerModeState: "full_operation",
    battConnect: "connected",
    antiTheftLockTime: 0,
    wakeupReason: "ignition",
});

/**
 * @param {import("../index.js").HmiBackend} backend
 */
export function registerAntiTheft(backend) {
    backend.on("AntiTheft", "getAntiTheftState", (dest, args, connection) => {
        backend.send(
            dest,
            { antiTheftState: { value: "unlocked" } },
            connection,
        );
    });

    backend.on("AntiTheft", "getProperties", (dest, args, connection) => {
        const props = Array.isArray(args?.props) ? args.props : [];
        const reply = {};
        for (const key of props) {
            if (Object.hasOwn(PROPERTIES, key)) {
                reply[key] = PROPERTIES[key];
            }
        }

        backend.send(dest, { getProperties: reply }, connection);
    });
}
