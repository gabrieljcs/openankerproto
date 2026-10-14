"""GATT service/characteristic UUID families and protocol constants.

Recovered from ``libapp.so`` (Dart AOT object pool) of
``Anker_3.8.0_release_mp_202505250018_encrypt.apk``.

Anker ships three 128-bit service families in the charging app. They share the
same 3-characteristic layout, so the transport code is identical; only the UUID
base differs. Anker has clearly kept the layout stable across generations and
only rotated the first 32 bits (which encode the model/SoC family).

===========================================  ===========================
Service (advertised + primary)               Family
===========================================  ===========================
``22150001-4002-81C5-b46e-cf057c562025``     Prime power banks (A1340/A1780/
                                             A1781/A1782/A1790, A17A0...)
``25400001-4002-81C5-b46e-cf057c562025``     second-generation power banks
``41580001-4002-81C5-b46e-cf057c562025``     chargers / desktop stations
``8C850001-0302-41C5-b46e-cf057c562025``     alternate base (0302 variant)
===========================================  ===========================

Within each family the characteristic offsets are consistent:

* ``...0001`` - service UUID, also present in the advertisement
* ``...0002`` - WRITE  (write-without-response)
* ``...0003`` - NOTIFY (subscribe for responses)

16-bit UUIDs also present in the app (used for advertising filters and by
older/adjacent product lines): ``0xFF09``, ``0xEF0A``, ``0xEF0B``, ``0x1770``,
``0x1780``, ``0x17A0``/``0x17A1``/``0x17A2``.
"""

from __future__ import annotations

from dataclasses import dataclass

__all__ = [
    "UuidFamily",
    "UUID_FAMILIES",
    "PRIMARY_FAMILY",
    "ADVERTISED_16BIT_UUIDS",
    "find_family",
    "CommandGroup",
]


@dataclass(frozen=True)
class UuidFamily:
    """One Anker GATT service family."""

    name: str
    service: str
    write: str
    notify: str
    #: 16-bit shorthand the device also advertises (``None`` if unknown).
    advertised_16bit: int | None = None

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        return f"{self.name} ({self.service})"


#: The Anker Prime family, used by every device the community has documented so
#: far and the one this client defaults to.
PRIMARY_FAMILY = UuidFamily(
    name="prime-2215",
    service="22150001-4002-81C5-b46e-cf057c562025",
    write="22150002-4002-81c5-b46e-cf057c562025",
    notify="22150003-4002-81c5-b46e-cf057c562025",
    advertised_16bit=0x2215,
)

UUID_FAMILIES: tuple[UuidFamily, ...] = (
    PRIMARY_FAMILY,
    UuidFamily(
        name="gen2-2540",
        service="25400001-4002-81c5-b46e-cf057c562025",
        write="25400002-4002-81c5-b46e-cf057c562025",
        notify="25400003-4002-81c5-b46e-cf057c562025",
        advertised_16bit=0x2540,
    ),
    UuidFamily(
        name="station-4158",
        service="41580001-4002-81c5-b46e-cf057c562025",
        write="41580002-4002-81c5-b46e-cf057c562025",
        notify="41580003-4002-81c5-b46e-cf057c562025",
    ),
    UuidFamily(
        name="alt-8c85",
        service="8c850001-0302-41c5-b46e-cf057c562025",
        write="8c850002-0302-41c5-b46e-cf057c562025",
        notify="8c850003-0302-41c5-b46e-cf057c562025",
    ),
)

#: Service UUIDs to filter on while scanning.
ADVERTISED_16BIT_UUIDS: tuple[int, ...] = (
    0x2215,
    0x2540,
    0xFF09,
    0xEF0A,
    0xEF0B,
)


def find_family(uuid: str) -> UuidFamily | None:
    """Return the family a service UUID belongs to, case-insensitively."""
    needle = uuid.lower()
    for fam in UUID_FAMILIES:
        if fam.service.lower() == needle or fam.write.lower() == needle:
            return fam
    # Fall back to matching on the trailing (shared) part of the UUID.
    for fam in UUID_FAMILIES:
        if needle.endswith(fam.service.lower()[8:]):
            return fam
    return None


class CommandGroup:
    """Logical channels encoded in byte 2 of the frame pattern (``03 00 <grp>``)."""

    #: Handshake, capability negotiation, keys, binding, OTA.
    MANAGEMENT = 0x01
    #: Port/telemetry channel used by the Prime power banks.
    POWER = 0x11
