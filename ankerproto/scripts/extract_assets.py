#!/usr/bin/env python3
"""Extract real product imagery from the Anker app for the web client.

The app ships Anker's own product renders and per-port connector artwork. This
script copies the relevant ones out of the APK's asset tree, resizes them to
web-appropriate dimensions and writes WebP into ``web/assets/device/``.

Why a separate step instead of just committing the images
---------------------------------------------------------

These files are Anker's copyrighted artwork, extracted from their app. Two
practical consequences, both encoded here rather than hand-waved:

* **They are not redistributed by default.** The output directory is
  gitignored, so a clone of this repo contains no third-party assets. Run this
  script locally to get them. Whether *you* commit them to *your* fork is your
  call - see ``web/README.md`` for the trade-off.
* **They are large.** The source tree is ~95 MB across 1,640 files. Only the
  handful actually used are extracted, resized and converted to WebP, which
  brings the whole set in at well under a megabyte.

The web client degrades gracefully without them: the panel falls back to the
drawn schematic, so the site still works if this script has not been run.

Usage:
    python3 scripts/extract_assets.py            # extract everything
    python3 scripts/extract_assets.py --list     # show what would be extracted
"""

from __future__ import annotations

import argparse
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # .../ankerproto
REPO = os.path.dirname(ROOT)          # workspace root

SRC = os.path.join(
    REPO, "work", "apk", "assets", "flutter_assets",
    "packages", "resource", "assets", "img",
)
OUT = os.path.join(ROOT, "web", "assets", "device")

# Hero render: the product shot the app shows on the device home screen.
# Keyed by SKU. Chosen by hand from the app's asset tree - each is the
# "device only, no text" render at the largest sensible resolution.
HERO = {
    "A1340": "a1340/a1340_black_normal.png",
    "A1753": "a1753/picl_A1762_normal.png",
    "A1763": "a1763/picl_A1763_device_blue_lighton.png",
    "A1782": "a1782/picl_A1782_device_red_lightoff.png",
    "A1790": "a1790/picl_A1790_device_blue_lighton.png",
    "A2345": "a2345/imgl_device_A2345_black_normal.png",
    "A5101": "a5101/picl_A5101_device_bg.png",
}

# Per-port connector artwork, where the app ships one image per port per state.
# Only some models have these; they are the app's own port-state indicators, so
# the panel can show the same connector graphic the official app shows.
# {SKU: {port id: {state: relative path}}}
PORT_ART = {
    "A1340": {
        "C1": {"empty": "a1340/a1340_c1_empty.png",
               "input": "a1340/a1340_c1_input.png",
               "output": "a1340/a1340_c1_output.png"},
        "C2": {"empty": "a1340/a1340_c2_empty.png",
               "input": "a1340/a1340_c2_input.png",
               "output": "a1340/a1340_c2_output.png"},
        # The app only ships these states for P and A; the renderer falls back.
        "P": {"empty": "a1340/a1340_p_empty.png",
              "input": "a1340/a1340_p_input.png"},
        "A": {"empty": "a1340/a1340_a_empty.png",
              "output": "a1340/a1340_a_output.png"},
    },
    "A2345": {
        "C1": {"output": "a2345/imgl_usb_A2345_black_normal_c1.png"},
        "C2": {"output": "a2345/imgl_usb_A2345_black_normal_c2.png"},
        "C3": {"output": "a2345/imgl_usb_A2345_black_normal_c3.png"},
        "C4": {"output": "a2345/imgl_usb_A2345_black_normal_c4.png"},
        "A1": {"output": "a2345/imgl_usb_A2345_black_normal_a1.png"},
        "A2": {"output": "a2345/imgl_usb_A2345_black_normal_a2.png"},
    },
}

# Alternate renders for the same device, selected at render time from live
# state. These are real differences in the app's artwork, not colour grading:
#   a1340_black_light_on  - the power bank seated on its charging base
#   *_lighton / _lightoff - the device's LED bar lit or dark
#   *_lowbattery/_lowtemp - the screen showing a warning
# `a1340_black_normal.png` is a physically different photo from
# `a1340_black_light_on.png` - not a brightness variant - which is why they are
# treated as distinct renders rather than one image with a filter.
VARIANTS = {
    "A1340": {
        "normal": "a1340/a1340_black_normal.png",
        "charging": "a1340/a1340_black_light_on.png",
        "lowBattery": "a1340/imgl_device_A1340_black_lowbattery.png",
        "lowTemp": "a1340/imgl_device_A1340_black_lowtemp.png",
    },
    "A1753": {
        "normal": "a1753/picl_A1753_device_blue_lightoff.png",
        "active": "a1753/picl_A1753_device_blue_lighton.png",
        "critical": "a1753/picl_A1753_device_red_lighton.png",
    },
    "A1763": {
        "normal": "a1763/picl_A1763_device_blue_lighton.png",
        "critical": "a1763/a1763_main_normal_offline.png",
    },
    "A1782": {
        "normal": "a1782/picl_A1782_device_red_lightoff.png",
        "active": "a1782/picl_A1782_device_blue_lighton.png",
    },
    "A1790": {
        "normal": "a1790/picl_A1790_device_blue_lightoff.png",
        "active": "a1790/picl_A1790_device_blue_lighton.png",
        "critical": "a1790/picl_A1790_device_red_lighton.png",
    },
}

