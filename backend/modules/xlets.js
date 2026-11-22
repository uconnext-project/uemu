/**
 * Real Uconnect xlets (the Java applications from the KIM1 package).
 *
 * The stock HMI only switches its AMS layer on; the application itself is a
 * Java xlet. In the browser the xlet runs in an iframe (`xlets/index.html` with
 * CheerpJ) that is placed *under* the Ruffle canvas, so the transparent HMI
 * window keeps its own chrome and close button above the xlet.
 *
 * This module answers the HMI's `AppManager` protocol and drives that iframe:
 *
 *     getAppManagerStatus  -> {"status": "Ready"}
 *     getXletsDir          -> {"xletsDir": ""}   (HMI appends "/xlets")
 *     getAppList           -> the KIM1 GUI apps, current car's Performance Pages last
 *     startApp             -> open the iframe, then appStarted/setAppVisible/operStatus
 *     pauseApp/resumeApp   -> hide/show the iframe without destroying its JVM
 *     stopApp              -> destroy the iframe and report "stopped"
 *     DisplayManager.requestDisplay("ams", ...) -> show/hide the layer
 *
 * Reference: `exycalEmu/emulator/modules/xlets.py` (AppManager section).
 */

/** `AppManager.as:45-49`. */
const ALL_APPS = -2;
const FAVORITE_APPS = -1;
const RUNNING_APPS = -3;

/** `xlets.py:48-54`: the Performance Pages build for each vehicle line. */
const PERF_BY_LINE = Object.freeze({
    LA: "7DEC7834-535D-47B5-BD33-695477EDCD57",
    LD: "7DEC7834-535D-47B5-BD33-695477EDCD57",
    LX: "7DEC7834-535D-47B5-BD33-695477EDCD57",
    WK: "6BFD02C0-40C3-11E2-A25F-0800200C9A66",
    ZD: "52c79381-6719-11e1-b86c-0800200c9a66",
});

function lower(value) {
    return String(value ?? "").trim().toLowerCase();
}

/**
 * @typedef {object} XletOverlay
 * @property {(app: any, variant: any) => void} open Show the iframe (reloads
 *   when the app/variant changes).
 * @property {() => void} show Re-show a paused iframe.
 * @property {() => void} hide Hide the iframe, keeping the Java VM alive.
 * @property {() => void} close Unload the iframe.
 */

/**
 * @param {import("../index.js").HmiBackend} backend
 * @param {Record<string, any>} catalog Parsed `xlets/catalog.json`.
 * @param {{overlay?: XletOverlay|null, vehicle?: any}} [options]
 */
