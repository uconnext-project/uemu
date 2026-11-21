/**
 * A browser-side implementation of the HMI ("ModuleLink") protocol.
 *
 * This is the JavaScript equivalent of the generic parts of the reference
 * backend: NUL-framed JSON messages, subscriptions, generic property
 * get/set handling and a read/write persistency store. It deliberately does
 * not contain any real module behaviour - those are added by registering
 * handlers, which keeps the protocol plumbing separate from the emulation.
 *
 * Example:
 *
 *     import { createBackend } from "./backend/index.js";
 *
 *     const backend = createBackend();
 *
 *     backend.on("Audio", "getAudioSource", (dest, args, connection) => {
 *         backend.send(dest, { getAudioSource: { source: "fm" } }, connection);
 *     });
 *
 *     const provider = backend.localSocketProvider;
 *     player.load({ url: "/hmi/main.xml", localSocketProvider: provider });
 *
 * The `connection` argument passed to handlers is a {@link HmiConnection}; use
 * `reply()`/`send()` on the backend for replies, or `connection.send()` to
 * target only that client.
 */

import { FrameReader, encodeFrame, formatFrame, parseFrame } from "./protocol.js";

/** Modules whose change signals wrap the value in its own name. */
export const DEFAULT_NESTED_MODULES = Object.freeze(["PersonalConfig", "Clock"]);

/** Keys in the state object that are configuration, not module state. */
const RESERVED_KEYS = new Set(["_replies", "_props", "_persist", "_unavailable"]);

const noop = () => {};

/**
 * A single client connected to the emulated backend.
 *
 * Ruffle gives the backend a channel for delivering bytes to the movie and
 * expects a handle with `write()`/`close()` in return. `HmiConnection` is the
 * glue between those two directions.
 */
export class HmiConnection {
    /**
     * @param {HmiBackend} backend
     * @param {string} host
     * @param {number} port
     * @param {{send(data: Uint8Array): void, close(): void}} channel
     */
    constructor(backend, host, port, channel) {
        this.backend = backend;
        this.host = host;
        this.port = port;
        this.channel = channel;
        /** @type {FrameReader} */
        this.reader = new FrameReader();
        /** @type {Set<string>} `module\0signal` pairs requested by this client. */
        this.subscriptions = new Set();
        this.open = true;

        // This is the object Ruffle's socket layer talks to.
        this.handle = {
            write: (data) => this.receive(data),
            close: () => this.dispose(),
        };
    }

    /** @returns {boolean} Whether the connection is still usable. */
    get connected() {
        return this.open;
    }

    /**
     * Feeds bytes from the movie into the backend.
     *
     * @param {Uint8Array} data
     */
    receive(data) {
        if (!this.open) {
            return;
        }

        const bytes =
            data instanceof Uint8Array ? data : new Uint8Array(data);
        for (const raw of this.reader.push(bytes)) {
            const text = raw.trim();
            if (text.length === 0) {
                continue;
            }

            this.backend.log("<<", text);

            let message;
            try {
                message = parseFrame(text);
            } catch (error) {
                this.backend.log("!!", `invalid frame: ${error.message}`);
                continue;
            }

            try {
                this.backend.handle(message, this);
            } catch (error) {
                this.backend.log(
                    "!!",
                    `${error && error.stack ? error.stack : error}`,
                );
            }
        }
    }

    /**
     * Sends a signal or reply to the movie.
     *
     * @param {string} module
     * @param {unknown} payload
     */
    send(module, payload) {
        if (!this.open) {
            return;
        }

        this.backend.log(">>", formatFrame(module, payload));
        this.channel.send(encodeFrame(module, payload));
    }

    /**
     * Called by Ruffle when the movie closed the socket. The JS side is
     * already gone, so this only cleans up local state.
     */
    dispose() {
        if (!this.open) {
            return;
        }

        this.open = false;
        this.backend.connections.delete(this);
    }

    /**
     * Closes the connection from the backend side, notifying the movie.
     */
    close() {
        if (!this.open) {
            return;
        }

        this.dispose();
        this.channel.close();
    }
}

/**
 * Emulated HMI backend: protocol state machine plus a handler registry.
 */
