/**
 * Media / USB audio (`handlers.py:543-865`).
 *
 * The reference backend keeps the music library and the browse stack in
 * module globals (`LIBRARY`, `MEDIA`, `BROWSE`) and publishes a block of
 * "device" signals at boot, before the HMI's Media screen is built. This port
 * does the same: the demo library from `backend/data/media.json` is active
 * immediately, and choosing a real music folder swaps it for the scanned one.
 *
 * Playback is delegated to `lib/player.js`, which is the browser equivalent of
 * `audio.py`'s player thread. The 1 s ticker mirrors `handlers.py:1015-1035`:
 * real playback advances `MEDIA.time` from the element, the silent demo list
 * advances it from a monotonic clock.
 *
 * Shapes and command names come from
 * `com/nfuzion/moduleLink/MediaPlayer.as`; the browse tree matches the
 * reference `CATEGORIES`/`_level()` implementation so the HMI's
 * PlayerBrowseScreen can walk it unchanged.
 */

import { after, every } from "../lib/timer.js";
import { createPlayer, mediaGain, mediaPan } from "../lib/player.js";
import {
    clearDirectoryHandle,
    directoryPermission,
    loadDirectoryHandle,
    requestDirectoryPermission,
    saveDirectoryHandle,
    scanDirectory,
} from "../lib/folder.js";

/** handlers.py:560-563 - browse categories; `folders` must stay first. */
const CATEGORIES = Object.freeze([
    "folders",
    "artists",
    "albums",
    "genres",
    "songs",
]);

/** handlers.py:564 - the item type a category expands to. */
const CAT_KIND = Object.freeze({
    folders: "song",
    songs: "song",
    artists: "artist",
    albums: "album",
    genres: "genre",
});

/** handlers.py:565-566 - library tuple index per browse level. */
const COLS = Object.freeze({ artist: "artist", album: "album", genre: "genre" });

/** handlers.py:567 - what a level expands to. */
const BELOW = Object.freeze({
    genre: "artist",
    artist: "album",
    album: "song",
});

/** handlers.py:568 - the HMI's "All Songs" pseudo album. */
const ALL = "*all*";

const TICK_MS = 1000;

/** handlers.py:913 - call states that make the car mute media. */
const CALL_STATES = new Set([
    "ringing",
    "dialing",
    "alerting",
    "active",
    "onhold",
    "waiting",
]);

function nowMs() {
    return typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
}

function toInt(value, fallback = 0) {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }

    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function cloneTracks(tracks) {
    return (tracks ?? []).map((track) => ({
        title: String(track.title ?? ""),
        artist: String(track.artist ?? ""),
        album: String(track.album ?? ""),
        genre: String(track.genre ?? ""),
        year: toInt(track.year, 0),
        duration: toInt(track.duration, 0),
        path: track.path ?? null,
        file: track.file ?? null,
    }));
}

/**
 * Registers the media module.
 *
 * @param {import("../index.js").HmiBackend} backend
 * @param {{devices: Record<string, any>, tracks: Array<Record<string, any>>}} [seed]
 *   Parsed `backend/data/media.json`.
 * @param {object} [options]
 * @param {() => object} [options.playerFactory] Test hook: build the playback
 *   engine from the report callbacks.
 * @returns {object} Controller used by the HUD and by tests.
 */
