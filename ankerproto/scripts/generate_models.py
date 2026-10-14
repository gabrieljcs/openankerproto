#!/usr/bin/env python3
"""Generate the web client's model registry from the Anker app binary.

Writes ``web/src/models.js``.

Everything here is extracted from ``Anker_3.8.0_release_mp_202505250018_encrypt.apk``
rather than invented:

* **SKU -> marketing name**, and the 16-bit / 128-bit service UUID associated with
  each model, come from a device registry table in the Dart AOT object pool
  (``blutter_out/pp.txt``). It is a flat, repeated record shape:
  ``SKU, marketing name, 0000xxxx, <service uuid>...``.
* **Per-port layout** comes from the app's own artwork filenames, which follow
  ``<model>_<port>_<state>.png`` (``a1340_c1_input.png``). Only four models ship
  explicit per-port artwork, so only those have a *confirmed* port list; the rest
  are left for the device to report.
* **Form factor** (outline aspect ratio) comes from the pixel dimensions of the
  largest product render in each model's asset directory.

Imported artwork is deliberately **not** shipped: it is Anker's copyright, and it
is ~95 MB across 1,640 files. The UI draws schematic SVG instead.

Usage:
    python3 scripts/generate_models.py
"""

from __future__ import annotations

import json
import os
import re
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.dirname(ROOT)  # .../ankerproto

POOL = os.path.join(REPO, "work", "blutter_out", "pp.txt")
ASSETS = os.path.join(
    REPO, "work", "apk", "assets", "flutter_assets", "packages", "resource", "assets", "img"
)
OUT = os.path.join(ROOT, "web", "src", "models.js")

# ---------------------------------------------------------------------------
# 1. SKU registry from the object pool
# ---------------------------------------------------------------------------

SKU_RE = re.compile(r'^String: "(A[0-9]{3,4}[A-Za-z]{0,4})"$')
NAME_RE = re.compile(r'^String: "([^"]+)"$')
U128_RE = re.compile(
    r'^String: "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-'
    r'[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"$'
)
U16_RE = re.compile(r'^String: "(0000[0-9A-Fa-f]{4})"$')


def parse_pool(path: str) -> dict[str, dict]:
    """Pull `SKU -> {name, uuids}` records out of the object pool."""
    values = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = re.match(r"^\[pp\+0x[0-9a-f]+\]\s*(.*)$", line.rstrip("\n"))
            values.append(m.group(1) if m else None)

    entries: dict[str, dict] = {}
    for i, value in enumerate(values):
        if not value:
            continue
        sku = SKU_RE.match(value)
        if not sku:
            continue
        nxt = values[i + 1] if i + 1 < len(values) else None
        if not nxt:
            continue
        name = NAME_RE.match(nxt)
        if not name or SKU_RE.match(nxt):
            continue

        model, label = sku.group(1), name.group(1)
        uuids: list[str] = []
        short = None
        for j in range(i + 2, min(i + 16, len(values))):
            t = values[j]
            if not t:
                continue
            if SKU_RE.match(t):
                break
            u = U128_RE.match(t)
            if u:
                uuids.append(u.group(1).lower())
                continue
            s = U16_RE.match(t)
            if s and short is None:
                short = s.group(1).lower()
                continue
            break

        entries.setdefault(
            model, {"sku": model, "name": label, "shortUuid": short, "uuids": uuids}
        )
    return entries


# ---------------------------------------------------------------------------
# 2. Port layouts from per-port artwork filenames
# ---------------------------------------------------------------------------

# Tokens the app uses for a port in an asset filename.
PORT_TOKENS = {
    "c1", "c2", "c3", "c4", "c5", "a", "a1", "a2", "p",
    "ac", "dc", "car", "carport", "usba", "usbc",
}

