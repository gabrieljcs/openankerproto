# Methodology — how the Anker APK was reversed

Reproduction notes for recovering the ZX BLE protocol from
`Anker_3.8.0_release_mp_202505250018_encrypt.apk`. Written so the analysis can
be redone on a future app version without rediscovering the obstacles.

---

## 1. Obstacle: Ijiami (爱加密) packing

The APK's `classes.dex` is **13,660 bytes** — a stub. The real code is
encrypted and loaded at runtime:

```
lib/*/libexec.so          the real DEX loaders
lib/*/libexecmain.so      entry shim
assets/ijiami.dat         encrypted payload
assets/ijiami.ajm         encrypted payload
assets/IJMDal.Data
assets/libijmDataEncryption_*.so
```

`classes.dex` contains only `s.h.e.l.l.N` / `s.h.e.l.l.S`, whose static
initialiser does `System.loadLibrary("exec")` and hands control to a native
classloader. Static DEX decompilation is a dead end:

```bash
# This yields 4 trivial classes and nothing else.
jadx -d out classes.dex
```

## 2. The way in: it is a Flutter app

`lib/arm64-v8a/libapp.so` is **40 MB** and `libflutter.so` is present — this is
a Flutter release build. Ijiami cannot encrypt `libapp.so`, because the Flutter
engine demand-pages it. All the application's *protocol* logic is Dart, so it is
sitting there in the clear as a Dart AOT snapshot.

Identifying the engine version is the first step:

```bash
strings -n 6 lib/arm64-v8a/libapp.so | grep -i 'dart\|snapshot'
```

`blutter`'s `extract_dart_info.py` reports it precisely:

```
Dart version: 2.19.6, Snapshot: adb4292f3ec25074ca70abcd2d5c7251,
Target: android arm64
flags: product no-code_comments no-dwarf_stack_traces_mode no-lazy-dispatchers
       dedup_instructions no-asserts arm64 android compressed-pointers null-safety
```

## 3. Toolchain

```bash
git clone https://github.com/worawit/blutter.git
```

`blutter` builds the matching Dart VM from source and links its analyzer against
it. On a modern macOS the build needs three workarounds, all encoded below.

### 3.1 Ninja

```bash
curl -sL -o ninja.zip \
  https://github.com/ninja-build/ninja/releases/download/v1.12.1/ninja-mac.zip
unzip ninja.zip && chmod +x ninja
export PATH="$PWD:$PATH"
```

### 3.2 Broken `MacOSX.sdk` symlink

`/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk` was a dangling symlink to
a removed SDK, producing:

```
ld: tapi error: malformed file
    .../libSystem.B.tbd:4:20: error: unknown architecture
```

Point the build at Xcode's real SDK instead:

```bash
SYSROOT=/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk
```

### 3.3 capstone

`blutter`'s CMake hard-requires capstone via pkg-config, and Homebrew was not
usable in this environment, so capstone is built from source:

```bash
curl -sL -o capstone.tar.gz \
  https://github.com/capstone-engine/capstone/archive/refs/tags/5.0.1.tar.gz
tar xzf capstone.tar.gz && cd capstone-5.0.1
cmake -B build -GNinja -DCMAKE_BUILD_TYPE=Release \
      -DCAPSTONE_BUILD_SHARED=ON -DCAPSTONE_BUILD_TESTS=OFF \
      -DCAPSTONE_BUILD_CSTOOL=OFF \
      -DCMAKE_INSTALL_PREFIX=$PWD/../capstone-install \
      -DCMAKE_OSX_SYSROOT=$SYSROOT
ninja -C build install
```

Capstone 5.0.1's `.pc` file advertises `-I…/include` while its headers live in
`…/include/capstone`, and `blutter` includes `<capstone.h>`. Shim it:

```bash
for h in capstone-install/include/capstone/*.h; do
  ln -sf "capstone/$(basename $h)" "capstone-install/include/$(basename $h)"
done
```

### 3.4 Two `cmake` call sites

`blutter` invokes `cmake` twice (once for the Dart VM, once for itself) and
neither inherits `CMAKE_OSX_SYSROOT`. Both were patched to append
`BLUTTER_CMAKE_ARGS` from the environment:

```python
# dartvm_fetch_build.py  (cmake_dart)  and  blutter.py (cmake_blutter)
extra = os.environ.get('BLUTTER_CMAKE_ARGS', '').split()
subprocess.run([..., *extra, '--log-level=NOTICE'], ...)
```

