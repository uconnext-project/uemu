/**
 * Uconnect xlet runtime page.
 *
 * Standalone it is a small browser for the staged KIM1 applications.  The HMI
 * embeds the same page with `?app=<appId>&variant=<key>&embed=1`: the chrome is
 * hidden, the CheerpJ display fills the 640x480 stage and the page reports its
 * state to the parent window with `postMessage`:
 *
 *     { source: "air-xlet", type: "ready" | "started" | "exit" | "error", appId, ... }
 *
 * CheerpJ maps `/app/` to the origin root, so every runtime file lives under
 * `/app/xlets/`.  `pcrt.web.WebLauncher` seeds the writable `/files/<appId>`
 * directory from `/app/seed/<appId>` (staged at the repository root).
 */

const params = new URLSearchParams(location.search);
const EMBED = params.get("embed") === "1";
const DEBUG = params.has("debug");

const els = {
  catalogView: document.getElementById("catalogView"),
  runtimeView: document.getElementById("runtimeView"),
  appList: document.getElementById("appList"),
  catalogInfo: document.getElementById("catalogInfo"),
  search: document.getElementById("search"),
  detailTitle: document.getElementById("detailTitle"),
  detailMeta: document.getElementById("detailMeta"),
  detailNotes: document.getElementById("detailNotes"),
  variantSelect: document.getElementById("variantSelect"),
  appIdField: document.getElementById("appIdField"),
  mainClassField: document.getElementById("mainClassField"),
  vendorField: document.getElementById("vendorField"),
  launchBtn: document.getElementById("launchBtn"),
  debugToggle: document.getElementById("debugToggle"),
  runtimeTitle: document.getElementById("runtimeTitle"),
  runtimeStatus: document.getElementById("runtimeStatus"),
  restartBtn: document.getElementById("restartBtn"),
  backBtn: document.getElementById("backBtn"),
  logToggle: document.getElementById("logToggle"),
  display: document.getElementById("display"),
  overlay: document.getElementById("overlay"),
  log: document.getElementById("log"),
};

const state = { catalog: null, app: null, variant: null };
const logLines = [];

/* ------------------------------------------------------------------ helpers */

function post(type, extra = {}) {
  if (!EMBED || window.parent === window) return;
  window.parent.postMessage(
    { source: "air-xlet", type, appId: state.app?.id ?? null, ...extra },
    "*",
  );
}

function installLogger() {
  const originals = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  for (const level of ["log", "warn", "error"]) {
    console[level] = (...args) => {
      const text = args
        .map((value) => (typeof value === "string" ? value : String(value)))
        .join(" ");
      logLines.push(`[${level}] ${text}`);
      if (logLines.length > 800) logLines.shift();
      if (els.log) {
        els.log.textContent = logLines.join("\n");
        els.log.scrollTop = els.log.scrollHeight;
      }
      originals[level](...args);
    };
  }
  window.addEventListener("error", (event) =>
    console.error("window.error:", event.message),
  );
  window.addEventListener("unhandledrejection", (event) =>
    console.error("unhandled rejection:", event.reason),
  );
}

function setStatus(text, overlay = null) {
  if (els.runtimeStatus) els.runtimeStatus.textContent = text;
  if (overlay !== null && els.overlay) {
    els.overlay.hidden = !overlay;
    if (overlay) els.overlay.textContent = overlay;
  }
}

function variantLabel(variant) {
  const bits = [variant.version || "version ?", variant.kim || "KIM1"];
  if (variant.srt) bits.push("SRT");
  if (variant.vug) bits.push("VUG");
  return bits.join(" · ");
}

function notesFor(app, variant) {
  const notes = [];
  if (variant.vug) {
    notes.push(
      "Vehicle User Guide: the local content bundle is generated on first launch.",
    );
  }
  if (variant.srt) {
    notes.push(
      "SRT variant: pcrt.srtPresent=true is set (the JAR only ships the SRT resources).",
    );
  }
  if (app.headless) notes.push("Headless xlet — the window may stay empty; check the logs.");
  notes.push("Sensors are simulated (no CAN/PPS); online services may not answer.");
  return notes.join(" ");
}

