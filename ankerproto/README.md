# ankerproto — talk to Anker BLE devices without the official app

A clean-room Python implementation of the Anker **ZX BLE protocol**, recovered
from `Anker_3.8.0_release_mp_202505250018_encrypt.apk` (`com.anker.charging`)
and validated against independently captured device traffic.

Works with Anker's BLE-enabled power banks (Anker Prime and friends),
desktop chargers, and the A51xx power-station line. No account, no cloud, no
phone required.

**→ [Full protocol specification](docs/PROTOCOL.md)** — framing, crypto,
opcodes, TLV tags, MQTT.

---

## Quick start

```bash
cd ankerproto
python -m venv .venv && . .venv/bin/activate
pip install -e '.[ble]'
```

Find your device and read it:

```bash
python -m ankerproto scan
python -m ankerproto status --address 12:34:56:78:9A:BC
python -m ankerproto ports  --address 12:34:56:78:9A:BC
python -m ankerproto beep off
```

Or from Python:

```python
from ankerproto import AnkerSession, BleTransport, PRIMARY_FAMILY

with BleTransport(PRIMARY_FAMILY) as t:
    session = AnkerSession(t)
    info = session.connect()
    print(info.serial_number, info.firmware_version, info.bt_mac)

    status = session.read_status()
    print(status.battery_percent, status.temperature_c)
    for name, port in status.ports.items():
        print(name, port.mode_name, port.voltage, port.current, port.power)
```

No device handy? Decode captured frames offline:

```bash
python -m ankerproto decode ff0924000300110d00a10131a20a00000000000000005732ae0500d2043002b30300194d3a
```

```
command : 0x0500  postA17b1DeviceInfoReq
group   : 0x11
flags   : response
  TLV 0xA1 len=1   31  ascii='1'
  TLV 0xA2 len=10  000000000000000000005732
  TLV 0xAE len=5   00d2043002
  TLV 0xB3 len=3   00194d
```

## What was actually recovered

| | |
|---|---|
| **Framing** | `FF 09 │ size LE │ 03 00 <group> │ cmd+flags │ TLV │ XOR` |
| **Flags** | `0x40` = AES-encrypted, `0x08` = response |
| **Crypto** | AES-128-CBC. Key = first 16 chars of a static 40-char blob; IV = device serial number |
| **Key exchange** | Plaintext handshake leaks the serial → device issues a 16-byte session key in TLV `A1` |
| **Opcodes** | 129 recovered, with names, from the `ZXOpcodeType` enum |
| **TLV tags** | `A1`–`E5` mapped for the 2215 family, including per-port telemetry offsets |
| **GATT** | 4 service families, identical characteristic layout |
| **Cloud** | MQTT brokers, topic template, JSON envelope, gzip+base64 framing |

## Verification status — read this before trusting anything

| Claim | Status |
|---|---|
| Frame layout, flags, checksum | **Verified** — matches two independent public captures |
| Static key + SN-as-IV derivation | **Verified on hardware** by the community; re-derived here from the binary |
| Handshake sequence and tag numbers | **Verified** — app's own send path |
| Opcode table (129 entries) | **Read directly** from the AOT object pool |
| `0x0500`/`0x050E`/`0x0522` port offsets | **Verified** against a real captured payload |
| 2540 / 4158 / 8C85 families | **Unverified** — UUIDs confirmed present, key and tags assumed identical |
| X25519 / `SecureEcdhConfer` account auth | **Not implemented** |
| OTA upload | **Not implemented** (opcodes mapped only) |

No physical device was available during this work. See
[§8 of the spec](docs/PROTOCOL.md#8-what-is-not-solved-here) for the full list of
open questions.

## Tests

```bash
python tests/test_protocol.py        # no pytest needed
# or
pytest tests -q
```

19 offline tests cover framing round-trips, checksum rejection, CBC behaviour,
TLV edge cases, the full handshake against a scripted device, and decoding of a
real captured telemetry payload.

## How the APK was cracked

Worth recording, because the packaging is deliberately hostile:

1. **Ijiami (爱加密)** protects the APK: `classes.dex` is a 13 KB stub that
   just `System.load`s `libexec.so`, and the real DEX is encrypted. Tooling
   that only decompiles DEX finds nothing.
2. But the app is **Flutter**. All protocol logic is Dart, compiled AOT into
   `lib/arm64-v8a/libapp.so` — which the packer does not encrypt, because it
   has to be demand-paged by the Flutter engine.
3. Dart AOT snapshots retain the **object pool** (every string and constant) and
   the **class/function structure**. [`blutter`](https://github.com/worawit/blutter)
   recovers both.
4. Result: 195 package directories of disassembly, the complete `ZXOpcodeType`
   enum with names, and every protocol string — no key extraction or runtime
   instrumentation needed.

The full reproduction steps and toolchain fixes are in
[`docs/METHODOLOGY.md`](docs/METHODOLOGY.md).

## Layout

```
ankerproto/
├── ankerproto/
│   ├── framing.py     wire format, flags, checksum, fragmentation
│   ├── crypto.py      AES-128-CBC contexts (initial + session)
│   ├── tlv.py         TLV encode/decode
│   ├── opcodes.py     129 opcodes + TLV tag tables
│   ├── uuids.py       GATT service families
│   ├── session.py     protocol state machine (transport-agnostic)
│   ├── ble.py         bleak-backed BLE transport
│   ├── transport.py   replay/record/loopback transports
│   └── __main__.py    CLI
├── docs/
│   ├── PROTOCOL.md    the specification
│   └── METHODOLOGY.md how the APK was reversed
└── tests/
    └── test_protocol.py
```

## Legal

Interoperability research on hardware you own. Anker's ToS may prohibit reverse
engineering. Firmware modification is out of scope and blocked by Anker's
signature check on firmware ≥ 1.6.2. Don't use this against devices you don't own.

## Credits

The protocol was independently mapped by
[atc1441](https://github.com/atc1441/Anker_Prime_BLE_hacking),
[flip-dots](https://github.com/flip-dots/SolixBLE),
[moag1000](https://github.com/moag1000/anker-solix-api-exploration) and
[thomluther](https://github.com/thomluther/anker-solix-api). Their published
captures are what let the findings here be cross-checked rather than merely
asserted.
