/**
 * Project-specific backend handlers.
 *
 * The generic protocol state machine in `hmi-backend.js` already handles
 * subscriptions, `get(All)Properties`, generic `set*` commands and persistency.
 * This file only wires up the emulated modules, in the order they appear in the
 * reference Python backend.
 *
 * A handler mirrors `@on(module, command)` and receives
 * `(dest, args, connection)`:
 *
 *     backend.on("Audio", "getAudioSource", (dest, args, connection) => {
 *         backend.send(dest, { getAudioSource: { source: "fm" } }, connection);
 *     });
 *
 * Useful backend methods inside handlers:
 *
 *   backend.send(module, payload, connection)  - raw reply/notification
 *   backend.emit(module, signal, connection?)   - re-send a known signal
 *   backend.broadcast(module, signal, value)    - push to subscribers
 *   backend.setProperty(module, key, value, c?) - store + emit change signal
 *   backend.setSignals(module, values, c?)      - bulk update + emit
 *   backend.moduleStore(module)                 - signal values
 *   backend.propStore(module)                   - getProperties values
 *   backend.persistency                         - read/write store
 */

import { registerAntiTheft } from "./modules/anti-theft.js";
import { registerAppManager } from "./modules/app-manager.js";
import { registerAudio } from "./modules/audio.js";
import { registerClock } from "./modules/clock.js";
import { registerDab } from "./modules/dab.js";
import { registerDriveMode } from "./modules/drivemode.js";
import { registerHvac } from "./modules/hvac.js";
import { registerMedia } from "./modules/media.js";
import { registerMisc } from "./modules/misc.js";
import { registerNav } from "./modules/nav.js";
import { registerPhone } from "./modules/phone.js";
import { registerPps } from "./modules/pps.js";
import { registerSettings } from "./modules/settings.js";
import { registerSpeech } from "./modules/speech.js";
import { registerSxm } from "./modules/sxm.js";
import { registerTuner } from "./modules/tuner.js";
import { registerVehicle } from "./modules/vehicle.js";
import { registerXlets } from "./modules/xlets.js";

/**
 * Registers every project handler on the given backend.
 *
 * Stage 1 covers the replies that unblock the loading screen; stage 2 adds
 * Settings/Controls. Later stages add whole modules next to these.
 *
 * @param {import("./index.js").HmiBackend} backend
 * @param {Record<string, any>} settings Parsed `backend/data/settings.json`.
 * @param {Record<string, any>} [media] Parsed `backend/data/media.json`.
 * @param {Record<string, any>} [navfs] Parsed `backend/data/navfs.json`.
 * @param {Record<string, any>} [phones] Parsed `backend/data/phones.json`.
 * @param {Record<string, any>} [config] Parsed `backend/data/config.json`.
 * @param {{vehicleModel?: string|null,
 *   xlets?: {catalog?: Record<string, any>|null,
 *     overlay?: import("./modules/xlets.js").XletOverlay|null}}} [options]
 *   `?vehicle=` override and the KIM1 xlet catalog/iframe controller.
 * @returns {{media: ReturnType<typeof registerMedia> | null,
 *   phone: ReturnType<typeof registerPhone> | null,
 *   vehicle: ReturnType<typeof registerVehicle> | null,
 *   driveMode: ReturnType<typeof registerDriveMode> | null,
 *   misc: ReturnType<typeof registerMisc> | null,
 *   sxm: ReturnType<typeof registerSxm>,
 *   speech: ReturnType<typeof registerSpeech>,
 *   xlets: ReturnType<typeof registerXlets>}} Module controllers the
 *   launcher can expose in the HUD.
 */
export function registerHandlers(
    backend,
    settings,
    media,
    navfs,
    phones,
    config,
    options = {},
) {
    registerSettings(backend, settings); // modules/settings.py, sxm.py:13-17
    // `vehicle.py:103-120`: VehicleConfig is read once at HMI boot, so this
    // must run after Settings seeded its flags and before the HMI asks.
    const vehicle = registerVehicle(backend, config ?? {}, {
        model: options.vehicleModel ?? null,
    });
    // Real KIM1 xlets: AppManager protocol + the iframe layer under the HMI.
    const xlets = registerXlets(backend, options.xlets?.catalog ?? {}, {
        overlay: options.xlets?.overlay ?? null,
        vehicle,
    });
    registerHvac(backend); // handlers.py:242-388 (Climate)
    registerAntiTheft(backend); // handlers.py:230-238 (Settings icon gate)
    registerClock(backend); // handlers.py:216-227, 1015-1035
    registerAppManager(backend); // AppManager.as:997-1013
    registerAudio(backend); // handlers.py:389-412 (Audio source)
    registerTuner(backend); // handlers.py:413-542 (AM/FM, presets)
    const sxmController = registerSxm(backend); // modules/sxm.py (offline SXM)
    registerDab(backend); // DAB is not installed on this unit: "off" stubs
    registerPps(backend); // modules/nav_apps.py:81-88
    registerNav(backend, { navfs }); // modules/nav_apps.py (Navigation, NDR, trails)
    const phoneController = registerPhone(backend, phones ?? {}); // modules/phone.py
    const mediaController = registerMedia(backend, media ?? {}); // handlers.py:543-865
    mediaController.setRingtone(phoneController.ringtone);
    const driveModeController = registerDriveMode(backend, config ?? {}, vehicle); // modules/drivemode.py
    const miscController = registerMisc(backend, config ?? {}); // Camera/Rse/AnnouncementMaster/...
    const speechController = registerSpeech(backend); // TextToSpeech/UISpeechService
    return {
        media: mediaController,
        phone: phoneController,
        vehicle,
        driveMode: driveModeController,
        misc: miscController,
        sxm: sxmController,
        speech: speechController,
        xlets,
    };
}