function defaultVariant(app) {
  if (!app?.variants?.length) return null;
  return app.variants.find((v) => v.key === app.defaultVariant) || app.variants[0];
}

/* ------------------------------------------------------------------ catalog */

function renderList(filter = "") {
  if (!state.catalog || !els.appList) return;
  const needle = filter.trim().toLowerCase();
  els.appList.textContent = "";

  const apps = state.catalog.apps.filter((app) => {
    if (!needle) return true;
    return [app.name, app.vendor, app.id, app.category]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });

  for (const app of apps) {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "app-item" + (state.app && state.app.id === app.id ? " selected" : "");
    button.setAttribute("role", "option");
    button.setAttribute(
      "aria-selected",
      String(Boolean(state.app && state.app.id === app.id)),
    );

    const left = document.createElement("span");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = app.name;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${app.vendor || "unknown vendor"} · ${app.id.slice(0, 8)}`;
    left.append(name, meta);

    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(app.variants.length);
    count.title = `${app.variants.length} JAR variant(s) in KIM1`;
    button.append(left, count);
    button.addEventListener("click", () => selectApp(app));
    els.appList.append(button);
  }

  const variants = apps.reduce((total, app) => total + app.variants.length, 0);
  els.catalogInfo.textContent =
    `${apps.length} of ${state.catalog.apps.length} applications · ` +
    `${variants} variants · KIM1`;
}

function selectApp(app, variantKey = null) {
  if (!app?.variants?.length) return;
  state.app = app;
  state.variant =
    app.variants.find((variant) => variant.key === variantKey) ||
    defaultVariant(app);

  els.detailTitle.textContent = app.name;
  els.detailMeta.textContent =
    `${app.vendor || "unknown vendor"} · category ${app.category || "—"} · ` +
    `${app.variants.length} variant(s) in KIM1`;
  els.appIdField.value = app.id;
  els.vendorField.value = app.vendor || "";
  els.variantSelect.textContent = "";
  for (const variant of app.variants) {
    const option = document.createElement("option");
    option.value = variant.key;
    option.textContent = variantLabel(variant);
    els.variantSelect.append(option);
  }
  els.variantSelect.value = state.variant.key;
  els.variantSelect.disabled = false;
  updateVariantDetail();
  els.launchBtn.disabled = false;
  renderList(els.search?.value ?? "");
}

function updateVariantDetail() {
  if (!state.app || !state.variant) return;
  state.variant =
    state.app.variants.find((v) => v.key === els.variantSelect.value) ||
    state.variant;
  els.mainClassField.value = state.variant.mainClass;
  els.detailNotes.textContent = notesFor(state.app, state.variant);
}

/* ------------------------------------------------------------------ launcher */

function javaProperties(app, variant) {
  const properties = [
    // Kona's PlatformInfo.isRunningInEmulator() checks os.arch against
    // i386/x86/amd64.  CheerpJ reports a wasm architecture, which would make
    // Kona look for /fs/mmc1/kona/data/sensor_properties.json (not writable in
    // the browser).  Report the same architecture as the desktop runtime.
    "os.arch=amd64",
    `user.dir=/files/${app.id}`,
    `pcrt.workDir=/files/${app.id}`,
    `pcrt.seedVersion=${state.catalog.generatedAt}`,
    `pcrt.title=${app.name}`,
    "pcrt.width=640",
    "pcrt.height=480",
    `pcrt.rms=/files/rms/${app.id}`,
    "pcrt.sensorValues=/app/xlets/lib/sensor_values.properties",
    "pcrt.vugDownloadDir=/files/download",
    "pcrt.desktopJar=/app/xlets/lib/pcrt-desktop.jar",
    "pcrt.extraJar=/app/xlets/lib/backport.jar",
  ];
  if (variant.srt) properties.push("pcrt.srtPresent=true");
  if (variant.vug) properties.push("pcrt.layoutRefresh=true");
  if (DEBUG) properties.push("pcrt.debug=true");
  return properties;
}

/** `/app/` is mapped to the parent of this page (overrideDocumentBase); the runtime lives under `xlets/`. */
function runtimePath(relative) {
  return `/app/xlets/${relative.replace(/^\/+/, "")}`;
}

async function launch(app, variant) {
  state.app = app;
  state.variant = variant;

  els.catalogView.hidden = true;
  els.runtimeView.hidden = false;
  if (els.runtimeTitle) {
    els.runtimeTitle.textContent = `${app.name} · ${variant.version || ""}`;
  }
  setStatus("Starting the Java VM…", "Loading the Java runtime…");
  post("loading");

  try {
    await cheerpjInit({
      version: 21,
      status: EMBED ? "none" : "splash",
      disableScaling: true,
      javaProperties: javaProperties(app, variant),
      enableDebug: DEBUG,
      // CheerpJ mounts /app/ at the document base URL.  The xlet page lives at
      // xlets/index.html, so by default /app/xlets/lib/... would resolve to
      // xlets/xlets/lib/... (one level too deep).  Override the base to the
      // parent directory so /app/xlets/... maps to the actual xlets/ folder,
      // regardless of what path prefix the site is deployed under.
      overrideDocumentBase: new URL("../", location.href).href,
    });

    setStatus("Creating the 640×480 display…", "Creating the display…");
    // CheerpJ's window manager reserves 20px for its own title bar. Create a
    // display tall enough for both, then let the embed CSS hide the title bar
    // and shift the application up so it fills the real 640×480 stage.
    cheerpjCreateDisplay(640, EMBED ? 500 : 480, els.display);
    els.overlay.hidden = true;
    post("ready");

    const classPath = [
      runtimePath("lib/webrt.jar"),
      runtimePath("lib/pcrt.jar"),
      runtimePath("lib/lwuit.jar"),
    ].join(":");
    setStatus("Launching the xlet…", false);
    post("started");

    const exitCode = await cheerpjRunMain(
      "pcrt.web.WebLauncher",
      classPath,
      app.id,
      variant.mainClass,
      runtimePath(variant.jar),
      runtimePath("lib/kona.jar"),
    );

    setStatus(`The xlet exited (code ${exitCode}).`, false);
    post("exit", { code: exitCode });
  } catch (error) {
    console.error(error);
    const message = error?.message || String(error);
    setStatus("The xlet could not be launched — see the logs.", `Error: ${message}`);
    post("error", { message });
  }
}

/* ---------------------------------------------------------------------- boot */

async function boot() {
  installLogger();

  if (EMBED) {
    document.documentElement.classList.add("embed");
    document.body.classList.add("embed");
  }

  try {
    const response = await fetch(new URL("catalog.json", location.href));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.catalog = await response.json();
  } catch (error) {
    const message = `Could not load catalog.json: ${error.message}`;
    if (els.catalogInfo) els.catalogInfo.textContent = message;
    setStatus(message, message);
    post("error", { message });
    return;
  }

  if (params.has("app")) {
    const app = state.catalog.apps.find((entry) => entry.id === params.get("app"));
    if (!app) {
      const message = "Unknown appId — not present in the KIM1 catalog.";
      setStatus(message, message);
      post("error", { message });
      return;
    }
    const variant =
      app.variants.find((v) => v.key === params.get("variant")) ||
      defaultVariant(app);
    if (!variant) {
      const message = "No JAR variant for this application.";
      setStatus(message, message);
      post("error", { message });
      return;
    }
    await launch(app, variant);
    return;
  }

  els.restartBtn?.addEventListener("click", () => location.reload());
  els.backBtn?.addEventListener("click", () => {
    const url = new URL(location.href);
    url.search = "";
    location.href = url.toString();
  });
  els.logToggle?.addEventListener("click", () => {
    els.log.hidden = !els.log.hidden;
    els.logToggle.textContent = els.log.hidden ? "Show logs" : "Hide logs";
  });
  els.variantSelect?.addEventListener("change", updateVariantDetail);
  els.search?.addEventListener("input", () => renderList(els.search.value));
  els.launchBtn?.addEventListener("click", () => {
    if (!state.app || !state.variant) return;
    const url = new URL(location.href);
    url.search = new URLSearchParams({
      app: state.app.id,
      variant: state.variant.key,
    }).toString();
    location.href = url.toString();
  });

  renderList();
}

// The embedded page is started by the parent; tell it when the page itself is
// alive so it can show the close control even if the JVM is still loading.
if (EMBED) post("open");

boot();