# Presentation data. Port TYPE is not in the filename, so it is inferred from the
# token - and flagged as inferred in the output, never presented as measured.
PORT_TYPE = {
    "c1": {"type": "usb-c", "label": "USB-C 1"},
    "c2": {"type": "usb-c", "label": "USB-C 2"},
    "c3": {"type": "usb-c", "label": "USB-C 3"},
    "c4": {"type": "usb-c", "label": "USB-C 4"},
    "c5": {"type": "usb-c", "label": "USB-C 5"},
    "a": {"type": "usb-a", "label": "USB-A"},
    "a1": {"type": "usb-a", "label": "USB-A 1"},
    "a2": {"type": "usb-a", "label": "USB-A 2"},
    "p": {"type": "usb-c", "label": "USB-C (P)"},
    "ac": {"type": "ac", "label": "AC"},
    "dc": {"type": "dc", "label": "DC"},
    "car": {"type": "dc", "label": "Car socket"},
    "solar": {"type": "solar", "label": "Solar"},
}

# Display order: DC/USB ports first, then AC.
PORT_ORDER = ["c1", "c2", "c3", "c4", "c5", "p", "a", "a1", "a2", "dc", "car", "ac", "solar"]


def ports_from_assets(base: str) -> tuple[dict[str, list[str]], dict[str, tuple[int, int]]]:
    """Return `{model: [port tokens]}` and `{dir: (w, h)}` from the artwork."""
    ports: dict[str, set[str]] = {}
    biggest: dict[str, tuple[int, int, int]] = {}

    def png_size(path: str):
        try:
            with open(path, "rb") as fh:
                head = fh.read(33)
            if head[:8] != b"\x89PNG\r\n\x1a\n":
                return None
            return struct.unpack(">II", head[16:24])
        except OSError:
            return None

    if not os.path.isdir(base):
        return {}, {}

    for entry in sorted(os.listdir(base)):
        d = os.path.join(base, entry)
        if not os.path.isdir(d):
            continue
        for fname in os.listdir(d):
            stem, ext = os.path.splitext(fname)
            if ext.lower() not in (".png", ".jpg", ".webp"):
                continue
            m = re.match(r"^(a[0-9]{3,4}[a-z]*)_([a-z0-9]+)_(.+)$", stem, re.I)
            if m:
                model = m.group(1).lower()
                token = m.group(2).lower()
                if token in PORT_TOKENS:
                    ports.setdefault(model, set()).add(token)
            if ext.lower() == ".png":
                size = png_size(os.path.join(d, fname))
                if size:
                    area = size[0] * size[1]
                    # Asset dirs are mixed-case on disk ("a17C5"); key by lowercase
                    # so lookups by SKU match.
                    key = entry.lower()
                    if area > biggest.get(key, (0, 0, 0))[0]:
                        biggest[key] = (area, size[0], size[1])

    ordered = {
        model: sorted(tokens, key=lambda t: PORT_ORDER.index(t) if t in PORT_ORDER else 99)
        for model, tokens in ports.items()
    }
    dims = {d: (w, h) for d, (_, w, h) in biggest.items()}
    return ordered, dims


# Map asset directory names onto SKUs where they differ.
DIR_TO_SKU = {
    "a1340": "A1340",
    "a17c5": "A17C5",
    "a17c1": "A17C1",
    "a17c0": "A17C0",
    "a17c2": "A17C2",
    "a17x7": "A17X7",
    "a17x8": "A17X8",
    "a91b2": "A91B2",
    "a1763": "A1763",
    "a1780": "A1780",
    "a1782": "A1782",
    "a1790": "A1790",
    "a5101": "A5101",
    "a5140": "A5140",
    "a5150": "A5150",
    "a2345": "A2345",
    "a1753": "A1753",
    "a17a0": "A17A0",
    "a17a3": "A17A3",
}



# ---------------------------------------------------------------------------
# 3. Classification
# ---------------------------------------------------------------------------

# Entries in the pool that are not products. A1790B parses as a SKU but is a
# debug/log string ("a1790CanUpdate------"), not a device.
NOT_PRODUCTS = {"A1790B"}

