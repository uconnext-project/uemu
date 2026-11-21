/**
 * Music folder scanning for the browser backend.
 *
 * The reference `audio.py:15-70` walks a directory, reads tags with mutagen
 * and caches the result in `music_cache.json`. A browser cannot read arbitrary
 * paths, so this module accepts a `FileSystemDirectoryHandle` from the File
 * System Access API and walks it recursively. Tags are parsed here (ID3v2 /
 * ID3v1, MP4 atoms, FLAC comments, WAV INFO) and cached in `localStorage` with
 * the same `lastModified:size` key as the reference, so a rescan only re-reads
 * changed files.
 *
 * The directory handle itself is persisted in IndexedDB: handles survive a
 * reload, but read permission has to be granted again from a user gesture.
 *
 * Everything except `scanDirectory()` is pure and works in Node, which keeps
 * the tag parsers testable without a browser.
 */

/** audio.py:11 - extensions the reference treats as playable. */
export const AUDIO_EXTENSIONS = Object.freeze([
    ".mp3",
    ".m4a",
    ".aac",
    ".wma",
    ".wav",
    ".flac",
]);

const AUDIO_EXTENSION_SET = new Set(AUDIO_EXTENSIONS);

/** Reference message: "title, artist, album, genre, year, seconds, path". */
const TAG_CACHE_KEY = "air-browser-port:media-tags";
const DB_NAME = "air-browser-port";
const DB_VERSION = 1;
const HANDLE_STORE = "media";
const HANDLE_KEY = "music-folder";

/** ID3v1 genre byte -> name (standard 0-79 table). */
const ID3V1_GENRES = [
    "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge",
    "Hip-Hop", "Jazz", "Metal", "New Age", "Oldies", "Other", "Pop", "R&B",
    "Rap", "Reggae", "Rock", "Techno", "Industrial", "Alternative", "Ska",
    "Death Metal", "Pranks", "Soundtrack", "Euro-Techno", "Ambient",
    "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion", "Trance", "Classical",
    "Instrumental", "Acid", "House", "Game", "Sound Clip", "Gospel", "Noise",
    "AlternRock", "Bass", "Soul", "Punk", "Space", "Meditative",
    "Instrumental Pop", "Instrumental Rock", "Ethnic", "Gothic", "Darkwave",
    "Techno-Industrial", "Electronic", "Pop-Folk", "Eurodance", "Dream",
    "Southern Rock", "Comedy", "Cult", "Gangsta", "Top 40", "Christian Rap",
    "Pop/Funk", "Jungle", "Native American", "Cabaret", "New Wave",
    "Psychadelic", "Rave", "Showtunes", "Trailer", "Lo-Fi", "Tribal",
    "Acid Punk", "Acid Jazz", "Polka", "Retro", "Musical", "Rock & Roll",
    "Hard Rock",
];

/**
 * @param {string} name
 * @returns {string} Lower-case extension including the dot, or "".
 */
export function fileExtension(name) {
    const dot = String(name).lastIndexOf(".");
    return dot >= 0 ? String(name).slice(dot).toLowerCase() : "";
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isAudioFile(name) {
    return AUDIO_EXTENSION_SET.has(fileExtension(name));
}

function ascii(bytes, offset, length) {
    let text = "";
    for (let index = 0; index < length; index += 1) {
        text += String.fromCharCode(bytes[offset + index] ?? 0);
    }

    return text;
}

function trimText(value) {
    return String(value ?? "")
        .replace(/\0[\s\S]*$/, "")
        .trim();
}

/**
 * Decodes an ID3 text payload.
 *
 * @param {Uint8Array} bytes
 * @param {number} encoding 0 latin1, 1 UTF-16 with BOM, 2 UTF-16BE, 3 UTF-8.
 * @returns {string}
 */
function decodeText(bytes, encoding) {
    if (bytes.length === 0) {
        return "";
    }

    if (encoding === 1 || encoding === 2) {
        let start = 0;
        let littleEndian = encoding === 2;
        if (encoding === 1 && bytes.length >= 2) {
            if (bytes[0] === 0xff && bytes[1] === 0xfe) {
                littleEndian = true;
                start = 2;
            } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
                littleEndian = false;
                start = 2;
            }
        }

        let payload = bytes.subarray(start);
        if (!littleEndian) {
            // TextDecoder covers UTF-16BE, but some engines only ship the
            // little-endian variant; swap the pairs when needed.
            try {
                return trimText(new TextDecoder("utf-16be").decode(payload));
            } catch {
                payload = payload.slice();
                for (let index = 0; index + 1 < payload.length; index += 2) {
                    const swap = payload[index];
                    payload[index] = payload[index + 1];
                    payload[index + 1] = swap;
                }
            }
        }

        return trimText(new TextDecoder("utf-16le").decode(payload));
    }

    try {
        return trimText(
            new TextDecoder(encoding === 3 ? "utf-8" : "latin1").decode(bytes),
        );
    } catch {
        return trimText(String.fromCharCode(...bytes));
    }
}

