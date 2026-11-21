/**
 * Phone + Bluetooth (`modules/phone.py`, 832 lines).
 *
 * The car side of the stock Phone screens: BluetoothGAP (paired devices and
 * service connections), BluetoothHFP (the call state machine), PhoneBook
 * (contacts `pb` and favourites `ab`), PhoneCallList and the SMS half of
 * PimService. Nothing here touches the host's Bluetooth stack: the two paired
 * phones, the address book and the calls are all simulated.
 *
 * Shapes come from `com/nfuzion/moduleLink/Bluetooth.as`, `BluetoothHFP.as`,
 * `PhoneBook.as`, `PhoneCallList.as` and `SMSMessaging.as`.
 *
 * Simulated events are exposed to the page as `airPhone`:
 *
 *     airPhone.incomingCall({ name: "Mom" })
 *     airPhone.incomingSms({ body: "Hi" })
 *     airPhone.remoteHangup()
 *
 * Ringtone playback and media ducking live in `lib/player.js` / `modules/media.js`;
 * this module only publishes the call state they react to.
 */

import { after, every } from "../lib/timer.js";

/** handlers.py:915 - the ringtone shipped with the reference emulator. */
const RINGTONE_URL = new URL(
    "../assets/incomingCallDefaultRingtone.wav",
    import.meta.url,
).href;

const SERVICE_KEY = { HFPGW: "hfp", A2DP_SOURCE: "a2dp" };

/** `ab` database fields (phone.py:82). */
const FAV_FIELDS = [
    "formattedName",
    "givenName",
    "familyName",
    "workNumber",
    "homeNumber",
    "mobileNumber",
    "otherNumber",
];

function nowMs() {
    return Date.now();
}

