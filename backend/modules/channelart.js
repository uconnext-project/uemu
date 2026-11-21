/**
 * SXM channel logos.
 *
 * The stock receiver ships an `sdars/channelart` folder with one PNG per
 * station (`I<imageId>T00.png`), plus `I00000T00.png` as the generic `sxm`
 * fallback. `channelart.db` maps a station SID to that image id; the table
 * below already resolves SID → image for every channel in this port's local
 * lineup (the same `LOGO_SID` mapping as `sxm.py`).
 *
 * `SatHomeScreen.as:859-868` only leaves a logo URL untouched when it does not
 * start with `/` *and* contains the literal `channelart`; otherwise it
 * rewrites it to a receiver path (`//fs/mmc0/...`) that Ruffle cannot open.
 * Absolute URLs built here satisfy both checks, so the Loader gets a normal
 * same-origin HTTP(S) request instead of a failed `IOErrorEvent`.
 */

/** `channel number` → file name inside `backend/assets/channelart/`. */
export const CHANNEL_ART = Object.freeze({
    1: "I00001T00.png",
    2: "I00039T00.png",
    3: "none.png",
    5: "I00005T00.png",
    6: "I00006T00.png",
    7: "I00007T00.png",
    8: "I00008T00.png",
    9: "I00009T00.png",
    10: "I00030T00.png",
    15: "I00203T00.png",
    16: "I00155T00.png",
    20: "I00108T00.png",
    24: "I00091T00.png",
    25: "I00049T00.png",
    26: "I00046T00.png",
    27: "I00040T00.png",
    32: "I00025T00.png",
    34: "I00054T00.png",
    36: "I00034T00.png",
    37: "I00048T00.png",
    39: "I00041T00.png",
    40: "I00042T00.png",
    44: "I00065T00.png",
    45: "I00066T00.png",
    46: "I00067T00.png",
    48: "I00062T00.png",
    51: "I00081T00.png",
    52: "I00254T00.png",
    56: "I00016T00.png",
    58: "I00201T00.png",
    59: "I00160T00.png",
    60: "I00012T00.png",
    67: "I00070T00.png",
    71: "I00073T00.png",
    76: "I00110T00.png",
    80: "I00140T00.png",
    83: "I00142T00.png",
    88: "I00026T00.png",
    89: "I00175T00.png",
    94: "none.png",
    96: "I00151T00.png",
    99: "I00150T00.png",
    100: "I00018T00.png",
    101: "I00021T00.png",
    114: "I00122T00.png",
    116: "I00134T00.png",
    124: "I00130T00.png",
    134: "I00210T00.png",
    136: "I00210T00.png",
    138: "I00210T00.png",
    "-1": "none.png",
});

/** `backend/assets/channelart/`, resolved next to this module. */
const BASE = new URL("../assets/channelart/", import.meta.url);

/**
 * Absolute URL of a channel logo.
 *
 * @param {number} channel
 * @returns {string}
 */
export function channelArtUrl(channel) {
    return new URL(CHANNEL_ART[channel] ?? "none.png", BASE).href;
}