function syncsafe(bytes, offset) {
    return (
        ((bytes[offset] & 0x7f) << 21) |
        ((bytes[offset + 1] & 0x7f) << 14) |
        ((bytes[offset + 2] & 0x7f) << 7) |
        (bytes[offset + 3] & 0x7f)
    );
}

function yearFrom(value) {
    const match = /(\d{4})/.exec(String(value ?? ""));
    return match ? Number(match[1]) : 0;
}

function genreFrom(value) {
    const text = trimText(value);
    if (!text) {
        return "";
    }

    const numeric = /^\((\d+)\)/.exec(text);
    if (numeric) {
        return ID3V1_GENRES[Number(numeric[1])] ?? text;
    }

    return text;
}

/**
 * Reads an ID3v2 tag at the start of `bytes`.
 *
 * @param {Uint8Array} bytes
 * @returns {{title?: string, artist?: string, album?: string,
 *   genre?: string, year?: number, duration?: number}}
 */
export function parseId3v2(bytes) {
    if (bytes.length < 10 || ascii(bytes, 0, 3) !== "ID3") {
        return {};
    }

    const version = bytes[3];
    const flags = bytes[5];
    const tagSize = syncsafe(bytes, 6);
    const unsynchronised = Boolean(flags & 0x80);
    let body = bytes.subarray(10, Math.min(bytes.length, 10 + tagSize));

    // An extended header sits between the tag header and the first frame.
    if (flags & 0x40 && body.length >= 4) {
        const extended =
            version >= 4
                ? syncsafe(body, 0)
                : 4 +
                  ((body[0] << 24) |
                      (body[1] << 16) |
                      (body[2] << 8) |
                      body[3]);
        if (extended > 0 && extended <= body.length) {
            body = body.subarray(extended);
        }
    }

    const fields = {};
    let offset = 0;
    const headerLength = version === 2 ? 6 : 10;

    while (offset + headerLength <= body.length) {
        const id = ascii(body, offset, version === 2 ? 3 : 4);
        if (!/^[A-Z0-9]{3,4}$/.test(id)) {
            break;
        }

        let size;
        if (version === 2) {
            size =
                (body[offset + 3] << 16) |
                (body[offset + 4] << 8) |
                body[offset + 5];
        } else if (version >= 4) {
            size = syncsafe(body, offset + 4);
        } else {
            size =
                (body[offset + 4] << 24) |
                (body[offset + 5] << 16) |
                (body[offset + 6] << 8) |
                body[offset + 7];
        }

        offset += headerLength;
        if (size <= 0) {
            break;
        }

        let data;
        if (unsynchronised) {
            // Tag-level unsynchronisation: the frame size counts the bytes
            // before stuffing, so collect that many while dropping the 0x00
            // inserted after every 0xff.
            const collected = [];
            let cursor = offset;
            while (collected.length < size && cursor < body.length) {
                const byte = body[cursor];
                collected.push(byte);
                cursor += 1;
                if (byte === 0xff && body[cursor] === 0x00) {
                    cursor += 1;
                }
            }
            if (collected.length < size) {
                break;
            }
            data = Uint8Array.from(collected);
            offset = cursor;
        } else {
            if (offset + size > body.length) {
                break;
            }
            data = body.subarray(offset, offset + size);
            offset += size;
        }

        if (data.length < 1) {
            continue;
        }

        const encoding = data[0];
        const text = decodeText(data.subarray(1), encoding);
        switch (id) {
            case "TIT2":
            case "TT2":
                fields.title ??= text;
                break;
            case "TPE1":
            case "TP1":
                fields.artist ??= text;
                break;
            case "TALB":
            case "TAL":
                fields.album ??= text;
                break;
            case "TCON":
            case "TCO":
                fields.genre ??= genreFrom(text);
                break;
            case "TYER":
            case "TYE":
                fields.year ??= yearFrom(text);
                break;
            case "TDRC":
            case "TDRL":
                fields.year ??= yearFrom(text);
                break;
            case "TLEN":
            case "TLE": {
                const milliseconds = Number(text);
                if (Number.isFinite(milliseconds) && milliseconds > 0) {
                    fields.duration ??= Math.floor(milliseconds / 1000);
                }
                break;
            }
            default:
                break;
        }
    }

    return fields;
}

