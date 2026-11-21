/**
 * `Clock` replies and the minute tick.
 *
 * Reference: handlers.py:216-227 (`getTime`) and handlers.py:1015-1035
 * (ticker: a real car pushes the wall clock every minute). The user-editable
 * part of the clock lives in `modules/settings.js` (settings.py:296-355); it
 * moves the emulated clock by changing the offset kept here.
 *
 * `Clock.as` accepts both `getTime` and the unsolicited `time` signal, and
 * expects a flat payload (not wrapped in the module name), even though Clock is
 * one of the NESTED modules for property changes.
 */

import { every } from "../lib/timer.js";

const TICK_MS = 1000;

/**
 * Seconds the emulated clock is moved away from the browser clock.
 * Reference: settings.py:116 (`CLOCK = {"offset": 0}`).
 */
let offsetSeconds = 0;

/** @returns {number} Current clock offset in seconds. */
export function clockOffsetSeconds() {
    return offsetSeconds;
}

/**
 * Moves the emulated clock away from the browser clock.
 *
 * @param {number} seconds
 */
export function setClockOffsetSeconds(seconds) {
    offsetSeconds = Math.trunc(Number(seconds) || 0);
}

/**
 * The wall clock as the head unit sees it: browser time plus the user offset.
 *
 * @returns {Date}
 */
export function currentDate() {
    return new Date(Date.now() + offsetSeconds * 1000);
}

/**
 * @param {Date} [date] Defaults to {@link currentDate}.
 * @returns {{year: number, month: number, day: number, hour: number,
 *   minute: number, second: number, status: string}}
 */
export function nowPayload(date = currentDate()) {
    return {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes(),
        second: date.getSeconds(),
        status: "ok",
    };
}

/**
 * Stores and pushes the current time (used after the user moves the clock).
 *
 * @param {import("../index.js").HmiBackend} backend
 */
export function sendClockTime(backend) {
    const payload = nowPayload();
    backend.moduleStore("Clock").time = payload;
    backend.send("Clock", { time: payload });
}

/**
 * @param {import("../index.js").HmiBackend} backend
 */
export function registerClock(backend) {
    backend.on("Clock", "getTime", (dest, args, connection) => {
        backend.send(dest, { getTime: nowPayload() }, connection);
    });

    let lastMinute = "";

    const tick = () => {
        const payload = nowPayload();

        // Keep the store current so a fresh `Subscribe("time")` is answered at
        // once, but only push the signal when the minute actually changes.
        backend.moduleStore("Clock").time = payload;

        const minute = `${payload.year}-${payload.month}-${payload.day}` +
            `-${payload.hour}-${payload.minute}`;
        if (minute === lastMinute) {
            return;
        }

        lastMinute = minute;
        backend.send("Clock", { time: payload });
    };

    tick();
    every(TICK_MS, tick);
}