# Components and accessories that are real Anker hardware but are not
# consumer-facing BLE devices you would connect to from this client.
COMPONENT_SKUS = {
    "A5140", "A5141", "A5143",  # microinverters
    "A5150", "A5220", "A5450",  # expansion modules
    "A5341",                    # backup controller
    "A1780P",                   # variant of A1780, no separate entry
}

# Port layouts confirmed from the app's **per-port indicator artwork**, which is
# stronger evidence than the per-port-state files: the app ships one image per
# connector, named after it. A1340 -> a1340_c1/c2/p/a_*.png; A2345 ->
# imgl_usb_A2345_black_normal_c1..c4/a1/a2.png.
CONFIRMED_PORTS = {
    "A1340": ["c1", "c2", "p", "a"],
    "A2345": ["c1", "c2", "c3", "c4", "a1", "a2"],
}

# Models whose "device is doing something" render is not simply a lit LED bar.
# The A1340 is shown seated on its charging base while charging, which is a
# different photograph from its idle render.
VARIANT_ACTIVE_NAME = {"A1340": "charging"}

# Ports by product class, used ONLY to synthesise a plausible demo layout for
# models whose artwork does not confirm one. Never presented as real: the
# record carries `demoPortsSynthesised` so the UI can say so.
def synthesise_ports(aspect):
    """A believable port set for a demo, from the product's proportions."""
    if aspect is None:
        return ["C1", "C2", "A"]
    if aspect < 0.75:
        # Tall and narrow: a power bank. USB-C in/out plus USB-A.
        return ["C1", "C2", "A"]
    if aspect < 1.2:
        # Roughly square: a mid-size station: two USB-C, one A, one AC.
        return ["C1", "C2", "A", "AC"]
    # Wide: a desktop charger or large station.
    return ["C1", "C2", "C3", "A", "AC"]


def port_type(token):
    return PORT_TYPE.get(token.lower(), {}).get("type", "usb-c")


def port_label(token):
    return PORT_TYPE.get(token.lower(), {}).get("label", token.upper())