/**
 * Reads a trailing ID3v1 tag (last 128 bytes).
 *
 * @param {Uint8Array} bytes
 * @returns {{title?: string, artist?: string, album?: string,
 *   genre?: string, year?: number}}
 */
export function parseId3v1(bytes) {
    if (bytes.length < 128) {
        return {};
    }

    const tail = bytes.subarray(bytes.length - 128);
    if (ascii(tail, 0, 3) !== "TAG") {
        return {};
    }

    const title = trimText(ascii(tail, 3, 30));
    const artist = trimText(ascii(tail, 33, 30));
    const album = trimText(ascii(tail, 63, 30));
    const year = yearFrom(ascii(tail, 93, 4));
    const genreIndex = tail[127];
    const genre = ID3V1_GENRES[genreIndex] ?? "";
    const fields = {};

    if (title) fields.title = title;
    if (artist) fields.artist = artist;
    if (album) fields.album = album;
    if (year) fields.year = year;
    if (genre) fields.genre = genre;
    return fields;
}

function readUint64(view, offset) {
    const high = view.getUint32(offset);
    const low = view.getUint32(offset + 4);
    return high * 2 ** 32 + low;
}

/**
 * Reads MP4/M4A metadata atoms (`moov/udta/meta/ilst`) and the movie header
 * duration. AAC-in-MP4 is the common "m4a" case in a music folder.
 *
 * @param {Uint8Array} bytes
 * @returns {{title?: string, artist?: string, album?: string,
 *   genre?: string, year?: number, duration?: number}}
 */
