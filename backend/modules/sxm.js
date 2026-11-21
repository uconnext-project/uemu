/**
 * XM / SiriusXM satellite radio (`modules/sxm.py`, 1077 lines).
 *
 * This is the offline half of the reference module: the same channel lineup,
 * static song pools, presets, favourites, Game Zone, Traffic Jump and Instant
 * Replay, but no `xmplaylist.com` polling. Every command that the stock
 * `SatelliteRadio.as` sends at boot and from the SatHome/Browse screens is
 * answered locally, so the SXM source appears and tunes without a network.
 *
 * Shapes come from `com/nfuzion/moduleLink/SatelliteRadio.as`:
 *
 *   - `XMApp`     channels, current station, app status, featured favourites
 *   - `XMPresets` the 12 preset slots (`localXMPresetList`)
 *   - `XMFavorites` songs/artists (persisted in the read/write store)
 *   - `XMGameZone`, `XMTrafficJump`, `XMInstantReplay`
 *   - `XMFuel`, `XMLandWeather`, `XMSports`, `XMMovies`, `XMTraffic`
 *
 * The HMI only offers the source when `VARIANT_SDARS` is `YES` and
 * `VehicleConfig.destination` is the US value, so this module sets the
 * destination to `"2"` exactly like `sxm.py:init`.
 *
 * There is no HTTP and no audio stream: tuning updates the station metadata,
 * the instant-replay buffer advances while `Audio.audioSource.source` is
 * `"sat"`, and the head unit keeps playing whatever the media module plays.
 */

import { channelArtUrl } from "./channelart.js";

/** `sxm.py:18-20`. */
const CATS = Object.freeze({
    Pop: 1,
    Rock: 2,
    "Hip-Hop/R&B": 3,
    "Dance/Electronic": 4,
    Country: 5,
    "Jazz/Standards": 6,
    Classical: 7,
    Sports: 8,
    "Howard Stern": 9,
    Comedy: 10,
    "News/Public Radio": 11,
    "Politics/Issues": 12,
    "Traffic/Weather": 13,
    Ect: 14,
});