function toInt(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function digits(number) {
    return String(number ?? "").replace(/\D/g, "").slice(-10);
}

/** `time.strftime("%Y-%m-%d %H:%M:%S")` on a browser timestamp. */
function timestamp(value) {
    const date = new Date(value);
    const pad = (part) => String(part).padStart(2, "0");
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
}

/** Python's plain lowercase string order. */
function byName(a, b) {
    const left = a.formattedName.toLowerCase();
    const right = b.formattedName.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
}

function requested(args) {
    const list = args?.properties ?? args?.props ?? [];
    return Array.isArray(list) ? list : [];
}

/**
 * Registers the phone modules.
 *
 * @param {import("../index.js").HmiBackend} backend
 * @param {Record<string, any>} [seed] Parsed `backend/data/phones.json`.
 * @param {object} [options]
 * @param {(ms: number, callback: () => void) => unknown} [options.schedule]
 * @param {(ms: number, callback: () => void) => unknown} [options.repeat]
 * @param {() => number} [options.now]
 * @param {boolean} [options.startTimers] Tests start them explicitly.
 * @returns {object} Controller exposed to the page and tests.
 */
export function registerPhone(backend, seed = {}, options = {}) {
    const schedule = options.schedule ?? after;
    const repeat = options.repeat ?? every;
    const now = options.now ?? nowMs;

    const PHONES = structuredClone(seed.phones ?? []);
    for (const phone of PHONES) {
        phone.hfp = Boolean(phone.hfp);
        phone.a2dp = Boolean(phone.a2dp);
        phone.prio = toInt(phone.prio, 0);
    }

    const CONTACTS = structuredClone(seed.contacts ?? []);
    CONTACTS.sort(byName);
    CONTACTS.forEach((contact, index) => {
        contact.contactsId = toInt(contact.contactsId, index + 1);
        for (const field of FAV_FIELDS.slice(3)) {
            contact[field] ??= "";
        }
    });

    const FAVORITES = structuredClone(seed.favorites ?? []);
    for (const favorite of FAVORITES) {
        for (const field of FAV_FIELDS) {
            favorite[field] ??= "";
        }
    }
    let nextFavoriteId =
        Math.max(100, ...FAVORITES.map((item) => toInt(item.contactsId, 100))) + 1;

    const HISTORY = (seed.history ?? []).map((row) => ({
        type: row.type,
        number: String(row.number ?? ""),
        time: now() - toInt(row.minutesAgo, 0) * 60000,
    }));

    const SMS = (seed.sms ?? []).map((message, index) => ({
        uid_messageId: String(index + 1),
        smsName: String(message.name ?? ""),
        smsFrom: String(message.from ?? ""),
        smsBody: String(message.body ?? ""),
        localTimeStamp: "",
        smsReadStatus: Boolean(message.read),
        numberType: "mobileNumber",
        _t: now() - toInt(message.minutesAgo, 0) * 60000,
    }));

    const NAMES = { head: String(seed.headName ?? "Uconnect") };
    const HEAD_ADDRESS = String(seed.headAddress ?? "00:1E:AE:4C:91:07");
    const PIN = String(seed.pin ?? "1234");
    const CARRIER = structuredClone(seed.carrier ?? {});
    const SIGNAL = toInt(seed.signal, 18);
    const BATTERY = toInt(seed.battery, 4);

    /** @type {Map<number, Record<string, any>>} */
    const CALLS = new Map();
    const STATE = {
        nextCall: 1,
        hfMode: true,
        muted: false,
        lastDialed: String(seed.lastDialed ?? "3135550111"),
    };

    const timers = [];

    // ------------------------------------------------------------ data helpers
    function lookup(number) {
        const value = digits(number);
        if (!value) {
            return [null, ""];
        }

        for (const contact of CONTACTS) {
            for (const field of [
                "mobileNumber",
                "homeNumber",
                "workNumber",
                "otherNumber",
            ]) {
                if (digits(contact[field]) === value) {
                    return [contact, field];
                }
            }
        }

        return [null, ""];
    }

    function smsOut(message) {
        const { _t: sent, ...rest } = message;
        return { ...rest, localTimeStamp: timestamp(sent) };
    }

    function contactNames(number) {
        const [contact] = lookup(number);
        return contact
            ? { givenName: contact.givenName, lastName: contact.familyName }
            : { givenName: String(number ?? ""), lastName: "" };
    }

    // ------------------------------------------------------------ BluetoothGAP
    function device(phone) {
        return {
            address: phone.address,
            name: phone.name,
            serviceSearchList: [
                {
                    service: "HFPGW",
                    connected: Boolean(phone.hfp),
                    priority: phone.prio,
                },
                {
                    service: "A2DP_SOURCE",
                    connected: Boolean(phone.a2dp),
                    priority: phone.prio,
                },
            ],
        };
    }

    function gap(command, connection, extra = {}) {
        backend.send(
            "BluetoothGAP",
            {
                [command]: {
                    description: "success",
                    code: 0,
                    ...extra,
                },
            },
            connection,
        );
    }

    function phoneByAddress(address) {
        return PHONES.find((phone) => phone.address === address) ?? null;
    }

    function setService(phone, service, connected) {
        const key = SERVICE_KEY[service];
        if (!key || Boolean(phone[key]) === Boolean(connected)) {
            return;
        }

        phone[key] = Boolean(connected);
        if (connected) {
            backend.send("BluetoothGAP", {
                serviceConnected: { address: phone.address, service },
            });
        } else {
            backend.send("BluetoothGAP", {
                serviceDisconnected: {
                    address: phone.address,
                    service,
                    reason: "userRequest",
                },
            });
        }
    }

    /** handlers.py:232-237 (`_pim_sync`). */
    function pimSync(connection) {
        for (const objectType of ["Contacts", "CallStack", "SMS"]) {
            backend.send(
                "PimService",
                {
                    pimObjectSyncState: {
                        objectType,
                        syncStatus: "syncComplete",
                    },
                },
                connection,
            );
        }
    }

    backend.on("BluetoothGAP", "setBluetoothStatus", (dest, args, connection) => {
        gap("setBluetoothStatus", connection);
    });

    backend.on("BluetoothGAP", "getPairedDeviceList", (dest, args, connection) => {
        gap("getPairedDeviceList", connection, {
            pairedDeviceList: PHONES.map(device),
        });
        // The HMI has subscribed by the time it asks for the paired devices;
        // CallStack/SMS follow a moment later (phone.py:824-831).
        timers.push(schedule(2000, () => pimSync(connection)));
    });

    backend.on("BluetoothGAP", "getProperties", (dest, args, connection) => {
        const values = {
            passkey: { pin: PIN },
            localDeviceName: { localDeviceName: NAMES.head },
            bluetoothAddress: { address: HEAD_ADDRESS },
        };
        const out = {};
        for (const key of requested(args)) {
            if (Object.hasOwn(values, key)) {
                out[key] = values[key];
            }
        }
        backend.send("BluetoothGAP", { getProperties: out }, connection);
    });

    backend.on("BluetoothGAP", "startServiceConnect", (dest, args, connection) => {
        const phone = phoneByAddress(args.address);
        const service = String(args.service ?? "");
        if (!phone || !Object.hasOwn(SERVICE_KEY, service)) {
            gap("startServiceConnect", connection, { description: "failure" });
            return;
        }

        gap("startServiceConnect", connection);
        for (const other of PHONES) {
            if (other !== phone) {
                setService(other, service, false);
            }
        }
        setService(phone, service, true);
        if (service === "HFPGW") {
            timers.push(schedule(500, () => pimSync(connection)));
        }
    });

    backend.on(
        "BluetoothGAP",
        "startServiceDisconnect",
        (dest, args, connection) => {
            gap("startServiceDisconnect", connection);
            const phone = phoneByAddress(args.address);
            if (phone) {
                setService(phone, String(args.service ?? ""), false);
            }
        },
    );

    backend.on("BluetoothGAP", "setFavourite", (dest, args, connection) => {
        const phone = phoneByAddress(args.address);
        if (phone) {
            PHONES.sort((left, right) =>
                left === phone ? -1 : right === phone ? 1 : 0,
            );
            PHONES.forEach((item, index) => {
                item.prio = index + 1;
            });
        }
        gap("setFavourite", connection);
    });

    backend.on("BluetoothGAP", "startDeviceUnpairing", (dest, args, connection) => {
        const phone = phoneByAddress(args.address);
        if (phone) {
            for (const service of Object.keys(SERVICE_KEY)) {
                setService(phone, service, false);
            }
            PHONES.splice(PHONES.indexOf(phone), 1);
            PHONES.forEach((item, index) => {
                item.prio = index + 1;
            });
            backend.send("BluetoothGAP", {
                deviceUnpaired: { address: phone.address },
            });
        }
        gap("startDeviceUnpairing", connection);
    });

    backend.on("BluetoothGAP", "startDeviceSearch", (dest, args, connection) => {
        gap("startDeviceSearch", connection);
    });

    // ------------------------------------------------------------ PimService / SMS
    backend.on("PimService", "getProperties", (dest, args, connection) => {
        const values = {
            pimSupportedFeatures: [
                {
                    objectType: "SMS",
                    syncSupport: "yes",
                    sendSupport: "yes",
                },
            ],
            pimObjectSyncState: ["contacts", "callStack", "sms"].map(
                (objectType) => ({
                    objectType,
                    syncState: "syncComplete",
                }),
            ),
        };
        const out = {};
        for (const key of requested(args)) {
            if (Object.hasOwn(values, key)) {
                out[key] = values[key];
            }
        }
        backend.send("PimService", { getProperties: out }, connection);
    });

    function smsCount(command, connection, messages) {
        backend.send(
            "PimService",
            {
                [command]: {
                    smsCount: messages.length,
                    code: 0,
                    description: "success",
                },
            },
            connection,
        );
    }

    backend.on("PimService", "getSMSCount", (dest, args, connection) => {
        smsCount("getSMSCount", connection, SMS);
    });

    backend.on("PimService", "getUnreadSMSCount", (dest, args, connection) => {
        smsCount(
            "getUnreadSMSCount",
            connection,
            SMS.filter((message) => !message.smsReadStatus),
        );
    });

    function smsPage(command, messages, args, connection) {
        const start = Math.max(0, toInt(args.startSMSFrom, 0));
        const count = toInt(args.numSMS, 0) || messages.length;
        backend.send(
            "PimService",
            {
                [command]: {
                    smsList: messages
                        .slice(start, start + count)
                        .map(smsOut),
                    code: 0,
                },
            },
            connection,
        );
    }

    backend.on("PimService", "getSMSList", (dest, args, connection) => {
        smsPage("getSMSList", SMS, args, connection);
    });

    backend.on("PimService", "getUnreadSMSList", (dest, args, connection) => {
        smsPage(
            "getUnreadSMSList",
            SMS.filter((message) => !message.smsReadStatus),
            args,
            connection,
        );
    });

    backend.on("PimService", "getNewSMS", (dest, args, connection) => {
        const message = SMS.find(
            (item) => item.uid_messageId === String(args.UID ?? ""),
        );
        backend.send(
            "PimService",
            {
                getNewSMS: {
                    smsList: message ? [smsOut(message)] : [],
                    code: 0,
                },
            },
            connection,
        );
    });

    backend.on("PimService", "setSMSReadStatus", (dest, args, connection) => {
        for (const message of SMS) {
            if (message.uid_messageId === String(args.messageUID ?? "")) {
                message.smsReadStatus = true;
            }
        }
        backend.send(
            "PimService",
            {
                setSMSReadStatus: {
                    description: "success",
                    code: 0,
                },
            },
            connection,
        );
    });

    backend.on("PimService", "sendSms", (dest, args, connection) => {
        backend.send(
            "PimService",
            { sendSms: { description: "success", code: 0 } },
            connection,
        );
        timers.push(
            schedule(1000, () => {
                backend.send("PimService", {
                    sentMessageStatus: {
                        notificationType: "SENDING_SUCCESS",
                    },
                });
            }),
        );
    });

    /** phone.py:678-691 - a new SMS arrives from the paired phone. */
    function incomingSms({ name = "", number = "3135550142", body = "" } = {}) {
        let sender = String(name ?? "");
        if (!sender) {
            const [contact] = lookup(number);
            sender = contact ? contact.formattedName : "";
        }

        let uid = 1;
        for (const message of SMS) {
            uid = Math.max(uid, toInt(message.uid_messageId, 0) + 1);
        }

        const message = {
            uid_messageId: String(uid),
            smsName: sender,
            smsFrom: String(number ?? ""),
            smsBody: String(body ?? ""),
            localTimeStamp: "",
            smsReadStatus: false,
            numberType: "mobileNumber",
            _t: now(),
        };
        SMS.unshift(message);
        backend.send("PimService", { newSMS: { message: smsOut(message) } });
        return message;
    }

    // ------------------------------------------------------------ PhoneBook
    function matches(contact, text) {
        const query = String(text ?? "").toLowerCase();
        if (!query) {
            return true;
        }

        return (
            contact.formattedName
                .split(" ")
                .some((word) => word.toLowerCase().startsWith(query)) ||
            contact.formattedName.toLowerCase().startsWith(query)
        );
    }

    function phonebook(command, connection, extra = {}) {
        backend.send(
            "PhoneBook",
            {
                [command]: {
                    status: "success",
                    code: 0,
                    ...extra,
                },
            },
            connection,
        );
    }

    function emptyFavorite(favIndex, name, numbers = {}) {
        const favorite = { ...numbers, formattedName: name, givenName: name };
        for (const field of FAV_FIELDS) {
            favorite[field] ??= "";
        }
        favorite.favIndex = favIndex;
        return favorite;
    }

    backend.on("PhoneBook", "getItemsCount", (dest, args, connection) => {
        const database = String(args.database ?? "pb");
        const count =
            database === "ab"
                ? FAVORITES.length
                : CONTACTS.filter((contact) =>
                      matches(contact, args.filterCriteria),
                  ).length;
        phonebook("getItemsCount", connection, { count, database });
    });

    backend.on("PhoneBook", "getItems", (dest, args, connection) => {
        const database = String(args.database ?? "pb");
        if (database === "sms") {
            backend.send(
                "PhoneBook",
                { getItems: { status: "failure", database } },
                connection,
            );
            return;
        }

        const rows =
            database === "ab"
                ? [...FAVORITES].sort(
                      (left, right) =>
                          toInt(left.favIndex, 0) - toInt(right.favIndex, 0),
                  )
                : CONTACTS.filter((contact) =>
                      matches(contact, args.filterCriteria),
                  );
        const start = Math.max(0, toInt(args.startId, 0));
        const count = toInt(args.count, 0) || rows.length;
        phonebook("getItems", connection, {
            database,
            result: rows.slice(start, start + count),
        });
    });

    backend.on("PhoneBook", "getAlphaJumpTable", (dest, args, connection) => {
        const table = {};
        for (let index = 0; index < CONTACTS.length; index += 1) {
            const initial = CONTACTS[index].formattedName[0]?.toUpperCase() ?? "";
            if (initial && !Object.hasOwn(table, initial)) {
                table[initial] = index;
            }
        }
        phonebook("getAlphaJumpTable", connection, {
            result: {
                alphaTable: Object.entries(table).map(([letter, index]) => ({
                    [letter]: index,
                })),
            },
        });
    });

    backend.on("PhoneBook", "getNextValidCharacters", (dest, args, connection) => {
        const input = String(args.inputName ?? "");
        const hits = [];
        CONTACTS.forEach((contact, index) => {
            if (matches(contact, input)) {
                hits.push(index);
            }
        });

        const next = new Set();
        const prefix = input.toLowerCase();
        for (const contact of CONTACTS) {
            for (const word of [
                contact.formattedName,
                ...contact.formattedName.split(" "),
            ]) {
                if (
                    word.toLowerCase().startsWith(prefix) &&
                    word.length > input.length
                ) {
                    next.add(word[input.length].toLowerCase());
                }
            }
        }

        phonebook("getNextValidCharacters", connection, {
            result: {
                characterMask: [...next].sort().join(""),
                index: hits[0] ?? 0,
                count: hits.length,
            },
        });
    });

    backend.on("PhoneBook", "getNameByPhoneNum", (dest, args, connection) => {
        const [contact, kind] = lookup(args.phoneNumber);
        if (!contact) {
            phonebook("getNameByPhoneNum", connection, {
                status: "failure",
            });
            return;
        }
        phonebook("getNameByPhoneNum", connection, {
            result: [{ ...contact, numberType: kind }],
        });
    });

    backend.on("PhoneBook", "getPhoneNumByName", (dest, args, connection) => {
        const given = String(args.givenName ?? "").toLowerCase();
        const family = String(args.lastName ?? "").toLowerCase();
        const items = CONTACTS.filter(
            (contact) =>
                (!given || contact.givenName.toLowerCase() === given) &&
                (!family || contact.familyName.toLowerCase() === family),
        );
        phonebook("getPhoneNumByName", connection, { result: { items } });
    });

    backend.on("PhoneBook", "insertItems", (dest, args, connection) => {
        for (const item of args.insertList ?? []) {
            const favIndex = toInt(item.favIndex, 0);
            for (let index = FAVORITES.length - 1; index >= 0; index -= 1) {
                if (toInt(FAVORITES[index].favIndex, 0) === favIndex) {
                    FAVORITES.splice(index, 1);
                }
            }
            const favorite = emptyFavorite(
                favIndex,
                String(item.formattedName ?? ""),
            );
            for (const field of FAV_FIELDS) {
                favorite[field] = item[field] || "";
            }
            favorite.contactsId = nextFavoriteId;
            nextFavoriteId += 1;
            FAVORITES.push(favorite);
        }
        phonebook("insertItems", connection, { database: "ab" });
    });

    backend.on("PhoneBook", "updateItems", (dest, args, connection) => {
        for (const item of args.fieldsList ?? []) {
            const favIndex = toInt(item.favIndex, 0);
            let favorite = FAVORITES.find(
                (entry) => toInt(entry.favIndex, 0) === favIndex,
            );
            if (!favorite) {
                favorite = emptyFavorite(favIndex, "");
                favorite.contactsId = nextFavoriteId;
                nextFavoriteId += 1;
                FAVORITES.push(favorite);
            }
            for (const field of FAV_FIELDS) {
                if (item[field] !== undefined && item[field] !== null) {
                    favorite[field] = item[field];
                }
            }
        }
        phonebook("updateItems", connection, { database: "ab" });
    });

    backend.on("PhoneBook", "deleteItems", (dest, args, connection) => {
        const ids = new Set(
            String(args.deleteList ?? "")
                .split(",")
                .map((value) => value.trim())
                .filter((value) => /^\d+$/.test(value))
                .map(Number),
        );
        for (let index = FAVORITES.length - 1; index >= 0; index -= 1) {
            if (ids.has(toInt(FAVORITES[index].contactsId, -1))) {
                FAVORITES.splice(index, 1);
            }
        }
        phonebook("deleteItems", connection, { database: "ab" });
    });

    backend.on("PhoneBook", "refreshPhonebook", (dest, args, connection) => {
        phonebook("refreshPhonebook", connection);
        backend.send("PimService", {
            pimObjectSyncState: {
                objectType: "Contacts",
                syncStatus: "syncComplete",
            },
        });
    });

    // ------------------------------------------------------------ PhoneCallList
    function historyRows(kind) {
        const rows = HISTORY.filter(
            (row) => kind === null || row.type === kind,
        ).sort((left, right) => right.time - left.time);

        return rows.map((row) => {
            const [contact, numberType] = lookup(row.number);
            const names = contact
                ? {
                      givenName: contact.givenName,
                      lastName: contact.familyName,
                  }
                : { givenName: row.number, lastName: "" };
            return {
                givenName: names.givenName,
                lastName: names.lastName,
                telephoneNumber: row.number,
                StorageType: row.type,
                timeStamp: timestamp(row.time),
                numberType,
            };
        });
    }

    for (const [command, kind] of Object.entries({
        getAllCallsCount: null,
        getDialedCallsCount: "DC",
        getReceivedCallsCount: "RC",
        getMissedCallsCount: "MC",
    })) {
        backend.on("PhoneCallList", command, (dest, args, connection) => {
            backend.send(
                "PhoneCallList",
                { [command]: { callstackCount: historyRows(kind).length } },
                connection,
            );
        });
    }

    for (const [command, kind] of Object.entries({
        getAllCallLists: null,
        getDialedCallList: "DC",
        getReceivedCallList: "RC",
        getMissedCallList: "MC",
    })) {
        backend.on("PhoneCallList", command, (dest, args, connection) => {
            const start = Math.max(0, toInt(args.startCallstacksFrom, 0));
            const count = toInt(args.numCallstacks, 20);
            backend.send(
                "PhoneCallList",
                {
                    [command]: {
                        description: "success",
                        callstacksList: historyRows(kind).slice(
                            start,
                            start + count,
                        ),
                    },
                },
                connection,
            );
        });
    }

    /** phone.py:585-589 - keep a call in the recents and tell the HMI. */
    function logCall(kind, number) {
        if (!number) {
            return;
        }

        HISTORY.push({ type: kind, number, time: now() });
        backend.send("PimService", {
            newCallList: { storageType: kind, phoneNumber: number },
        });
    }

    // ------------------------------------------------------------ BluetoothHFP
    function hfp(command, connection, extra = {}) {
        backend.send(
            "BluetoothHFP",
            {
                [command]: {
                    description: "success",
                    code: 0,
                    ...extra,
                },
            },
            connection,
        );
    }

    function callInfo(call) {
        return {
            callId: call.callId,
            callState: call.callState,
            number: call.number,
            name: call.name,
            numberType: call.numberType,
            audio: call.audio,
            duration: Math.trunc((now() - call.start) / 1000),
        };
    }

    /** phone.py:599-605 - store only live calls, but send every row. */
    function publishCalls(extra = []) {
        const info = [...CALLS.values()].map(callInfo).concat(extra);
        backend.moduleStore("BluetoothHFP").callState = {
            callStateInfo: info.filter((call) => call.callState !== "idle"),
        };
        backend.send("BluetoothHFP", { callState: { callStateInfo: info } });
    }

    function firstCall(...states) {
        for (const call of CALLS.values()) {
            if (states.includes(call.callState)) {
                return call.callId;
            }
        }
        return null;
    }

    function hfpConnected() {
        return PHONES.some((phone) => phone.hfp);
    }

    function setState(callId, state) {
        const call = CALLS.get(callId);
        if (!call) {
            return;
        }

        if (state === "idle") {
            CALLS.delete(callId);
            if (call.incoming) {
                logCall(call.answered ? "RC" : "MC", call.number);
            } else {
                logCall("DC", call.number);
            }
            publishCalls([{ ...callInfo(call), callState: "idle" }]);
            return;
        }

        if (state === "active" && call.callState !== "onhold") {
            call.start = now();
        }
        call.callState = state;
        if (state === "active") {
            call.answered = true;
        }
        publishCalls();
    }

    function newCall(number, name, numberType, state, incoming) {
        let displayName = String(name ?? "");
        let kind = String(numberType ?? "");
        if (!displayName) {
            const [contact, matched] = lookup(number);
            if (contact) {
                displayName = contact.formattedName;
                kind = kind || matched;
            }
        }

        const callId = STATE.nextCall;
        STATE.nextCall += 1;
        CALLS.set(callId, {
            callId,
            callState: state,
            number: String(number ?? ""),
            name: displayName,
            numberType: kind,
            audio: STATE.hfMode,
            start: now(),
            incoming,
            answered: false,
        });
        publishCalls();
        return callId;
    }

    function dial(number, name = "", numberType = "") {
        if (!hfpConnected()) {
            return null;
        }

        for (const call of CALLS.values()) {
            if (call.callState === "active") {
                call.callState = "onhold";
            }
        }
        STATE.lastDialed = String(number ?? "");
        const callId = newCall(number, name, numberType, "dialing", false);
        timers.push(
            schedule(1000, () => {
                const call = CALLS.get(callId);
                if (call?.callState === "dialing") {
                    setState(callId, "alerting");
                }
            }),
        );
        timers.push(
            schedule(3000, () => {
                const call = CALLS.get(callId);
                if (call?.callState === "alerting") {
                    setState(callId, "active");
                }
            }),
        );
        return callId;
    }

    /** phone.py:610-616 - the far phone rings the head unit. */
    function incomingCall({ name = "", number = "3135550142" } = {}) {
        if (!hfpConnected()) {
            return null;
        }

        const state = [...CALLS.values()].some((call) =>
            ["active", "onhold"].includes(call.callState),
        )
            ? "waiting"
            : "ringing";
        return newCall(number, name, "", state, true);
    }

    /** phone.py:756-761 - the far end hangs up or stops ringing. */
    function remoteHangup() {
        const callId = firstCall(
            "active",
            "dialing",
            "alerting",
            "ringing",
            "waiting",
        );
        if (callId !== null) {
            setState(callId, "idle");
        }
    }

    backend.on("BluetoothHFP", "dial", (dest, args, connection) => {
        const callId = dial(
            String(args.number ?? ""),
            String(args.name ?? ""),
            String(args.numberType ?? ""),
        );
        if (callId === null) {
            hfp("dial", connection, {
                description: "failure",
                reason: "phone not connected",
            });
            return;
        }
        hfp("dial", connection, { callId });
    });

    backend.on("BluetoothHFP", "reDial", (dest, args, connection) => {
        const callId = dial(STATE.lastDialed);
        hfp("reDial", connection, { callId: callId ?? 0 });
    });

    backend.on("BluetoothHFP", "acceptIncomingCall", (dest, args, connection) => {
        const callId = firstCall("ringing", "waiting");
        hfp("acceptIncomingCall", connection);
        if (callId === null) {
            return;
        }

        for (const call of CALLS.values()) {
            if (call.callState === "active") {
                call.callState = "onhold";
            }
        }
        if (args.answerAndTransfer === true || args.answerAndTransfer === "true") {
            CALLS.get(callId).audio = false;
        }
        setState(callId, "active");
    });

    backend.on("BluetoothHFP", "rejectIncomingCall", (dest, args, connection) => {
        const callId = firstCall("ringing", "waiting");
        hfp("rejectIncomingCall", connection);
        if (callId !== null) {
            setState(callId, "idle");
        }
    });

    backend.on("BluetoothHFP", "endCall", (dest, args, connection) => {
        hfp("endCall", connection);
        setState(toInt(args.callId, 0), "idle");
    });

    backend.on("BluetoothHFP", "endActiveCall", (dest, args, connection) => {
        const callId =
            firstCall("active", "dialing", "alerting") ?? firstCall("onhold");
        hfp("endActiveCall", connection);
        if (callId !== null) {
            setState(callId, "idle");
            const held = firstCall("onhold");
            if (held !== null && firstCall("active") === null) {
                setState(held, "active");
            }
        }
    });

    backend.on("BluetoothHFP", "endAllCalls", (dest, args, connection) => {
        hfp("endAllCalls", connection);
        for (const callId of [...CALLS.keys()]) {
            setState(callId, "idle");
        }
    });

    backend.on("BluetoothHFP", "holdActiveCall", (dest, args, connection) => {
        hfp("holdActiveCall", connection);
        for (const call of CALLS.values()) {
            if (call.callState === "active") {
                call.callState = "onhold";
            }
        }
        publishCalls();
    });

    backend.on("BluetoothHFP", "resumeHeldCall", (dest, args, connection) => {
        hfp("resumeHeldCall", connection);
        for (const call of CALLS.values()) {
            if (call.callState === "onhold") {
                call.callState = "active";
            }
        }
        publishCalls();
    });

    backend.on("BluetoothHFP", "swapCalls", (dest, args, connection) => {
        hfp("swapCalls", connection);
        for (const call of CALLS.values()) {
            if (call.callState === "active") {
                call.callState = "onhold";
            } else if (
                call.callState === "onhold" ||
                call.callState === "waiting"
            ) {
                call.callState = "active";
            }
            call.answered =
                call.answered || call.callState === "active";
        }
        publishCalls();
    });

    backend.on("BluetoothHFP", "conferenceCall", (dest, args, connection) => {
        hfp("conferenceCall", connection);
        for (const call of CALLS.values()) {
            if (call.callState === "onhold") {
                call.callState = "active";
            }
        }
        publishCalls();
    });

    backend.on("BluetoothHFP", "setHfMode", (dest, args, connection) => {
        const onCar = args.hfMode === true || args.hfMode === "true";
        STATE.hfMode = onCar;
        hfp("setHfMode", connection);
        for (const call of CALLS.values()) {
            call.audio = onCar;
        }
        backend.moduleStore("BluetoothHFP").handsFreeMode = { hfMode: onCar };
        backend.send("BluetoothHFP", { handsFreeMode: { hfMode: onCar } });
        publishCalls();
    });

    backend.on("BluetoothHFP", "setMuteState", (dest, args, connection) => {
        STATE.muted = ["mute", "on", "true", true].includes(args.muteState);
        hfp("setMuteState", connection);
    });

    backend.on("BluetoothHFP", "getMuteState", (dest, args, connection) => {
        hfp("getMuteState", connection, { muteState: STATE.muted });
    });

    // Phone screen "Mute" button (AudioSettings.as MuteValue).
    backend.on("AudioSettings", "setSHFMicMute", (dest, args, connection) => {
        const mute = args.mute === true || args.mute === "true";
        backend.moduleStore("AudioSettings").MuteValue = { mutevalue: mute };
        backend.send("AudioSettings", { MuteValue: { mutevalue: mute } });
    });

    backend.on("BluetoothHFP", "sendDtmfTone", (dest, args, connection) => {
        hfp("sendDtmfTone", connection);
    });

    backend.on("BluetoothHFP", "setDNDStatus", (dest, args, connection) => {
        hfp("setDNDStatus", connection);
    });

    backend.on("BluetoothHFP", "getProperties", (dest, args, connection) => {
        const values = {
            signalQuality: { signalQuality: SIGNAL },
            batteryCharge: { batteryCharge: BATTERY },
            networkRegistrationState: { state: "PHONE_REGSTATE_HOME" },
            networkOperatorChanged: CARRIER,
            handsFreeMode: { hfMode: STATE.hfMode },
            audioStatus: { audioStatus: CALLS.size > 0 },
            subscriberNumber: {
                number: String(seed.subscriberNumber ?? "3135550100"),
            },
            siriStatus: { enabled: false, available: false },
        };
        const out = {};
        for (const key of requested(args)) {
            if (Object.hasOwn(values, key)) {
                out[key] = values[key];
            }
        }
        backend.send("BluetoothHFP", { getProperties: out }, connection);
    });

    // ------------------------------------------------------------ boot state
    const hfpStore = backend.moduleStore("BluetoothHFP");
    Object.assign(hfpStore, {
        signalQuality: { rssi: SIGNAL },
        batteryCharge: { level: BATTERY },
        networkRegistrationState: { state: "PHONE_REGSTATE_HOME" },
        networkOperatorChanged: CARRIER,
        handsFreeMode: { hfMode: true },
        callState: { callStateInfo: [] },
        supportedFeaturesList: {
            features:
                "PHONE_FEATURE_SWAP,PHONE_FEATURE_CONFERENCE," +
                "PHONE_FEATURE_REJECT,PHONE_FEATURE_VR",
        },
    });
    backend.moduleStore("BluetoothGAP").bluetoothStatus = { status: true };
    backend.moduleStore("PimService").pimObjectSyncState = {
        objectType: "Contacts",
        syncStatus: "syncComplete",
    };

    const replies = (backend.state._replies ??= {});
    const gapReplies = (replies.BluetoothGAP ??= {});
    for (const command of [
        "setAccessMode",
        "stopDeviceSearch",
        "setPin",
        "startAutoConnect",
        "pauseAutoConnect",
        "startDevicePairing",
        "standardPairingReply",
        "securePairingReply",
        "serviceConnectReply",
        "sendDtmfTone",
        "switchBluetoothOff",
        "setBTChipMode",
        "getBTChipBTID",
    ]) {
        gapReplies[command] ??= { description: "success", code: 0 };
    }
    const hfpReplies = (replies.BluetoothHFP ??= {});
    for (const command of ["setVRMode", "startAutoConnect", "setProperties"]) {
        hfpReplies[command] ??= { description: "success", code: 0 };
    }

    /** The 1 s call timer (`phone.py:787-793`). */
    function tick() {
        if (
            [...CALLS.values()].some((call) =>
                ["active", "onhold"].includes(call.callState),
            )
        ) {
            publishCalls();
        }
    }

    function stop() {
        for (const timer of timers) {
            clearTimeout(timer);
            clearInterval(timer);
        }
    }

    if (typeof window !== "undefined" || options.startTimers === true) {
        timers.push(repeat(1000, tick));
    }

    return {
        incomingCall,
        incomingSms,
        remoteHangup,
        dial,
        answer: () => {
            const callId = firstCall("ringing", "waiting");
            if (callId === null) {
                return null;
            }
            setState(callId, "active");
            return callId;
        },
        hangup: remoteHangup,
        sync: pimSync,
        tick,
        stop,
        ringtone: RINGTONE_URL,
        get calls() {
            return [...CALLS.values()].map(callInfo);
        },
        get contacts() {
            return CONTACTS;
        },
        get favorites() {
            return FAVORITES;
        },
        get history() {
            return HISTORY;
        },
        get sms() {
            return SMS;
        },
        get phones() {
            return PHONES;
        },
    };
}
