# Anker ZX BLE Protocol — Recovered Specification

Clean-room specification of the protocol the Anker mobile app
(`com.anker.charging`, v3.8.0) uses to talk to its BLE-enabled devices:
power banks (Anker Prime, A1340/A1753/A1770/A1771/A1772/A1780/A1781/A1782/
A1790), desktop chargers, and the A51xx power-station line.

Everything here was recovered from
`Anker_3.8.0_release_mp_202505250018_encrypt.apk` and cross-validated against
independently captured device traffic. Where a claim is *verified against a real
device* or *read directly out of the binary* it is marked as such; anything
inferred is called out.

---

## 1. Source of truth

| Layer | Where it lives in the APK | How it was read |
|---|---|---|
| Wire framing | `package:charging/ble_zx/base/assemble_command_util.dart` | Dart AOT disassembly (`blutter`) |
| Crypto | `ble_zx/ble_confer/{aes_confer_v1,ecdh_confer,secure_ecdh_confer}.dart`, `ble_zx/helper/aes_helper.dart` | Dart AOT disassembly |
| Opcodes | `ZXOpcodeType` enum + `PPSDeviceCommands.chargingOpcodeMap()` / `commonOpcodeMap()` | AOT object pool (`pp.txt` / `objs.txt`) |
| TLV tags | `PPSDeviceCommands.parse*` routines, `charging/command/*.dart` | Dart AOT disassembly |
| GATT UUIDs | Dart AOT object pool string table | String extraction |
| Cloud/MQTT | `charging/mqtt/*`, `charging/tcp/*` | Dart AOT disassembly |

The APK is a **Flutter** app packed with the **Ijiami (爱加密)** protector:
`classes.dex` is a 13 KB stub, and the real Kotlin/Java code lives in the
native `libexec.so` payload. All protocol logic, however, is Dart and therefore
lives in `lib/arm64-v8a/libapp.so` (Dart 2.19.6, AOT, compressed pointers,
null-safe) — which the packer does not touch. That is why the protocol is fully
recoverable despite the packer.

---

## 2. Transport

### 2.1 GATT layout

Anker uses three 128-bit service families in this app. They share an identical
characteristic layout; only the first 32 bits (model/SoC family) differ.

| Family | Service | Write | Notify |
|---|---|---|---|
| `prime-2215` | `22150001-4002-81C5-b46e-cf057c562025` | `…0002` | `…0003` |
| `gen2-2540` | `25400001-4002-81C5-b46e-cf057c562025` | `…0002` | `…0003` |
| `station-4158` | `41580001-4002-81C5-b46e-cf057c562025` | `…0002` | `…0003` |
| `alt-8c85` | `8c850001-0302-41C5-b46e-cf057c562025` | `…0002` | `…0003` |

Also advertised (used as scan filters, and by adjacent product lines):
`0x2215`, `0x2540`, `0xFF09`, `0xEF0A`, `0xEF0B`, `0x1770`, `0x1780`,
`0x17A0`/`0x17A1`/`0x17A2`.

Writes are **write-without-response**. All replies arrive as notifications on
the notify characteristic. Negotiate an MTU of at least 200; the app's own
fragmentation subtracts a 10-byte overhead.

### 2.2 Frame format

```
offset  size  field
------  ----  ---------------------------------------------------------
  0      2    header      FF 09
  2      2    size        uint16 LE — byte count of everything except the
                          checksum, i.e. len(frame) - 1
  4      1    pattern[0]  03
  5      1    pattern[1]  00
  6      1    pattern[2]  group  (logical channel, see below)
  7      1    cmd_high    command high byte + flags (see 2.3)
  8      1    cmd_low     command low byte
  9      n    payload     TLV, possibly AES-encrypted
 9+n     1    checksum    XOR of every preceding byte
```

