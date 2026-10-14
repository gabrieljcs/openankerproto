"""High-level Anker device session.

This is the transport-agnostic core: it turns protocol intent ("connect",
"read status", "set the beep") into frames, and turns inbound frames back into
Python values.

:class:`AnkerSession` deliberately knows nothing about BLE. It is driven by any
object implementing :class:`Transport`, which makes the whole protocol testable
offline and reusable over a serial link, an ESP32 bridge or a network tunnel.

Typical use with the bundled BLE transport::

    from ankerproto import AnkerSession, BleTransport, PRIMARY_FAMILY

    with BleTransport(PRIMARY_FAMILY) as t:
        session = AnkerSession(t)
        session.connect()          # handshake + key exchange
        status = session.read_status()
        print(status.battery_percent, status.ports)
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Callable, Protocol

from .crypto import A2_STATIC_VALUE, AesContext
from .framing import AnkerFrame, build_frame, parse_frame
from .opcodes import (
    HANDSHAKE_A3_CAPABILITY,
    HANDSHAKE_A4_CAPABILITY,
    HANDSHAKE_A5_CAPABILITY,
    OP_LIVE_POWER,
    OP_SET_BEEP,
    OP_SET_THEME,
    OP_TEMPERATURE,
    STATUS_CODE_OK,
    Opcode,
)
from .tlv import Tlv, decode_tlv, encode_tlv

log = logging.getLogger("ankerproto")

__all__ = ["Transport", "AnkerSession", "DeviceInfo", "BatteryStatus", "PortStatus"]


class Transport(Protocol):
    """Minimal duplex byte transport."""

    def send(self, data: bytes) -> None:  # pragma: no cover - protocol
        ...

    def receive(self, timeout: float = 2.0) -> bytes:  # pragma: no cover
        ...


@dataclass
class PortStatus:
    """State of one DC output port."""

    name: str
    mode: int = 0
    voltage: float = 0.0
    current: float = 0.0

    @property
    def power(self) -> float:
        return round(self.voltage * self.current, 2)

    @property
    def mode_name(self) -> str:
        return {0: "off", 1: "input", 2: "output"}.get(self.mode, f"unknown({self.mode})")


@dataclass
class BatteryStatus:
    """Decoded ``0x0500`` comprehensive status."""

    battery_percent: float | None = None
    temperature_c: int | None = None
    temperature_f: int | None = None
    total_output_w: float | None = None
    total_input_w: float | None = None
    ports: dict[str, PortStatus] = field(default_factory=dict)
    raw_tags: dict[int, bytes] = field(default_factory=dict)

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        bits = []
        if self.battery_percent is not None:
            bits.append(f"{self.battery_percent:.2f}%")
        if self.temperature_c is not None:
            bits.append(f"{self.temperature_c}C/{self.temperature_f}F")
        if self.total_output_w is not None:
            bits.append(f"out={self.total_output_w}W in={self.total_input_w}W")
        for p in self.ports.values():
            if p.mode:
                bits.append(f"{p.name}:{p.mode_name} {p.voltage}V {p.current}A {p.power}W")
        return " | ".join(bits) if bits else "<no data>"


@dataclass
class DeviceInfo:
    """Result of the plaintext handshake."""

    serial_number: str | None = None
    firmware_version: str | None = None
    bt_mac: str | None = None


class AnkerSession:
    """Drives an authenticated, encrypted session with an Anker device."""

    def __init__(
        self,
        transport: Transport,
        *,
        group: int = 0x01,
        status_group: int = 0x11,
        timeout: float = 2.0,
    ) -> None:
        self.transport = transport
        self.group = group
        self.status_group = status_group
        self.timeout = timeout
        self.info = DeviceInfo()
        self.crypto: AesContext | None = None
        self.session_key: bytes | None = None
        #: Every frame seen, for debugging and for the offline test harness.
        self.history: list[AnkerFrame] = []

    # -- low level ------------------------------------------------------
    def _exchange(
        self,
        command: int,
        tlvs: list[Tlv | tuple[int, bytes]] | None = None,
        *,
        group: int | None = None,
        encrypt: bool | None = None,
    ) -> AnkerFrame:
        """Send one command and return the matching response frame.

        ``encrypt`` defaults to "yes once a crypto context exists".
        """
        if encrypt is None:
            encrypt = self.crypto is not None
        grp = self.group if group is None else group

        plaintext = encode_tlv(tlvs or [])
        payload = self.crypto.encrypt(plaintext) if encrypt else plaintext
        frame = build_frame(command, payload, group=grp, encrypted=encrypt)
        log.debug("-> %s %s", command, frame.hex())
        self.transport.send(frame)

        return self._await_response(command)

    def _await_response(self, command: int) -> AnkerFrame:
        deadline = time.monotonic() + self.timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"no response to {command:#06x} within {self.timeout}s")
            raw = self.transport.receive(remaining)
            try:
                parsed = parse_frame(raw)
            except ValueError as exc:
                log.warning("dropping malformed frame: %s", exc)
                continue

            # Command 0x0822 carries the session key; it is encrypted with the
            # *initial* context, so decrypt before routing.
            decrypted = self._maybe_decrypt(parsed)
            routed = parsed if decrypted is None else decrypted
            self.history.append(routed)
            if routed.command == command and routed.response:
                return routed
            log.debug("ignoring frame %s while waiting for %#06x", routed, command)

    def _maybe_decrypt(self, frame: AnkerFrame) -> AnkerFrame | None:
        if not frame.encrypted or self.crypto is None:
            return None
        try:
            plain = self.crypto.decrypt(frame.payload)
        except Exception as exc:  # noqa: BLE001 - padding/oracle noise
            log.debug("decrypt failed for %s: %s", frame, exc)
            return None
        return AnkerFrame(
            group=frame.group,
            command=frame.command,
            payload=plain,
            encrypted=False,
            response=frame.response,
            raw=frame.raw,
        )

    # -- handshake ------------------------------------------------------
    def connect(self, *, password: str | None = None) -> DeviceInfo:
        """Run the full plaintext handshake, then establish the session key.

        After this returns, :attr:`crypto` is the session context and
        :attr:`info` is populated.
        """
        timestamp = int(time.time()).to_bytes(4, "little")
        a1 = Tlv(0xA1, timestamp)
        a2 = Tlv(0xA2, A2_STATIC_VALUE)

        # 1. startConnectReq
        self._exchange(Opcode.START_CONNECT_REQ, [a1, a2], encrypt=False)
        # 2. capabilityNegotiationReq
        self._exchange(
            Opcode.CAPABILITY_NEGOTIATION_REQ,
            [a1, a2, Tlv(0xA3, HANDSHAKE_A3_CAPABILITY), Tlv(0xA4, HANDSHAKE_A4_CAPABILITY)],
            encrypt=False,
        )
        # 3. getDeviceInfoReq -> serial number, firmware, MAC
        info_frame = self._exchange(Opcode.GET_DEVICE_INFO_REQ, [a1, a2], encrypt=False)
        self._parse_device_info(info_frame)

        # 4. setCapabilityReq
        self._exchange(
            Opcode.SET_CAPABILITY_REQ,
            [
                a1,
                a2,
                Tlv(0xA3, HANDSHAKE_A3_CAPABILITY),
                Tlv(0xA4, HANDSHAKE_A4_CAPABILITY),
                Tlv(0xA5, HANDSHAKE_A5_CAPABILITY),
            ],
            encrypt=False,
        )

        if not self.info.serial_number:
            raise RuntimeError("device did not report a serial number during handshake")

        # 5. Initial-key phase: ask for the session key with the static key.
        self.crypto = AesContext.initial(self.info.serial_number)
        key_frame = self._exchange(
            Opcode.GET_AES_KEY_REQ,
            [
                a1,
                a2,
                Tlv(0xA3, b"\x00" * 4),
                Tlv(0xA5, b"\x00" * 40),
            ],
        )
        session_key = self._extract_session_key(key_frame)
        if session_key is None:
            raise RuntimeError(
                "device did not return a 16-byte session key in TLV 0xA1 "
                f"(got tags {[hex(t.tag) for t in decode_tlv(key_frame.payload)]})"
            )
        self.session_key = session_key
        self.crypto = AesContext.session(session_key, self.info.serial_number)
        log.info(
            "session established with %s (fw %s)",
            self.info.serial_number,
            self.info.firmware_version,
        )
        return self.info

    # -- parsers --------------------------------------------------------
    def _parse_device_info(self, frame: AnkerFrame) -> None:
        # Unencrypted replies in the handshake skip a leading status byte.
        payload = frame.payload[1:] if frame.payload[:1] == b"\x00" else frame.payload
        for tag in decode_tlv(payload, strict=False):
            if tag.tag == 0xA3:
                self.info.firmware_version = tag.as_ascii().strip("\x00")
            elif tag.tag == 0xA4:
                self.info.serial_number = tag.as_ascii().strip("\x00")
            elif tag.tag == 0xA5:
                mac = tag.value.hex()
                self.info.bt_mac = ":".join(mac[i : i + 2] for i in range(0, len(mac), 2))
        log.debug("device info: %s", self.info)

    @staticmethod
    def _extract_session_key(frame: AnkerFrame) -> bytes | None:
        payload = frame.payload[1:] if frame.payload[:1] == b"\x00" else frame.payload
        for tag in decode_tlv(payload, strict=False):
            if tag.tag == 0xA1 and len(tag.value) == 16:
                return tag.value
        return None

    # -- commands -------------------------------------------------------
    def read_status(self) -> BatteryStatus:
        """``0x0500`` comprehensive status dump."""
        frame = self._exchange(
            Opcode.POST_A17B1_DEVICE_INFO_REQ,
            [Tlv(0xA1, b"\x21")],
            group=self.status_group,
        )
        return self.parse_status(frame.payload)

    def read_live_power(self) -> BatteryStatus:
        """``0x050E`` live port power (higher rate than the full dump)."""
        frame = self._exchange(OP_LIVE_POWER, [Tlv(0xA1, b"\x21")], group=self.status_group)
        return self.parse_status(frame.payload, live=True)

    def read_temperature(self) -> tuple[int | None, int | None]:
        """``0x0522`` dedicated temperature report."""
        frame = self._exchange(OP_TEMPERATURE, [Tlv(0xA1, b"\x21")], group=self.status_group)
        payload = self._strip_status(frame.payload)
        for tag in decode_tlv(payload, strict=False):
            if tag.tag == 0xA2 and len(tag.value) >= 3:
                return tag.value[1], tag.value[2]
        return None, None

    def set_theme(self, advanced: bool) -> None:
        """``0x0504`` - switch the power bank's on-device display theme."""
        self._exchange(
            OP_SET_THEME,
            [Tlv(0xA1, b"\x21"), Tlv(0xA2, bytes([0x01, 0x01 if advanced else 0x00]))],
            group=self.status_group,
        )

    def set_beep(self, enabled: bool) -> None:
        """``0x0505`` - enable/disable the power bank's beeper."""
        self._exchange(
            OP_SET_BEEP,
            [Tlv(0xA1, b"\x21"), Tlv(0xA2, bytes([0x01, 0x01 if enabled else 0x00]))],
            group=self.status_group,
        )

    # -- decoding helpers -----------------------------------------------
    @staticmethod
    def _strip_status(payload: bytes) -> bytes:
        return payload[1:] if payload[:1] == bytes([STATUS_CODE_OK]) else payload

    def parse_status(self, payload: bytes, *, live: bool = False) -> BatteryStatus:
        """Decode a status payload into :class:`BatteryStatus`.

        ``live=False`` expects the ``0x0500`` layout (tags A2/A4/A5/A6/AE/B3);
        ``live=True`` expects the ``0x050E`` layout (tags A2/A3/A4/A6/A8).
        """
        body = self._strip_status(payload)
        status = BatteryStatus()

        port_tags = (
            {0xA2: "C1", 0xA3: "C2", 0xA4: "A"} if live else {0xA4: "C1", 0xA5: "C2", 0xA6: "A"}
        )

        for tag in decode_tlv(body, strict=False):
            status.raw_tags[tag.tag] = tag.value

            if tag.tag in port_tags:
                port = self._parse_port(port_tags[tag.tag], tag.value)
                if port:
                    status.ports[port.name] = port

            elif tag.tag == 0xA2 and not live and len(tag.value) >= 10:
                status.battery_percent = tag.value[8] + tag.value[9] / 100.0

            elif tag.tag == 0xA8 and live and len(tag.value) >= 10:
                status.battery_percent = tag.value[8] + tag.value[9] / 100.0

            elif tag.tag == 0xAE and len(tag.value) >= 5:
                status.total_output_w = round(int.from_bytes(tag.value[1:3], "little") / 10.0, 2)
                status.total_input_w = round(int.from_bytes(tag.value[3:5], "little") / 10.0, 2)

            elif tag.tag == 0xB3 and len(tag.value) >= 3:
                status.temperature_c = tag.value[1]
                status.temperature_f = tag.value[2]

        return status

    @staticmethod
    def _parse_port(name: str, value: bytes) -> PortStatus | None:
        if len(value) < 12:
            return None
        port = PortStatus(name=name, mode=value[2])
        if port.mode != 0:
            port.voltage = round(int.from_bytes(value[3:5], "little") / 10.0, 2)
            port.current = round(int.from_bytes(value[5:7], "little") / 10.0, 3)
        return port