export function registerMedia(backend, seed = {}, options = {}) {
    const DEVICES = structuredClone(seed.devices ?? {});
    const DEMO_LIBRARY = cloneTracks(seed.tracks);
    /** Monotonic clock; tests replace it to drive the 1 s ticker. */
    const now = options.now ?? nowMs;

    /** handlers.py:567 - mutable device/track state (module-global in Python). */
    const MEDIA = {
        device: Object.keys(DEVICES)[0] ?? "usb1",
        track: 0,
        time: 0,
        playing: false,
        repeat: "off",
        random: "off",
        seek: { gen: 0, sec: 0 },
    };

    let LIBRARY = cloneTracks(DEMO_LIBRARY);
    /** @type {{stack: Array<[string, string | null, Record<string, any>]>}} */
    const BROWSE = { stack: [["root", null, {}]] };

    let playerPath = null;
    let playerLength = 0;
    let clockBase = now();
    let mode = "demo";
    let folderName = "";
    let busy = false;
    let needsPermission = false;
    let storedHandle = null;
    let scanning = null;

    const listeners = new Set();

    function currentEntry() {
        return LIBRARY[MEDIA.track] ?? null;
    }

    function durationOf(entry) {
        if (!entry) {
            return 0;
        }

        if (entry.path && playerPath === entry.path && playerLength > 0) {
            return playerLength;
        }

        return entry.duration;
    }

    function msid() {
        return DEVICES[MEDIA.device]?.id ?? 0;
    }

    function resetClock() {
        clockBase = now() - MEDIA.time * 1000;
    }

    function elapsed() {
        return Math.max(0, Math.floor((now() - clockBase) / 1000));
    }

    function setTime(seconds) {
        MEDIA.time = Math.max(0, Math.trunc(Number(seconds) || 0));
        resetClock();
    }

    function mediaSeek(seconds) {
        setTime(seconds);
        MEDIA.seek = {
            gen: MEDIA.seek.gen + 1,
            sec: MEDIA.time,
        };
    }

    /** handlers.py:582-633 - the four signals that describe the current track. */
    function trackPayloads() {
        const entry = currentEntry();
        const id = msid();
        if (!entry) {
            return {
                nowPlaying: {
                    title: "",
                    artist: "",
                    album: "",
                    genre: "",
                    year: "",
                    composer: "",
                    filename: "",
                    msid: id,
                },
                trackState: {
                    totalTracks: 0,
                    fid: 0,
                    track: 0,
                    msid: id,
                },
                playTime: { time: MEDIA.time, duration: 0, msid: id },
                playState: {
                    state: MEDIA.playing ? "playing" : "paused",
                    msid: id,
                    handle: 0,
                },
            };
        }

        return {
            nowPlaying: {
                title: entry.title,
                artist: entry.artist,
                album: entry.album,
                genre: entry.genre,
                year: entry.year ? String(entry.year) : "",
                composer: "",
                filename: entry.path
                    ? entry.path.split("/").at(-1)
                    : `${entry.title}.mp3`,
                msid: id,
            },
            trackState: {
                totalTracks: LIBRARY.length,
                fid: 0,
                track: MEDIA.track + 1,
                msid: id,
            },
            playTime: {
                time: MEDIA.time,
                duration: durationOf(entry),
                msid: id,
            },
            playState: {
                state: MEDIA.playing ? "playing" : "paused",
                msid: id,
                handle: 0,
            },
        };
    }

    /** handlers.py:635-641. */
    function devicePayloads() {
        const device = DEVICES[MEDIA.device];
        return {
            activeDevice: { device },
            deviceState: {
                device,
                state: "connected",
                available: true,
            },
            devicePlayable: { devicePlayable: true },
            readyToBrowse: { id: device?.id ?? 0, status: true },
            repeat: { mode: MEDIA.repeat },
            random: { mode: MEDIA.random },
            syncState: { state: "complete", msid: device?.id ?? 0 },
            DeviceCapability: {
                randomSupported: true,
                repeatSupported: true,
            },
        };
    }

    function publish(keys = ["trackState", "nowPlaying", "playState", "playTime"]) {
        const payloads = trackPayloads();
        const store = backend.moduleStore("Media");
        for (const key of keys) {
            store[key] = payloads[key];
            backend.send("Media", { [key]: payloads[key] });
        }
    }

    /** handlers.py:643-661. */
    function selectDevice(name) {
        if (!Object.hasOwn(DEVICES, name)) {
            return;
        }

        if (name !== MEDIA.device) {
            MEDIA.device = name;
            MEDIA.track = 0;
            setTime(0);
        }

        MEDIA.playing = true;
        resetClock();
        const payloads = devicePayloads();
        const store = backend.moduleStore("Media");
        for (const [key, value] of Object.entries(payloads)) {
            store[key] = value;
            backend.send("Media", { [key]: value });
        }
        publish();

        // handlers.py:655-661 - the real service needs a moment to index the
        // stick. Sent immediately, the HMI's Media screen misses it and greys
        // out Browse, so it is repeated once after a second.
        timers.push(
            after(1000, () => {
                backend.send("Media", {
                    readyToBrowse: payloads.readyToBrowse,
                });
            }),
        );
    }

    /** handlers.py:663-666. */
    function skip(delta) {
        if (LIBRARY.length === 0) {
            return;
        }

        MEDIA.track = ((MEDIA.track + delta) % LIBRARY.length + LIBRARY.length) %
            LIBRARY.length;
        mediaSeek(0);
        publish();
    }

    function reply(command, connection, extra = {}) {
        backend.send(
            "Media",
            { [command]: { description: "success", ...extra } },
            connection,
        );
    }

    // handlers.py:582-633 - seed the module store before the HMI is built.
    // `state.json` has no Media section and the HMI subscribes during boot.
    Object.assign(backend.moduleStore("Media"), devicePayloads(), trackPayloads());

    // ------------------------------------------------------------ playback
    const player = (options.playerFactory ?? createPlayer)({
        onLoaded(path, duration) {
            playerPath = path;
            playerLength = Math.max(0, Math.trunc(duration) || 0);
            publish(["playTime"]);
        },
        onPosition(path, seconds) {
            if (currentEntry()?.path === path) {
                MEDIA.time = Math.max(0, Math.trunc(seconds));
                resetClock();
            }
        },
        onEnded() {
            skip(MEDIA.repeat === "song" ? 0 : 1);
        },
        onFailed(path) {
            playerPath = null;
            playerLength = 0;
            backend.log("!!", `audio: cannot play ${path}`);
            if (MEDIA.playing) {
                skip(1);
            }
        },
        onLog(message) {
            backend.log("--", message);
        },
    });

    /** `audio_want()` - what the player should be doing right now. */
    function pump() {
        const audio = backend.moduleStore("Audio");
        const source = audio.audioSource?.source;
        const entry = currentEntry();
        const onMedia =
            Boolean(DEVICES[MEDIA.device]) && source === MEDIA.device;
        const settings = backend.moduleStore("AudioSettings");
        const volume = settings.volume ?? {};
        const muted = audio.userMuteState?.state === true;
        const balance = settings.balanceFade?.balance ?? 0;

        // handlers.py:913 - the car mutes media while any call is up and loops
        // the ringtone only while a call is ringing. `MEDIA.playing` is left
        // alone, so the song resumes after the call.
        const callInfo =
            backend.moduleStore("BluetoothHFP").callState?.callStateInfo ?? [];
        const states = new Set(callInfo.map((call) => call.callState));
        const inCall = [...states].some((state) => CALL_STATES.has(state));
        const ringing = states.has("ringing");

        player.update({
            path: onMedia ? entry?.path ?? null : null,
            file: onMedia ? entry?.file ?? null : null,
            playing: onMedia && MEDIA.playing && !inCall,
            start: MEDIA.time,
            seek: MEDIA.seek,
            gain: mediaGain(volume.volume, volume.cap, muted),
            pan: mediaPan(balance),
            ring: ringing,
        });
    }

    /** handlers.py:1015-1023 - the periodic media half of the reference ticker. */
    function tick() {
        const audio = backend.moduleStore("Audio");
        const source = audio.audioSource?.source;
        if (
            source === MEDIA.device &&
            Object.hasOwn(DEVICES, MEDIA.device) &&
            MEDIA.playing
        ) {
            if (currentEntry()?.path && playerPath === currentEntry().path) {
                // The player moved the clock through onPosition().
                publish(["playTime"]);
            } else {
                const time = elapsed();
                MEDIA.time = time;
                const duration = durationOf(currentEntry());
                if (duration > 0 && time >= duration) {
                    skip(MEDIA.repeat === "song" ? 0 : 1);
                } else {
                    publish(["playTime"]);
                }
            }
        }
    }

    // Keep Node imports (tests) from being held open by the interval; the
    // browser always has `window`, and tests drive `pump()`/`tick()` directly.
    const timers = [];
    if (typeof window !== "undefined" || options.startTimers === true) {
        timers.push(every(250, pump), every(TICK_MS, tick));
    }

    // ------------------------------------------------------------ device replies
    backend.on("Media", "getDevices", (dest, args, connection) => {
        backend.send(
            "Media",
            {
                getDevices: {
                    devices: Object.values(DEVICES).map((device) => ({
                        available: true,
                        device,
                    })),
                },
            },
            connection,
        );
    });

    // handlers.py:675-687 - play/resume/playAll/pause/stop.
    for (const command of ["play", "resume", "playAll", "pause", "stop"]) {
        backend.on("Media", command, (dest, args, connection) => {
            MEDIA.playing = command === "play" ||
                command === "resume" ||
                command === "playAll";
            resetClock();
            reply(command, connection);
            publish(["playState"]);
        });
    }

    // handlers.py:689-692.
    backend.on("Media", "deSelectActiveDevice", () => {
        MEDIA.playing = false;
        publish(["playState"]);
    });

    // handlers.py:694-698.
    backend.on("Media", "next", (dest, args, connection) => {
        reply("next", connection);
        skip(1);
    });

    // handlers.py:700-709 - restart the song unless it is in its first seconds.
    backend.on("Media", "previous", (dest, args, connection) => {
        reply("previous", connection);
        if (MEDIA.time > 3) {
            mediaSeek(0);
            publish(["playTime"]);
        } else {
            skip(-1);
        }
    });

    // handlers.py:711-714 - the stick has no cover art; empty keeps the default.
    backend.on("Media", "getAlbumArt", (dest, args, connection) => {
        backend.send(
            "Media",
            { getAlbumArt: { path: "", msid: msid() } },
            connection,
        );
    });

    // handlers.py:716-723 - the play queue, 1-based start.
    backend.on("Media", "getCurrentTrackList", (dest, args, connection) => {
        const start = Math.max(0, toInt(args?.start, 1) - 1);
        const count = Math.max(0, toInt(args?.count, LIBRARY.length));
        const end = Math.min(LIBRARY.length, start + count);
        const items = [];
        for (let index = start; index < end; index += 1) {
            items.push({
                id: index + 1,
                type: "song",
                name: LIBRARY[index].title,
            });
        }
        backend.send(
            "Media",
            { getCurrentTrackList: { items, code: 0 } },
            connection,
        );
    });

    // ------------------------------------------------------------ browse tree
    function matches(index, filter) {
        return Object.entries(filter).every(
            ([kind, value]) => LIBRARY[index][COLS[kind]] === value,
        );
    }

    function level(kind, filter) {
        const indexes = [];
        for (let index = 0; index < LIBRARY.length; index += 1) {
            if (matches(index, filter)) {
                indexes.push(index);
            }
        }

        if (kind === "song") {
            return indexes.map((index) => ({
                type: "song",
                name: LIBRARY[index].title,
                track: index,
                filt: filter,
            }));
        }

        const column = COLS[kind];
        if (!column) {
            return [];
        }

        const names = [];
        const seen = new Set();
        for (const index of indexes) {
            const name = LIBRARY[index][column];
            if (!seen.has(name)) {
                seen.add(name);
                names.push(name);
            }
        }
        names.sort();

        return names.map((name) => ({
            type: kind,
            name,
            browsable: true,
            filt: { ...filter, [kind]: name },
        }));
    }

    /** handlers.py:572-592. */
    function browseChildren(node) {
        const [kind, name, filter] = node;
        let children;

        if (kind === "root") {
            children = CATEGORIES.map((category) => ({
                type: "category",
                name: category,
                browsable: true,
                filt: {},
            }));
        } else if (kind === "category") {
            children = level(CAT_KIND[name] ?? "song", filter);
        } else {
            children = level(
                name === ALL ? "song" : BELOW[kind] ?? "song",
                filter,
            );
        }

        children.forEach((child, index) => {
            child.id = index + 2;
        });

        // handlers.py:590-591 - an artist opens with "All Songs" first.
        if (kind === "artist") {
            children.unshift({
                type: "album",
                name: ALL,
                browsable: true,
                filt: filter,
                id: 0,
            });
        }

        return children;
    }

    /** handlers.py:594-604. */
    function browseItems() {
        return browseChildren(BROWSE.stack.at(-1)).map((child) => {
            const item = {
                id: child.id,
                type: child.type,
                name: child.name,
                browsable: Boolean(child.browsable),
                playable: child.type === "song",
            };
            if (child.track === MEDIA.track) {
                item.nowPlaying = true;
            }
            return item;
        });
    }

    /** handlers.py:606-611. */
    function browseSelection(connection, ack) {
        backend.send(
            "Media",
            { [ack]: { description: "success" } },
            connection,
        );
        const [kind, name] = BROWSE.stack.at(-1);
        backend.send(
            "Media",
            {
                selection: {
                    track: 0,
                    count: browseChildren(BROWSE.stack.at(-1)).length,
                    name: name || "root",
                    type: kind,
                    alphaJumpAvailable: false,
                },
            },
            connection,
        );
    }

    /** handlers.py:613-617. */
    function browsePlay(tracks) {
        if (tracks.length > 0) {
            MEDIA.track = tracks[0];
            MEDIA.playing = true;
            mediaSeek(0);
            publish();
        }
    }

    // handlers.py:794-797.
    backend.on("Media", "gotoRoot", (dest, args, connection) => {
        BROWSE.stack = [["root", null, {}]];
        browseSelection(connection, "gotoRoot");
    });

    // handlers.py:799-803.
    backend.on("Media", "gotoPrevious", (dest, args, connection) => {
        if (BROWSE.stack.length > 1) {
            BROWSE.stack.pop();
        }
        browseSelection(connection, "gotoPrevious");
    });

    // handlers.py:805-810.
    backend.on("Media", "selectDevice", (dest, args, connection) => {
        BROWSE.stack = [["root", null, {}]];
        backend.send("Media", { selectDevice: { description: "" } }, connection);
        browseSelection(connection, "gotoRoot");
    });

    // handlers.py:812-822.
    backend.on("Media", "selectItem", (dest, args, connection) => {
        const node = BROWSE.stack.at(-1);
        const id = toInt(args?.id, -1);

        // The Media screen's track list sends the item's type as `name` and a
        // 1-based track id (MediaHomeScreen.as:1959-1965) while the browse
        // stack is still at the root. Treat that as a direct song choice;
        // otherwise root ids would select a category.
        if (
            node[0] === "root" &&
            args?.name === "song" &&
            id >= 1 &&
            id <= LIBRARY.length
        ) {
            backend.send(
                "Media",
                { selectItem: { description: "success" } },
                connection,
            );
            browsePlay([id - 1]);
            return;
        }

        const child = browseChildren(node).find((item) => item.id === id);
        if (!child) {
            backend.send(
                "Media",
                { selectItem: { description: "failed" } },
                connection,
            );
            return;
        }

        if (child.type === "song") {
            backend.send(
                "Media",
                { selectItem: { description: "success" } },
                connection,
            );
            browsePlay([child.track]);
            return;
        }

        BROWSE.stack.push(
            node[0] === "root"
                ? ["category", child.name, {}]
                : [child.type, child.name, child.filt],
        );
        browseSelection(connection, "selectItem");
    });

    // handlers.py:824-829.
    backend.on("Media", "selectAll", (dest, args, connection) => {
        const filter = BROWSE.stack.at(-1)[2];
        const tracks = [];
        for (let index = 0; index < LIBRARY.length; index += 1) {
            if (matches(index, filter)) {
                tracks.push(index);
            }
        }
        backend.send(
            "Media",
            { selectAll: { description: "success" } },
            connection,
        );
        browsePlay(tracks);
    });

    // handlers.py:831-837 - 1-based start.
    backend.on("Media", "getItems", (dest, args, connection) => {
        const items = browseItems();
        const start = Math.max(0, toInt(args?.start, 1) - 1);
        const count = Math.max(0, toInt(args?.count, items.length));
        const end = Math.min(items.length, start + count);
        backend.send(
            "Media",
            {
                getItems: {
                    request: "getItems",
                    items: items.slice(start, end),
                },
            },
            connection,
        );
    });

    // handlers.py:839-843.
    backend.on("Media", "seekToTime", (dest, args, connection) => {
        mediaSeek(toInt(args?.sec ?? args?.time, 0));
        reply("seekToTime", connection);
        publish(["playTime"]);
    });

    // handlers.py:845-856.
    backend.on("Media", "setProperties", (dest, args, connection) => {
        const props =
            args?.props && typeof args.props === "object"
                ? args.props
                : args;
        for (const key of ["repeat", "random"]) {
            if (!Object.hasOwn(props, key)) {
                continue;
            }

            const value = props[key];
            const modeValue =
                value && typeof value === "object" ? value.mode : value;
            MEDIA[key] = String(modeValue);
            const store = backend.moduleStore("Media");
            store[key] = { mode: MEDIA[key] };
            backend.send("Media", { [key]: { mode: MEDIA[key] } });
        }
        backend.send("Media", { setProperties: {} }, connection);
    });

    // handlers.py:388-403 - selecting an audio source selects the device.
    backend.alsoOn("Audio", "setAudioSource", (dest, args) => {
        const source = String(args?.source ?? "");
        if (Object.hasOwn(DEVICES, source)) {
            selectDevice(source);
        }
    });

    // ------------------------------------------------------------ folder controller
    function status() {
        return {
            mode,
            folderName,
            trackCount: LIBRARY.length,
            needsPermission,
            busy,
            scanning,
        };
    }

    function notify() {
        const snapshot = status();
        for (const listener of listeners) {
            listener(snapshot);
        }
    }

    function onStatus(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function setLibrary(tracks) {
        LIBRARY = cloneTracks(tracks);
        MEDIA.track = 0;
        mediaSeek(0);
        BROWSE.stack = [["root", null, {}]];
        playerPath = null;
        playerLength = 0;
        player.reset();
        publish();
        notify();
    }

    async function applyDirectory(handle, save) {
        scanning = { files: 0, directories: 0, name: handle.name ?? "" };
        notify();
        const tracks = await scanDirectory(handle, {
            onProgress(info) {
                scanning = info;
                notify();
            },
        });
        scanning = null;

        if (tracks.length === 0) {
            backend.log("--", `music: no playable files in ${handle.name ?? ""}`);
            notify();
            return false;
        }

        storedHandle = handle;
        folderName = handle.name ?? "";
        mode = "folder";
        needsPermission = false;
        if (save) {
            try {
                await saveDirectoryHandle(handle);
            } catch (error) {
                backend.log("!!", `music: could not remember folder (${error?.message ?? error})`);
            }
        }
        setLibrary(tracks);
        backend.log("--", `music: ${tracks.length} tracks from ${folderName}`);
        return true;
    }

    async function restoreDirectory(handle, ask) {
        let permission = await directoryPermission(handle);
        if (ask && permission === "prompt") {
            permission = await requestDirectoryPermission(handle);
        }

        if (permission === "granted" || permission === "unsupported") {
            return applyDirectory(handle, false);
        }

        needsPermission = true;
        notify();
        return false;
    }

    /**
     * HUD action: choose a folder, or re-grant the remembered one.
     *
     * @returns {Promise<boolean>}
     */
    async function pickFolder() {
        if (busy) {
            return false;
        }

        busy = true;
        notify();
        try {
            if (needsPermission && storedHandle) {
                const restored = await restoreDirectory(storedHandle, true);
                if (restored) {
                    return true;
                }
                if ((await directoryPermission(storedHandle)) !== "prompt") {
                    return false;
                }
            }

            const picker = globalThis.showDirectoryPicker;
            if (typeof picker !== "function") {
                backend.log(
                    "!!",
                    "music: this browser has no folder picker; keeping the demo library",
                );
                return false;
            }

            const handle = await picker.call(globalThis, { mode: "read" });
            storedHandle = handle;
            return await applyDirectory(handle, true);
        } catch (error) {
            if (error?.name !== "AbortError") {
                backend.log("!!", `music: ${error?.message ?? error}`);
            }
            return false;
        } finally {
            busy = false;
            scanning = null;
            notify();
        }
    }

    /** HUD action: drop the scanned folder and go back to the demo list. */
    async function useDemo() {
        mode = "demo";
        folderName = "";
        needsPermission = false;
        storedHandle = null;
        await clearDirectoryHandle();
        setLibrary(DEMO_LIBRARY);
    }

    // Restore the remembered folder when the browser still grants access.
    // A real picker handle usually comes back as "prompt" after a reload, so
    // the HUD asks for one more click instead of reading without consent.
    void (async () => {
        const handle = await loadDirectoryHandle();
        if (!handle) {
            return;
        }

        storedHandle = handle;
        folderName = handle.name ?? "";
        const permission = await directoryPermission(handle);
        if (permission === "granted" || permission === "unsupported") {
            await restoreDirectory(handle, false);
        } else {
            needsPermission = true;
            notify();
        }
    })();

    return {
        pickFolder,
        useDemo,
        status,
        onStatus,
        setLibrary,
        tick,
        pump,
        /** @param {string | null} url */
        setRingtone(url) {
            player.setRingtone(url);
        },
        stop() {
            for (const timer of timers) {
                clearInterval(timer);
            }
            player.stop();
        },
        /** @returns {typeof MEDIA} */
        get media() {
            return MEDIA;
        },
        /** @returns {typeof LIBRARY} */
        get library() {
            return LIBRARY;
        },
        get player() {
            return player;
        },
        get browse() {
            return BROWSE;
        },
    };
}
