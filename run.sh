#!/usr/bin/env bash
#
# Build the Ruffle fork (if needed) and serve the AIR launcher page.
#
#   ./run.sh                 # serve on http://127.0.0.1:8000
#   ./run.sh --build         # rebuild Ruffle, then serve
#   ./run.sh --port 9000     # use a different port
#   ./run.sh --host 0.0.0.0  # listen on all interfaces
#
set -euo pipefail
cd "$(dirname "$0")"

# Prefer the rustup shims in ~/.cargo/bin. Distro `cargo` packages usually do
# not ship the wasm32 target, which makes the Ruffle wasm build fail with
# "can't find crate for `core`".
export PATH="$HOME/.cargo/bin:$PATH"

BUILD=0
HOST=127.0.0.1
PORT=8000

while [[ $# -gt 0 ]]; do
    case "$1" in
        --build)
            BUILD=1
            shift
            ;;
        --host)
            HOST="${2:?--host needs a value}"
            shift 2
            ;;
        --port)
            PORT="${2:?--port needs a value}"
            shift 2
            ;;
        -h|--help)
            sed -n '3,8p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "unknown option: $1 (try --help)" >&2
            exit 1
            ;;
    esac
done

RUFFLE_DIR="ruffle-air/web"
RUFFLE_DIST="$RUFFLE_DIR/packages/selfhosted/dist/ruffle.js"

if [[ ! -f "$RUFFLE_DIST" ]]; then
    BUILD=1
fi

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

if [[ "$BUILD" -eq 1 ]]; then
    ensure_rust

    echo "building ruffle-core..."
    (cd "$RUFFLE_DIR" && npm run build --workspace=ruffle-core)

    echo "building ruffle-selfhosted..."
    (cd "$RUFFLE_DIR" && npm run build --workspace=ruffle-selfhosted)
fi

exec python3 tools/serve.py --host "$HOST" --port "$PORT"