/** `sxm.py:22-76` - `[channel, name, category, [[artist, title], ...]]`. */
const LINEUP = [
    [1, "SiriusXM Preview", "Pop", [["SiriusXM", "Channel Guide"], ["SiriusXM", "Free Preview Weekend"]]],
    [2, "SiriusXM Hits 1", "Pop", [["Taylor Swift", "Blank Space"], ["Mark Ronson", "Uptown Funk"], ["Ed Sheeran", "Thinking Out Loud"], ["Maroon 5", "Sugar"]]],
    [3, "Venus", "Pop", [["Jason Derulo", "Want To Want Me"], ["Rihanna", "FourFiveSeconds"], ["Ariana Grande", "One Last Time"]]],
    [5, "'50s on 5", "Pop", [["Elvis Presley", "Jailhouse Rock"], ["Buddy Holly", "Peggy Sue"], ["Chuck Berry", "Johnny B. Goode"]]],
    [6, "'60s on 6", "Pop", [["The Beatles", "Help!"], ["The Supremes", "Stop! In The Name Of Love"], ["The Beach Boys", "Good Vibrations"]]],
    [7, "'70s on 7", "Pop", [["Fleetwood Mac", "Dreams"], ["ABBA", "Dancing Queen"], ["Elton John", "Tiny Dancer"]]],
    [8, "'80s on 8", "Pop", [["Michael Jackson", "Billie Jean"], ["a-ha", "Take On Me"], ["Madonna", "Like A Virgin"], ["Duran Duran", "Hungry Like The Wolf"]]],
    [9, "'90s on 9", "Pop", [["Nirvana", "Smells Like Teen Spirit"], ["TLC", "Waterfalls"], ["Spice Girls", "Wannabe"]]],
    [10, "Pop2K", "Pop", [["OutKast", "Hey Ya!"], ["Britney Spears", "Toxic"], ["Kelly Clarkson", "Since U Been Gone"]]],
    [15, "The Pulse", "Pop", [["Coldplay", "Viva La Vida"], ["Adele", "Rolling In The Deep"], ["OneRepublic", "Counting Stars"]]],
    [16, "The Blend", "Pop", [["Train", "Hey, Soul Sister"], ["Sara Bareilles", "Love Song"], ["Phil Collins", "Easy Lover"]]],
    [20, "Elvis Radio", "Rock", [["Elvis Presley", "Suspicious Minds"], ["Elvis Presley", "Burning Love"], ["Elvis Presley", "Hound Dog"]]],
    [24, "Radio Margaritaville", "Rock", [["Jimmy Buffett", "Margaritaville"], ["Kenny Chesney", "No Shoes, No Shirt, No Problems"]]],
    [25, "Classic Rewind", "Rock", [["Bon Jovi", "Livin' On A Prayer"], ["Def Leppard", "Pour Some Sugar On Me"], ["Journey", "Separate Ways"]]],
    [26, "Classic Vinyl", "Rock", [["Led Zeppelin", "Black Dog"], ["The Who", "Baba O'Riley"], ["Lynyrd Skynyrd", "Free Bird"]]],
    [27, "Deep Tracks", "Rock", [["Pink Floyd", "Echoes"], ["The Allman Brothers Band", "Whipping Post"], ["Neil Young", "Cortez The Killer"]]],
    [32, "The Bridge", "Rock", [["James Taylor", "Fire And Rain"], ["Eagles", "Peaceful Easy Feeling"], ["Jackson Browne", "Running On Empty"]]],
    [34, "Lithium", "Rock", [["Pearl Jam", "Alive"], ["Soundgarden", "Black Hole Sun"], ["Stone Temple Pilots", "Plush"]]],
    [36, "Alt Nation", "Rock", [["Imagine Dragons", "Shots"], ["Walk The Moon", "Shut Up And Dance"], ["Twenty One Pilots", "Tear In My Heart"]]],
    [37, "Octane", "Rock", [["Shinedown", "Cut The Cord"], ["Disturbed", "The Vengeful One"], ["Breaking Benjamin", "Failure"]]],
    [39, "Hair Nation", "Rock", [["Motley Crue", "Dr. Feelgood"], ["Poison", "Talk Dirty To Me"], ["Whitesnake", "Here I Go Again"]]],
    [40, "Liquid Metal", "Rock", [["Metallica", "Master Of Puppets"], ["Slayer", "Raining Blood"], ["Pantera", "Walk"]]],
    [44, "Hip-Hop Nation", "Hip-Hop/R&B", [["Drake", "Energy"], ["Kendrick Lamar", "King Kunta"], ["Big Sean", "Blessings"]]],
    [45, "Shade 45", "Hip-Hop/R&B", [["Eminem", "Lose Yourself"], ["50 Cent", "In Da Club"], ["Dr. Dre", "Still D.R.E."]]],
    [46, "The Heat", "Hip-Hop/R&B", [["The Weeknd", "Earned It"], ["Chris Brown", "Ayo"], ["Usher", "I Don't Mind"]]],
    [48, "Heart & Soul", "Hip-Hop/R&B", [["Alicia Keys", "No One"], ["John Legend", "All Of Me"], ["Mary J. Blige", "Be Without You"]]],
    [51, "BPM", "Dance/Electronic", [["Calvin Harris", "Summer"], ["David Guetta", "Titanium"], ["Avicii", "Wake Me Up"]]],
    [52, "Electric Area", "Dance/Electronic", [["Hardwell", "Spaceman"], ["Tiesto", "Red Lights"], ["Armin van Buuren", "Ping Pong"]]],
    [56, "The Highway", "Country", [["Luke Bryan", "Kick The Dust Up"], ["Florida Georgia Line", "Sun Daze"], ["Carrie Underwood", "Smoke Break"], ["Sam Hunt", "Take Your Time"]]],
    [58, "Prime Country", "Country", [["George Strait", "Check Yes Or No"], ["Alan Jackson", "Chattahoochee"], ["Brooks & Dunn", "Neon Moon"]]],
    [59, "Willie's Roadhouse", "Country", [["Willie Nelson", "On The Road Again"], ["Patsy Cline", "Crazy"], ["Merle Haggard", "Mama Tried"]]],
    [60, "Outlaw Country", "Country", [["Johnny Cash", "Folsom Prison Blues"], ["Waylon Jennings", "Luckenbach, Texas"], ["Steve Earle", "Copperhead Road"]]],
    [67, "Real Jazz", "Jazz/Standards", [["Miles Davis", "So What"], ["John Coltrane", "Naima"], ["Dave Brubeck", "Take Five"]]],
    [71, "Siriusly Sinatra", "Jazz/Standards", [["Frank Sinatra", "Fly Me To The Moon"], ["Tony Bennett", "The Way You Look Tonight"], ["Dean Martin", "That's Amore"]]],
    [76, "Symphony Hall", "Classical", [["Beethoven", "Symphony No. 5"], ["Mozart", "Eine kleine Nachtmusik"], ["Dvorak", "New World Symphony"]]],
    [80, "ESPN Radio", "Sports", [["Mike & Mike", "NFL Week 6 Preview"], ["SportsCenter", "Top Headlines"]]],
    [83, "FOX Sports Radio", "Sports", [["The Herd", "Playoff Picture"], ["Fox Sports Update", "Scores And Highlights"]]],
    [88, "SiriusXM NFL Radio", "Sports", [["Movin' The Chains", "Week 6 Breakdown"], ["Opening Drive", "Injury Report"]]],
    [89, "MLB Network Radio", "Sports", [["Inside Pitch", "ALCS Game 3"], ["Power Alley", "Postseason Talk"]]],
    [94, "Comedy Greats", "Comedy", [["George Carlin", "Stuff"], ["Richard Pryor", "Live On The Sunset Strip"]]],
    [96, "Laugh USA", "Comedy", [["Jim Gaffigan", "Hot Pockets"], ["Brian Regan", "Stupid In School"]]],
    [99, "Raw Dog Comedy", "Comedy", [["Louis C.K.", "Hilarious"], ["Bill Burr", "Why Do I Do This?"]]],
    [100, "Howard 100", "Howard Stern", [["The Howard Stern Show", "Live"], ["Howard 100 News", "Wrap-Up"]]],
    [101, "Howard 101", "Howard Stern", [["Howard Stern Show", "Replay"], ["Bad Boy Hour", "Special"]]],
    [114, "FOX News Channel", "News/Public Radio", [["FOX News", "America's Newsroom"], ["FOX News", "The Five"]]],
    [116, "CNN", "News/Public Radio", [["CNN", "Newsroom"], ["CNN", "The Situation Room"]]],
    [124, "POTUS", "Politics/Issues", [["POTUS", "Morning Briefing"], ["POTUS", "Campaign 2016"]]],
    [134, "Chicago Traffic/Weather", "Traffic/Weather", [["Traffic & Weather", "Chicago Area Report"]]],
    [136, "Detroit Traffic/Weather", "Traffic/Weather", [["Traffic & Weather", "Detroit Area Report"]]],
    [138, "New York Traffic/Weather", "Traffic/Weather", [["Traffic & Weather", "New York Area Report"]]],
    [-1, "Discord", "Ect", [["Join the Community", "discord.gg/X66nKtjwpW"]]],
];

