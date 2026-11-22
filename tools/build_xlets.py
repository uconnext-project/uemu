#!/usr/bin/env python3
"""Stage the KIM1 Uconnect xlets for the browser runtime.

The source is a Uconnect ``usr/share/XLETS`` tree (the SD-card dump used by
the desktop emulator).  The script copies the unmodified application JARs and
runtime JARs into this repository, regenerates ``xlets/catalog.json``, extracts
the HMI app icons and creates the per-xlet seed directories that
``pcrt.web.WebLauncher`` copies into CheerpJ's writable ``/files`` mount.

Only the ``KIM1`` package is staged - no other KIM package is read or copied.

Usage:
    python3 tools/build_xlets.py
    python3 tools/build_xlets.py --source /run/media/.../usr/share/XLETS
    python3 tools/build_xlets.py --source ... --link   # hardlink instead of copy

The generated files are tracked in git; re-running the script is only needed
when the source XLETS dump changes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "xlets"
SEED_ROOT = ROOT / "seed"
KIM = "KIM1"

# Runtime pieces live outside the KIM package itself.
RUNTIME_JARS = [
    ("web_runtime/lib/webrt.jar", "webrt.jar"),
    ("pc_runtime/pcrt.jar", "pcrt.jar"),
    ("pc_runtime/lwuit.jar", "lwuit.jar"),
    ("pc_runtime/backport.jar", "backport.jar"),
    ("pc_runtime/pcrt-desktop.jar", "pcrt-desktop.jar"),
    ("base/kona/lib/kona.jar", "kona.jar"),
]
RUNTIME_FILES = [
    ("pc_runtime/sensor_values.properties", "sensor_values.properties"),
    ("pc_runtime/javaproxy.properties", "javaproxy.properties"),
]

# `xlet.properties` keys we keep from the source (without the `xlet.` prefix).
PROP_KEYS = (
    "appId",
    "name",
    "vendor",
    "version",
    "mainClass",
    "jarFile",
    "AppCategory",
    "showConditions",
    "NameLanguages",
    "NameSmallLanguages",
    "NameMedLanguages",
    "LargeIconPath",
    "LgIconOnPath",
    "LgIconOffPath",
    "ExLargeIconPath",
    "headless",
    "daemon",
)

# App icon files the HMI asks for.  `exLgIcon.png` is the spelling used by
# AppManager.as; `exlgIcon.png` is the spelling used by the desktop helper.
ICON_TARGETS = (
    ("onIcon.png", ("LgIconOnPath", "LargeIconPath")),
    ("offIcon.png", ("LgIconOffPath", "LgIconOnPath", "LargeIconPath")),
    ("lgIcon.png", ("LargeIconPath", "LgIconOnPath")),
    ("exLgIcon.png", ("ExLargeIconPath", "LargeIconPath", "LgIconOnPath")),
    ("exlgIcon.png", ("ExLargeIconPath", "LargeIconPath", "LgIconOnPath")),
    ("medIcon.png", ("LargeIconPath", "LgIconOnPath")),
)


def find_source(explicit: str | None) -> Path:
    if explicit:
        path = Path(explicit).expanduser()
        if valid_root(path):
            return path.resolve()
        raise SystemExit(f"error: {path} is not an XLETS root (base/kona/lib/kona.jar + kim_packages)")

    candidates: list[Path] = []
    env = os.environ.get("XLETS_ROOT", "").strip()
    if env:
        candidates.append(Path(env).expanduser())
    candidates.extend([
        ROOT.parent / "XLETS",
        ROOT / "XLETS",
        Path("/usr/share/XLETS"),
        Path.home() / "XLETS",
    ])

    import glob

    for pattern in (
        "/run/media/*/*/reverse_engineering/uconnect/extracted_updates/*/v18secondary/usr/share/XLETS",
        "/run/media/*/*/uconnect/extracted_updates/*/v18secondary/usr/share/XLETS",
        "/run/media/*/*/XLETS",
        "/media/*/*/XLETS",
    ):
        candidates.extend(Path(p) for p in glob.glob(pattern))

    for path in candidates:
        if valid_root(path):
            return path.resolve()
    raise SystemExit("error: XLETS not found; pass --source or set XLETS_ROOT")


def valid_root(path: Path) -> bool:
    return (
        (path / "base/kona/lib/kona.jar").is_file()
        and (path / "kim_packages" / KIM / "xlets").is_dir()
    )


def unescape_java(value: str) -> str:
    """Undo the escaping used by Java properties (\\:, \\=, \\uXXXX, ...)."""

    def replace(match: re.Match[str]) -> str:
        esc = match.group(1)
        if esc.startswith("u") and len(esc) == 5:
            try:
                return chr(int(esc[1:], 16))
            except ValueError:
                return esc
        return {"t": "\t", "n": "\n", "r": "\r", "f": "\f"}.get(esc, esc)

    return re.sub(r"\\(u[0-9a-fA-F]{4}|.)", replace, value).strip()


def read_properties(path: Path) -> dict[str, str]:
    props: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not raw or raw.lstrip().startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        key = key.strip()
        if key.startswith("xlet."):
            props[key[5:]] = unescape_java(value)
    return props


def english_name(value: str, default: str) -> str:
    decoded = value or ""
    for part in decoded.split(","):
        if part.lower().startswith("en_us:"):
            return part[6:].strip() or default
    if decoded:
        return decoded.split(":", 1)[-1].strip() or default
    return default


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def link_or_copy(source: Path, destination: Path, use_link: bool) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination.unlink()
    if use_link:
        try:
            os.link(source, destination)
            return
        except OSError:
            pass
    shutil.copy2(source, destination)


def normalize_entry(value: str) -> str:
    return value.lstrip("/").replace("\\", "/").lower()


def jar_icon(archive: zipfile.ZipFile, names: dict[str, str], wanted: str) -> bytes | None:
    if not wanted:
        return None
    key = normalize_entry(wanted)
    actual = names.get(key)
    if actual is None:
        base = os.path.basename(key)
        actual = next((name for lower, name in names.items() if os.path.basename(lower) == base), None)
    if actual is None:
        return None
    try:
        return archive.read(actual)
    except (KeyError, OSError, RuntimeError):
        return None


def extract_icons(jar: Path, props: dict[str, str], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(jar) as archive:
        names = {name.lower(): name for name in archive.namelist()}
        for target, sources in ICON_TARGETS:
            data = None
            for source in sources:
                data = jar_icon(archive, names, props.get(source, ""))
                if data:
                    break
            path = out_dir / target
            if data:
                path.write_bytes(data)
            elif path.exists():
                path.unlink()


def prepare_seed(source_root: Path, app_id: str, dest: Path, version: str) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)

    for rel, name in RUNTIME_FILES:
        source = source_root / rel
        if source.is_file():
            shutil.copy2(source, dest / name)

    work = source_root / "pc_runtime/work" / app_id
    if work.is_dir():
        for child in work.iterdir():
            target = dest / child.name
            if child.is_dir():
                shutil.copytree(child, target)
            elif not target.exists():
                shutil.copy2(child, target)

    for name, source in (
        ("__rms", source_root / "pc_runtime/rms" / app_id),
        ("__download", source_root / "pc_runtime/download" / app_id),
    ):
        if source.is_dir():
            shutil.copytree(source, dest / name)

    (dest / ".seed-version").write_text(version + "\n", encoding="utf-8")

    lines: list[str] = []
    for prefix, folder in (("work", dest), ("rms", dest / "__rms"), ("download", dest / "__download")):
        if not folder.is_dir():
            continue
        for path in sorted(folder.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(folder) if prefix == "work" else path.relative_to(dest)
            if prefix == "work" and (path.name in (".seed-version", "manifest.txt")):
                continue
            if prefix == "work" and relative.parts and relative.parts[0] in ("__rms", "__download"):
                continue
            lines.append(f"{prefix}:{relative.as_posix()}")
    (dest / "manifest.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", help="XLETS root (default: XLETS_ROOT or auto-detect)")
    parser.add_argument("--link", action="store_true", help="hardlink JARs instead of copying")
    args = parser.parse_args()

    source_root = find_source(args.source)
    kim_root = source_root / "kim_packages" / KIM
    print(f"source: {source_root}")
    print(f"package: {KIM}")

    # Clean generated output, but keep the hand-written runtime page.
    lib = DEST / "lib"
    if lib.exists():
        shutil.rmtree(lib)
    lib.mkdir(parents=True)
    if SEED_ROOT.exists():
        shutil.rmtree(SEED_ROOT)
    SEED_ROOT.mkdir(parents=True)

    for rel, name in RUNTIME_JARS + RUNTIME_FILES:
        source = source_root / rel
        if not source.is_file():
            raise SystemExit(f"missing runtime file: {source}")
        link_or_copy(source, lib / name, args.link)

    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    apps: list[dict] = []

    for xlet_dir in sorted((kim_root / "xlets").iterdir()):
        props_path = xlet_dir / "prog" / "xlet.properties"
        if not props_path.is_file():
            continue
        props = read_properties(props_path)
        app_id = props.get("appId", "").strip()
        jar_name = props.get("jarFile", "").strip()
        main_class = props.get("mainClass", "").strip()
        # Services/daemons have no AppCategory and never appear in the HMI.
        if not app_id or not jar_name or not main_class or not props.get("AppCategory"):
            continue

        jar_source = xlet_dir / "prog" / "jars" / jar_name
        if not jar_source.is_file():
            print(f"warning: missing {jar_source}")
            continue

        digest = sha256(jar_source)
        key = digest[:10]
        jar_rel = f"lib/apps/{app_id}/{key}/jars/{jar_name}"
        link_or_copy(jar_source, DEST / jar_rel, args.link)

        # The xlet reads /xlet.properties from the classpath; keep the
        # `prog` directory next to `jars` for the launcher.
        prog = DEST / "lib/apps" / app_id / key / "prog"
        prog.mkdir(parents=True, exist_ok=True)
        shutil.copy2(props_path, prog / "xlet.properties")

        raw_name = props.get("name") or app_id
        name_string = props.get("NameLanguages") or f"en_US:{raw_name}"
        short = props.get("NameSmallLanguages") or f"en_US:{raw_name}"
        med = props.get("NameMedLanguages") or name_string
        name = english_name(name_string, raw_name)

        extract_icons(jar_source, props, DEST / app_id / "data")
        prepare_seed(source_root, app_id, SEED_ROOT / app_id, generated_at)

        apps.append(
            {
                "id": app_id,
                "name": name,
                "rawName": raw_name,
                "vendor": props.get("vendor", ""),
                "version": props.get("version", ""),
                "category": props.get("AppCategory", ""),
                "mainClass": main_class,
                "jarFile": jar_name,
                "icon": props.get("LargeIconPath") or props.get("LgIconOnPath", ""),
                "conditions": props.get("showConditions", ""),
                "short": short,
                "med": med,
                "nameString": name_string,
                "headless": props.get("headless", "").lower() == "true",
                "daemon": props.get("daemon", "").lower() == "true",
                "defaultVariant": key,
                "variants": [
                    {
                        "key": key,
                        "version": props.get("version", ""),
                        "name": name,
                        "vendor": props.get("vendor", ""),
                        "category": props.get("AppCategory", ""),
                        "icon": props.get("LargeIconPath") or props.get("LgIconOnPath", ""),
                        "kim": KIM,
                        "packages": [KIM],
                        "source": jar_source.relative_to(source_root).as_posix(),
                        "jar": jar_rel,
                        "mainClass": main_class,
                        "size": jar_source.stat().st_size,
                        # Mirrors pc_runtime/run-xlet.sh.
                        "srt": "SRT" in name.upper(),
                        "vug": main_class == "com.tweddle.help.HUXlet",
                    }
                ],
            }
        )

    apps.sort(key=lambda app: app["name"].lower())
    catalog = {
        "generatedAt": generated_at,
        "sourceRoot": str(source_root),
        "kim": KIM,
        "stats": {
            "propertiesFiles": len(apps),
            "apps": len(apps),
            "variants": sum(len(app["variants"]) for app in apps),
        },
        "apps": apps,
    }
    (DEST / "catalog.json").write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print(f"staged {len(apps)} KIM1 xlets")
    print(f"catalog: {DEST / 'catalog.json'}")
    print(f"seeds:   {SEED_ROOT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
