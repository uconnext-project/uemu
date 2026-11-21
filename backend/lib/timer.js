/**
 * Timer helpers replacing Python's `threading.Timer` and the ticker thread.
 *
 * Reference: handlers.py:1015-1035 (periodic clock/media loop).
 */

/**
 * Runs `callback` once after `ms` milliseconds.
 *
 * @param {number} ms
 * @param {() => void} callback
 * @returns {ReturnType<typeof setTimeout>}
 */
export function after(ms, callback) {
    return setTimeout(callback, ms);
}

/**
 * Runs `callback` every `ms` milliseconds.
 *
 * @param {number} ms
 * @param {() => void} callback
 * @returns {ReturnType<typeof setInterval>}
 */
export function every(ms, callback) {
    return setInterval(callback, ms);
}

/**
 * Cancels a handle returned by {@link after} or {@link every}.
 *
 * @param {ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>} handle
 */
export function stop(handle) {
    clearTimeout(handle);
    clearInterval(handle);
}