export class HmiBackend {
    /**
     * @param {object} [options]
     * @param {Record<string, any>} [options.state] Initial module state, in the
     *   same shape as the reference `state.json` (`_replies`, `_props`, ...).
     * @param {Record<string, Record<string, any>>} [options.persistency]
     *   Initial read/write store.
     * @param {string[]} [options.nestedModules] Modules that wrap change
     *   signals in `{key: value}`.
     * @param {string[]} [options.unavailable] Modules that should not answer
     *   `subscribeNameHasOwnerNotification`.
     * @param {(direction: string, text: string) => void} [options.log]
     *   Receives every frame (`<<` from the movie, `>>` to the movie, `??` for
     *   protocol warnings).
     * @param {(persistency: Record<string, any>) => void} [options.onPersistencyChange]
     *   Called after a successful `write` request.
     */
    constructor(options = {}) {
        /** @type {Record<string, any>} */
        this.state = options.state ?? {};
        /** @type {Record<string, Record<string, any>>} */
        this.persistency = options.persistency ?? {};
        this.nestedModules = new Set(
            options.nestedModules ?? DEFAULT_NESTED_MODULES,
        );
        this.unavailable = new Set(
            options.unavailable ?? this.state._unavailable ?? [],
        );
        this.log = options.log ?? noop;
        this.onPersistencyChange = options.onPersistencyChange ?? noop;

        /** @type {Map<string, Function>} `module\0command` -> handler */
        this.hooks = new Map();
        /** @type {Map<string, Function[]>} `module\0command` -> extra handlers */
        this.extraHooks = new Map();
        /** @type {Function[]} */
        this.emitSignalHandlers = [];
        /** @type {Set<HmiConnection>} */
        this.connections = new Set();
    }

    /**
     * The function to pass to Ruffle as `localSocketProvider`.
     *
     * @type {(host: string, port: number, channel: {send(data: Uint8Array): void, close(): void}) => {write(data: Uint8Array): void, close(): void}}
     */
    get localSocketProvider() {
        return (host, port, channel) => this.connect(host, port, channel);
    }

    /**
     * Creates a connection and returns the handle Ruffle expects.
     *
     * @param {string} host
     * @param {number} port
     * @param {{send(data: Uint8Array): void, close(): void}} channel
     * @returns {{write(data: Uint8Array): void, close(): void}}
     */
    connect(host, port, channel) {
        const connection = new HmiConnection(this, host, port, channel);
        this.connections.add(connection);
        this.log("++", `connection from ${host}:${port}`);
        return connection.handle;
    }

    /**
     * Registers a command handler.
     *
     * Mirrors the reference `@on(module, command)` decorator:
     *
     *     backend.on("Audio", "getAudioSource", (dest, args, connection) => {...});
     *     backend.on("*", "ping", (dest, args, connection) => {...});   // wildcard
     *
     * The handler may also be returned as a decorator:
     *
     *     const handler = backend.on("Audio", "getAudioSource");
     *     handler((dest, args, connection) => {...});
     *
     * @param {string} module Module name, or `"*"` for all modules.
     * @param {string} command Command name.
     * @param {Function} [handler] `(dest, args, connection)`.
     * @returns {Function} The registered handler, or a decorator when
     *   `handler` was omitted.
     */
    on(module, command, handler) {
        const key = `${module}\u0000${command}`;
        const register = (fn) => {
            this.hooks.set(key, fn);
            return fn;
        };

        return handler === undefined ? register : register(handler);
    }

    /**
     * Registers an additional handler without replacing an existing one.
     * Useful when several independent modules want to observe a command.
     *
     * @param {string} module
     * @param {string} command
     * @param {Function} handler
     * @returns {Function} The handler.
     */
    alsoOn(module, command, handler) {
        const key = `${module}\u0000${command}`;
        const handlers = this.extraHooks.get(key) ?? [];
        handlers.push(handler);
        this.extraHooks.set(key, handlers);
        return handler;
    }

    /**
     * Registers a handler for `{"Type":"EmitSignal"}` messages.
     *
     * @param {(packet: object, connection: HmiConnection) => void} handler
     * @returns {Function} The handler.
     */
    onEmitSignal(handler) {
        this.emitSignalHandlers.push(handler);
        return handler;
    }

    /**
     * Convenience helper for declaring a module in one place.
     *
     * @param {string} name
     * @param {object} [definition]
     * @param {Record<string, any>} [definition.state] Initial signal values.
     * @param {Record<string, any>} [definition.properties] Initial
     *   `get(All)Properties` values (defaults to `state`).
     * @param {boolean} [definition.nested] Wrap change signals in `{key: value}`.
     * @param {Record<string, Function>} [definition.handlers] Command handlers.
     * @returns {this}
     */
    defineModule(name, definition = {}) {
        if (definition.state) {
            Object.assign(this.moduleStore(name), definition.state);
        }
        if (definition.properties) {
            Object.assign(this.propStore(name), definition.properties);
        }
        if (definition.nested) {
            this.nestedModules.add(name);
        }
        for (const [command, handler] of Object.entries(
            definition.handlers ?? {},
        )) {
            this.on(name, command, handler);
        }

        return this;
    }

