"""Anker BLE/MQTT wire framing.

Wire format (little-endian, verified against ``SolixBLE`` packet structures,
the community ``atc1441`` WebBluetooth tool and the APK's own
``AssembleCmdUtil``/``ZXCommandTransformer``)::

    <header 2B> <size 2B LE> <pattern 3B> <cmd 2B> <payload nB> <checksum 1B>
      FF 09      len+5        03 00 grp    cmdh cmdl   ...            XOR

``size`` counts every byte of the frame *including* the two header bytes but
*excluding* the trailing checksum (see :func:`build_frame`).

The command word
----------------
The 16-bit command is split across two bytes and carries flags in the high
byte::

    cmd_high = (command >> 8) & 0xFF
    cmd_low  =  command       & 0xFF

    bit 0x40 of cmd_high -> payload is AES encrypted
    bit 0x08 of cmd_high -> this is a response/ACK (high byte + 0x08)

So command ``0x0022`` (``getAesKeyReq``) becomes ``40 22`` when encrypted and
``08 22`` when the device answers it.

The ``pattern`` triple is ``03 00 <group>``. ``group`` is a logical channel
(0x01 for the handshake/management channel, 0x11 for the power/status channel
used by the Prime power banks).
"""

from __future__ import annotations

import operator
from dataclasses import dataclass
from functools import reduce
from typing import Iterator

__all__ = [
    "HEADER",
    "PATTERN_PREFIX",
    "FLAG_ENCRYPTED",
    "FLAG_RESPONSE",
    "AnkerFrame",
    "build_frame",
    "parse_frame",
    "xor_checksum",
    "split_fragments",
]

HEADER = b"\xff\x09"
PATTERN_PREFIX = b"\x03\x00"

FLAG_ENCRYPTED = 0x40
FLAG_RESPONSE = 0x08

#: Maximum bytes of ``payload`` per BLE write. The device subtracts 10 bytes of
#: framing overhead from the negotiated MTU (default MTU 200 -> 190 data bytes).
MTU_OVERHEAD = 10
DEFAULT_MTU = 200


def xor_checksum(data: bytes) -> int:
    """XOR-fold every byte (the checksum used by the Anker BLE frame)."""
    return reduce(operator.xor, data, 0)


@dataclass(frozen=True)
class AnkerFrame:
    """A parsed Anker frame in either direction."""

    group: int
    command: int
    payload: bytes
    encrypted: bool
    #: ``True`` when the device transmitted this frame (``cmd_high`` bit 3 set).
    response: bool
    raw: bytes = b""

    @property
    def command_low(self) -> int:
        return self.command & 0xFF

    @property
    def command_high(self) -> int:
        return (self.command >> 8) & 0xFF

    @property
    def command_hex(self) -> str:
        return f"0x{self.command:04X}"

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        flags = []
        if self.encrypted:
            flags.append("ENC")
        if self.response:
            flags.append("RESP")
        return (
            f"<AnkerFrame {self.command_hex} group=0x{self.group:02X} "
            f"flags={'|'.join(flags) or '-'} payload={len(self.payload)}B>"
        )


def build_frame(
    command: int,
    payload: bytes = b"",
    *,
    group: int = 0x01,
    encrypted: bool = False,
    response: bool = False,
) -> bytes:
    """Serialise one Anker frame, appending the XOR checksum.

    ``payload`` must already be encrypted when ``encrypted=True``.
    """
    if not 0 <= command <= 0xFFFF:
        raise ValueError("command must fit in 16 bits")
    if not 0 <= group <= 0xFF:
        raise ValueError("group must fit in one byte")

    cmd_high = (command >> 8) & 0xFF
    cmd_low = command & 0xFF
    if encrypted:
        cmd_high |= FLAG_ENCRYPTED
    if response:
        cmd_high |= FLAG_RESPONSE

    body = PATTERN_PREFIX + bytes([group, cmd_high, cmd_low]) + payload
    # size counts header + size + body, i.e. everything before the checksum.
    size = len(body) + 4
    frame = HEADER + size.to_bytes(2, "little") + body
    return frame + bytes([xor_checksum(frame)])


def parse_frame(data: bytes) -> AnkerFrame:
    """Parse a frame received from the device.

    Raises :class:`ValueError` when the header, declared length or checksum do
    not match.
    """
    if len(data) < 6:
        raise ValueError(f"frame too short: {len(data)} bytes")
    if data[:2] != HEADER:
        raise ValueError(f"bad header: {data[:2].hex()} (expected {HEADER.hex()})")

    size = int.from_bytes(data[2:4], "little")
    if size != len(data) - 1:
        raise ValueError(f"length mismatch: header says {size}, got {len(data) - 1}")

    expected = xor_checksum(data[:-1])
    if expected != data[-1]:
        raise ValueError(
            f"checksum mismatch: computed 0x{expected:02X}, got 0x{data[-1]:02X}"
        )

    if data[4:6] != PATTERN_PREFIX:
        raise ValueError(f"bad pattern prefix: {data[4:6].hex()}")

    group = data[6]
    cmd_high = data[7]
    cmd_low = data[8]

    return AnkerFrame(
        group=group,
        command=((cmd_high & ~(FLAG_ENCRYPTED | FLAG_RESPONSE)) << 8) | cmd_low,
        payload=bytes(data[9:-1]),
        encrypted=bool(cmd_high & FLAG_ENCRYPTED),
        response=bool(cmd_high & FLAG_RESPONSE),
        raw=bytes(data),
    )


def split_fragments(payload: bytes, mtu: int = DEFAULT_MTU) -> Iterator[bytes]:
    """Split ``payload`` into BLE-sized chunks.

    ``mtu - MTU_OVERHEAD`` data bytes fit in each frame. This mirrors
    ``AssembleCmdUtil.splitPackageCmd`` in the official app.
    """
    chunk = max(1, mtu - MTU_OVERHEAD)
    for i in range(0, len(payload), chunk):
        yield payload[i : i + chunk]
