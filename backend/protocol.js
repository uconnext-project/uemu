/**
 * Wire protocol spoken by the HMI ("ModuleLink") backend.
 *
 * Frames are UTF-8 JSON documents terminated by a NUL byte. Messages coming
 * from the HMI look like this:
 *
 *     {"Length":00086, "Type":"Subscribe", "Dest":"TextToSpeech", "Signal":"..."}\0
 *
 * The zero-padded `Length` field makes the document invalid JSON, so it is
 * stripped before parsing. Messages going back to the HMI are plain JSON:
 *
 *     {"TextToSpeech": {"ttsReadout": "..."}}\0
 *
 * Nothing in here knows about sockets or Ruffle - it only turns bytes into
 * message objects and back.
 */

/** The byte that terminates every XMLSocket message. */
export const FRAME_TERMINATOR = 0x00;

const LENGTH_PREFIX = /^\{"Length":\d+,\s*/;

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

/**
 * Removes the invalid, zero-padded `"Length"` member from a raw HMI frame.
 *
 * @param {string} raw The frame text, without the NUL terminator.
 * @returns {string} Valid JSON.
 */
export function stripLengthPrefix(raw) {
    if (!LENGTH_PREFIX.test(raw)) {
        return raw;
    }

    return "{" + raw.replace(LENGTH_PREFIX, "");
}

/**
 * Parses a single frame received from the HMI.
 *
 * @param {string} raw The frame text, without the NUL terminator.
 * @returns {object} The decoded message.
 * @throws {SyntaxError} If the frame is not valid JSON.
 */
export function parseFrame(raw) {
    return JSON.parse(stripLengthPrefix(raw.trim()));
}

/**
 * Encodes a message for the HMI.
 *
 * @param {string} module The destination module, for example `"Audio"`.
 * @param {unknown} payload The signal or reply payload.
 * @returns {Uint8Array} The encoded frame, including the NUL terminator.
 */
export function encodeFrame(module, payload) {
    return encoder.encode(JSON.stringify({ [module]: payload }) + "\u0000");
}

/**
 * Convenience helper for logging a frame as one line.
 *
 * @param {string} module The destination module.
 * @param {unknown} payload The signal or reply payload.
 * @returns {string} Pretty-ish compact JSON.
 */
export function formatFrame(module, payload) {
    return JSON.stringify({ [module]: payload });
}

/**
 * Splits a byte stream into NUL-terminated strings.
 *
 * TCP/XMLSocket data is not guaranteed to arrive one frame per write, so the
 * reader keeps the incomplete tail until the next chunk.
 */
export class FrameReader {
    constructor() {
        /** @type {Uint8Array} */
        this.buffer = new Uint8Array(0);
    }

    /**
     * Adds a chunk and returns every complete frame it contained.
     *
     * @param {Uint8Array} chunk
     * @returns {string[]} Complete frame texts, without terminators.
     */
    push(chunk) {
        if (chunk.length === 0) {
            return [];
        }

        let buffer;
        if (this.buffer.length === 0) {
            buffer = chunk;
        } else {
            buffer = new Uint8Array(this.buffer.length + chunk.length);
            buffer.set(this.buffer, 0);
            buffer.set(chunk, this.buffer.length);
        }

        const frames = [];
        let start = 0;
        for (let i = 0; i < buffer.length; i++) {
            if (buffer[i] === FRAME_TERMINATOR) {
                frames.push(decoder.decode(buffer.subarray(start, i)));
                start = i + 1;
            }
        }

        this.buffer = buffer.subarray(start).slice();
        return frames;
    }

    /** Drops any buffered partial frame. */
    reset() {
        this.buffer = new Uint8Array(0);
    }
}