    /**
     * Returns the module's change-signal store, creating it when needed.
     *
     * @param {string} module
     * @returns {Record<string, any>}
     */
    moduleStore(module) {
        const store = this.state[module];
        if (store && typeof store === "object") {
            return store;
        }

        return (this.state[module] = {});
    }

    /**
     * Values returned by `getProperties`/`getAllProperties`. A module's
     * `_props` entry overrides its signal store when present.
     *
     * @param {string} module
     * @returns {Record<string, any>}
     */
    propsOf(module) {
        return this.state._props?.[module] ?? this.moduleStore(module);
    }

    /**
     * The writable property store for a module.
     *
     * @param {string} module
     * @returns {Record<string, any>}
     */
    propStore(module) {
        this.state._props ??= {};
        return (this.state._props[module] ??= {});
    }

    /**
     * Stores a property and emits its change signal in the module's style.
     *
     * @param {string} module
     * @param {string} key
     * @param {unknown} value
     * @param {HmiConnection} [connection] Target only this client.
     */
    setProperty(module, key, value, connection) {
        this.propStore(module)[key] = value;

        const signal = this.nestedModules.has(module)
            ? { [key]: value }
            : value;
        this.moduleStore(module)[key] = signal;
        this.send(module, { [key]: signal }, connection);
    }

    /**
     * Emits a module's current value for a signal.
     *
     * @param {string} module
     * @param {string} signal
     * @param {HmiConnection} [connection] Target only this client.
     * @returns {boolean} Whether the signal was known.
     */
    emit(module, signal, connection) {
        const store = this.moduleStore(module);
        if (!Object.hasOwn(store, signal)) {
            return false;
        }

        this.send(module, { [signal]: store[signal] }, connection);
        return true;
    }

    /**
     * Sends a signal to every client subscribed to it.
     *
     * @param {string} module
     * @param {string} signal
     * @param {unknown} [value] Defaults to the value in the module store.
     */
    broadcast(module, signal, value) {
        const store = this.moduleStore(module);
        if (arguments.length >= 3) {
            store[signal] = value;
        } else if (!Object.hasOwn(store, signal)) {
            return;
        }

        const payload = store[signal];
        const key = `${module}\u0000${signal}`;
        for (const connection of this.connections) {
            if (connection.subscriptions.has(key)) {
                connection.send(module, { [signal]: payload });
            }
        }
    }

    /**
     * Updates several signal values without the property-store bookkeeping.
     *
     * @param {string} module
     * @param {Record<string, any>} values
     * @param {HmiConnection} [connection]
     */
    setSignals(module, values, connection) {
        for (const [key, value] of Object.entries(values)) {
            this.moduleStore(module)[key] = value;
            this.send(module, { [key]: value }, connection);
        }
    }

    /**
     * Sends a payload to the given client, or to every client when omitted.
     *
     * @param {string} module
     * @param {unknown} payload
     * @param {HmiConnection} [connection]
     */
    send(module, payload, connection) {
        if (connection) {
            connection.send(module, payload);
            return;
        }

        for (const client of this.connections) {
            client.send(module, payload);
        }
    }

    /**
     * Handles a decoded message from a client.
     *
     * @param {object} message
     * @param {HmiConnection} connection
     */
    handle(message, connection) {
        const type = message?.Type;
        const dest = message?.Dest ?? "";

        switch (type) {
            case "subscribeNameHasOwnerNotification":
                if (!this.unavailable.has(dest)) {
                    this.send(
                        dest,
                        { dBusServiceAvailable: "true" },
                        connection,
                    );
                }
                break;

            case "Subscribe": {
                const signals = message.Signals ?? [message.Signal];
                for (const signal of signals) {
                    if (typeof signal !== "string" || signal.length === 0) {
                        continue;
                    }
                    connection.subscriptions.add(`${dest}\u0000${signal}`);
                    this.emit(dest, signal, connection);
                }
                break;
            }

            case "Unsubscribe":
                for (const signal of message.Signals ?? [message.Signal]) {
                    if (typeof signal === "string") {
                        connection.subscriptions.delete(`${dest}\u0000${signal}`);
                    }
                }
                break;

            case "EmitSignal": {
                const packet = message.packet ?? {};
                for (const handler of this.emitSignalHandlers) {
                    handler(packet, connection);
                }
                break;
            }

            case "Command":
                this.handleCommand(dest, message.packet ?? {}, connection);
                break;

            default:
                this.log("??", `unknown type ${type} ${dest}`);
                break;
        }
    }

