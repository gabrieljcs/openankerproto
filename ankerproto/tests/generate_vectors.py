#!/usr/bin/env python3
"""Generate the frozen cross-implementation protocol vectors.

Writes ``tests/vectors.json``, which is the contract between the Python client
(``ankerproto/``) and the JavaScript client (``web/``). Both test suites assert
against it, so any divergence between the two implementations fails a build.

Run after changing anything that affects the wire format:

    cd ankerproto && python tests/generate_vectors.py
    cd web && npm run sync-vectors

The vectors are deliberately *behavioural*, not snapshots of internal state:
every entry is something a peer on the wire could observe.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from Crypto.Util.Padding import pad  # noqa: E402

from ankerproto.crypto import A2_STATIC_VALUE, INITIAL_KEY, AesContext  # noqa: E402
from ankerproto.framing import build_frame  # noqa: E402
from ankerproto.opcodes import OPCODE_NAMES  # noqa: E402
from ankerproto.tlv import decode_tlv, encode_tlv  # noqa: E402
from ankerproto.uuids import UUID_FAMILIES  # noqa: E402

# A real decrypted telemetry payload from a 2215-family device, published in
# flip-dots/SolixBLE's device test fixtures. 49 TLV records.
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

SERIALS = ["A8B9C0D1E2F30001", "1234567890ABCDEF"]
PLAINTEXTS = ["a10100000000", "a10131"]


def build() -> dict:
    vectors: dict[str, object] = {}

    # --- framing ---------------------------------------------------------
    frames = []
    cases = [
        (0x0001, encode_tlv([(0xA1, b"\x00\x00\x00\x00"), (0xA2, A2_STATIC_VALUE)]), 0x01, False, False),
        (0x0003, encode_tlv([(0xA1, b"\x11\x22\x33\x44"), (0xA2, A2_STATIC_VALUE),
                             (0xA3, b"\x20"), (0xA4, b"\x00\xf0")]), 0x01, False, False),
        (0x0029, encode_tlv([(0xA1, b"\x11\x22\x33\x44"), (0xA2, A2_STATIC_VALUE)]), 0x01, False, False),
        (0x0500, encode_tlv([(0xA1, b"\x21")]), 0x11, False, True),
        (0x0001, b"\xde\xad\xbe\xef", 0x01, False, False),
        (0x0022, b"\x00" * 16, 0x01, True, False),
        (0x0022, b"\x11" * 16, 0x01, True, True),
    ]
    for command, payload, group, encrypted, response in cases:
        frames.append({
            "command": command,
            "payload_hex": payload.hex(),
            "group": group,
            "encrypted": encrypted,
            "response": response,
            "frame_hex": build_frame(
                command, payload, group=group, encrypted=encrypted, response=response
            ).hex(),
        })
    vectors["frames"] = frames

    # --- tlv -------------------------------------------------------------
    vectors["tlv"] = {
        "a1_21": encode_tlv([(0xA1, b"\x21")]).hex(),
        "a2_1": encode_tlv([(0xA2, 1)]).hex(),
        "a3_256": encode_tlv([(0xA3, 256)]).hex(),
        "static_blob": A2_STATIC_VALUE.hex(),
        "static_ascii": A2_STATIC_VALUE.decode(),
        "initial_key_hex": INITIAL_KEY.hex(),
    }

    # --- crypto ----------------------------------------------------------
    crypto = []
    for serial in SERIALS:
        for phase in ("initial", "session"):
            key = INITIAL_KEY if phase == "initial" else bytes(range(16))
            ctx = AesContext(key=key, iv=serial.encode()[:16], phase=phase)
            for hex_plaintext in PLAINTEXTS:
                plaintext = bytes.fromhex(hex_plaintext)
                crypto.append({
                    "serial": serial,
                    "phase": phase,
                    "key_hex": key.hex(),
                    "iv_hex": ctx.iv.hex(),
                    "plaintext_hex": plaintext.hex(),
                    # Included so the JS side can check pure PKCS#7 padding
                    # independently of the AES implementation.
                    "padded_hex": pad(plaintext, 16).hex(),
                    "ciphertext_hex": ctx.encrypt(plaintext).hex(),
                })
    vectors["crypto"] = crypto

    # --- real captured payload -------------------------------------------
    vectors["real_payload"] = {
        "hex": REAL_PAYLOAD_HEX,
        "tags": [
            {"tag": t.tag, "value_hex": t.value.hex()}
            for t in decode_tlv(bytes.fromhex(REAL_PAYLOAD_HEX))
        ],
    }

    # --- opcode table ----------------------------------------------------
    vectors["opcodes"] = {f"{k:04x}": v for k, v in sorted(OPCODE_NAMES.items())}

    # --- uuids -----------------------------------------------------------
    vectors["uuids"] = [
        {"name": f.name, "service": f.service, "write": f.write, "notify": f.notify}
        for f in UUID_FAMILIES
    ]

    return vectors


def main() -> int:
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vectors.json")
    vectors = build()
    with open(out, "w") as fh:
        json.dump(vectors, fh, indent=1, sort_keys=True)
        fh.write("\n")

    print(f"wrote {out}")
    print(f"  frames   : {len(vectors['frames'])}")
    print(f"  crypto   : {len(vectors['crypto'])}")
    print(f"  tlv      : {len(vectors['tlv'])} keys")
    print(f"  real tags: {len(vectors['real_payload']['tags'])}")
    print(f"  opcodes  : {len(vectors['opcodes'])}")
    print(f"  uuids    : {len(vectors['uuids'])}")
    print("\nNow run: cd ../web && npm run sync-vectors")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