HERO_MAX_W = 640
PORT_MAX_W = 96
QUALITY = 82


def require_pillow():
    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        print("Pillow is required: pip install Pillow", file=sys.stderr)
        return False
    return True


def convert(src_path: str, dst_path: str, max_w: int) -> tuple[int, int, int]:
    """Resize to at most `max_w` wide and write WebP. Returns sizes in bytes."""
    from PIL import Image

    before = os.path.getsize(src_path)
    with Image.open(src_path) as img:
        img = img.convert("RGBA")
        if img.width > max_w:
            h = round(img.height * (max_w / img.width))
            img = img.resize((max_w, h), Image.LANCZOS)
        os.makedirs(os.path.dirname(dst_path), exist_ok=True)
        img.save(dst_path, "WEBP", quality=QUALITY, method=6)
    return before, os.path.getsize(dst_path), img.width


def plan() -> list[tuple[str, str, int]]:
    """[(src_abs, dst_abs, max_width)] for everything to be extracted."""
    jobs: list[tuple[str, str, int]] = []
    for sku, rel in HERO.items():
        jobs.append(
            (os.path.join(SRC, rel), os.path.join(OUT, f"{sku.lower()}-hero.webp"), HERO_MAX_W)
        )
    for sku, variants in VARIANTS.items():
        for name, rel in variants.items():
            jobs.append((
                os.path.join(SRC, rel),
                os.path.join(OUT, f"{sku.lower()}-{name.lower()}.webp"),
                HERO_MAX_W,
            ))
    for sku, ports in PORT_ART.items():
        for port, states in ports.items():
            for state, rel in states.items():
                jobs.append((
                    os.path.join(SRC, rel),
                    os.path.join(OUT, f"{sku.lower()}-port-{port.lower()}-{state}.webp"),
                    PORT_MAX_W,
                ))
    return jobs


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--list", action="store_true", help="list the assets without extracting")
    ap.add_argument("--force", action="store_true", help="re-extract even if present")
    args = ap.parse_args()

    if not os.path.isdir(SRC):
        print(f"Anker asset tree not found at:\n  {SRC}", file=sys.stderr)
        print("Extract the APK first - see work/README.md.", file=sys.stderr)
        return 2

    jobs = plan()
    missing = [j for j in jobs if not os.path.exists(j[0])]
    present = [j for j in jobs if os.path.exists(j[0])]

    if args.list:
        print(f"{len(present)} assets available, {len(missing)} missing\n")
        for src, dst, _ in present:
            print(f"  {os.path.relpath(src, SRC):50s} -> {os.path.basename(dst)}")
        for src, _, _ in missing:
            print(f"  MISSING {os.path.relpath(src, SRC)}")
        return 0

    if not require_pillow():
        return 2

    total_before = total_after = 0
    written = skipped = 0
    for src, dst, max_w in present:
        try:
            if os.path.exists(dst) and not args.force:
                total_after += os.path.getsize(dst)
                total_before += os.path.getsize(src)
                skipped += 1
                continue
            before, after, width = convert(src, dst, max_w)
            total_before += before
            total_after += after
            written += 1
            print(f"  {os.path.basename(dst):34s} {before // 1024:>5}K -> {after // 1024:>4}K  ({width}px)")
        except Exception as exc:  # noqa: BLE001
            print(f"  FAILED {os.path.relpath(src, SRC)}: {exc}", file=sys.stderr)

    print()
    print(f"wrote {written} ({skipped} already present, {len(missing)} source files missing)")
    if total_before:
        print(
            f"size: {total_before // 1024}K source -> {total_after // 1024}K optimised "
            f"({100 - round(total_after * 100 / total_before)}% smaller)"
        )
    print(f"output: {OUT}")
    print()
    print("Note: these are Anker's copyrighted renders. The directory is gitignored,")
    print("so they are not redistributed by this repo. See web/README.md.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
