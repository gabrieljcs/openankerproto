"""Anker ZX BLE protocol - clean-room reference implementation.

Recovered from ``Anker_3.8.0_release_mp_202505250018_encrypt.apk``
(``com.anker.charging``) and cross-checked against the public reverse
engineering work by atc1441, flip-dots and moag1000.

Quick start::

    from ankerproto import AnkerSession, BleTransport, PRIMARY_FAMILY

    with BleTransport(PRIMARY_FAMILY) as t:
        session = AnkerSession(t)
        print(session.connect())        # -> serial number, firmware, MAC
        print(session.read_status())

Offline (no device) - build and inspect frames::

    from ankerproto import build_frame, parse_frame, Opcode, encode_tlv

    frame = build_frame(Opcode.GET_DEVICE_INFO_REQ, encode_tlv([(0xA1, b"\\x00" * 4)]))
"""

from .crypto import A2_STATIC_VALUE, INITIAL_KEY, AesContext
from .framing import (
    FLAG_ENCRYPTED,
    FLAG_RESPONSE,
    HEADER,
    AnkerFrame,
    build_frame,
    parse_frame,
    split_fragments,
    xor_checksum,
)
from .opcodes import (
    OPCODE_NAMES,
    REQUEST_TAGS,
    RESPONSE_TAGS,
    STATUS_CODE_OK,
    Opcode,
)
from .session import (
    AnkerSession,
    BatteryStatus,
    DeviceInfo,
    PortStatus,
    Transport,
)
from .tlv import Tlv, decode_tlv, encode_tlv
from .transport import LoopbackTransport, RecordingTransport, ReplayTransport
from .uuids import (
    ADVERTISED_16BIT_UUIDS,
    PRIMARY_FAMILY,
    UUID_FAMILIES,
    CommandGroup,
    UuidFamily,
    find_family,
)

__version__ = "0.1.0"


def __getattr__(name: str):
    """Expose :class:`BleTransport` without importing ``bleak`` until needed."""
    if name in ("BleTransport", "scan"):
        from . import ble

        return getattr(ble, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "__version__",
    # framing
    "AnkerFrame",
    "build_frame",
    "parse_frame",
    "split_fragments",
    "xor_checksum",
    "HEADER",
    "FLAG_ENCRYPTED",
    "FLAG_RESPONSE",
    # crypto
    "AesContext",
    "A2_STATIC_VALUE",
    "INITIAL_KEY",
    # tlv
    "Tlv",
    "encode_tlv",
    "decode_tlv",
    # opcodes
    "Opcode",
    "OPCODE_NAMES",
    "RESPONSE_TAGS",
    "REQUEST_TAGS",
    "STATUS_CODE_OK",
    # session
    "AnkerSession",
    "BatteryStatus",
    "DeviceInfo",
    "PortStatus",
    "Transport",
    # transports
    "ReplayTransport",
    "RecordingTransport",
    "LoopbackTransport",
    "BleTransport",
    "scan",
    # uuids
    "UuidFamily",
    "UUID_FAMILIES",
    "PRIMARY_FAMILY",
    "ADVERTISED_16BIT_UUIDS",
    "CommandGroup",
    "find_family",
]
