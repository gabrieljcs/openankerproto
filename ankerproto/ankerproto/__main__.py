"""Command line interface: ``python -m ankerproto``.

Examples
--------
List nearby devices::

    python -m ankerproto scan

Read a power bank's status::

    python -m ankerproto status --address 12:34:56:78:9A:BC

Toggle the beeper::

    python -m ankerproto beep on

Decode a captured frame hex string (no device needed)::

    python -m ankerproto decode ffd90c000300110500a1012100
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import asdict

from .framing import parse_frame
from .opcodes import OPCODE_NAMES, Opcode
from .session import AnkerSession
from .tlv import decode_tlv
from .uuids import PRIMARY_FAMILY, UUID_FAMILIES, find_family


def _add_common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--address", help="BLE address/MAC of the device")
    p.add_argument("--name", help="substring to match in the device name when scanning")
    p.add_argument(
        "--family",
        default=PRIMARY_FAMILY.name,
        help="UUID family: " + ", ".join(f.name for f in UUID_FAMILIES),
    )
    p.add_argument("--timeout", type=float, default=2.0, help="per-command timeout")
    p.add_argument("-v", "--verbose", action="store_true")


def cmd_scan(args: argparse.Namespace) -> int:
    import asyncio

    from .ble import scan

    fam = next((f for f in UUID_FAMILIES if f.name == args.family), PRIMARY_FAMILY)
    found = asyncio.run(scan(timeout=args.timeout or 8.0, families=[fam]))
    if not found:
        print("no Anker devices found")
        return 1
    for d in found:
        print(f"{d['address']}  rssi={d['rssi']:>4}  {d['name'] or '(unnamed)'}")
    return 0


def _connect(args: argparse.Namespace) -> AnkerSession:
    from .ble import BleTransport

    fam = next((f for f in UUID_FAMILIES if f.name == args.family), PRIMARY_FAMILY)
    transport = BleTransport(fam, address=args.address, name_hint=args.name)
    transport.connect()
    session = AnkerSession(transport, timeout=args.timeout)
    info = session.connect()
    print(f"serial   : {info.serial_number}")
    print(f"firmware : {info.firmware_version}")
    print(f"bt mac   : {info.bt_mac}")
    print(f"session  : {session.session_key.hex().upper()}")
    return session


def cmd_status(args: argparse.Namespace) -> int:
    session = _connect(args)
    try:
        status = session.read_status()
    finally:
        session.transport.close()  # type: ignore[attr-defined]
    print()
    if args.json:
        print(json.dumps(asdict(status), indent=2, default=str))
    else:
        print(status)
    return 0


def cmd_ports(args: argparse.Namespace) -> int:
    session = _connect(args)
    try:
        status = session.read_live_power()
    finally:
        session.transport.close()  # type: ignore[attr-defined]
    for name, port in status.ports.items():
        print(
            f"{name:<3} {port.mode_name:<7} {port.voltage:>7.2f} V "
            f"{port.current:>7.3f} A {port.power:>8.2f} W"
        )
    if status.battery_percent is not None:
        print(f"battery {status.battery_percent:.2f} %")
    return 0


def cmd_beep(args: argparse.Namespace) -> int:
    session = _connect(args)
    try:
        session.set_beep(args.state == "on")
    finally:
        session.transport.close()  # type: ignore[attr-defined]
    print(f"beep {args.state}")
    return 0


def cmd_theme(args: argparse.Namespace) -> int:
    session = _connect(args)
    try:
        session.set_theme(args.theme == "advanced")
    finally:
        session.transport.close()  # type: ignore[attr-defined]
    print(f"theme {args.theme}")
    return 0


def cmd_decode(args: argparse.Namespace) -> int:
    """Decode a frame hex string offline - no device required."""
    raw = bytes.fromhex(args.hex.replace(" ", "").replace(":", ""))
    try:
        frame = parse_frame(raw)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        # Still try to show the header for diagnosis.
        if len(raw) >= 9:
            print(
                f"header={raw[:2].hex()} size={int.from_bytes(raw[2:4],'little')} "
                f"pattern={raw[4:7].hex()} cmd={raw[7:9].hex()}",
                file=sys.stderr,
            )
        return 1

    print(f"command : {frame.command_hex}  {OPCODE_NAMES.get(frame.command, '?')}")
    print(f"group   : 0x{frame.group:02X}")
    print(f"flags   : {'encrypted ' if frame.encrypted else ''}"
          f"{'response' if frame.response else 'request'}")
    print(f"payload : {len(frame.payload)} bytes")

    body = frame.payload
    if not frame.encrypted and body[:1] == b"\x00":
        print("status  : 0x00 (OK)")
        body = body[1:]
    for tag in decode_tlv(body, strict=False):
        printable = tag.value.decode("ascii", "replace")
        suffix = f"  ascii={printable!r}" if printable.isprintable() else ""
        print(f"  TLV 0x{tag.tag:02X} len={tag.length:<3} {tag.value.hex()}{suffix}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="ankerproto",
        description="Talk to Anker BLE devices without the official app.",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan", help="scan for Anker BLE devices")
    _add_common(s)
    s.set_defaults(func=cmd_scan)

    s = sub.add_parser("status", help="print battery, temperature and power")
    _add_common(s)
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_status)

    s = sub.add_parser("ports", help="print per-port voltage/current/power")
    _add_common(s)
    s.set_defaults(func=cmd_ports)

    s = sub.add_parser("beep", help="enable/disable the beeper")
    _add_common(s)
    s.add_argument("state", choices=["on", "off"])
    s.set_defaults(func=cmd_beep)

    s = sub.add_parser("theme", help="set the display theme")
    _add_common(s)
    s.add_argument("theme", choices=["simple", "advanced"])
    s.set_defaults(func=cmd_theme)

    s = sub.add_parser("decode", help="decode a captured frame (offline)")
    s.add_argument("hex", help="frame bytes as hex")
    s.set_defaults(func=cmd_decode)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if getattr(args, "verbose", False):
        logging.basicConfig(level=logging.DEBUG, format="%(levelname)s %(name)s %(message)s")
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        print(f"error: {exc}", file=sys.stderr)
        if getattr(args, "verbose", False):
            raise
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
