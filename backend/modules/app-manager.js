/**
 * `AppPersistenceManager` readiness gate.
 *
 * Reference: AppManager.as:997-1013. `AppManager.isReady()` stays false while
 * `mAppsExist == "notReady"`, and only a `read` reply containing a `res` object
 * moves it forward. An `err`-only reply makes the HMI retry every ~40 ms and
 * never leaves the loading screen.
 *
 * The generic persistency handler in `hmi-backend.js` already answers `res` for
 * keys present in the store. This handler makes that guarantee unconditional,
 * so a stale or empty `localStorage` cannot stall boot.
 */

/**
 * @param {import("../index.js").HmiBackend} backend
 */
export function registerAppManager(backend) {
    backend.on("AppPersistenceManager", "read", (dest, args, connection) => {
        const store = (backend.persistency[dest] ??= {});
        const key = args?.key ?? "";
        const value = Object.hasOwn(store, key) ? store[key] : null;

        backend.send(dest, { read: { res: { key, value } } }, connection);
    });
}