const CH = new Map(LINEUP.map((entry) => [entry[0], entry]));
const NUMS = LINEUP.map((entry) => entry[0]);

/** `sxm.py:548-555` - short names shown under preset buttons. */
const SHORT = Object.freeze({
    1: "Preview",
    2: "Hits 1",
    3: "Venus",
    5: "50s on 5",
    6: "60s on 6",
    7: "70s on 7",
    8: "80s on 8",
    9: "90s on 9",
    10: "Pop2K",
    15: "Pulse",
    16: "Blend",
    20: "Elvis",
    24: "Margvlle",
    25: "Rewind",
    26: "Vinyl",
    27: "DeepTrks",
    32: "Bridge",
    34: "Lithium",
    36: "AltNation",
    37: "Octane",
    39: "HairNatn",
    40: "LiqMetal",
    44: "HipHopNtn",
    45: "Shade 45",
    46: "The Heat",
    48: "HrtSoul",
    51: "BPM",
    52: "Electric",
    56: "Highway",
    58: "PrimeCtry",
    59: "Willie's",
    60: "Outlaw",
    67: "RealJazz",
    71: "Sinatra",
    76: "Symphony",
    80: "ESPN",
    83: "FOXSports",
    88: "NFL",
    89: "MLB",
    94: "ComedyGr",
    96: "LaughUSA",
    99: "Raw Dog",
    100: "Howard100",
    101: "Howard101",
    114: "FOX News",
    116: "CNN",
    124: "POTUS",
    134: "CHI T/W",
    136: "DET T/W",
    138: "NYC T/W",
    "-1": "Disco.",
});

/** `sxm.py:177` - the receiver serial shown in Diagnostics. */
const ESN = "0R7X9C2KQ4";

/** `sxm.py:649-652` - the factory preset page. */
const DEFAULT_PRESETS = [41, 37, 34, 27, 10, -1, 45, 50, 46, 49, 153, 6];

/** `sxm.py:689-697` - no live traffic markets on this unit. */
const MARKETS = Array.from({ length: 9 }, (_, index) => ({
    uniqueID: index + 1,
    marketID: "N/A",
    marketName: "Depricated Service",
    channel: -2,
}));

/** `sxm.py:700-706`. */
const LEAGUES = [
    { abbrev: "MLB", name: "Major League Baseball", contentDescriptor: 1 },
    { abbrev: "NBA", name: "National Basketball Association", contentDescriptor: 2 },
    { abbrev: "NFL", name: "National Football League", contentDescriptor: 3 },
    { abbrev: "NHL", name: "National Hockey League", contentDescriptor: 4 },
];

/** `sxm.py:707-711`. */
const TEAMS = {
    1: [["Detroit", "Tigers"], ["Chicago", "Cubs"], ["New York", "Yankees"], ["Kansas City", "Royals"]],
    2: [["Detroit", "Pistons"], ["Chicago", "Bulls"], ["Golden State", "Warriors"], ["Cleveland", "Cavaliers"]],
    3: [["Detroit", "Lions"], ["Chicago", "Bears"], ["Green Bay", "Packers"], ["New England", "Patriots"]],
    4: [["Detroit", "Red Wings"], ["Chicago", "Blackhawks"], ["New York", "Rangers"], ["Boston", "Bruins"]],
};

const GZ_CHANNEL = { 1: 89, 2: 80, 3: 88, 4: 83 };

/** `sxm.py:718-736` - offline data-service payloads. */
const FUEL_DATA = [
    { stationID: 1, name: "Shell", address: "123 Main St", distance: "1.2 mi", regular: "3.49", midGrade: "3.79", premium: "4.09", diesel: "3.89" },
    { stationID: 2, name: "Exxon", address: "456 Oak Ave", distance: "2.5 mi", regular: "3.45", midGrade: "3.75", premium: "4.05", diesel: "3.85" },
    { stationID: 3, name: "Chevron", address: "789 Pine Rd", distance: "3.1 mi", regular: "3.55", midGrade: "3.85", premium: "4.15", diesel: "3.95" },
];

const WEATHER_CURRENT = { temperature: "67°F", condition: "Sunny", humidity: "45%", wind: "NE 8 mph" };
const WEATHER_3_6HR = [
    { time: "12:00 PM", temp: "68°F", condition: "Partly Cloudy" },
    { time: "3:00 PM", temp: "71°F", condition: "Sunny" },
    { time: "6:00 PM", temp: "65°F", condition: "Clear" },
];
const WEATHER_5_DAY = [
    { day: "Today", high: "72°F", low: "52°F", condition: "Sunny" },
    { day: "Monday", high: "75°F", low: "54°F", condition: "Partly Cloudy" },
    { day: "Tuesday", high: "68°F", low: "49°F", condition: "Rain" },
];
const SKI_INFO = [{ resort: "Summit Alpine", openStatus: "Open", newSnow: "2 in", baseDepth: "48 in" }];

