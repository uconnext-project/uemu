/**
 * DAB stubs for the NAFTA unit.
 *
 * `VARIANT_DAB` is `NO` in `backend/data/settings.json` and `VehicleConfig` has
 * no `dabPresent`, so the HMI never shows DAB sources. `MainSupplement.swf`
 * still creates `DABTunerControl` and `DABTunerFollowMaster`, and they ask for
 * their linking switches on boot; without an answer the backend log fills with
 * `?? unhandled DABTuner*.requestGet*`.
 *
 * These are plain "feature is off" replies - not a DAB implementation. The
 * generic `getProperties` handler already answers the modules' property reads.
 *
 * Shapes: `com/harman/moduleLink/DABTunerControl.as:129-140` and
 * `DABTunerFollowMaster.as:82-86`.
 */

/**
 * @param {import("../index.js").HmiBackend} backend
 */
export function registerDab(backend) {
    // DABTunerControl.MessageHandler -> DAB2DABLinkingSwitch.DAB2DABLinkingSwitch
    backend.on(
        "DABTunerControl",
        "requestGetDab2DabLinkingSwitch",
        (dest, args, connection) => {
            backend.send(
                dest,
                { DAB2DABLinkingSwitch: { DAB2DABLinkingSwitch: false } },
                connection,
            );
        },
    );

    // DABTunerFollowMaster.MessageHandler -> followingSwitch.followingSwitch
    backend.on(
        "DABTunerFollowMaster",
        "requestGetDab2FmLinkingSwitch",
        (dest, args, connection) => {
            backend.send(
                dest,
                { followingSwitch: { followingSwitch: false } },
                connection,
            );
        },
    );
}