export function registerXlets(backend, catalog, options = {}) {
    const apps = Array.isArray(catalog?.apps) ? catalog.apps : [];
    const across = new Map(apps.map((app) => [lower(app.id), app]));
    const overlay = options.overlay ?? null;
    const vehicle = options.vehicle ?? null;

    /** @type {{app: any|null, status: string, visible: boolean}} */
    const state = { app: null, status: "stopped", visible: false };

    function vehicleProfile() {
        try {
            return vehicle?.current?.() ?? {};
        } catch {
            return {};
        }
    }

    /**
     * `xlets.py:299-311`. `AppManager.mPPId` is overwritten for every app whose
     * name contains "Performance", so the selected car's build must come last:
     * its Perform button then launches the right xlet.
     */
    function orderedApps() {
        const list = apps.slice();
        const profile = vehicleProfile();
        if (!profile.perfPages) {
            return list;
        }
        const perfId = PERF_BY_LINE[profile.line];
        if (!perfId) {
            return list;
        }
        const index = list.findIndex((app) => lower(app.id) === lower(perfId));
        if (index >= 0) {
            list.push(list.splice(index, 1)[0]);
        }
        return list;
    }

    function findApp(appId) {
        return across.get(lower(appId)) ?? null;
    }

    function findAppByName(name) {
        const wanted = lower(name);
        if (!wanted) {
            return null;
        }
        return (
            apps.find(
                (app) =>
                    lower(app.id) === wanted ||
                    lower(app.name) === wanted ||
                    lower(app.rawName) === wanted,
            ) ?? null
        );
    }

    function defaultVariant(app) {
        if (!app?.variants?.length) {
            return null;
        }
        return (
            app.variants.find(
                (variant) => variant.key === app.defaultVariant,
            ) ?? app.variants[0]
        );
    }

    /** `xlets.py:951-957`. */
    function appEntry(app) {
        return {
            "xlet.name": app.rawName || app.name,
            "xlet.appId": app.id,
            isFavorite: false,
            isEmbeddedApp: false,
            shortName: app.short,
            medName: app.med,
            nameString: app.nameString,
        };
    }

    /** `xlets.py:940-949`. */
    function operStatus(statusName, app) {
        backend.send("AppManager", {
            operStatus: {
                appId: app.id,
                name: app.rawName || app.name,
                shortName: app.short,
                medName: app.med,
                nameString: app.nameString,
                state: statusName,
                type: "gui",
                daemon: false,
                hasGUI: true,
                headless: false,
            },
        });
    }

    function markRunning(app) {
        state.app = app;
        state.status = "running";
        state.visible = true;
    }

    function start(app, connection) {
        const variant = defaultVariant(app);
        if (!overlay || !variant) {
            backend.send("AppManager", { startApp: { errorCode: 1 } }, connection);
            return;
        }

        backend.send("AppManager", { startApp: { errorCode: 0 } }, connection);

        // Switching from another running xlet: the old JVM cannot be reused.
        if (state.app && lower(state.app.id) !== lower(app.id)) {
            overlay.close();
        }

        markRunning(app);
        overlay.open(app, variant);
        backend.send("AppManager", {
            appStarted: { appId: app.id, errorCode: 0 },
        });
        backend.send("AppManager", {
            setAppVisible: { appId: app.id, visible: true },
        });
        operStatus("running", app);
    }

    function pause(app) {
        if (!state.app || lower(state.app.id) !== lower(app.id)) {
            return;
        }
        state.status = "paused";
        state.visible = false;
        overlay?.hide();
        operStatus("paused", app);
    }

    function stop(app) {
        if (!state.app || lower(state.app.id) !== lower(app.id)) {
            return;
        }
        const previous = state.app;
        state.app = null;
        state.status = "stopped";
        state.visible = false;
        overlay?.close();
        operStatus("stopped", previous);
    }

    /** Called by the host when the embedded page reports a JVM exit/error. */
    function exited(appId) {
        if (!state.app || lower(state.app.id) !== lower(appId)) {
            return;
        }
        const previous = state.app;
        state.app = null;
        state.status = "stopped";
        state.visible = false;
        overlay?.close();
        operStatus("stopped", previous);
    }

    function requestStop() {
        if (state.app) {
            stop(state.app);
        }
    }

    /* ------------------------------------------------------------ AppManager */

    backend.on("AppManager", "getAppManagerStatus", (dest, args, connection) => {
        backend.send(
            dest,
            { getAppManagerStatus: { status: "Ready" } },
            connection,
        );
    });

    // `AppManager.as:290` stores `xletsDir = <response> + "/xlets"`, and every
    // consumer prepends `file://` (`AppXlet.as:58`, `AppManager.as:343`). An
    // empty response therefore yields clean `file:///xlets/<appId>/data/...`
    // URLs, which Ruffle rewrites to the served `/xlets/` directory (see
    // `urlRewriteRules` in `app.js`).
    //
    // `AppXlet.as:60` also checks `File.desktopDirectory.resolvePath(...)`
    // before using `onIcon.png`/`offIcon.png`; that resolves inside the VFS
    // (`vfs://desktop/xlets/...`). `app.js` seeds those two existence probes
    // in localStorage so the check passes and the real URLs are kept.
    backend.on("AppManager", "getXletsDir", (dest, args, connection) => {
        backend.send(dest, { getXletsDir: { xletsDir: "" } }, connection);
    });

    backend.on("AppManager", "getAppList", (dest, args, connection) => {
        let category = Number(args?.category);
        if (!Number.isFinite(category)) {
            category = ALL_APPS;
        }

        let list;
        if (category === RUNNING_APPS) {
            list =
                state.app && state.status !== "stopped"
                    ? [appEntry(state.app)]
                    : [];
        } else {
            // FAVORITE_APPS is mapped to ALL_APPS by the HMI as well.
            list = orderedApps().map(appEntry);
        }
        if (category === FAVORITE_APPS) {
            category = ALL_APPS;
        }

        backend.send(
            dest,
            {
                getAppList: {
                    AppManager: { appList: { category, list } },
                },
            },
            connection,
        );
    });

    backend.on("AppManager", "getXletPropsbyName", (dest, args, connection) => {
        const app =
            findAppByName(args?.appName) ??
            (typeof args?.appName === "string" ? findApp(args.appName) : null);
        if (!app) {
            return;
        }
        const variant = defaultVariant(app);
        backend.send(
            dest,
            {
                getXletPropsbyName: {
                    xletProps: {
                        appId: app.id,
                        name: app.rawName || app.name,
                        jarFile: variant?.jarFile ?? app.jarFile ?? "",
                        mainClass: variant?.mainClass ?? app.mainClass ?? "",
                        vendor: app.vendor ?? "",
                        version: variant?.version ?? app.version ?? "",
                    },
                },
            },
            connection,
        );
    });

    // `startDaemonApp` is used by Drive Modes > "SRT Pages".
    for (const command of ["startApp", "startDaemonApp"]) {
        backend.on("AppManager", command, (dest, args, connection) => {
            const app = findApp(args?.appId);
            if (!app) {
                backend.send(
                    dest,
                    { startApp: { errorCode: 1 } },
                    connection,
                );
                return;
            }
            start(app, connection);
        });
    }

    backend.on("AppManager", "resumeApp", (dest, args, connection) => {
        const app = findApp(args?.appId);
        if (!app) {
            return;
        }
        if (state.app && lower(state.app.id) === lower(app.id)) {
            markRunning(app);
            overlay?.show();
            operStatus("running", app);
        } else {
            start(app, connection);
        }
    });

    for (const command of ["pauseApp", "pauseDaemonApp"]) {
        backend.on("AppManager", command, (dest, args) => {
            const app = findApp(args?.appId);
            if (app) {
                pause(app);
            }
        });
    }

    for (const command of ["stopApp", "stopDaemonApp"]) {
        backend.on("AppManager", command, (dest, args) => {
            const app = findApp(args?.appId);
            if (app) {
                stop(app);
            }
        });
    }

    /* -------------------------------------------------------- DisplayManager */

    // `AppsActiveScreen.screenIn/screenOut` requests the AMS layer. The xlet
    // frame follows that layer, while a pause keeps the JVM in memory.
    backend.on("DisplayManager", "requestDisplay", (dest, args, connection) => {
        if (lower(args?.requester) !== "ams") {
            return;
        }
        const visible = String(args?.value).toLowerCase() === "true";

        if (visible) {
            if (state.app && state.status !== "stopped") {
                state.visible = true;
                overlay?.show();
            }
        } else if (state.app) {
            state.visible = false;
            overlay?.hide();
        }

        backend.send(
            dest,
            {
                requestDisplay: {
                    layer: "ams",
                    visible: visible ? "true" : "false",
                    granted: "true",
                },
            },
            connection,
        );
    });

    return {
        get app() {
            return state.app;
        },
        get status() {
            return state.status;
        },
        get visible() {
            return state.visible;
        },
        list: () => orderedApps().map(appEntry),
        find: findApp,
        launch(appId) {
            const app = findApp(appId);
            if (app) {
                start(app, null);
            }
            return Boolean(app);
        },
        pause() {
            if (state.app) {
                pause(state.app);
            }
        },
        stop: requestStop,
        exited,
    };
}
