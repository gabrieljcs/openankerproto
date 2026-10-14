"""TLV encoding and decoding for Anker payloads.

Inside a frame's ``payload`` the data is a flat sequence of Type-Length-Value
records::

    <type 1B> <length 1B> <value length B> ...

Tags below ``0xA0`` are fixed, single-byte fields. Tags from ``0xA1`` upward are
"generic" fields whose meaning depends on the *direction*: in a request the tag
identifies a field the caller is setting; in a response the same byte identifies
the field being reported. This is why the same tag number carries different
names in :data:`ankerproto.opcodes.REQUEST_TAGS` and
:data:`ankerproto.opcodes.RESPONSE_TAGS`.

Some firmware uses a wider length field for a few tags; pass
``length_overrides`` to model that.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Iterator, Mapping, Sequence

__all__ = ["Tlv", "encode_tlv", "decode_tlv", "TlvError"]


class TlvError(ValueError):
    """Raised when a TLV stream is malformed."""


@dataclass(frozen=True)
class Tlv:
    """One Type-Length-Value record."""

    tag: int
    value: bytes

    @property
    def length(self) -> int:
        return len(self.value)

    def as_int(self, byteorder: str = "little", signed: bool = False) -> int:
        return int.from_bytes(self.value, byteorder, signed=signed)

    def as_str(self, encoding: str = "utf-8", errors: str = "replace") -> str:
        return self.value.decode(encoding, errors)

    def as_ascii(self) -> str:
        return self.value.decode("ascii", "replace")

    def as_hex(self) -> str:
        return self.value.hex()

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        return f"Tlv(0x{self.tag:02X}, {self.length}B) = {self.value.hex()}"


def encode_tlv(
    items: Iterable[Tlv | tuple[int, bytes] | tuple[int, int]],
) -> bytes:
    """Serialise TLV records.

    Accepts :class:`Tlv` instances, ``(tag, bytes)`` pairs, or
    ``(tag, int)`` pairs (in which case the integer is stored in the fewest
    little-endian bytes needed, minimum one).
    """
    out = bytearray()
    for item in items:
        if isinstance(item, Tlv):
            tag, value = item.tag, item.value
        else:
            tag, raw = item
            value = (
                raw.to_bytes(max(1, (raw.bit_length() + 7) // 8), "little")
                if isinstance(raw, int)
                else bytes(raw)
            )
        if not 0 <= tag <= 0xFF:
            raise TlvError(f"tag out of range: {tag}")
        if len(value) > 0xFF:
            raise TlvError(f"value for tag 0x{tag:02X} exceeds 255 bytes")
        out.append(tag)
        out.append(len(value))
        out.extend(value)
    return bytes(out)


def decode_tlv(
    data: bytes,
    offset: int = 0,
    *,
    length_overrides: Mapping[int, int] | None = None,
    strict: bool = True,
) -> list[Tlv]:
    """Decode a TLV stream starting at ``offset``.

    ``length_overrides`` maps a tag to a fixed length, for the handful of tags
    whose length field is wider or narrower than one byte.

    With ``strict=False`` a truncated trailing record is dropped rather than
    raising, which is what the device's own parser does when a frame is cut
    short.
    """
    overrides = dict(length_overrides or {})
    out: list[Tlv] = []
    i = offset
    while i < len(data):
        if i + 2 > len(data):
            if strict:
                raise TlvError(f"truncated TLV header at offset {i}")
            break
        tag = data[i]
        if tag in overrides:
            width = overrides[tag]
        else:
            width = 1
        if i + 1 + width > len(data):
            if strict:
                raise TlvError(f"truncated length field for tag 0x{tag:02X} at {i}")
            break
        length = int.from_bytes(data[i + 1 : i + 1 + width], "little")
        start = i + 1 + width
        end = start + length
        if end > len(data):
            if strict:
                raise TlvError(
                    f"tag 0x{tag:02X} at offset {i} declares {length} bytes "
                    f"but only {len(data) - start} remain"
                )
            break
        out.append(Tlv(tag, bytes(data[start:end])))
        i = end
    return out


def iter_tlv(data: bytes, offset: int = 0) -> Iterator[Tlv]:
    """Lazily iterate TLV records (same rules as :func:`decode_tlv`)."""
    yield from decode_tlv(data, offset)
