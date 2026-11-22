#!/usr/bin/env bash
#
# Build Ruffle and the control panel, then assemble a self-contained folder
# that can be uploaded as-is to a static web server.
#
#   ./cicd.sh                 # build everything into dist/
#   ./cicd.sh --skip-ruffle   # reuse the existing Ruffle wasm build
#   ./cicd.sh --skip-panel    # reuse the existing assets/panel build
#   ./cicd.sh --out public    # write to another folder
#
# Serve the result from the domain root: the HMI requests absolute paths such
# as /skins/default/themes.xml and /img/..., so a subdirectory deployment
# would need those paths rewritten in the HMI itself.
#
set -euo pipefail
cd "$(dirname "$0")"

# Prefer the rustup shims in ~/.cargo/bin. Distro `cargo` packages usually do
# not ship the wasm32 target, which makes the Ruffle wasm build fail.
export PATH="$HOME/.cargo/bin:$PATH"

OUT="dist"
SKIP_RUFFLE=0
SKIP_PANEL=0
RUFFLE_DIR="ruffle-air/web"
RUFFLE_DIST="$RUFFLE_DIR/packages/selfhosted/dist"
PANEL_CSS="assets/panel/panel.css"

usage() {
    sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-ruffle)
            SKIP_RUFFLE=1
            shift
            ;;
        --skip-panel)
            SKIP_PANEL=1
            shift
            ;;
        --out)
            OUT="${2:?--out needs a value}"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "unknown option: $1 (try --help)" >&2
            exit 1
            ;;
    esac
done

case "$OUT" in
    "" | "/" | ".")
        echo "error: refusing to use '$OUT' as the output directory" >&2
        exit 1
        ;;
esac

# Checks the Rust toolchain needed by the Ruffle wasm build.
ensure_rust() {
    local target="wasm32-unknown-unknown"

    if ! command -v cargo >/dev/null 2>&1; then
        echo "error: cargo not found. Install Rust from https://rustup.rs" >&2
        exit 1
    fi

    if command -v rustc >/dev/null 2>&1 &&
        [[ -d "$(rustc --print sysroot)/lib/rustlib/$target" ]]; then
        return
    fi

    if command -v rustup >/dev/null 2>&1; then
        echo "installing Rust target $target..."
        rustup target add "$target"
    else
        echo "error: Rust target $target is missing and rustup is not available." >&2
        echo "       Install it with: rustup target add $target" >&2
        echo "       (or add \$HOME/.cargo/bin to PATH if you use rustup)" >&2
        exit 1
    fi
}

# ---------------------------------------------------------------- dependencies

if [[ ! -d node_modules ]]; then
    echo "installing panel dependencies..."
    npm ci
fi

if [[ "$SKIP_RUFFLE" -eq 0 && ! -d "$RUFFLE_DIR/node_modules" ]]; then
    echo "installing Ruffle dependencies..."
    (cd "$RUFFLE_DIR" && npm ci)
fi

# --------------------------------------------------------------------- builds

if [[ "$SKIP_RUFFLE" -eq 0 ]]; then
    ensure_rust

    echo "building ruffle-core..."
    (cd "$RUFFLE_DIR" && npm run build --workspace=ruffle-core)

    echo "building ruffle-selfhosted..."
    (cd "$RUFFLE_DIR" && npm run build --workspace=ruffle-selfhosted)
fi

if [[ ! -f "$RUFFLE_DIST/ruffle.js" ]]; then
    echo "error: $RUFFLE_DIST/ruffle.js is missing (run without --skip-ruffle)" >&2
    exit 1
fi

if [[ "$SKIP_PANEL" -eq 0 ]]; then
    echo "building control panel..."
    npm run build:panel
fi

if [[ ! -f "$PANEL_CSS" ]]; then
    echo "error: $PANEL_CSS is missing (run without --skip-panel)" >&2
    exit 1
fi

# ---------------------------------------------------------------- static site

echo "assembling $OUT/..."
rm -rf "$OUT"
mkdir -p "$OUT"

cp index.html app.js "$OUT"/
cp -R backend assets "$OUT"/

# Ruffle is loaded from this exact path by index.html. The source map is a
# development-only file, so it stays out of the deployment.
mkdir -p "$OUT/$RUFFLE_DIST"
cp -R "$RUFFLE_DIST/." "$OUT/$RUFFLE_DIST/"
rm -f "$OUT/$RUFFLE_DIST/ruffle.js.map"

# The AIR application itself (descriptor, SWFs, skins, text archives).
cp -R hmi "$OUT"/

# Real KIM1 xlets (JARs, icons, catalog + the CheerpJ runtime page) and the
# per-app seeds. `pcrt.web.WebLauncher` reads `/app/seed/<appId>`, and `/app/`
# is the site root, so `seed/` has to live next to `index.html`.
cp -R xlets seed "$OUT"/

# The HMI builds two URLRequests with a leading slash, so they resolve against
# the site origin instead of /hmi/. Mirror those two trees at the root:
#
#   /skins/default/themes.xml  Settings > Theme list
#   /img/...                   album art and app icons
#
# Theme SWFs are loaded relative to /hmi/ (for example
# /hmi/skins/default/themeSwfs/SRT/157_SRT.swf), so the rest of the skins tree
# does not need to be duplicated.
mkdir -p "$OUT/skins/default"
cp hmi/skins/default/themes.xml "$OUT/skins/default/themes.xml"
cp -R hmi/img "$OUT/img"

echo
echo "static site ready: $OUT/ ($(du -sh "$OUT" | cut -f1))"
echo "preview with: python3 tools/serve.py --port 8000 --directory \"$OUT\""