export function parseMp4(bytes) {
    if (bytes.length < 12) {
        return {};
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fields = {};

    const name = (offset) => ascii(bytes, offset, 4);

    function parseMvhd(start, length) {
        const end = start + length;
        if (start + 4 > end) {
            return;
        }

        const version = bytes[start];
        if (version === 1 && start + 32 <= end) {
            const timescale = view.getUint32(start + 20);
            const duration = readUint64(view, start + 24);
            if (timescale > 0 && duration > 0) {
                fields.duration ??= Math.floor(duration / timescale);
            }
        } else if (start + 20 <= end) {
            const timescale = view.getUint32(start + 12);
            const duration = view.getUint32(start + 16);
            if (timescale > 0 && duration > 0) {
                fields.duration ??= Math.floor(duration / timescale);
            }
        }
    }

    function firstData(start, end) {
        let offset = start;
        while (offset + 8 <= end) {
            let size = view.getUint32(offset);
            const type = name(offset + 4);
            let header = 8;
            if (size === 1) {
                if (offset + 16 > end) {
                    return "";
                }
                size = readUint64(view, offset + 8);
                header = 16;
            } else if (size === 0) {
                size = end - offset;
            }

            if (size < header || offset + size > end) {
                return "";
            }

            if (type === "data") {
                const body = offset + header;
                if (body + 8 > offset + size) {
                    return "";
                }
                const dataType = view.getUint32(body) & 0xffffff;
                const payload = bytes.subarray(body + 8, offset + size);
                if (dataType === 1) {
                    return trimText(new TextDecoder("utf-8").decode(payload));
                }
                if (dataType === 2) {
                    return decodeText(
                        Uint8Array.from([1, ...payload]),
                        1,
                    );
                }
                if (dataType === 21 && payload.length >= 2) {
                    return String(
                        (payload[0] << 8) | payload[1],
                    );
                }
                return "";
            }

            offset += size;
        }

        return "";
    }

    function parseIlst(start, end) {
        let offset = start;
        while (offset + 8 <= end) {
            let size = view.getUint32(offset);
            const key = name(offset + 4);
            let header = 8;
            if (size === 1) {
                if (offset + 16 > end) {
                    return;
                }
                size = readUint64(view, offset + 8);
                header = 16;
            } else if (size === 0) {
                size = end - offset;
            }

            if (size < header || offset + size > end) {
                return;
            }

            const body = offset + header;
            const bodyEnd = offset + size;
            const value = firstData(body, bodyEnd);
            switch (key) {
                case "\u00a9nam":
                    if (value) fields.title ??= value;
                    break;
                case "\u00a9ART":
                case "aART":
                    if (value) fields.artist ??= value;
                    break;
                case "\u00a9alb":
                    if (value) fields.album ??= value;
                    break;
                case "\u00a9gen":
                    if (value) fields.genre ??= genreFrom(value);
                    break;
                case "gnre": {
                    const index = Number(value);
                    if (Number.isFinite(index) && index > 0) {
                        fields.genre ??=
                            ID3V1_GENRES[index - 1] ?? fields.genre ?? "";
                    }
                    break;
                }
                case "\u00a9day":
                    if (value) fields.year ??= yearFrom(value);
                    break;
                default:
                    break;
            }

            offset += size;
        }
    }

    function walk(start, end) {
        let offset = start;
        while (offset + 8 <= end) {
            let size = view.getUint32(offset);
            const type = name(offset + 4);
            let header = 8;
            if (size === 1) {
                if (offset + 16 > end) {
                    return;
                }
                size = readUint64(view, offset + 8);
                header = 16;
            } else if (size === 0) {
                size = end - offset;
            }

            if (size < header || offset + size > end) {
                return;
            }

            const body = offset + header;
            const bodyEnd = offset + size;
            if (type === "mvhd") {
                parseMvhd(body, bodyEnd - body);
            } else if (type === "ilst") {
                parseIlst(body, bodyEnd);
            } else if (type === "moov" || type === "udta" || type === "trak") {
                walk(body, bodyEnd);
            } else if (type === "meta") {
                // `meta` is a full box: version/flags before the children.
                walk(body + 4, bodyEnd);
            }

            offset += size;
        }
    }

    walk(0, bytes.length);
    return fields;
}

/**
 * Reads FLAC STREAMINFO duration and Vorbis comments.
 *
 * @param {Uint8Array} bytes
 * @returns {{title?: string, artist?: string, album?: string,
 *   genre?: string, year?: number, duration?: number}}
 */
export function parseFlac(bytes) {
    if (bytes.length < 8 || ascii(bytes, 0, 4) !== "fLaC") {
        return {};
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fields = {};
    let offset = 4;

    while (offset + 4 <= bytes.length) {
        const header = bytes[offset];
        const type = header & 0x7f;
        const last = Boolean(header & 0x80);
        const length =
            (bytes[offset + 1] << 16) |
            (bytes[offset + 2] << 8) |
            bytes[offset + 3];
        const start = offset + 4;
        const end = start + length;
        if (end > bytes.length) {
            break;
        }

        if (type === 0 && length >= 34) {
            // sample rate (20 bits) / channels (3) / bits (5) / samples (36)
            const packed = view.getBigUint64(start + 10);
            const totalSamples = Number(packed & 0xfffffffffn);
            const sampleRate = Number(packed >> 44n);
            if (sampleRate > 0 && totalSamples > 0) {
                fields.duration ??= Math.floor(totalSamples / sampleRate);
            }
        } else if (type === 4) {
            let cursor = start;
            if (cursor + 4 <= end) {
                const vendorLength = view.getUint32(cursor, true);
                cursor += 4 + vendorLength;
                if (cursor + 4 <= end) {
                    const count = view.getUint32(cursor, true);
                    cursor += 4;
                    for (let index = 0; index < count && cursor + 4 <= end; index += 1) {
                        const length2 = view.getUint32(cursor, true);
                        cursor += 4;
                        if (cursor + length2 > end) {
                            break;
                        }
                        const entry = new TextDecoder("utf-8").decode(
                            bytes.subarray(cursor, cursor + length2),
                        );
                        cursor += length2;
                        const eq = entry.indexOf("=");
                        if (eq <= 0) {
                            continue;
                        }
                        const key = entry.slice(0, eq).toUpperCase();
                        const value = trimText(entry.slice(eq + 1));
                        if (key === "TITLE" && value) fields.title ??= value;
                        else if (key === "ARTIST" && value) fields.artist ??= value;
                        else if (key === "ALBUM" && value) fields.album ??= value;
                        else if (key === "GENRE" && value) fields.genre ??= value;
                        else if ((key === "DATE" || key === "YEAR") && value) {
                            fields.year ??= yearFrom(value);
                        }
                    }
                }
            }
        }

        if (last) {
            break;
        }

        offset = end;
    }

    return fields;
}

/**
 * Reads WAV `LIST/INFO` tags and the data-chunk duration.
 *
 * @param {Uint8Array} bytes
 * @returns {{title?: string, artist?: string, album?: string,
 *   genre?: string, year?: number, duration?: number}}
 */
export function parseWav(bytes) {
    if (
        bytes.length < 12 ||
        ascii(bytes, 0, 4) !== "RIFF" ||
        ascii(bytes, 8, 4) !== "WAVE"
    ) {
        return {};
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fields = {};
    let offset = 12;
    let sampleRate = 0;
    let channels = 0;
    let bits = 16;
    let dataSize = 0;

    while (offset + 8 <= bytes.length) {
        const id = ascii(bytes, offset, 4);
        const size = view.getUint32(offset + 4, true);
        const body = offset + 8;
        const end = Math.min(body + size, bytes.length);
        if (size < 0 || body + size > bytes.length + 1) {
            break;
        }

        if (id === "fmt " && body + 16 <= end) {
            channels = view.getUint16(body + 2, true);
            sampleRate = view.getUint32(body + 4, true);
            bits = view.getUint16(body + 14, true) || 16;
        } else if (id === "data") {
            dataSize = Math.min(size, bytes.length - body);
        } else if (id === "LIST" && ascii(bytes, body, 4) === "INFO") {
            let cursor = body + 4;
            while (cursor + 8 <= end) {
                const key = ascii(bytes, cursor, 4);
                const length = view.getUint32(cursor + 4, true);
                const valueStart = cursor + 8;
                if (valueStart + length > end) {
                    break;
                }
                const value = trimText(
                    new TextDecoder("latin1").decode(
                        bytes.subarray(valueStart, valueStart + length),
                    ),
                );
                if (key === "INAM" && value) fields.title ??= value;
                else if (key === "IART" && value) fields.artist ??= value;
                else if (key === "IPRD" && value) fields.album ??= value;
                else if (key === "IGNR" && value) fields.genre ??= value;
                else if (key === "ICRD" && value) fields.year ??= yearFrom(value);
                cursor = valueStart + length + (length & 1);
            }
        }

        offset = body + size + (size & 1);
    }

    if (dataSize > 0 && sampleRate > 0 && channels > 0) {
        const bytesPerSecond = sampleRate * channels * (bits / 8);
        if (bytesPerSecond > 0) {
            fields.duration ??= Math.floor(dataSize / bytesPerSecond);
        }
    }

    return fields;
}

/**
 * Python `audio.py:15-45` fallback naming plus the real tags when present.
 *
 * @param {Uint8Array} bytes File bytes (a parser may ignore them).
 * @param {string} fileName Name including the extension.
 * @param {string[]} [directories] Directories between the root and the file.
 * @returns {{title: string, artist: string, album: string, genre: string,
 *   year: number, duration: number}}
 */
export function tagsFromBuffer(bytes, fileName, directories = []) {
    const stem = fileName.replace(/\.[^.]+$/, "");
    const dirs = directories.filter((part) => part && part !== ".");
    const fallback = {
        title: stem,
        artist: dirs.length > 1 ? dirs[dirs.length - 2] : "Unknown Artist",
        album: dirs.length > 0 ? dirs[dirs.length - 1] : "Unknown Album",
        genre: "Unknown",
        year: 0,
        duration: 0,
    };

    const extension = fileExtension(fileName);
    let parsed = {};
    try {
        if (extension === ".mp3" || extension === ".wma") {
            parsed = parseId3v2(bytes);
        } else if (extension === ".m4a" || extension === ".aac") {
            parsed = parseMp4(bytes);
        } else if (extension === ".flac") {
            parsed = parseFlac(bytes);
        } else if (extension === ".wav") {
            parsed = parseWav(bytes);
        }
    } catch {
        parsed = {};
    }

    // ID3v1 is a last-resort tag for old MP3s; merge it field by field.
    if (
        (extension === ".mp3" || extension === ".wma") &&
        (!parsed.title || !parsed.artist || !parsed.album)
    ) {
        const legacy = parseId3v1(bytes);
        for (const [key, value] of Object.entries(legacy)) {
            if (!parsed[key] && value) {
                parsed[key] = value;
            }
        }
    }

    return {
        title: parsed.title || fallback.title,
        artist: parsed.artist || fallback.artist,
        album: parsed.album || fallback.album,
        genre: parsed.genre || fallback.genre,
        year: Number.isFinite(parsed.year) && parsed.year > 0
            ? Math.trunc(parsed.year)
            : fallback.year,
        duration: Number.isFinite(parsed.duration) && parsed.duration > 0
            ? Math.trunc(parsed.duration)
            : fallback.duration,
    };
}

function storage() {
    try {
        return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
        return null;
    }
}

/**
 * @returns {Record<string, {key: string, tags: Record<string, any>}>}
 */
export function readTagCache() {
    const store = storage();
    if (!store) {
        return {};
    }

    try {
        const raw = store.getItem(TAG_CACHE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed.entries === "object"
            ? parsed.entries
            : {};
    } catch {
        return {};
    }
}

/**
 * @param {Record<string, {key: string, tags: Record<string, any>}>} entries
 */
export function writeTagCache(entries) {
    const store = storage();
    if (!store) {
        return;
    }

    try {
        store.setItem(
            TAG_CACHE_KEY,
            JSON.stringify({ version: 1, entries }),
        );
    } catch {
        // Quota or a private-mode store: the next scan simply re-reads tags.
    }
}

function openDatabase() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
            reject(new Error("IndexedDB is not available"));
            return;
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(HANDLE_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Persists the chosen music folder.
 *
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<void>}
 */
export async function saveDirectoryHandle(handle) {
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
        const transaction = database.transaction(HANDLE_STORE, "readwrite");
        transaction.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
    database.close();
}

/**
 * @returns {Promise<FileSystemDirectoryHandle | null>}
 */
export async function loadDirectoryHandle() {
    try {
        const database = await openDatabase();
        const handle = await new Promise((resolve, reject) => {
            const transaction = database.transaction(HANDLE_STORE, "readonly");
            const request = transaction.objectStore(HANDLE_STORE).get(HANDLE_KEY);
            request.onsuccess = () => resolve(request.result ?? null);
            request.onerror = () => reject(request.error);
        });
        database.close();
        return handle;
    } catch {
        return null;
    }
}

/** @returns {Promise<void>} */
export async function clearDirectoryHandle() {
    try {
        const database = await openDatabase();
        await new Promise((resolve, reject) => {
            const transaction = database.transaction(HANDLE_STORE, "readwrite");
            transaction.objectStore(HANDLE_STORE).delete(HANDLE_KEY);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
        database.close();
    } catch {
        // Nothing stored, or IndexedDB is blocked: nothing to clear.
    }
}

/**
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<"granted" | "prompt" | "denied" | "unsupported">}
 */
export async function directoryPermission(handle) {
    if (typeof handle?.queryPermission !== "function") {
        return "unsupported";
    }

    try {
        return await handle.queryPermission({ mode: "read" });
    } catch {
        return "denied";
    }
}

/**
 * Asks for read access. Must be called from a user gesture.
 *
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<"granted" | "prompt" | "denied" | "unsupported">}
 */
export async function requestDirectoryPermission(handle) {
    if (typeof handle?.requestPermission !== "function") {
        return "unsupported";
    }

    try {
        return await handle.requestPermission({ mode: "read" });
    } catch {
        return "denied";
    }
}

/**
 * Recursively reads every playable file under `directory`.
 *
 * @param {FileSystemDirectoryHandle} directory
 * @param {object} [options]
 * @param {Record<string, {key: string, tags: Record<string, any>}>} [options.cache]
 *   Tag cache to use; defaults to `localStorage`.
 * @param {(info: {files: number, directories: number, name: string}) => void}
 *   [options.onProgress]
 * @param {number} [options.yieldEvery] Files between animation-frame yields.
 * @returns {Promise<Array<Record<string, any>>>} Sorted like `audio.scan()`:
 *   artist, album, path (case-insensitive), each with `file` and `path`.
 */
export async function scanDirectory(directory, options = {}) {
    const cache = options.cache ?? readTagCache();
    const fresh = {};
    const output = [];
    let files = 0;
    let directories = 0;
    const yieldEvery = options.yieldEvery ?? 25;

    async function walk(handle, parents) {
        directories += 1;
        options.onProgress?.({ files, directories, name: parents.at(-1) ?? handle.name ?? "" });

        const entries = [];
        for await (const [name, child] of handle.entries()) {
            entries.push([name, child]);
        }
        entries.sort((a, b) =>
            a[0].toLowerCase() < b[0].toLowerCase()
                ? -1
                : a[0].toLowerCase() > b[0].toLowerCase()
                  ? 1
                  : 0,
        );

        for (const [name, child] of entries) {
            if (child.kind === "directory") {
                await walk(child, [...parents, name]);
                continue;
            }

            if (!isAudioFile(name)) {
                continue;
            }

            const file = await child.getFile();
            const relative = [...parents, name].join("/");
            const key = `${file.lastModified}:${file.size}`;
            const hit = cache[relative];
            let tags = hit && hit.key === key ? hit.tags : null;
            if (!tags) {
                tags = tagsFromBuffer(
                    new Uint8Array(await file.arrayBuffer()),
                    name,
                    parents,
                );
            }

            fresh[relative] = { key, tags };
            output.push({ ...tags, path: relative, file });
            files += 1;
            options.onProgress?.({
                files,
                directories,
                name,
            });

            if (
                yieldEvery > 0 &&
                files % yieldEvery === 0 &&
                typeof requestAnimationFrame === "function"
            ) {
                await new Promise((resolve) =>
                    requestAnimationFrame(() => resolve()),
                );
            }
        }
    }

    await walk(directory, []);
    writeTagCache(fresh);

    return output.sort((a, b) => {
        const left = `${a.artist}\u0000${a.album}\u0000${a.path}`.toLowerCase();
        const right = `${b.artist}\u0000${b.album}\u0000${b.path}`.toLowerCase();
        return left < right ? -1 : left > right ? 1 : 0;
    });
}
