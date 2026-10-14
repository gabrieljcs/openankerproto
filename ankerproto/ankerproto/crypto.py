"""Anker BLE session crypto.

The Anker "ZX" BLE protocol uses **AES-128 in CBC mode** with a *fixed*
initialisation vector per session phase. There is no ECDH on the wire for the
2215-family (Prime power banks): the whole scheme is two static, app-wide
secrets plus a serial number that the device hands out during an unencrypted
handshake.

Three phases
------------

1. **Plaintext handshake.** Commands ``0x0001``, ``0x0003``, ``0x0029``,
   ``0x0005`` are exchanged with no encryption. The response to ``0x0029``
   (:data:`OP_GET_DEVICE_INFO`) contains TLV tags ``A3`` (firmware version),
   ``A4`` (serial number) and ``A5`` (BT MAC address).

2. **"Initial" encryption.** Key = :data:`INITIAL_KEY`, IV = the device serial
   number as ASCII. The app sends command ``0x0022`` (:data:`OP_GET_AES_KEY`)
   with this context. The device answers with a fresh 16-byte session key in
   TLV tag ``A1``.

3. **"Session" encryption.** Key = the 16-byte session key from step 2, IV =
   the serial number again. All further commands use this context.

Because the phase-1 key is derived only from public constants, anyone who can
read the serial number (it is readable in plaintext during the handshake) can
derive the session key. This is a link-layer obfuscation scheme, not a security
boundary.

Passwords are handled separately: the app registers the user with
``loginPasswordECDH`` / ``SecureEcdhConfer`` (real ECDH, see
``secure_ecdh_confer.dart``), but that is *account authentication*, not link
encryption.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad

__all__ = [
    "A2_STATIC_VALUE",
    "INITIAL_KEY",
    "OP_GET_AES_KEY",
    "OP_GET_DEVICE_INFO",
    "AesContext",
]

#: 40-byte static blob sent in TLV tag ``A2`` on every handshake frame.
#: Stored in the app as the ASCII string below, i.e. it is itself hex text.
A2_STATIC_VALUE = b"2c377dfa09cdb7924889e4292a37f61c8c5ed52d"

#: The first 16 bytes of :data:`A2_STATIC_VALUE` used verbatim as the AES-128
#: key for the "Initial" phase.
INITIAL_KEY = A2_STATIC_VALUE[:16]

#: Command ``0x0022`` - request the 16-byte session key (encrypted).
OP_GET_AES_KEY = 0x0022
#: Command ``0x0029`` - returns firmware version, serial number and BT MAC.
OP_GET_DEVICE_INFO = 0x0029


@dataclass
class AesContext:
    """AES-128-CBC context whose IV is always the device serial number.

    >>> ctx = AesContext.initial("ABCDEFGH12345678")
    >>> roundtrip = ctx.decrypt(ctx.encrypt(b"hello"))
    >>> roundtrip
    b'hello'
    """

    key: bytes
    iv: bytes
    phase: str = "session"

    def __post_init__(self) -> None:
        if len(self.key) != 16:
            raise ValueError(f"AES-128 key must be 16 bytes, got {len(self.key)}")
        if len(self.iv) != 16:
            raise ValueError(f"AES-CBC IV must be 16 bytes, got {len(self.iv)}")

    # -- constructors ---------------------------------------------------
    @classmethod
    def initial(cls, serial_number: str) -> "AesContext":
        """Phase-2 context: static key, serial number as IV."""
        return cls(
            key=INITIAL_KEY,
            iv=_serial_iv(serial_number),
            phase="initial",
        )

    @classmethod
    def session(cls, session_key: bytes, serial_number: str) -> "AesContext":
        """Phase-3 context: device-supplied session key, serial number as IV."""
        return cls(
            key=bytes(session_key),
            iv=_serial_iv(serial_number),
            phase="session",
        )

    # -- primitives -----------------------------------------------------
    def encrypt(self, plaintext: bytes) -> bytes:
        """PKCS#7-pad and encrypt."""
        return AES.new(self.key, AES.MODE_CBC, self.iv).encrypt(pad(plaintext, 16))

    def decrypt(self, ciphertext: bytes) -> bytes:
        """Decrypt and strip PKCS#7 padding."""
        if len(ciphertext) == 0 or len(ciphertext) % 16:
            raise ValueError(
                f"ciphertext must be a non-zero multiple of 16, got {len(ciphertext)}"
            )
        return unpad(AES.new(self.key, AES.MODE_CBC, self.iv).decrypt(ciphertext), 16)


def _serial_iv(serial_number: str) -> bytes:
    """The IV is the serial number, NUL-padded or truncated to 16 bytes.

    Devices in the field report 16-char serials; we normalise defensively so a
    shorter or longer serial still yields a usable IV.
    """
    raw = serial_number.encode("ascii", "replace")
    return (raw + b"\x00" * 16)[:16]