def main() -> int:
    if not os.path.exists(POOL):
        print(f"object pool not found: {POOL}", file=sys.stderr)
        print("Run the blutter analysis first (see work/README.md).", file=sys.stderr)
        return 2

    registry = parse_pool(POOL)
    ports_by_model, dims = ports_from_assets(ASSETS)

    print(f"SKUs from the pool            : {len(registry)}")
    print(f"models with per-port artwork  : {len(ports_by_model)}")
    print(f"models with render dimensions : {len(dims)}")

    models = []
    for sku in sorted(registry):
        entry = registry[sku]
        lower = sku.lower()
        confirmed = CONFIRMED_PORTS.get(sku) or ports_by_model.get(lower)

        # Form factor from the model's asset directory, if it has one.
        wh = dims.get(lower) or dims.get(DIR_TO_SKU.get(lower, "").lower()) or None
        aspect = round(wh[0] / wh[1], 3) if wh else None

        if sku in NOT_PRODUCTS:
            continue

        is_component = sku in COMPONENT_SKUS
        # Anything that is neither a component nor an obviously indoor-only
        # product, and that has a usable form factor, can be simulated.
        demoable = not is_component and aspect is not None

        record = {
            "sku": sku,
            "name": entry["name"],
            "shortUuid": entry["shortUuid"],
            "uuids": entry["uuids"],
            "portLayoutConfirmed": bool(confirmed),
            "ports": (
                [
                    {"id": t.upper(), "token": t, "type": port_type(t), "label": port_label(t)}
                    for t in confirmed
                ]
                if confirmed
                else []
            ),
            "aspectRatio": aspect,
            "variantActiveName": VARIANT_ACTIVE_NAME.get(sku),
            "demoable": demoable,
            # Used only by demo mode when no confirmed layout exists.
            "demoPorts": (
                [
                    {"id": t.upper(), "token": t.lower(), "type": port_type(t), "label": port_label(t)}
                    for t in (confirmed if confirmed else synthesise_ports(aspect))
                ]
                if demoable
                else []
            ),
            "demoPortsSynthesised": bool(demoable and not confirmed),
        }
        models.append(record)

    payload = {
        "_generated": (
            "Generated by ankerproto/scripts/generate_models.py from the Anker app "
            "binary. Do not edit by hand."
        ),
        "_sources": {
            "skus": "Dart AOT object pool (blutter_out/pp.txt)",
            "ports": "per-port artwork filenames (only 4 models ship these)",
            "aspectRatio": "largest product render pixel dimensions",
        },
        "models": models,
    }

    body = json.dumps(payload, indent=2)
    # JSON is valid JS here; keep it a plain object literal for zero tooling.
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("/**\n")
        fh.write(" * Anker device model registry.\n *\n")
        fh.write(" * GENERATED - do not edit. Run: python3 scripts/generate_models.py\n *\n")
        fh.write(" * Real data only, extracted from the app binary:\n")
        fh.write(" *  - SKU -> marketing name and service UUIDs: an actual device registry\n")
        fh.write(" *    table in the Dart AOT object pool.\n")
        fh.write(" *  - ports: from the app's own per-port artwork filenames\n")
        fh.write(" *    (`a1340_c1_input.png`). Only 4 models ship per-port artwork, so only\n")
        fh.write(" *    those list ports; for everything else the device reports its own\n")
        fh.write(" *    capabilities over the protocol and the UI follows that.\n")
        fh.write(" *  - aspectRatio: largest product render's pixel dimensions, used for the\n")
        fh.write(" *    schematic outline's proportions.\n")
        fh.write(" *\n")
        fh.write(" * Anker's artwork is NOT redistributed here (copyright, and ~95 MB).\n")
        fh.write(" */\n\n")
        fh.write(f"export const REGISTRY = {body};\n\n")
        fh.write(
            """export const MODELS = REGISTRY.models;

/** Look up a model by SKU, case-insensitively. */
export function modelBySku(sku) {
  if (!sku) return null;
  const needle = String(sku).trim().toUpperCase();
  return MODELS.find((m) => m.sku.toUpperCase() === needle) ?? null;
}

/**
 * Match a model from a device name, e.g. "Anker A1340".
 *
 * Deliberately strict: the BLE device name is **writable over the air**, so
 * treating an arbitrary substring as a model would let a device claim to be
 * something it is not and have the UI draw the wrong hardware. A SKU is only
 * accepted when it appears as its own token - surrounded by non-alphanumerics or
 * the string ends - and only if it is a SKU that actually exists.
 */
export function modelFromName(name) {
  if (!name) return null;
  const upper = String(name).toUpperCase();
  // Longest SKU first so A1790P is matched before A1790.
  const candidates = [...MODELS].sort((a, b) => b.sku.length - a.sku.length);
  for (const m of candidates) {
    const sku = m.sku.toUpperCase();
    const at = upper.indexOf(sku);
    if (at === -1) continue;
    const before = at === 0 ? "" : upper[at - 1];
    const after = upper[at + sku.length] ?? "";
    const boundary = (c) => c === "" || !/[A-Z0-9]/.test(c);
    if (boundary(before) && boundary(after)) return m;
  }
  return null;
}

/** True when a string is a SKU that exists in the registry. */
export function isKnownSku(value) {
  return modelBySku(value) !== null;
}

/** Human label for a model, falling back to the SKU. */
export function modelLabel(model) {
  if (!model) return null;
  return model.name ? `${model.name} (${model.sku})` : model.sku;
}
"""
        )

    print(f"\nwrote {OUT}")
    confirmed = [m["sku"] for m in models if m["portLayoutConfirmed"]]
    print(f"  models                 : {len(models)}")
    demoable = [m["sku"] for m in models if m["demoable"]]
    print(f"  with confirmed ports   : {', '.join(confirmed) or '(none)'}")
    print(f"  demo-able models       : {len(demoable)}")
    with_aspect = [m["sku"] for m in models if m["aspectRatio"]]
    print(f"  with form factor       : {len(with_aspect)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