> **Verified** against the packet structures published in
> [`flip-dots/SolixBLE`](https://github.com/flip-dots/SolixBLE/blob/main/SolixBLE/constructs.py)
> and the frames documented in
> [`moag1000/anker-solix-api-exploration`](https://github.com/moag1000/anker-solix-api-exploration/blob/main/BLE_COMMAND_MAP.md).

### 2.3 The command word and its flags

The 16-bit opcode is transmitted in two bytes, and the high byte carries flags:

```python
cmd_high = (command >> 8) & 0xFF
cmd_low  =  command       & 0xFF

cmd_high |= 0x40   # payload is AES-encrypted
cmd_high |= 0x08   # this frame is a response / ACK
```

A request for opcode `0x0022` goes out as `40 22` (encrypted). The device
answers with `08 22` for the plaintext variant or `48 22` for an encrypted
reply. **Strip the flags before matching**: `command = ((cmd_high & ~0x48) << 8) | cmd_low`.

> Note: `0x08` as a *response* flag and `0x08` as a *bit in the command* are
> easily confused. Observed device replies to `getAesKeyReq` use `48 22`
> (encrypted + response).

### 2.4 Logical groups (`pattern[2]`)

| Group | Purpose |
|---|---|
| `0x01` | session: connect, capability negotiation, keys, binding, OTA |
| `0x11` | power/telemetry: status dumps, port control, display settings |

**Verified** — the app sends `03 00 01 40 22` for the key request and
`03 00 11 …` for `0x0500`/`0x0504`/`0x0505`.

### 2.5 Fragmentation

`AssembleCmdUtil::splitPackageCmd` writes `mtu - 10` payload bytes per BLE
write; default MTU 200 → 190 data bytes. Large payloads (e.g. `0x005E`
schedules, which negotiate MTU 400) are reassembled by the device. The app's
`parseSubPackageData` handles the inverse. Fragment headers are
`<index nibble><total nibble>` followed by data.

---

## 3. TLV encoding

Inside the payload, data is a flat sequence of Type-Length-Value records:

```
<type 1B> <length 1B> <value length B>
```

* All multi-byte integers are **little-endian**.
* Tags `0x00`–`0x9F` are fixed single-byte fields.
* Tags `0xA0`–`0xFF` are command-scoped; the same tag means different things in
  a request and in a response.
* The device prefixes decrypted payloads with a **status byte**: `0x00` = OK.
  Parsers skip it when present.
* Tags `0xFD`/`0xFE` carry a trailing timestamp (`0xFE` = epoch **seconds** in
  4 bytes LE; `0xFD` = milliseconds, used by `CMD_COMMON_V2`).

A real decrypted telemetry payload, 49 records, every length field one byte:

```
a1 01 31                      port selector
a2 05 03 00 00 00 00
a3 05 03 00 00 00 00
a4 03 02 6b 06                <datatype 0x02 = signed int LE> 0x066b
…
b3 03 02 a6 00
…
d0 11 00 41 50 43 39 46 45 30 45 32 37 33 30 30 32 37 35
                              vendor string "APC9FE0E27300275"
e5 02 01 00
```

### 3.1 Data-type byte

Inside a 3-byte field the first byte is a type discriminator:

| Code | App helper | Meaning | Width |
|---|---|---|---|
| `0x01` | `intToList1` | unsigned int | 1 |
| `0x02` | `intToList2` | **signed** int, LE | 2 |
| `0x03` | `intToList3` | variable-length bytes | N |
| `0x04` | `intToList4` | bitmap / LE int | N |
| `0x05` | — | signed float LE | 4 |
| `0x00` | — | string | N |

### 3.2 Scaling

| Factor | Applied to |
|---|---|
| ÷10 | voltage, temperature, total power |
| ÷100 | current, energy, battery SOC |
| ÷1000 | fine-precision values |

Signed 8-bit values use two's complement — this is how **temperature** is
carried (`if v >= 0x80: v -= 0x100`).

---

## 4. Pairing, authentication and encryption

The 2215 family uses **AES-128-CBC with a fixed IV per phase**. There is no
Diffie-Hellman on the BLE link. The whole scheme is two app-wide constants
plus the device serial number.

### 4.1 The static secrets

```
A2_STATIC_VALUE = "2c377dfa09cdb7924889e4292a37f61c8c5ed52d"   (40 ASCII chars)
INITIAL_KEY     = A2_STATIC_VALUE[0:16] = "2c377dfa09cdb792"   (AES-128 key)
IV              = device serial number as ASCII, 16 bytes
```

`A2_STATIC_VALUE` is transmitted verbatim as the value of TLV tag `0xA2` on
every handshake frame. `INITIAL_KEY` is then just its first 16 characters used
as key material.

> **Verified on real hardware** — this derivation is what
> [`atc1441/Anker_Prime_BLE_hacking`](https://github.com/atc1441/Anker_Prime_BLE_hacking)
> and the `atc1441.github.io/AnkerPrimeWebBle.html` WebBluetooth tool use to
> talk to an Anker Prime 27650 mAh, and what `SolixBLE` uses for the A17xx line.
> `INITIAL_KEY` and `A2_STATIC_VALUE` were re-derived here from the app binary's
> handshake construction.

### 4.2 The three phases

**Phase 1 — plaintext handshake.** All four frames are unencrypted:

| # | Opcode | Name | TLV sent |
|---|---|---|---|
| 1 | `0x0001` | `startConnectReq` | `A1` = 4-byte LE epoch seconds, `A2` = static blob |
| 2 | `0x0003` | `capabilityNegotiationReq` | + `A3` = `20`, `A4` = `00 F0` |
| 3 | `0x0029` | `getDeviceInfoReq` | `A1`, `A2` |
| 4 | `0x0005` | `setCapabilityReq` | + `A3` = `20`, `A4` = `00 F0`, `A5` = `02` |

The reply to step 3 carries the identity, which is what makes the rest
possible:

| Tag | Meaning |
|---|---|
| `A3` | firmware version, ASCII |
| `A4` | **serial number**, ASCII |
| `A5` | BT MAC address, 6 raw bytes |

**Phase 2 — "Initial" encryption.**

```python
ctx = AesContext.initial(serial_number)   # key = INITIAL_KEY, iv = SN
send(0x0022, ctx.encrypt(tlv(A1=timestamp, A2=static, A3=00*4, A5=00*40)))
```

**Phase 3 — "Session" encryption.** The device's reply to `0x0022` is
encrypted with the *initial* context and contains the new key in TLV `A1`:

```python
session_key = response_tlv[0xA1]          # 16 bytes
ctx = AesContext.session(session_key, serial_number)   # iv = SN again
```

Every subsequent command — status polls, port control, display settings — uses
`ctx`. The app tears the context down on disconnect (`BleConfer.clearAction`).

### 4.3 Security assessment

The link layer provides **obfuscation, not confidentiality or authenticity**:

* The initial key is a public constant shipped in every copy of the app and
  re-broadcast on every handshake frame.
* The IV is a serial number that the device hands out in cleartext in phase 1.
* There is no MAC/AEAD, so the ciphertext is malleable. PKCS#7 padding means a
  CBC padding oracle is at least plausible.
* The **session key itself is generated by the device**, so an attacker can
  simply perform the handshake and receive a valid session key — authentication
  is what the *account* layer (`loginPasswordECDH` / `SecureEcdhConfer`, real
  ECDH with the Anker cloud account) adds, not what the link layer adds.

Anyone who can reach the device over BLE can drive it. That is a design
property of the protocol, not a bug in this implementation.

> On Prime power banks up to firmware 1.6.1 this also allowed unsigned firmware
> upload; 1.6.2 added ECDSA signature checking.

---

## 5. Opcode reference

129 distinct opcodes were recovered. The response form of an opcode is always
`request | 0x0800`. Full tables live in `ankerproto/opcodes.py`; the highlights:

### Session and security

| Opcode | Name |
|---|---|
| `0x0001` | `startConnectReq` |
| `0x0002` | `startDisconnectReq` |
| `0x0003` | `capabilityNegotiationReq` |
| `0x0004` | `configureCapabilityReq` |
| `0x0005` | `setCapabilityReq` |
| `0x0021` | `getModuleInfoReq` / `getPublicKeyReq` |
| `0x0022` | `getAesKeyReq` / `scanWifiReq` |
| `0x0023` | `bindUserIdReq` / `getWifiListReq` |
| `0x0027` | `getAuthenticationReq` |
| `0x0029` | `getDeviceInfoReq` |
| `0x0032` | `getBindBluetoothDeviceReq` |
| `0x0033` | `getUnBindBluetoothDeviceReq` |
| `0x0035` | `exitConnectReq` |

### Telemetry

| Opcode | Name |
|---|---|
| `0x0020` | `postDeviceInfoReq` (push) |
| `0x001E` | `postWorkInfoReq` (push) |
| `0x0050` | `postDeviceAllInfoReq` (push) |
| `0x0500` | `postA17b1DeviceInfoReq` — full status poll |
| `0x0501` | `postA17b1SelfCheckReq` |
| `0x050E` | live port power — **not in the app's opcode enum**; dispatched by literal value in the notification handler |
| `0x0522` | dedicated temperature report — likewise dispatched by literal value |
| `0x0601` | `postA1790DeviceInfoReq` |
| `0x0074` | `getA17B2DeviceInfoReq` |
| `0x0200` | `getMiniChargeAllDeviceInfoReq` |

### Control

| Opcode | Name |
|---|---|
| `0x0036`/`0x0037` | `setMultiDevicesReq` / `getMultiDevicesReq` |
| `0x0057` | `setDeviceUpdateEnergyReq` |
| `0x005E` | `setSuperChargeReq` |
| `0x007A` | `setRelaySwitchReq` |
| `0x007B` | `setLocationLightReq` |
| `0x007C`/`0x007D` | `setTimingReq` / `getTimingReq` (schedules) |
| `0x007E`/`0x007F` | `setCountdownReq` / `getCountdownReq` |
| `0x0504` | set display theme |
| `0x0505` | set beeper |
| `0x004A`–`0x0051` | AC switch, car switch, LCD light, frequency, energy mode, ambient light, temp unit, reset |

### Unsolicited device push (`0x04xx`)

The device pushes state without being polled. `0x0400` error, `0x0401` switch
state, `0x0402` work info, `0x0403` device info, `0x0404` countdown,
`0x0405` full device info, `0x0406` upgrade state, `0x0409`/`0x040A` BMS
sub-battery BT/Wi-Fi info, `0x040E` micro-inverter, `0x040F` sub-battery error,
`0x0410`/`0x0411` A17B2 Wi-Fi/BT info.

### Firmware and logs

`0x002E` `sendOtaSubPackageReq`, `0x0030` `getZXOTAStateReq`, `0x0089`
`getOTAStateReq`, `0x0067` `bleOtaProgressReq`, `0x0065`–`0x0066` MCU log,
`0x0031` module log upload.

---

## 6. Status payload layouts

### 6.1 `0x0500` — comprehensive status

Port blocks in tags `A4`/`A5`/`A6`:

| Offset | Size | Field |
|---|---|---|
| 2 | 1 | mode: 0 = off, 1 = input, 2 = output |
| 3 | 2 | voltage, uint16 LE ÷10 → V |
| 5 | 2 | current, uint16 LE ÷10 → A |
| — | — | power = voltage × current (not transmitted) |

Other tags: `A2` battery (SOC at bytes `[8]` + `[9]`/100), `AE` total power
(`[1:3]` output ÷10 W, `[3:5]` input ÷10 W), `B3` temperature
(`[1]` °C, `[2]` °F).

### 6.2 `0x050E` — live power

Same port layout but tags `A2`/`A3`/`A4` are ports C1/C2/A, `A6` is total power
and `A8` is battery. Higher update rate than `0x0500`.

### 6.3 `0x0522` — temperature

Tag `A2`: `[1]` = °C, `[2]` = °F.

### 6.4 The 3-byte "datatype + int16" field pattern

The vast majority of the 49-record telemetry dump uses `02 LL HH`, i.e.
`<0x02 signed-int16>`, little-endian:

```
a4 03 02 6b 06   -> 0x066b = 1643
bd 02 01 17      -> 2-byte field: 0x17 << 8 | 0x01 = 0x1701 (unsigned)
```

Note that the 2-byte fields (`bc`–`e5`) are `<datatype><value>` pairs with a
**single** value byte, not int16s. Both forms occur in the same payload, so
decode per-tag rather than assuming a uniform width.

---

## 7. Cloud / MQTT (Wi-Fi devices)

Wi-Fi-capable devices (power stations, A17xx solar) additionally speak MQTT
through Anker's cloud. This path needs a **logged-in Anker account** and is not
a replacement for the local BLE link, but it gives remote control.

### 7.1 Endpoints (recovered from the app binary)

```
aiot-mqtt-us.anker.com        aiot-mqtt-eu.anker.com
aiot-mqtt-us-beta.anker.com   aiot-mqtt-eu-beta.anker.com
aiot-mqtt-us-qa.anker.com     aiot-mqtt-eu-qa.anker.com
aiot-mqtt-us-ci.anker.com
ankerpower-api.anker.com      ankerpower-api-eu.anker.com
aiot-api-cn.anker.com.cn
```

Transport is **TLS-secured WebSocket** (the app bundles Eclipse Paho; see
`bundle.properties`, `org/eclipse/paho/client/mqttv3/…`), QoS 1.

### 7.2 Topics

```
subscribe  cmd/anker_power/{product_key}/{device_sn}/app/res
subscribe  dt/anker_power/{product_key}/{device_sn}/basic_info
subscribe  dt/anker_power/{product_key}/{device_sn}/param_info
publish    cmd/anker_power/{product_key}/{device_sn}/req
```

### 7.3 Envelope

Payloads are base64-encoded JSON, **optionally gzip-compressed** (sniff the
`1F 8B` magic before decoding):

```json
{
  "head": {
    "version": "…", "client_id": "…", "sess_id": "1234-5678", "msg_seq": 1,
    "cmd": 34, "cmd_status": 4, "sign_code": 2, "seed": "1",
    "timestamp": 1711622400, "device_pn": "A17C1", "device_sn": "…"
  },
  "payload": {
    "device_sn": "…", "account_id": "…",
    "data": "<base64 of the same TLV binary>"
  }
}
```

`cmd` values: `0x22` normal, `0x0C` OTA, `0x0A` upload log, `0x32` remote Wi-Fi
scan, `0x34` remote Wi-Fi switch, `0x18` unbind, `0x38` get BSSID.

The **inner `data` blob is the same TLV encoding as the BLE path**, so the
codecs in this package apply unchanged.

---

## 8. What is *not* solved here

Be explicit about the boundaries of this work:

1. **The 2540 / 4158 / 8C85 UUID families** are present in the app but have no
   public device captures. The framing and handshake are very likely identical
   (same code path), but the static key and the device-info tag numbers are
   **unverified** for those families. This client lets you point at them
   (`--family gen2-2540`) and will log raw frames so the difference can be
   found quickly.
2. **The X25519/ECDH path** (`SecureEcdhConfer`, `EcdhConfer`,
   `getPublicKeyReq`, `getAesKeyRes`) is used for *account* authentication and
   by some newer firmware. The implementation here does not perform it; only
   the AES session path is implemented.
3. **OTA is not implemented.** `0x002E` sub-package upload, signature
   verification and the `0x0067` progress protocol are mapped by opcode only.
4. **No device was available during this work.** Correctness is established by
   (a) reading the opcode/crypto tables straight out of the binary, (b) matching
   the frame layout against two independent public captures, and (c) 19 offline
   tests including a real captured telemetry payload. A first run against real
   hardware should be done with `-v` and the decode tool to confirm the
   per-tag status offsets for the specific model.
5. **Some opcodes are ambiguous.** `0x0022` is both `getAesKeyReq` and
   `scanWifiReq`; `0x0023` is both `bindUserIdReq` and `getWifiListReq`. Which
   meaning applies is decided by the device state/group, not the opcode alone.

---

## 9. Legal and ethical note

This is interoperability research on a device you own, using an APK you
obtained. Anker's terms of service may prohibit reverse engineering; the
technical findings here are documented for personal interoperability and
security research. Firmware extraction, modification, or flashing is out of
scope and, given Anker's signed-OTA check (firmware ≥ 1.6.2), not something
this document enables. Do not use this to access devices you do not own.