const SPORTS_SCORES = [
    { league: "NFL", matchup: "Chiefs vs 49ers", score: "24 - 21", status: "Final" },
    { league: "NBA", matchup: "Lakers vs Celtics", score: "102 - 98", status: "4th Qtr" },
];

const MOVIE_LISTINGS = [
    { title: "Dune: Part Two", theater: "AMC Metro 12", distance: "1.8 mi", times: ["1:00 PM", "4:30 PM", "8:00 PM"] },
    { title: "Civil War", theater: "Regal Cinemas", distance: "3.4 mi", times: ["2:15 PM", "5:45 PM", "9:15 PM"] },
];

const TRAFFIC_EVENTS = [
    { eventID: 1, road: "I-95 South", description: "Construction work near Exit 42", delay: "5 mins", severity: "Moderate" },
];

/** `sxm.py:868-871`. */
const IR_BUFFER_SECONDS = 44 * 60;

const FEATURED = { 1: [2, 8, 26, 56], 2: [80, 88, 89, 83] };

const noop = () => {};

function toInt(value, fallback = 0) {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) ? number : fallback;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function channelList(args) {
    const raw = args?.channelList ?? args?.list ?? [];
    if (Array.isArray(raw)) {
        return raw.map((item) => toInt(item, Number.NaN)).filter(Number.isFinite);
    }

    const text = String(raw ?? "").trim();
    const inner = text.replace(/^\[/, "").replace(/\]$/, "").trim();
    if (!inner) {
        return [];
    }
    return inner
        .split(",")
        .map((item) => toInt(item, Number.NaN))
        .filter(Number.isFinite);
}

function requested(args) {
    const list = args?.props ?? args?.properties ?? [];
    return Array.isArray(list) ? list : [];
}

/** Marks the favourite fields on a station payload (`sxm.py:436-448`). */
function favouriteFlags(favorites, artist, title) {
    return {
        isSongFavorite: Boolean(title) && favorites.some((favorite) => favorite.favoriteType === "song" && favorite.song === title),
        isArtistFavorite: Boolean(artist) && favorites.some((favorite) => favorite.favoriteType === "artist" && favorite.artist === artist),
    };
}

/**
 * Registers the SXM modules.
 *
 * @param {import("../index.js").HmiBackend} backend
 * @param {object} [options]
 * @param {() => number} [options.now] Clock override for tests.
 * @param {boolean} [options.startTimers] Tests drive `tick()` explicitly.
 * @returns {object} Controller exposed on `window.airSxm`.
 */