    /**
     * Applies the generic command rules, in the same order as the reference
     * backend: exact hook, wildcard hook, canned reply, property commands,
     * generic setters, then "unhandled".
     *
     * @param {string} dest
     * @param {Record<string, any>} packet
     * @param {HmiConnection} connection
     */
    handleCommand(dest, packet, connection) {
        const commands = Object.entries(packet);
        if (commands.length === 0) {
            return;
        }

        const [firstCommand] = commands[0];
        if (
            ("read" in packet || "write" in packet) &&
            !this.hasHook(dest, firstCommand)
        ) {
            this.handlePersistency(dest, packet, connection);
            return;
        }

        const replies = this.state._replies?.[dest] ?? {};

        for (const [command, rawArgs] of commands) {
            const args =
                rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
                    ? rawArgs
                    : { value: rawArgs };
            const hook =
                this.hooks.get(`${dest}\u0000${command}`) ??
                this.hooks.get(`*\u0000${command}`);

            if (hook) {
                hook(dest, args, connection);
                for (const extra of this.extraHooks.get(
                    `${dest}\u0000${command}`,
                ) ?? []) {
                    extra(dest, args, connection);
                }
                for (const extra of this.extraHooks.get(
                    `*\u0000${command}`,
                ) ?? []) {
                    extra(dest, args, connection);
                }
            } else if (Object.hasOwn(replies, command)) {
                this.send(dest, { [command]: replies[command] }, connection);
            } else if (command === "getProperties") {
                const source = this.propsOf(dest);
                const requested = Array.isArray(args.props) ? args.props : [];
                const props = {};
                for (const key of requested) {
                    if (typeof key === "string" && Object.hasOwn(source, key)) {
                        props[key] = source[key];
                    }
                }
                this.send(dest, { getProperties: props }, connection);
            } else if (command === "getAllProperties") {
                this.send(
                    dest,
                    { getAllProperties: this.propsOf(dest) },
                    connection,
                );
            } else if (command === "setProperties") {
                const props =
                    args.props &&
                    typeof args.props === "object" &&
                    !Array.isArray(args.props)
                        ? args.props
                        : args;
                for (const [key, value] of Object.entries(props)) {
                    this.setProperty(dest, key, value, connection);
                }
            } else if (command.startsWith("set") && Object.keys(args).length > 0) {
                // Generic setter: setFoo {"foo": value} -> state + echo.
                this.setSignals(dest, args, connection);
            } else {
                this.log(
                    "??",
                    `unhandled ${dest}.${command} ${JSON.stringify(args).slice(0, 200)}`,
                );
            }
        }
    }

    /**
     * The shared read/write key-value store (`Persistency`, `*Persistency`,
     * `*PersistenceManager`).
     *
     * @param {string} dest
     * @param {Record<string, any>} packet
     * @param {HmiConnection} connection
     */
    handlePersistency(dest, packet, connection) {
        this.persistency[dest] ??= {};
        const store = this.persistency[dest];

        if ("read" in packet) {
            const key = packet.read?.key;
            if (Object.hasOwn(store, key)) {
                this.send(
                    dest,
                    { read: { res: { key, value: store[key] } } },
                    connection,
                );
            } else {
                this.send(dest, { read: { key, err: "notFound" } }, connection);
            }
            return;
        }

        if ("write" in packet) {
            for (const [key, item] of Object.entries(packet.write ?? {})) {
                store[key] =
                    item && typeof item === "object"
                        ? item.value
                        : item;
            }
            this.onPersistencyChange(this.persistency);
            this.send(dest, { write: { res: "success" } }, connection);
        }
    }

    /**
     * @param {string} module
     * @param {string} command
     * @returns {boolean}
     */
    hasHook(module, command) {
        return this.hooks.has(`${module}\u0000${command}`);
    }

    /** Closes every connection and notifies the movie. */
    closeAll() {
        for (const connection of [...this.connections]) {
            connection.close();
        }
    }

    /**
     * Returns a serialisable snapshot of the emulated state.
     *
     * @returns {{state: Record<string, any>, persistency: Record<string, any>}}
     */
    snapshot() {
        return {
            state: structuredClone(this.state),
            persistency: structuredClone(this.persistency),
        };
    }
}

/** Reserved state keys, exported mostly for tests and tooling. */
export { RESERVED_KEYS };
