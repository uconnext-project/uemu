/**
 * Entry point for the in-browser HMI backend.
 *
 * Create one backend and hand `backend.localSocketProvider` to Ruffle:
 *
 *     import { createBackend } from "./backend/index.js";
 *
 *     const backend = createBackend();
 *     player.load({ url: "/app.xml", localSocketProvider: backend.localSocketProvider });
 *
 * New handlers are registered per module and command, exactly like the
 * reference Python backend's `@on(module, command)` decorator:
 *
 *     backend.on("TextToSpeech", "speak", (dest, args, connection) => {
 *         backend.send(dest, { speak: { res: "success" } }, connection);
 *     });
 *
 * See `handlers.js` for the place where project-specific handlers live.
 */

export {
    FRAME_TERMINATOR,
    FrameReader,
    encodeFrame,
    formatFrame,
    parseFrame,
    stripLengthPrefix,
} from "./protocol.js";

export {
    DEFAULT_NESTED_MODULES,
    HmiBackend,
    HmiConnection,
} from "./hmi-backend.js";

import { HmiBackend } from "./hmi-backend.js";

/**
 * Creates an emulated HMI backend.
 *
 * @param {ConstructorParameters<typeof HmiBackend>[0]} [options]
 * @returns {HmiBackend}
 */
export function createBackend(options = {}) {
    return new HmiBackend(options);
}

/**
 * Loads the seed data shipped with the backend:
 *
 *   `state.json`       - module state, `_replies`, `_props`, `_persist`
 *   `persistency.json` - factory defaults for the read/write store
 *   `settings.json`    - Settings/Controls defaults (stage 2)
 *   `media.json`       - demo media devices/library (stage 6)
 *   `navfs.json`       - nav trail folders/listings (stage 7)
 *   `phones.json`      - paired phones, contacts, recents, SMS (stage 8)
 *   `config.json`      - car profile and Drive Mode tables (stage 9)
 *
 * All files are fetched relative to this module, so the page can be served
 * from any directory as long as `backend/data/` travels with it.
 *
 * @param {URL} [baseUrl]
 * @returns {Promise<{state: Record<string, any>, persistency: Record<string, any>,
 *   settings: Record<string, any>, media: Record<string, any>,
 *   navfs: Record<string, any>, phones: Record<string, any>,
 *   config: Record<string, any>}>}
 */
export async function loadSeed(
    baseUrl = new URL("./data/", import.meta.url),
) {
    const load = async (name) => {
        const url = new URL(name, baseUrl);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Could not load ${url.pathname} (${response.status})`);
        }

        return response.json();
    };

    const [state, persistency, settings, media, navfs, phones, config] =
        await Promise.all([
            load("state.json"),
            load("persistency.json"),
            load("settings.json"),
            load("media.json"),
            load("navfs.json"),
            load("phones.json"),
            load("config.json"),
        ]);

    return { state, persistency, settings, media, navfs, phones, config };
}

/**
 * Merges persistency snapshots; later stores win per key.
 *
 * Mirrors the reference backend's start-up order: `state.json` `_persist`
 * first, then `persistency.json`, then whatever the browser saved last.
 *
 * @param {...Record<string, Record<string, any>>} stores
 * @returns {Record<string, Record<string, any>>}
 */
export function mergePersistency(...stores) {
    const merged = {};

    for (const store of stores) {
        if (!store || typeof store !== "object") {
            continue;
        }

        for (const [dest, values] of Object.entries(store)) {
            if (!values || typeof values !== "object") {
                continue;
            }

            merged[dest] = { ...(merged[dest] ?? {}), ...values };
        }
    }

    return merged;
}