### 3.5 Run

```bash
export BLUTTER_CMAKE_ARGS="-DCMAKE_OSX_SYSROOT=$SYSROOT \
  -DCMAKE_C_COMPILER=/usr/bin/clang -DCMAKE_CXX_COMPILER=/usr/bin/clang++"
python blutter.py <dir-with-libapp.so-and-libflutter.so> out/
```

Output:

```
out/
├── asm/            195 package directories, full Dart disassembly
├── objs.txt        every heap object with its fields (this is where enum
│                   values and names live)
├── pp.txt          the object pool: every string and constant
├── blutter_frida.js
└── ida_script/
```

## 4. Reading the output

The disassembly is verbose; the leverage is in the object pool and object dump.

### 4.1 Find the protocol packages

```bash
ls out/asm/charging/
# ble  ble_zx  command  communication  mqtt  tcp  ...
ls out/asm/charging/ble_zx/ble_confer/
# aes_confer_v1.dart  ble_confer.dart  ecdh_confer.dart  secure_ecdh_confer.dart
```

### 4.2 Recover an enum with names

`objs.txt` records heap objects field by field, so enum members come back
complete — the obfuscator did not strip them:

```
Obj!ZXOpcodeType@1ce5341 : {
  Super!_Enum : {
    off_8: int(0x20),
    off_10: "postDeviceInfoReq"
  }
}
```

### 4.3 Recover the opcode map

`PPSDeviceCommands.chargingOpcodeMap()` builds a `Map<String, ZXOpcodeType>`
by calling `bytesToHexString` on 2-byte literals. The literals appear as
`r16 = const [0x0, 0x22]` in the disassembly and the enum object follows
immediately. Pairing the two streams reconstructs the whole table:

```
0022  getAesKeyReq, scanWifiReq
0500  postA17b1DeviceInfoReq
0835  exitConnectRes
...
```

That is exactly what `ankerproto/opcodes.py` was generated from.

### 4.4 Recover constants

```bash
grep -oE 'String: "[a-z0-9.-]+\.anker[a-z0-9.-]*"' out/pp.txt | sort -u
grep -oE 'String: "[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}"' out/pp.txt | sort -u
```

This yields the MQTT brokers, the API hosts, and the four GATT UUID families.

### 4.5 Read a specific function

The blutter listing interleaves Dart-level and ARM-level comments. Strip the
ARM lines to see the logic:

```bash
sed -n '/_setInitialKeyForSecure/,/^  [a-z]/p' \
  out/asm/charging/ble_zx/helper/zx_ble_confer.dart |
  grep -vE '^\s*//\s+0x[0-9a-f]+: (ldr|str|stur|mov|stp|ldp|cmp|b\.)'
```

## 5. Cross-validation

Static analysis alone cannot distinguish "this is the protocol" from "this is
dead code". Two independent sources were used to confirm:

* **`flip-dots/SolixBLE`** — `SolixBLE/constructs.py` defines the exact frame
  layout, and `tests/test_devices.py` contains real captured payloads. The
  49-record telemetry payload in `tests/test_protocol.py` comes from there.
* **`atc1441/Anker_Prime_BLE_hacking`** — the WebBluetooth tool
  (`atc1441.github.io/AnkerPrimeWebBle.html`) demonstrates the static key and
  serial-number IV against real Anker Prime hardware. Its `setupCrypto`,
  `performHandshake` and `performInitialEncryption` functions line up
  one-for-one with `ZXBleConfer.startZXBleConfer` in the disassembly.

Two independent implementations agreeing with the binary is what makes the
findings in `docs/PROTOCOL.md` trustworthy.

## 6. Doing this again on a newer version

1. Check whether `libapp.so` still exists and re-run `extract_dart_info.py` —
   the Dart version may have moved, and blutter handles 2.x and 3.x differently.
2. Re-extract `objs.txt` and diff the `ZXOpcodeType` set against
   `ankerproto/opcodes.py`; new opcodes show up immediately.
3. Re-diff the UUID table and the MQTT host list.
4. Check whether `A2_STATIC_VALUE` changed. It is the single most useful
   constant, and if Anker rotates it the handshake breaks — grep the object pool
   for a 40-character hex string near the handshake code.
5. Re-run `tests/test_protocol.py`; the framing tests are version-independent
   and will catch a layout change instantly.
