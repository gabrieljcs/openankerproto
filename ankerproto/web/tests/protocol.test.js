/**
 * Protocol test suite. Run with `npm test` (node --test).
 *
 * Two things are being checked:
 *
 *  1. **Parity with the Python implementation.** `vectors.json` is generated
 *     from `ankerproto/` (Python) and frozen into this repo, so any drift
 *     between the two implementations fails the build.
 *  2. **Self-consistency.** Framing round-trips, checksum rejection, the full
 *     handshake against a simulated device, and decoding of a real captured
 *     telemetry payload.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  A2_STATIC_VALUE,
  INITIAL_KEY,
  AesContext,
  cryptoAvailable,
  initialContext,
  pkcs7Pad,
  pkcs7Unpad,
  serialIv,
  sessionContext,
} from "../src/crypto.js";
import {
  buildFrame,
  bytesEqual,
  concat,
  fromHex,
  parseFrame,
  splitFragments,
  toHex,
  xorChecksum,
} from "../src/framing.js";
import { OPCODE_NAMES, Opcode, tagName } from "../src/opcodes.js";
import { AnkerSession } from "../src/session.js";
import { decodeTlv, encodeTlv, stripStatus, Tlv } from "../src/tlv.js";
import { ReplayTransport, ScriptedDevice } from "../src/transport.js";
import { PRIMARY_FAMILY, UUID_FAMILIES, findFamily } from "../src/uuids.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "vectors.json"), "utf8"));

// ---------------------------------------------------------------------------
// parity with the Python implementation
// ---------------------------------------------------------------------------

test("framing matches the Python implementation", () => {
  for (const v of vectors.frames) {
    const payload = fromHex(v.payload_hex);
    const built = buildFrame(v.command, payload, {
      group: v.group,
      encrypted: v.encrypted,
      response: v.response,
    });
    assert.equal(toHex(built), v.frame_hex, `frame for command 0x${v.command.toString(16)}`);

    const parsed = parseFrame(built);
    assert.equal(parsed.command, v.command);
    assert.equal(parsed.group, v.group);
    assert.equal(parsed.encrypted, v.encrypted);
    assert.equal(parsed.response, v.response);
    assert.equal(toHex(parsed.payload), v.payload_hex);
  }
});

test("static constants match the Python implementation", () => {
  assert.equal(toHex(A2_STATIC_VALUE), vectors.tlv.static_blob);
  assert.equal(new TextDecoder().decode(A2_STATIC_VALUE), vectors.tlv.static_ascii);
  assert.equal(toHex(INITIAL_KEY), vectors.tlv.initial_key_hex);
  assert.equal(A2_STATIC_VALUE.length, 40);
  assert.equal(INITIAL_KEY.length, 16);
});

test("TLV encoding matches the Python implementation", () => {
  assert.equal(toHex(encodeTlv([[0xa1, Uint8Array.of(0x21)]])), vectors.tlv.a1_21);
  assert.equal(toHex(encodeTlv([[0xa2, 1]])), vectors.tlv.a2_1);
  assert.equal(toHex(encodeTlv([[0xa3, 256]])), vectors.tlv.a3_256);
});

test("AES-CBC ciphertext matches the Python implementation", async (t) => {
  if (!cryptoAvailable()) return t.skip("WebCrypto unavailable in this runtime");
  assert.ok(vectors.crypto.length > 0, "expected crypto vectors");

  for (const v of vectors.crypto) {
    const key = fromHex(v.key_hex);
    const iv = fromHex(v.iv_hex);
    const plaintext = fromHex(v.plaintext_hex);

    // `AesContext.encrypt` pads internally, so compare the padding separately
    // and then compare one full encrypt/decrypt cycle.
    assert.equal(toHex(pkcs7Pad(plaintext)), v.padded_hex, "padding");

    const ctx = new AesContext(key, iv, v.phase, await importRawKey(key));
    const cipher = await ctx.encrypt(plaintext);
    assert.equal(toHex(cipher), v.ciphertext_hex, `${v.phase}/${v.serial}`);

    const roundtrip = await ctx.decrypt(cipher);
    assert.equal(toHex(roundtrip), v.plaintext_hex, "decrypt round-trip");

    // And confirm the raw primitive agrees, so a padding bug cannot hide here.
    const rawCipher = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-CBC", iv }, await importRawKey(key), plaintext),
    );
    assert.equal(toHex(rawCipher), v.ciphertext_hex, `raw WebCrypto ${v.phase}/${v.serial}`);
  }
});

test("opcode table matches the Python implementation", () => {
  const pyKeys = Object.keys(vectors.opcodes);
  assert.equal(Object.keys(OPCODE_NAMES).length, pyKeys.length);
  for (const hex of pyKeys) {
    const code = parseInt(hex, 16);
    assert.equal(OPCODE_NAMES[code], vectors.opcodes[hex], `opcode 0x${hex}`);
  }
});

test("UUID families match the Python implementation", () => {
  assert.equal(UUID_FAMILIES.length, vectors.uuids.length);
  for (let i = 0; i < vectors.uuids.length; i++) {
    const py = vectors.uuids[i];
    const js = UUID_FAMILIES[i];
    assert.equal(js.name, py.name);
    assert.equal(js.service.toLowerCase(), py.service.toLowerCase());
    assert.equal(js.write.toLowerCase(), py.write.toLowerCase());
    assert.equal(js.notify.toLowerCase(), py.notify.toLowerCase());
  }
});

async function importRawKey(keyBytes) {
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

// ---------------------------------------------------------------------------
// framing behaviour
// ---------------------------------------------------------------------------

test("frame layout is exactly as documented", () => {
  const payload = encodeTlv([
    [0xa1, Uint8Array.of(0x21)],
  ]);
  const raw = buildFrame(0x0500, payload, { group: 0x11 });
  const body = concat(Uint8Array.of(0x03, 0x00, 0x11, 0x05, 0x00), payload);
  const size = body.length + 4;

  assert.deepEqual([...raw.subarray(0, 2)], [0xff, 0x09]);
  assert.equal(raw[2] | (raw[3] << 8), size);
  assert.deepEqual([...raw.subarray(4, 7)], [0x03, 0x00, 0x11]);
  assert.deepEqual([...raw.subarray(7, 9)], [0x05, 0x00]);
  assert.equal(raw[raw.length - 1], xorChecksum(raw.subarray(0, raw.length - 1)));
});

test("flag bits are masked out of the parsed command", () => {
  const enc = parseFrame(buildFrame(0x0022, new Uint8Array(16), { encrypted: true }));
  assert.equal(enc.command, 0x0022);
  assert.equal(enc.encrypted, true);
  assert.equal(enc.response, false);

  const resp = parseFrame(buildFrame(0x0022, new Uint8Array(16), { response: true }));
  assert.equal(resp.command, 0x0022);
  assert.equal(resp.response, true);
  assert.equal(resp.raw[7], 0x08);
});

test("corrupt checksum is rejected", () => {
  const raw = buildFrame(0x0001, Uint8Array.of(0x01));
  raw[raw.length - 1] ^= 0xff;
  assert.throws(() => parseFrame(raw), /checksum/);
});

test("bad header and short frames are rejected", () => {
  assert.throws(() => parseFrame(Uint8Array.of(1, 2, 3)), /too short/);
  const raw = buildFrame(0x0001, Uint8Array.of(0x01));
  raw[0] = 0x00;
  assert.throws(() => parseFrame(raw), /bad header/);
});

test("length mismatch is rejected", () => {
  const raw = buildFrame(0x0001, Uint8Array.of(0x01, 0x02));
  raw[2] += 4;
  assert.throws(() => parseFrame(raw), /length mismatch/);
});

test("fragmentation splits to MTU minus overhead", () => {
  const chunks = splitFragments(new Uint8Array(500), 200);
  assert.deepEqual(
    chunks.map((c) => c.length),
    [190, 190, 120],
  );
  assert.equal(chunks.reduce((n, c) => n + c.length, 0), 500);
});

test("hex helpers round-trip and reject garbage", () => {
  assert.equal(toHex(fromHex("deadBEEF")), "deadbeef");
  assert.equal(toHex(fromHex("de ad:be-ef")), "deadbeef");
  assert.throws(() => fromHex("abc"), /odd length/);
  assert.throws(() => fromHex("zz"), /non-hex/);
  assert.ok(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2)));
  assert.ok(!bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3)));
});

// ---------------------------------------------------------------------------
// TLV
// ---------------------------------------------------------------------------

test("TLV round-trips", () => {
  const items = [
    new Tlv(0xa1, Uint8Array.of(0x21)),
    new Tlv(0xa2, Uint8Array.of(0x01, 0x01)),
    new Tlv(0xa6, new Uint8Array(12)),
  ];
  const decoded = decodeTlv(encodeTlv(items));
  assert.equal(decoded.length, 3);
  for (let i = 0; i < items.length; i++) {
    assert.equal(decoded[i].tag, items[i].tag);
    assert.equal(toHex(decoded[i].value), toHex(items[i].value));
  }
});

test("TLV wire format is type-length-value", () => {
  assert.equal(toHex(encodeTlv([[0xa1, Uint8Array.of(0x21)]])), "a10121");
  assert.equal(toHex(encodeTlv([[0xa2, 1]])), "a20101");
  assert.equal(toHex(encodeTlv([[0xa3, 256]])), "a30200 01".replace(/ /g, ""));
});

test("TLV rejects oversized values", () => {
  assert.throws(() => encodeTlv([[0xa1, new Uint8Array(256)]]), /exceeds 255 bytes/);
  assert.throws(() => encodeTlv([[0x1ff, Uint8Array.of(1)]]), /tag out of range/);
});

test("truncated TLV is tolerated when not strict", () => {
  const good = encodeTlv([
    [0xa1, Uint8Array.of(0x21)],
    [0xa2, Uint8Array.of(1, 2)],
  ]);
  const truncated = good.subarray(0, good.length - 3);
  assert.equal(decodeTlv(truncated, { strict: false }).length, 1);
  assert.throws(() => decodeTlv(truncated, { strict: true }), /declares|truncated/);
});

test("length overrides decode wider length fields", () => {
  // tag D0 with a 2-byte length prefix
  const data = Uint8Array.of(0xd0, 0x02, 0x00, 0xaa, 0xbb);
  const noOverride = decodeTlv(data, { strict: false });
  assert.equal(noOverride[0].length, 2);

  const withOverride = decodeTlv(data, {
    lengthOverrides: { 0xd0: 2 },
    strict: false,
  });
  assert.equal(withOverride[0].length, 2);
  assert.equal(toHex(withOverride[0].value), "aabb");
});

test("TLV integer helpers interpret little-endian and sign", () => {
  assert.equal(new Tlv(0xa1, Uint8Array.of(0x34, 0x12)).asInt(), 0x1234);
  assert.equal(new Tlv(0xa1, Uint8Array.of(0xff)).asInt(), 255);
  assert.equal(new Tlv(0xa1, Uint8Array.of(0xff)).asInt({ signed: true }), -1);
  assert.equal(new Tlv(0xa1, Uint8Array.of(0xfe)).asInt({ signed: true }), -2);
});

test("stripStatus drops the OK byte only when present", () => {
  assert.equal(toHex(stripStatus(Uint8Array.of(0x00, 0xa1))), "a1");
  assert.equal(toHex(stripStatus(Uint8Array.of(0xa1))), "a1");
  assert.equal(toHex(stripStatus(new Uint8Array(0))), "");
});

// ---------------------------------------------------------------------------
// real captured payload
// ---------------------------------------------------------------------------

test("real captured telemetry payload walks to exactly its own length", () => {
  const raw = fromHex(vectors.real_payload.hex);
  const tags = decodeTlv(raw, { strict: true });
  assert.equal(tags.length, vectors.real_payload.tags.length);
  assert.equal(
    tags.reduce((n, t) => n + 2 + t.length, 0),
    raw.length,
    "TLV walk must consume the payload exactly",
  );
});

test("real captured telemetry payload decodes to the same tags as Python", () => {
  const raw = fromHex(vectors.real_payload.hex);
  const tags = decodeTlv(raw);
  for (let i = 0; i < tags.length; i++) {
    const expected = vectors.real_payload.tags[i];
    assert.equal(tags[i].tag, expected.tag, `tag #${i}`);
    assert.equal(toHex(tags[i].value), expected.value_hex, `value of tag #${i}`);
  }
});

test("vendor string tag decodes as ASCII", () => {
  const tags = decodeTlv(fromHex(vectors.real_payload.hex));
  const d0 = tags.find((t) => t.tag === 0xd0);
  assert.ok(d0, "expected tag 0xD0");
  assert.equal(d0.length, 17);
  assert.equal(d0.value[0], 0x00);
  assert.equal(new TextDecoder().decode(d0.value.subarray(1)), "APC9FE0E27300275");
});

// ---------------------------------------------------------------------------
// crypto behaviour
// ---------------------------------------------------------------------------

test("IV is the serial number, padded to 16 bytes", () => {
  assert.equal(toHex(serialIv("A8B9C0D1E2F30001")), toHex(new TextEncoder().encode("A8B9C0D1E2F30001")));
  assert.equal(serialIv("SHORT").length, 16);
  assert.equal(serialIv("SHORT")[5], 0x00);
  assert.equal(serialIv("X".repeat(32)).length, 16);
});

test("PKCS#7 padding round-trips and validates", () => {
  for (const n of [0, 1, 15, 16, 17, 31, 32]) {
    const data = new Uint8Array(n).fill(0xab);
    const padded = pkcs7Pad(data);
    assert.equal(padded.length % 16, 0);
    assert.ok(padded.length > n || n === 0);
    assert.equal(toHex(pkcs7Unpad(padded)), toHex(data));
  }
  assert.throws(() => pkcs7Unpad(new Uint8Array(0)), /non-zero multiple/);
  assert.throws(() => pkcs7Unpad(Uint8Array.of(1, 2, 3)), /multiple of 16/);
});

test("AES-CBC chains blocks so identical plaintext blocks differ", async (t) => {
  if (!cryptoAvailable()) return t.skip("WebCrypto unavailable");
  const ctx = await initialContext("A8B9C0D1E2F30001");
  const ct = await ctx.encrypt(new Uint8Array(32));
  assert.notEqual(toHex(ct.subarray(0, 16)), toHex(ct.subarray(16, 32)));
});

test("session context differs from initial context", async (t) => {
  if (!cryptoAvailable()) return t.skip("WebCrypto unavailable");
  const serial = "A8B9C0D1E2F30001";
  const a = await initialContext(serial);
  const b = await sessionContext(Uint8Array.from({ length: 16 }, (_, i) => i), serial);
  assert.notEqual(a.keyHex, b.keyHex);
  assert.equal(a.ivHex, b.ivHex);
  assert.equal(b.phase, "session");
});

test("decrypt rejects non-block-aligned ciphertext", async (t) => {
  if (!cryptoAvailable()) return t.skip("WebCrypto unavailable");
  const ctx = await initialContext("A8B9C0D1E2F30001");
  await assert.rejects(() => ctx.decrypt(new Uint8Array(15)), /multiple of 16/);
});

// ---------------------------------------------------------------------------
// session / handshake
// ---------------------------------------------------------------------------

test("full handshake against a simulated device", async (t) => {
  if (!cryptoAvailable()) return t.skip("WebCrypto unavailable");
  const device = new ScriptedDevice();
  const session = new AnkerSession(device);
  const info = await session.connect();

  assert.equal(info.serialNumber, "A8B9C0D1E2F30001");
  assert.equal(info.firmwareVersion, "1.6.2");
  assert.equal(info.btMac, "aa:bb:cc:dd:ee:ff");

  assert.equal(session.sessionKey.length, 16);
  assert.equal(session.crypto.phase, "session");

  // The four plaintext handshake frames, then the encrypted key request.
  assert.deepEqual(device.sentCommands(), [0x0001, 0x0003, 0x0029, 0x0005, 0x0022]);
  const encryptedFlags = device.sent.map((raw) => parseFrame(raw).encrypted);
  assert.deepEqual(encryptedFlags, [false, false, false, false, true]);
});

test("AES-CBC padding follows PKCS#7 for block-aligned input", async (t) => {
  if (!cryptoAvailable()) return t.skip("WebCrypto unavailable");
  const ctx = await initialContext("A8B9C0D1E2F30001");

  // PKCS#7 always adds padding, so a block-aligned plaintext gains a whole extra
  // block. Getting this wrong produced a silent extra block in Chrome while a
  // Node-only suite passed, so the rule is pinned explicitly here.
  assert.equal((await ctx.encrypt(new Uint8Array(6))).length, 16, "6 bytes -> one block");
  assert.equal((await ctx.encrypt(new Uint8Array(16))).length, 32, "16 bytes -> extra block");
  assert.equal((await ctx.encrypt(new Uint8Array(32))).length, 48, "32 bytes -> extra block");

  // Every width must round-trip through decrypt.
  for (const n of [0, 1, 6, 15, 16, 17, 31, 32]) {
    const data = new Uint8Array(n).fill(0x5a);
    assert.equal(toHex(await ctx.decrypt(await ctx.encrypt(data))), toHex(data), `n=${n}`);
  }
});

test("handshake reports progress in order", async (t) => {
  if (!cryptoAvailable()) return t.skip("WebCrypto unavailable");
  const session = new AnkerSession(new ScriptedDevice());
  const stages = [];
  await session.connect({ onProgress: (s) => stages.push(s) });
  assert.deepEqual(stages, [
    "startConnectReq",
    "capabilityNegotiationReq",
    "getDeviceInfoReq",
    "setCapabilityReq",
    "getAesKeyReq",
    "done",
  ]);
});

test("handshake fails clearly when the device omits the serial number", async (t) => {
  if (!cryptoAvailable()) return t.skip("WebCrypto unavailable");

  // A device that replies to getDeviceInfo without tag A4.
  class NoSerial extends ScriptedDevice {
    async _respond(req) {
      if (req.command === Opcode.GET_DEVICE_INFO_REQ) {
        return buildFrame(req.command, Uint8Array.of(0x00, 0xa3, 0x03, 0x31, 0x2e, 0x30), {
          group: req.group,
          response: true,
        });
      }
      return super._respond(req);
    }
  }

  const session = new AnkerSession(new NoSerial());
  await assert.rejects(() => session.connect(), /serial number/);
});

test("a timeout surfaces as a TimeoutError", async (t) => {
  if (!cryptoAvailable()) return t.skip("WebCrypto unavailable");
  const empty = new ReplayTransport([]);
  const session = new AnkerSession(empty, { timeout: 30 });
  await assert.rejects(() => session.connect(), (err) => {
    assert.equal(err.name, "TimeoutError");
    return true;
  });
});

test("malformed frames are skipped while waiting for a response", async (t) => {
  if (!cryptoAvailable()) return t.skip("WebCrypto unavailable");
  const device = new ScriptedDevice();
  const session = new AnkerSession(device, { timeout: 500 });

  // Inject a garbage notification ahead of the real reply.
  const realSend = device.send.bind(device);
  device.send = async (data) => {
    await realSend(data);
    device._out.unshift(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
  };

  const info = await session.connect();
  assert.equal(info.serialNumber, "A8B9C0D1E2F30001");
  assert.ok(
    session.history.some((h) => h.dir === "rx-error"),
    "the malformed frame should be recorded",
  );
});

// ---------------------------------------------------------------------------
// status decoding
// ---------------------------------------------------------------------------

test("status decoding produces the documented values", async (t) => {
  if (!cryptoAvailable()) return t.skip("WebCrypto unavailable");
  const device = new ScriptedDevice();
  const session = new AnkerSession(device);
  await session.connect();
  await device.makeSessionContext(sessionContext);

  const status = await session.readStatus();
  assert.equal(status.batteryPercent, 87.5);
  assert.equal(status.temperatureC, 25);
  assert.equal(status.temperatureF, 77);
  assert.equal(status.totalOutputW, 123.4);
  assert.equal(status.totalInputW, 56.0);

  const c1 = status.ports.C1;
  assert.equal(c1.modeName, "output");
  assert.equal(c1.voltage, 200);
  assert.equal(c1.current, 1.5);
  assert.equal(c1.power, 300);
});

test("status decoding ignores an absent status byte", () => {
  const session = new AnkerSession(new ReplayTransport());
  const port = new Uint8Array(12);
  port[2] = 1;
  port[3] = 0x64;
  port[4] = 0x00; // 10.0 V
  const payload = encodeTlv([
    [0xa2, Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 42, 0])],
    [0xa4, port],
  ]);
  const status = session.parseStatus(payload);
  assert.equal(status.batteryPercent, 42);
  assert.equal(status.ports.C1.voltage, 10);
  assert.equal(status.ports.C1.modeName, "input");
});

test("port blocks that are too short are ignored rather than throwing", () => {
  const session = new AnkerSession(new ReplayTransport());
  const status = session.parseStatus(encodeTlv([[0xa4, Uint8Array.of(1, 2, 3)]]));
  assert.equal(Object.keys(status.ports).length, 0);
});

// ---------------------------------------------------------------------------
// tables and helpers
// ---------------------------------------------------------------------------

test("opcode table is complete and named", () => {
  assert.equal(Object.keys(OPCODE_NAMES).length, 129);
  assert.equal(OPCODE_NAMES[0x0500], "postA17b1DeviceInfoReq");
  assert.equal(OPCODE_NAMES[0x0001], "startConnectReq");
  assert.equal(OPCODE_NAMES[0x0822], "getAesKeyRes / scanWifiRes");
});

test("findFamily is case-insensitive and matches both service and write", () => {
  assert.equal(findFamily("22150001-4002-81C5-b46e-cf057c562025"), PRIMARY_FAMILY);
  assert.equal(findFamily("22150002-4002-81c5-b46e-cf057c562025"), PRIMARY_FAMILY);
  assert.equal(findFamily("8c850003-0302-41c5-b46e-cf057c562025").name, "alt-8c85");
  assert.equal(findFamily("0000180f-0000-1000-8000-00805f9b34fb"), null);
});

test("tagName resolves response and request tags", () => {
  assert.match(tagName(0xa1, "response"), /session_key/);
  assert.match(tagName(0xa1, "request"), /timestamp/);
  assert.equal(tagName(0x12, "response"), null);
});

test("replay transport records what the client sent", async () => {
  const replay = new ReplayTransport([buildFrame(0x0001, Uint8Array.of(0), { response: true })]);
  const session = new AnkerSession(replay, { timeout: 200 });
  await session._exchange(0x0001, []);
  assert.deepEqual(replay.sentCommands(), [0x0001]);
});

// ---------------------------------------------------------------------------
// demo mode
// ---------------------------------------------------------------------------

test("demo device completes a real handshake and serves telemetry", async (t) => {
  if (!cryptoAvailable()) return t.skip("WebCrypto unavailable");
  const { DemoDevice } = await import("../src/demo.js");

  const device = new DemoDevice();
  const session = new AnkerSession(device);
  const info = await session.connect();

  assert.equal(info.serialNumber, "APC9FE0E27300275");
  assert.equal(info.firmwareVersion, "1.6.2");
  assert.equal(info.btMac, "a4:c1:38:b2:7f:01");
  assert.equal(info.sku, "A1340", "the model SKU should be picked up from TLV 0xAB");
  assert.equal(session.sessionKey.length, 16);

  // The demo must go through the same encrypted path as a real device.
  assert.deepEqual(device.sentCommands(), [0x0001, 0x0003, 0x0029, 0x0005, 0x0022]);

  const status = await session.readStatus();
  assert.ok(status.batteryPercent > 0 && status.batteryPercent <= 100, `battery=${status.batteryPercent}`);
  assert.ok(status.temperatureC !== null);
  assert.equal(status.temperatureF, Math.round(status.temperatureC * 1.8 + 32));
  assert.ok(status.totalOutputW > 0);
  assert.ok(status.totalInputW > 0);

  // The demo reports the A1340's four connectors, matching its confirmed layout.
  assert.deepEqual(Object.keys(status.ports).sort(), ["A", "C1", "C2", "P"]);
  assert.equal(status.ports.C1.modeName, "input");
  assert.equal(status.ports.C2.modeName, "output");
  assert.ok(status.ports.C2.power > 0);
  assert.ok(status.ports.P.power > 0);
});

test("demo telemetry varies between polls", async (t) => {
  if (!cryptoAvailable()) return t.skip("WebCrypto unavailable");
  const { DemoDevice } = await import("../src/demo.js");

  const device = new DemoDevice();
  const session = new AnkerSession(device);
  await session.connect();

  const first = await session.readStatus();
  const second = await session.readStatus();

  // Battery is a deterministic function of the poll count, so this cannot pass by
  // accident the way comparing two wobbling ports might.
  assert.notEqual(first.batteryPercent, second.batteryPercent);

  // And the per-port readings should move too.
  const readings = (s) => Object.values(s.ports).map((p) => `${p.voltage}/${p.current}`).join(",");
  assert.notEqual(readings(first), readings(second));
});

test("demo device accepts settings commands", async (t) => {
  if (!cryptoAvailable()) return t.skip("WebCrypto unavailable");
  const { DemoDevice } = await import("../src/demo.js");

  const session = new AnkerSession(new DemoDevice());
  await session.connect();
  await session.setBeep(true);
  await session.setTheme(true);
  assert.equal(session.history.filter((h) => h.dir === "tx").length, 7);
});

// ---------------------------------------------------------------------------
// model registry
// ---------------------------------------------------------------------------

test("model registry carries real data from the app binary", async () => {
  const { MODELS, modelBySku, modelFromName, modelLabel, isKnownSku } =
    await import("../src/models.js");

  assert.ok(MODELS.length >= 30, `expected the full registry, got ${MODELS.length}`);

  // Spot-check names that came from the app's own device registry table.
  assert.equal(modelBySku("A1340").name, "Prime Power Bank");
  assert.equal(modelBySku("A1782").name, "SOLIX F3000");
  assert.equal(modelBySku("A1790").name, "SOLIX F3800");
  assert.equal(modelBySku("A2345").name, "250W Prime Charger");

  // Case-insensitive, and P-variants must not be confused with their base SKU.
  assert.equal(modelBySku("a1340").sku, "A1340");
  assert.equal(modelBySku("A1790P").name, "SOLIX F3800 Plus");
  assert.equal(modelBySku("A1790P").sku, "A1790P");

  assert.equal(modelBySku("nope"), null);
  assert.equal(modelFromName("Anker A1340").sku, "A1340");
  assert.equal(modelFromName("Anker Prime Power Bank (A1340)").sku, "A1340");
  // The device name is writable over the air, so a SKU must be its own token
  // and must exist - "A13400" must not match "A1340".
  assert.equal(modelFromName("A13400"), null);
  assert.equal(modelFromName("myA1340bank"), null);
  assert.equal(modelFromName("Anker Z9999"), null);
  assert.equal(modelLabel(modelBySku("A1340")), "Prime Power Bank (A1340)");
  assert.equal(isKnownSku("A1340"), true);
  assert.equal(isKnownSku("A9999"), false);
  assert.equal(isKnownSku(""), false);
});

test("A1340 port layout is the one confirmed from per-port artwork", async () => {
  const { modelBySku } = await import("../src/models.js");
  const a1340 = modelBySku("A1340");

  assert.equal(a1340.portLayoutConfirmed, true);
  assert.deepEqual(
    a1340.ports.map((p) => p.id),
    ["C1", "C2", "P", "A"],
  );

  // The A2345's layout comes from its per-port indicator artwork
  // (imgl_usb_A2345_black_normal_c1..c4/a1/a2.png), which is stronger evidence
  // than a guess from its form factor would be.
  const a2345 = modelBySku("A2345");
  assert.equal(a2345.portLayoutConfirmed, true);
  assert.deepEqual(
    a2345.ports.map((p) => p.id),
    ["C1", "C2", "C3", "C4", "A1", "A2"],
  );
  // Connector types are inferred from the token, and marked as such by being
  // separate from the confirmed port list.
  assert.equal(a1340.ports.find((p) => p.id === "A").type, "usb-a");
  assert.equal(a1340.ports.find((p) => p.id === "C1").type, "usb-c");
});

test("models without per-port artwork do not claim a port layout", async () => {
  const { MODELS } = await import("../src/models.js");
  const unconfirmed = MODELS.filter((m) => !m.portLayoutConfirmed);
  assert.ok(unconfirmed.length > 0);
  for (const m of unconfirmed) {
    assert.deepEqual(m.ports, [], `${m.sku} should not invent a port list`);
  }
});

test("aspect ratios are plausible when present", async () => {
  const { MODELS } = await import("../src/models.js");
  const withAspect = MODELS.filter((m) => m.aspectRatio !== null);
  assert.ok(withAspect.length >= 5, `expected some form factors, got ${withAspect.length}`);
  for (const m of withAspect) {
    assert.ok(
      m.aspectRatio > 0.1 && m.aspectRatio < 10,
      `${m.sku} aspect ratio out of range: ${m.aspectRatio}`,
    );
  }
});

test("demo can simulate any demoable model, with its own port set", async (t) => {
  if (!cryptoAvailable()) return t.skip("WebCrypto unavailable");
  const { connectDemoDevice, demoModels } = await import("../src/demo.js");

  const models = demoModels();
  assert.ok(models.length >= 5, `expected several demoable models, got ${models.length}`);

  // Every demoable model must produce a working session with the ports it claims.
  for (const model of models) {
    const { transport, model: resolved } = await connectDemoDevice({ sku: model.sku });
    const session = new AnkerSession(transport);
    const info = await session.connect();

    assert.equal(info.sku, model.sku, `${model.sku}: SKU should round-trip`);
    assert.equal(resolved.sku, model.sku);

    const status = await session.readStatus();
    const actual = Object.keys(status.ports);

    // The wire protocol exposes a fixed set of port slots, so a model with more
    // connectors than slots reports two on the same slot - the A2345's two USB-A
    // ports both arrive on slot A6 and are disambiguated as "A" and "A2". So the
    // invariant is the *count* and that each port reports data, not that the
    // names match the registry's labelling exactly.
    assert.equal(
      actual.length,
      model.demoPorts.length,
      `${model.sku}: expected ${model.demoPorts.length} ports, got ${actual.join(",")}`,
    );
    for (const [name, port] of Object.entries(status.ports)) {
      assert.ok(port.voltage >= 0, `${model.sku}/${name}: voltage`);
      assert.ok(port.current >= 0, `${model.sku}/${name}: current`);
      assert.ok(["off", "input", "output"].includes(port.modeName), `${model.sku}/${name}: mode`);
    }
    assert.ok(status.totalOutputW >= 0, `${model.sku}: output power`);
  }
});

test("demo does not offer components as selectable models", async () => {
  const { demoModels } = await import("../src/demo.js");
  const skus = demoModels().map((m) => m.sku);
  // Microinverters and expansion modules are real hardware but not devices you
  // connect to here, so they must not appear in the demo picker.
  for (const excluded of ["A5140", "A5141", "A5143", "A5150", "A5220", "A5345", "A5341"]) {
    assert.ok(!skus.includes(excluded), `${excluded} should not be demoable`);
  }
});

test("the debug string masquerading as a SKU is not in the registry", async () => {
  const { modelBySku } = await import("../src/models.js");
  // "a1790CanUpdate------" parses as SKU A1790B but is a log message.
  assert.equal(modelBySku("A1790B"), null);
});

// ---------------------------------------------------------------------------
// product imagery
// ---------------------------------------------------------------------------

test("panel asset paths are derived from the SKU", async () => {
  const { heroSrc, portSrc } = await import("../src/schematic.js");

  assert.match(heroSrc("A1340"), /assets\/device\/a1340-hero\.webp$/);
  assert.match(heroSrc("a2345"), /assets\/device\/a2345-hero\.webp$/);
  assert.equal(heroSrc(null), null);

  // The preferred state comes first, then fallbacks, because the app does not
  // ship every port/state combination (there is no a1340 p_output).
  const out = portSrc("A1340", "P", "output");
  assert.match(out[0], /a1340-port-p-output\.webp$/);
  assert.ok(out.some((u) => /a1340-port-p-input\.webp$/.test(u)), "should fall back to a state that exists");
  assert.ok(out.some((u) => /a1340-port-p-empty\.webp$/.test(u)));

  // No duplicate candidates.
  assert.equal(new Set(out).size, out.length);
  assert.deepEqual(portSrc(null, "C1", "output"), []);
});

test("schematic falls back rather than throwing when a model has no art", async () => {
  const { heroSrc, portSrc } = await import("../src/schematic.js");
  // A registry model with no extracted imagery must still produce a path (the
  // <img> error handler then falls back), not an exception.
  assert.ok(typeof heroSrc("A1722") === "string");
  assert.ok(Array.isArray(portSrc("A1722", "C1", "output")));
});

test("display variant is chosen from live state, not cosmetics", async () => {
  const { variantFor } = await import("../src/schematic.js");
  const { modelBySku } = await import("../src/models.js");

  const a1340 = modelBySku("A1340");
  const a1753 = modelBySku("A1753");

  // A model whose active render shows it on the charging base uses that name.
  assert.equal(variantFor(a1340, { anyActive: true }), "charging");
  // Others just light up.
  assert.equal(variantFor(a1753, { anyActive: true }), "active");

  assert.equal(variantFor(a1340, { anyActive: false }), "normal");

  // Warnings take precedence over activity.
  assert.equal(variantFor(a1340, { anyActive: true, batteryPercent: 4 }), "lowBattery");
  assert.equal(variantFor(a1340, { anyActive: true, temperatureC: 52 }), "lowTemp");
  assert.equal(variantFor(a1340, { anyActive: true, temperatureC: -3 }), "lowTemp");

  // Boundary values must not trigger warnings.
  assert.equal(variantFor(a1340, { anyActive: true, batteryPercent: 50 }), "charging");
  assert.equal(variantFor(a1340, { anyActive: true, temperatureC: 30 }), "charging");

  assert.equal(variantFor(null, { anyActive: true }), null);
});

test("port indicator artwork coverage is known, so approximations are disclosed", async () => {
  const { hasPortArt } = await import("../src/schematic.js");

  // The A1340 ships full triples for its USB-C ports...
  assert.equal(hasPortArt("A1340", "C1", "input"), true);
  assert.equal(hasPortArt("A1340", "C1", "output"), true);
  // ...but only partial coverage for P and A. The panel must know this so it can
  // say it is showing the nearest available state rather than imply precision.
  assert.equal(hasPortArt("A1340", "P", "output"), false);
  assert.equal(hasPortArt("A1340", "P", "input"), true);
  assert.equal(hasPortArt("A1340", "A", "input"), false);
  assert.equal(hasPortArt("A1340", "A", "output"), true);

  // Unknown models report no coverage rather than guessing.
  assert.equal(hasPortArt("A1722", "C1", "output"), false);
  assert.equal(hasPortArt(null, "C1", "output"), false);
});

 test("checksum-inclusive framing matches a physical charger response", () => {
  const raw = fromHex("ff090e00030001080100a1010152");
  assert.equal(parseFrame(raw, { sizeIncludesChecksum: true }).command, 1);
  assert.deepEqual(buildFrame(1, fromHex("00a10101"), { response: true, sizeIncludesChecksum: true }), raw);
});
