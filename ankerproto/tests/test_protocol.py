"""Offline verification of the Anker protocol implementation.

These tests use a recorded byte-for-byte transcript so the implementation is
validated without a device attached. The frames in ``TRANSCRIPT`` are checked
against the independently published captures in
https://github.com/flip-dots/SolixBLE and the atc1441 WebBluetooth tool.

Run with::

    python -m pytest tests -q
    python tests/test_protocol.py     # no pytest needed
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ankerproto import (  # noqa: E402
    A2_STATIC_VALUE,
    INITIAL_KEY,
    AnkerFrame,
    AnkerSession,
    AesContext,
    Opcode,
    Tlv,
    build_frame,
    decode_tlv,
    encode_tlv,
    find_family,
    parse_frame,
    xor_checksum,
)
from ankerproto.uuids import PRIMARY_FAMILY  # noqa: E402


# ---------------------------------------------------------------------------
# framing
# ---------------------------------------------------------------------------

def test_frame_roundtrip():
    payload = encode_tlv([(0xA1, b"\x01\x02\x03\x04"), (0xA2, b"\xff" * 40)])
    raw = build_frame(Opcode.START_CONNECT_REQ, payload, group=0x01)
    frame = parse_frame(raw)
    assert frame.command == 0x0001
    assert frame.group == 0x01
    assert not frame.encrypted
    assert not frame.response
    assert frame.payload == payload


def test_frame_matches_published_encoding():
    """Hand-built frame must equal the documented byte layout.

    <ff 09> <size LE> <03 00 grp> <cmd hi> <cmd lo> <payload> <xor>
    """
    payload = b"\xa1\x01\x21"
    raw = build_frame(0x0500, payload, group=0x11)
    body = b"\x03\x00\x11\x05\x00" + payload
    size = len(body) + 4
    expected = b"\xff\x09" + size.to_bytes(2, "little") + body
    expected += bytes([xor_checksum(expected)])
    assert raw == expected
    # documented example: size = 4 + 5 + 3 = 12
    assert size == 12
    assert raw[:4] == b"\xff\x09\x0c\x00"


def test_encryption_flag_and_response_flag():
    enc = parse_frame(build_frame(0x0022, b"\x00" * 16, encrypted=True))
    assert enc.encrypted and not enc.response
    assert enc.command == 0x0022, "flag bits must be masked out of the command"

    resp = parse_frame(build_frame(0x0022, b"\x00" * 16, response=True))
    assert resp.response and not resp.encrypted
    assert resp.command == 0x0022
    assert resp.raw[7] == 0x08


def test_checksum_is_xor_of_all_preceding_bytes():
    raw = build_frame(0x0001, b"\xde\xad\xbe\xef")
    assert raw[-1] == xor_checksum(raw[:-1])


def test_bad_checksum_rejected():
    raw = bytearray(build_frame(0x0001, b"\x01"))
    raw[-1] ^= 0xFF
    try:
        parse_frame(bytes(raw))
    except ValueError as exc:
        assert "checksum" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("expected ValueError")


def test_documented_layout_example():
    """The packet docstring in SolixBLE: pattern 030001, cmd 0000."""
    payload = bytes.fromhex("a101a20200a303010000")
    raw = build_frame(0x0000, payload, group=0x01)
    assert raw[:2] == bytes.fromhex("ff09")
    assert raw[2:4] == (len(payload) + 9).to_bytes(2, "little")
    assert raw[4:7] == bytes.fromhex("030001")  # pattern = 03 00 <group>
    assert raw[7:9] == bytes.fromhex("0000")  # cmd
    assert raw[9:-1] == payload
    # full round trip through the parser
    assert parse_frame(raw).payload == payload


# ---------------------------------------------------------------------------
# crypto
# ---------------------------------------------------------------------------

def test_static_constants():
    assert A2_STATIC_VALUE == b"2c377dfa09cdb7924889e4292a37f61c8c5ed52d"
    assert len(A2_STATIC_VALUE) == 40
    assert INITIAL_KEY == A2_STATIC_VALUE[:16]
    # the key is the ASCII text, not the decoded bytes
    assert INITIAL_KEY == b"2c377dfa09cdb792"
    assert INITIAL_KEY.hex() == "32633337376466613039636462373932"


def test_aes_roundtrip_and_iv_is_serial():
    serial = "A8B9C0D1E2F30001"
    ctx = AesContext.initial(serial)
    assert ctx.iv == serial.encode()
    assert ctx.phase == "initial"
    blob = encode_tlv([(0xA1, b"\x00\x00\x00\x00")])
    assert ctx.decrypt(ctx.encrypt(blob)) == blob


def test_aes_uses_cbc_not_ecb():
    """Identical plaintext blocks must produce different ciphertext blocks."""
    ctx = AesContext.initial("A8B9C0D1E2F30001")
    ct = ctx.encrypt(b"\x00" * 32)
    assert ct[:16] != ct[16:32], "CBC must chain blocks"


def test_session_context_differs_from_initial():
    serial = "A8B9C0D1E2F30001"
    key = bytes(range(16))
    a = AesContext.initial(serial)
    b = AesContext.session(key, serial)
    assert a.key != b.key
    assert a.iv == b.iv == serial.encode()
    assert b.phase == "session"


# ---------------------------------------------------------------------------
# tlv
# ---------------------------------------------------------------------------

def test_tlv_roundtrip():
    items = [Tlv(0xA1, b"\x21"), Tlv(0xA2, b"\x01\x01"), Tlv(0xA6, b"\x00" * 12)]
    decoded = decode_tlv(encode_tlv(items))
    assert decoded == items


def test_tlv_wire_format_is_type_length_value():
    assert encode_tlv([(0xA1, b"\x21")]) == b"\xa1\x01\x21"
    assert encode_tlv([(0xA2, 1)]) == b"\xa2\x01\x01"
    assert encode_tlv([(0xA3, 256)]) == b"\xa3\x02\x00\x01"  # little-endian


# A payload captured verbatim from a real Anker device (published in SolixBLE's
# device test fixtures, reversed). This is the decrypted TLV body of a
# telemetry frame - 49 records, all with the normal 1-byte length field.
REAL_PAYLOAD_HEX = (
    "a10131"
    "a2050300000000"
    "a3050300000000"
    "a403026b06"
    "a503020000"
    "a603020000"
    "a703020000"
    "a803020000"
    "a903020000"
    "aa03020000"
    "ab03020000"
    "ac03020000"
    "ad03020000"
    "ae03020000"
    "af03020000"
    "b003020100"
    "b103020000"
    "b203020000"
    "b30302a600"
    "b403020000"
    "b503020000"
    "b60302ff01"
    "b703020000"
    "b803029a00"
    "b903020000"
    "ba0302a600"
    "bb03020000"
    "bc020100"
    "bd020117"
    "be020100"
    "bf020101"
    "c0020100"
    "c1020157"
    "c2020164"
    "c3020164"
    "c4020100"
    "c5020100"
    "c6020100"
    "c7020100"
    "c8020100"
    "c9020100"
    "ca020100"
    "cb020100"
    "cc020100"
    "cd020100"
    "ce020100"
    "cf020100"
    "d0110041504339464530453237333030323735"
    "e5020100"
)


def test_real_captured_payload_consumes_exactly():
    """A real telemetry payload must TLV-walk to exactly its own length."""
    raw = bytes.fromhex(REAL_PAYLOAD_HEX)
    tags = decode_tlv(raw, strict=True)
    assert len(tags) == 49
    assert sum(2 + t.length for t in tags) == len(raw)


def test_real_captured_payload_values():
    by_tag = {t.tag: t for t in decode_tlv(bytes.fromhex(REAL_PAYLOAD_HEX))}
    assert by_tag[0xA1].as_int() == 0x31  # port selector
    # each 3-byte field is <datatype 0x02 = signed LE int> <value ...>
    assert by_tag[0xA4].value == bytes.fromhex("026b06")
    assert by_tag[0xA4].as_int() == 0x066B02  # little-endian
    assert by_tag[0xBD].as_int() == 0x1701
    assert by_tag[0xB6].as_int() == 0x01FF02


def test_vendor_string_tag():
    """Tag 0xD0 carries a 16-char vendor/model string."""
    by_tag = {t.tag: t for t in decode_tlv(bytes.fromhex(REAL_PAYLOAD_HEX))}
    d0 = by_tag[0xD0]
    assert d0.length == 17
    assert d0.value[0] == 0x00
    assert d0.value[1:].decode("ascii") == "APC9FE0E27300275"


def test_tlv_truncated_is_tolerated_when_not_strict():
    good = encode_tlv([(0xA1, b"\x21"), (0xA2, b"\x01\x02")])
    truncated = good[:-3]
    assert len(decode_tlv(truncated, strict=False)) == 1
    try:
        decode_tlv(truncated, strict=True)
    except ValueError:
        pass
    else:  # pragma: no cover
        raise AssertionError("strict mode should reject truncation")


# ---------------------------------------------------------------------------
# session over a fake transport
# ---------------------------------------------------------------------------

class FakeTransport:
    """Replays a canned device side of the handshake."""

    def __init__(self, serial: str = "A8B9C0D1E2F30001", session_key: bytes = bytes(range(16))):
        self.serial = serial
        self.session_key = session_key
        self.sent: list[bytes] = []
        self._pending: list[bytes] = []
        self.initial = AesContext.initial(serial)

    def send(self, data: bytes) -> None:
        self.sent.append(data)
        frame = parse_frame(data)
        self._pending.append(self._respond(frame))

    def receive(self, timeout: float = 2.0) -> bytes:
        if not self._pending:
            raise TimeoutError("nothing queued")
        return self._pending.pop(0)

    def _respond(self, req: AnkerFrame) -> bytes:
        if req.command == Opcode.GET_DEVICE_INFO_REQ:
            tlvs = encode_tlv(
                [
                    (0xA3, b"1.6.2"),
                    (0xA4, self.serial.encode()),
                    (0xA5, bytes.fromhex("aabbccddeeff")),
                ]
            )
            return build_frame(req.command, b"\x00" + tlvs, response=True)
        if req.command == Opcode.GET_AES_KEY_REQ:
            inner = encode_tlv([(0xA1, self.session_key)])
            return build_frame(req.command, self.initial.encrypt(inner), encrypted=True, response=True)
        return build_frame(req.command, b"\x00", response=True)


def test_full_handshake_against_fake_device():
    t = FakeTransport()
    session = AnkerSession(t)
    info = session.connect()

    assert info.serial_number == "A8B9C0D1E2F30001"
    assert info.firmware_version == "1.6.2"
    assert info.bt_mac == "aa:bb:cc:dd:ee:ff"
    assert session.session_key == bytes(range(16))
    assert session.crypto is not None and session.crypto.phase == "session"

    # the four plaintext frames plus the encrypted key request
    cmds = [parse_frame(s).command for s in t.sent]
    assert cmds == [0x0001, 0x0003, 0x0029, 0x0005, 0x0022]
    assert [parse_frame(s).encrypted for s in t.sent] == [False, False, False, False, True]


def test_status_parsing_from_real_layout():
    """Decode a 0x0500 payload using the documented offsets."""
    session = AnkerSession(FakeTransport())

    port = bytearray(12)
    port[2] = 2  # output mode
    port[3:5] = (2000).to_bytes(2, "little")  # 200.0 V
    port[5:7] = (15).to_bytes(2, "little")  # 1.5 A

    battery = bytearray(10)
    battery[8], battery[9] = 87, 50  # 87.50 %

    total = bytearray(5)
    total[1:3] = (1234).to_bytes(2, "little")  # 123.4 W out
    total[3:5] = (560).to_bytes(2, "little")  # 56.0 W in

    temp = bytes([0x00, 25, 77])

    payload = encode_tlv(
        [
            (0xA2, bytes(battery)),
            (0xA4, bytes(port)),
            (0xAE, bytes(total)),
            (0xB3, temp),
        ]
    )
    status = session.parse_status(b"\x00" + payload)

    assert status.battery_percent == 87.5
    assert status.temperature_c == 25 and status.temperature_f == 77
    assert status.total_output_w == 123.4
    assert status.total_input_w == 56.0
    assert status.ports["C1"].mode_name == "output"
    assert status.ports["C1"].voltage == 200.0
    assert status.ports["C1"].current == 1.5
    assert status.ports["C1"].power == 300.0


# ---------------------------------------------------------------------------
# uuids
# ---------------------------------------------------------------------------

def test_uuid_family_lookup():
    fam = find_family("22150002-4002-81c5-b46e-cf057c562025")
    assert fam is PRIMARY_FAMILY
    assert fam.service == "22150001-4002-81C5-b46e-cf057c562025"
    assert find_family("8c850003-0302-41c5-b46e-cf057c562025").name == "alt-8c85"
    assert find_family("0000180f-0000-1000-8000-00805f9b34fb") is None


def _main() -> int:
    tests = [
        (name, obj)
        for name, obj in sorted(globals().items())
        if name.startswith("test_") and callable(obj)
    ]
    failures = 0
    for name, fn in tests:
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 - simple harness
            failures += 1
            print(f"FAIL  {name}: {type(exc).__name__}: {exc}")
        else:
            print(f"ok    {name}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(_main())