export function registerSxm(backend, options = {}) {
    const now = options.now ?? (() => Date.now());

    // `sxm.py:init` - the HMI's satellite gate wants the US destination.
    const vehicleConfig = backend.propStore("VehicleConfig");
    vehicleConfig.destination = "2";
    vehicleConfig.destinationName = vehicleConfig.destinationName || "US";
    backend.moduleStore("VehicleConfig").destination = "2";

    const persisted = backend.persistency.XMFavorites?.allFavorites;
    const XM = {
        channel: -1,
        previous: 8,
        presets: [...DEFAULT_PRESETS],
        skipped: [],
        favorites: Array.isArray(persisted) ? clone(persisted) : [],
        favId: Array.isArray(persisted)
            ? Math.max(0, ...persisted.map((favorite) => toInt(favorite.id, 0)))
            : 0,
        market: 0,
        jumpFrom: null,
    };

    const GZ = { favorites: [] };
    const IR = { fill: 0, behind: 0, paused: false, ff: 0 };

    function setSignal(module, key, value, connection) {
        backend.moduleStore(module)[key] = value;
        backend.send(module, { [key]: value }, connection);
    }

    /** `sxm.py:525-546` - deterministic "now playing" from the static pool. */
    function nowPlaying(num) {
        if (num === -1) {
            return ["Join the Community", "discord.gg/X66nKtjwpW"];
        }

        const songs = CH.get(num)?.[3] ?? [];
        if (songs.length === 0) {
            return ["", ""];
        }

        const seconds = Math.floor(now() / 1000);
        const length = 170 + ((num * 37) % 100);
        const index = Math.floor((seconds + num * 53) / length) % songs.length;
        return songs[index];
    }

    /** `sxm.py:558-562`. */
    function shortName(num) {
        const entry = CH.get(num);
        if (!entry) {
            return "";
        }
        return SHORT[num] ?? entry[1].replace(/^SiriusXM /, "").slice(0, 9);
    }

    /** `sxm.py:436-458`. */
    function station(num, full = false) {
        const entry = CH.get(num) ?? CH.get(-1);
        const [n, name, category] = entry;
        const [artist, title] = nowPlaying(n);
        const payload = {
            channelID: n,
            sid: 1000 + n,
            channelName: name,
            shortName: shortName(n),
            catName: category,
            catNum: CATS[category] ?? 14,
            artist,
            program: title,
            isSubscribed: true,
            ...favouriteFlags(XM.favorites, artist, title),
            // Absolute URL that still contains `channelart`, so
            // `SatHomeScreen.as` keeps it instead of rewriting it to the
            // receiver's `//fs/mmc0/...` path (which Ruffle cannot open).
            logoLocation: channelArtUrl(n),
            albumArt: "",
        };

        if (full) {
            payload.info = "";
            payload.presetNum = XM.presets.includes(n) ? XM.presets.indexOf(n) : 255;
        }

        return payload;
    }

    function presetsPayload() {
        return XM.presets.map((num) => ({
            channelID: num || 65535,
            text: CH.has(num) ? shortName(num) : "",
        }));
    }

    function publishCurrent(connection) {
        setSignal("XMApp", "currentStationInfo", station(XM.channel, true), connection);
    }

    function publishLineup(connection) {
        setSignal("XMApp", "stationInfoList", NUMS.map((num) => station(num)), connection);
    }

    function activeFavorites() {
        const active = [];
        for (const num of NUMS) {
            const [artist, title] = nowPlaying(num);
            const match = XM.favorites.find(
                (favorite) =>
                    (favorite.favoriteType === "song" && favorite.song === title) ||
                    (favorite.favoriteType === "artist" && favorite.artist === artist),
            );
            if (match) {
                active.push({
                    channel: num,
                    artist,
                    song: title,
                    isActiveArtist: match.favoriteType === "artist",
                    isActiveSong: match.favoriteType === "song",
                });
            }
        }
        return active;
    }

    function saveFavorites() {
        backend.persistency.XMFavorites ??= {};
        backend.persistency.XMFavorites.allFavorites = clone(XM.favorites);
        try {
            backend.onPersistencyChange?.(backend.persistency);
        } catch {
            // A full/blocked localStorage must not break tuning.
        }
    }

    function publishFavorites() {
        setSignal("XMFavorites", "allFavorites", clone(XM.favorites));
        setSignal("XMFavorites", "activeFavorites", activeFavorites());
        publishCurrent();
        saveFavorites();
    }

    // ------------------------------------------------------------ XMApp
    function tune(num) {
        if (!CH.has(num) || num === XM.channel) {
            publishCurrent();
            return;
        }

        XM.previous = XM.channel;
        XM.channel = num;
        IR.fill = 0;
        IR.behind = 0;
        IR.paused = false;
        publishCurrent();
        publishInstantReplay();
    }

    function step(up) {
        const order = NUMS.filter((num) => !XM.skipped.includes(num) && num !== 1);
        if (order.length === 0) {
            return XM.channel;
        }
        const index = order.includes(XM.channel) ? order.indexOf(XM.channel) : 0;
        return order[(index + (up ? 1 : -1) + order.length) % order.length];
    }

    function presetStep(up) {
        const filled = XM.presets.filter((num) => CH.has(num));
        if (filled.length === 0) {
            return;
        }
        const index = filled.includes(XM.channel) ? filled.indexOf(XM.channel) : -1;
        tune(filled[(index + (up ? 1 : -1) + filled.length) % filled.length]);
    }

    function addFavorite(kind, args) {
        const requestedChannel = toInt(args?.newFavorite, XM.channel);
        const num = CH.has(requestedChannel) ? requestedChannel : XM.channel;
        const [artist, title] = nowPlaying(num);
        const value = kind === "song" ? title : artist;
        if (!value) {
            return;
        }

        const exists = XM.favorites.some(
            (favorite) =>
                favorite.favoriteType === kind &&
                (kind === "song" ? favorite.song : favorite.artist) === value,
        );
        if (!exists) {
            XM.favId += 1;
            XM.favorites.push({
                id: XM.favId,
                favoriteType: kind,
                artist,
                song: kind === "song" ? title : "",
            });
        }
        publishFavorites();
    }

    function verifyFavorites(args) {
        // `sxm.py:141-158` - the car answers with the whole favourite picture.
        backend.send("XMFavorites", {
            getProperties: {
                allFavorites: clone(XM.favorites),
                activeFavorites: activeFavorites(),
                favAllowed: { isArtistAllowed: true, isSongAllowed: true },
            },
        });
    }

    // -------------------------------------------------------- Instant Replay
    function publishInstantReplay() {
        const fillPct = Math.min(100, Math.trunc((IR.fill * 100) / IR_BUFFER_SECONDS));
        const playPct = Math.max(0, 100 - Math.trunc((IR.behind * 100) / IR_BUFFER_SECONDS));
        const behind = IR.behind;
        setSignal("XMInstantReplay", "replayBufferStatus", {
            fillPct,
            playbackPct: playPct,
            hours: Math.trunc(behind / 3600),
            minutes: Math.trunc(behind / 60) % 60,
            seconds: behind % 60,
        });
        setSignal("XMInstantReplay", "replayPlayStatus", {
            pauseStatus: IR.paused ? "PAUSE" : "PLAY",
            isLive: behind === 0 && !IR.paused,
            fastForwardActive: IR.ff > 0,
            rewindActive: IR.ff < 0,
            scanActive: false,
        });
    }

    function moveInstantReplay(delta) {
        IR.behind = Math.max(0, Math.min(IR.fill, IR.behind - delta));
        publishInstantReplay();
    }

    // ----------------------------------------------------------- Game Zone
    function gzFavoritesPayload() {
        return {
            currentTeamFavorites: GZ.favorites.map(([league, team, alertType]) => ({
                leagueDescriptor: league,
                teamDescriptor: team,
                alertType,
                teamName: TEAMS[league][team][0],
                teamNick: TEAMS[league][team][1],
            })),
        };
    }

    function gzScores() {
        return GZ.favorites.map(([league, team]) => {
            const home = TEAMS[league][team];
            const away = TEAMS[league][(team + 1) % TEAMS[league].length];
            return {
                channel: GZ_CHANNEL[league],
                teams: `${away[1]} at ${home[1]}`,
                scores: `${(team * 3 + league) % 6} - ${(team + 2 * league) % 5}`,
            };
        });
    }

    function publishGameZone() {
        setSignal("XMGameZone", "currentTeamFavorites", gzFavoritesPayload());
        setSignal("XMGameZone", "activeScores", gzScores());
    }

    // -------------------------------------------------------- boot values
    backend.defineModule("XMApp", {
        state: {
            appStatus: { appStatus: "READY" },
            advisoryMsg: { advisoryMsg: "NO ERROR" },
            signalStrength: { signalStrength: 3 },
            ESN: { ESN },
            xmAppVersion: "SXV300 07.01.15",
            audioSubscriptionStatus: { subStatus: 1 },
            dataServicesSubscriptionStatus: Object.fromEntries(
                [
                    "channelArtSubStatus",
                    "fuelSubStatus",
                    "graphicalWeatherSubStatus",
                    "landWeatherSubStatus",
                    "moviesSubStatus",
                    "securityAlertsSubStatus",
                    "sportsSubStatus",
                    "trafficSubStatus",
                ].map((key) => [key, 1]),
            ),
            dataServicesState: ["fuel", "movies", "sports", "weather"].map((service) => ({
                service,
                state: "READY",
            })),
            availableChannelList: [...NUMS],
            skippedChannelList: [],
            lockedChannelList: [],
            smartFavoritesStatus: { smartFavoritesStatus: 1 },
            featuredFavoritesList: {
                list: [
                    { bandID: 1, name: "SXM Picks", longName: "SiriusXM Picks", verboseName: "SiriusXM Picks", description: "Channels picked for you" },
                    { bandID: 2, name: "Sports", longName: "Sports Talk", verboseName: "Sports Talk & Play-by-Play", description: "Live sports talk" },
                ],
            },
            stationInfoList: NUMS.map((num) => station(num)),
            currentStationInfo: station(XM.channel, true),
        },
    });

    backend.defineModule("XMPresets", {
        state: { localXMPresetList: presetsPayload() },
    });

    backend.defineModule("XMFavorites", {
        state: {
            allFavorites: clone(XM.favorites),
            activeFavorites: activeFavorites(),
            favAllowed: { isArtistAllowed: true, isSongAllowed: true },
        },
    });

    backend.defineModule("XMGameZone", {
        state: {
            globalGameAlertStatus: { Status: true },
            globalScoreAlertStatus: { Status: true },
            currentTeamFavorites: gzFavoritesPayload(),
            leagueList: clone(LEAGUES),
            activeScores: [],
        },
    });

    backend.defineModule("XMTrafficJump", {
        state: {
            trafficList: clone(MARKETS),
            jumpStatus: "JUMP_MARKET_NOT_SELECTED",
            selectedMarket: 0,
        },
    });

    backend.defineModule("XMInstantReplay", {
        state: {
            replayBufferStatus: { fillPct: 0, playbackPct: 100, hours: 0, minutes: 0, seconds: 0 },
            replayPlayStatus: {
                pauseStatus: "PLAY",
                isLive: true,
                fastForwardActive: false,
                rewindActive: false,
                scanActive: false,
            },
            numPlaylistItems: 0,
            currentOffset: 0,
        },
    });

    backend.defineModule("XMFuel", { state: { fuelList: clone(FUEL_DATA) } });
    backend.defineModule("XMLandWeather", {
        state: {
            currentWeather: clone(WEATHER_CURRENT),
            hourlyForecast: clone(WEATHER_3_6HR),
            forecast5Day: clone(WEATHER_5_DAY),
            skiInfo: clone(SKI_INFO),
        },
    });
    backend.defineModule("XMSports", { state: { sportsScores: clone(SPORTS_SCORES) } });
    backend.defineModule("XMMovies", { state: { movieListings: clone(MOVIE_LISTINGS) } });
    backend.defineModule("XMTraffic", { state: { trafficEvents: clone(TRAFFIC_EVENTS) } });

    // ------------------------------------------------------------ XMApp
    backend.on("XMApp", "channelSelect", (dest, args) => {
        tune(toInt(args?.station, XM.channel));
    });

    backend.on("XMApp", "tunePreviousChannel", () => tune(XM.previous));
    backend.on("XMApp", "seekUpPress", () => tune(step(true)));
    backend.on("XMApp", "seekDownPress", () => tune(step(false)));

    backend.on("XMApp", "presetRecall", (dest, args) => {
        const position = toInt(args?.presetNum, -1);
        if (position >= 0 && position < XM.presets.length && XM.presets[position]) {
            tune(XM.presets[position]);
        }
    });

    backend.on("XMApp", "presetSeekUp", () => presetStep(true));
    backend.on("XMApp", "presetSeekDown", () => presetStep(false));

    backend.on("XMApp", "skipChannel", (dest, args) => {
        const skipped = new Set([...XM.skipped, ...channelList(args)]);
        XM.skipped = [...skipped].sort((a, b) => a - b);
        setSignal("XMApp", "skippedChannelList", XM.skipped);
    });

    backend.on("XMApp", "clearSkipChannel", (dest, args) => {
        const cleared = new Set(channelList(args));
        XM.skipped = XM.skipped.filter((num) => !cleared.has(num));
        setSignal("XMApp", "skippedChannelList", XM.skipped);
    });

    backend.on("XMApp", "getFeaturedFavoritesList", (dest, args, connection) => {
        backend.emit("XMApp", "featuredFavoritesList", connection);
    });

    backend.on("XMApp", "getFeaturedFav", (dest, args, connection) => {
        const band = toInt(args?.bandID, 0);
        const channels = (FEATURED[band] ?? []).filter((num) => CH.has(num));
        backend.send(
            "XMApp",
            {
                featureFavorite: {
                    list: channels.map((num) => ({ channelID: num, name: CH.get(num)[1] })),
                },
            },
            connection,
        );
    });

    // Commands the HMI sends but the stock screens do not need answered.
    for (const command of [
        "seekRelease",
        "scanUp",
        "scanDown",
        "scanCancel",
        "setCategoryFilter",
        "setCategoryOrder",
        "setTimeZoneOffset",
        "requestEnableICSTuning",
        "requestDisableICSTuning",
        "enableSmartFavs",
        "disableSmartFavs",
        "lockChannel",
        "clearLockChannel",
        "requestChannelSort",
        "setChannelSort",
    ]) {
        backend.on("XMApp", command, noop);
    }

    // -------------------------------------------------------- XMPresets
    backend.on("XMPresets", "presetStore", (dest, args) => {
        const position = toInt(args?.presetNum, -1);
        const channel = toInt(args?.channelNum, 65535);
        if (position >= 0 && position < XM.presets.length) {
            XM.presets[position] = CH.has(channel) ? channel : 0;
            setSignal("XMPresets", "localXMPresetList", presetsPayload());
            publishCurrent();
        }
    });

    // `PresetPersistencyManager.as:369-373` can also recall through this name.
    backend.on("XMPresets", "presetRecall", (dest, args) => {
        const position = toInt(args?.presetNum, -1);
        if (position >= 0 && position < XM.presets.length && XM.presets[position]) {
            tune(XM.presets[position]);
        }
    });

    // ------------------------------------------------------- XMFavorites
    backend.on("XMFavorites", "setFavoriteSong", (dest, args) => addFavorite("song", args));
    backend.on("XMFavorites", "setFavoriteArtist", (dest, args) => addFavorite("artist", args));
    backend.on("XMFavorites", "getProperties", () => verifyFavorites());
    backend.on("XMFavorites", "Subscribe", () => publishFavorites());

    backend.on("XMFavorites", "removeFavorite", (dest, args) => {
        const id = toInt(args?.id, -1);
        XM.favorites = XM.favorites.filter((favorite) => favorite.id !== id);
        publishFavorites();
    });

    backend.on("XMFavorites", "removeAllFavorites", () => {
        XM.favorites = [];
        publishFavorites();
    });

    // ------------------------------------------------------- XMTrafficJump
    backend.on("XMTrafficJump", "selectTrafficMarket", (dest, args) => {
        XM.market = toInt(args?.marketID, 0);
        setSignal("XMTrafficJump", "selectedMarket", XM.market);
        setSignal("XMTrafficJump", "jumpStatus", "JUMP_IDLE");
    });

    backend.on("XMTrafficJump", "clearTrafficMarkets", () => {
        XM.market = 0;
        setSignal("XMTrafficJump", "selectedMarket", 0);
        setSignal("XMTrafficJump", "jumpStatus", "JUMP_MARKET_NOT_SELECTED");
    });

    function cancelJump(connection) {
        backend.send("XMTrafficJump", { cancelJump: { CmdResponse: { errCode: "eSuccess" } } }, connection);
        if (XM.jumpFrom !== null) {
            const back = XM.jumpFrom;
            XM.jumpFrom = null;
            tune(back);
            setSignal("XMTrafficJump", "jumpStatus", "JUMP_COMPLETED");
        }
        setSignal(
            "XMTrafficJump",
            "jumpStatus",
            XM.market ? "JUMP_IDLE" : "JUMP_MARKET_NOT_SELECTED",
        );
    }

    backend.on("XMTrafficJump", "trafficJumpPress", (dest, args, connection) => {
        const market = MARKETS.find((entry) => entry.uniqueID === XM.market);
        if (!market) {
            backend.send(
                "XMTrafficJump",
                { trafficJumpPress: { CmdResponse: { errCode: "eNoMarketSelected" } } },
                connection,
            );
            return;
        }

        backend.send(
            "XMTrafficJump",
            { trafficJumpPress: { CmdResponse: { errCode: "eSuccess" } } },
            connection,
        );
        if (XM.jumpFrom === null) {
            XM.jumpFrom = XM.channel;
            setSignal("XMTrafficJump", "jumpStatus", "JUMP_IN_PROGRESS");
            tune(market.channel);
        } else {
            cancelJump(connection);
        }
    });

    backend.on("XMTrafficJump", "cancelJump", (dest, args, connection) => {
        cancelJump(connection);
    });

    // --------------------------------------------------------- XMGameZone
    backend.on("XMGameZone", "requestLeagueList", (dest, args, connection) => {
        backend.send("XMGameZone", { leagueList: clone(LEAGUES) }, connection);
    });

    backend.on("XMGameZone", "requestTeamList", (dest, args, connection) => {
        const league = toInt(args?.contentDescriptor, 1);
        const favorites = new Map(GZ.favorites.map(([l, t, alert]) => [`${l}:${t}`, alert]));
        const teams = (TEAMS[league] ?? []).map(([teamName, teamNick], teamID) => ({
            league,
            teamID,
            teamName,
            teamNick,
            alertType: favorites.get(`${league}:${teamID}`) ?? "NONE",
        }));
        backend.send("XMGameZone", { teamList: teams }, connection);
    });

    backend.on("XMGameZone", "setFavoriteTeam", (dest, args) => {
        const league = toInt(args?.leagueDescriptor, 0);
        const team = toInt(args?.teamDescriptor, 0);
        if (
            TEAMS[league]?.[team] &&
            !GZ.favorites.some(([l, t]) => l === league && t === team)
        ) {
            GZ.favorites.push([league, team, args?.alertType ?? "GAME_SCORE"]);
        }
        publishGameZone();
    });

    backend.on("XMGameZone", "removeFavTeam", (dest, args) => {
        const league = toInt(args?.leagueDescriptor, 0);
        const team = toInt(args?.teamDescriptor, 0);
        GZ.favorites = GZ.favorites.filter(([l, t]) => !(l === league && t === team));
        publishGameZone();
    });

    backend.on("XMGameZone", "removeAllTeams", () => {
        GZ.favorites = [];
        publishGameZone();
    });

    backend.on("XMGameZone", "enableGlobalGameAlert", (dest, args) => {
        setSignal("XMGameZone", "globalGameAlertStatus", {
            Status: args?.Status === true || args?.Status === "true",
        });
    });

    backend.on("XMGameZone", "enableGlobalScoreAlert", (dest, args) => {
        setSignal("XMGameZone", "globalScoreAlertStatus", {
            Status: args?.Status === true || args?.Status === "true",
        });
    });

    // ---------------------------------------------------- data services
    backend.on("XMFuel", "requestFuelPrices", (dest, args, connection) => {
        backend.send("XMFuel", { fuelList: clone(FUEL_DATA) }, connection);
    });

    backend.on("XMLandWeather", "requestWeather", (dest, args, connection) => {
        backend.send(
            "XMLandWeather",
            {
                currentWeather: clone(WEATHER_CURRENT),
                hourlyForecast: clone(WEATHER_3_6HR),
                forecast5Day: clone(WEATHER_5_DAY),
                skiInfo: clone(SKI_INFO),
            },
            connection,
        );
    });

    backend.on("XMSports", "requestSportsScores", (dest, args, connection) => {
        backend.send("XMSports", { sportsScores: clone(SPORTS_SCORES) }, connection);
    });

    backend.on("XMMovies", "requestMovieListings", (dest, args, connection) => {
        backend.send("XMMovies", { movieListings: clone(MOVIE_LISTINGS) }, connection);
    });

    backend.on("XMTraffic", "requestTrafficEvents", (dest, args, connection) => {
        backend.send("XMTraffic", { trafficEvents: clone(TRAFFIC_EVENTS) }, connection);
    });

    // ---------------------------------------------------- XMInstantReplay
    const replayActions = {
        live: () => {
            IR.behind = 0;
            IR.paused = false;
            IR.ff = 0;
        },
        pausePlayRelease: () => {
            IR.paused = !IR.paused;
        },
        seekPrevious: () => {
            IR.behind = Math.min(IR.fill, IR.behind + 30);
        },
        seekForward: () => {
            IR.behind = Math.max(0, IR.behind - 30);
        },
        rewindPress: () => {
            IR.ff = -1;
        },
        fastForwardPress: () => {
            IR.ff = 1;
        },
        rewindRelease: () => {
            IR.ff = 0;
        },
        fastForwardRelease: () => {
            IR.ff = 0;
        },
        seekToPosition: (args) => {
            const percent = toInt(args?.percent, 100);
            IR.behind = Math.min(
                IR.fill,
                Math.max(0, Math.trunc(((100 - percent) * IR_BUFFER_SECONDS) / 100)),
            );
        },
    };

    for (const [command, action] of Object.entries(replayActions)) {
        backend.on("XMInstantReplay", command, (dest, args) => {
            action(args);
            publishInstantReplay();
        });
    }

    for (const command of [
        "pausePlayPress",
        "scanPressed",
        "setIRMode",
        "requestPlaylist",
        "playFromPlaylist",
    ]) {
        backend.on("XMInstantReplay", command, noop);
    }

    // ------------------------------------------------------------ ticker
    function tick() {
        const source = backend.moduleStore("Audio").audioSource?.source;
        if (source !== "sat") {
            return;
        }

        IR.fill = Math.min(IR_BUFFER_SECONDS, IR.fill + 1);
        if (IR.paused) {
            IR.behind = Math.min(IR.fill, IR.behind + 1);
        } else if (IR.ff) {
            moveInstantReplay(IR.ff * 10);
            return;
        } else if (IR.behind === 0 && IR.fill % 5 !== 0) {
            return;
        }
        publishInstantReplay();
    }

    if (typeof window !== "undefined" || options.startTimers === true) {
        setInterval(tick, 1000);
    }

    return {
        tune,
        step: (up = true) => {
            const next = step(up);
            tune(next);
            return next;
        },
        skip: (channels) => {
            const skipped = new Set([...XM.skipped, ...channels.map(Number)]);
            XM.skipped = [...skipped].sort((a, b) => a - b);
            setSignal("XMApp", "skippedChannelList", XM.skipped);
        },
        presetRecall: (position) => {
            if (position >= 0 && position < XM.presets.length && XM.presets[position]) {
                tune(XM.presets[position]);
            }
        },
        tick,
        channel: () => XM.channel,
        presets: () => [...XM.presets],
        favorites: () => clone(XM.favorites),
        station: (num = XM.channel) => station(num, true),
    };
}
