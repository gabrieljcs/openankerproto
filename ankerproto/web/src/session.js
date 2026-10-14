/**
 * High-level Anker device session. Mirrors `ankerproto/session.py`.
 *
 * Transport-agnostic: it turns protocol intent into frames and frames back into
 * values. In the browser the transport is Web Bluetooth (see `bluetooth.js`);
 * in tests it is a scripted replay of recorded bytes.
 */

import {
  A2_STATIC_VALUE,
  AesContext,
  OP_GET_AES_KEY,
  OP_GET_DEVICE_INFO,
  initialContext,
  sessionContext,
} from "./crypto.js";
import { buildFrame, parseFrame, toHex } from "./framing.js";
import { modelControls } from './capabilities.js';
import { settingBytes, decodeChargerSettings } from './charger-settings.js';
import { clockThemeFields, decodeClockTheme, clockOffset, clockTimezone } from './clock.js';
import {
  CommandGroup,
  HANDSHAKE_A3_CAPABILITY,
  HANDSHAKE_A4_CAPABILITY,
  HANDSHAKE_A5_CAPABILITY,
  OP_LIVE_POWER,
  OP_SET_BEEP,
  OP_SET_THEME,
  OP_TEMPERATURE,
  OPCODE_NAMES,
  Opcode,
} from "./opcodes.js";
import { Tlv, decodeTlv, encodeTlv, stripStatus } from "./tlv.js";
import { isKnownSku } from "./models.js";

/**
 * Run an async crypto operation without letting unhandled rejections escape,
 * but keep the (intentionally loosely-typed) JS surface simple.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function attempt(fn) {
  return fn();
}

/** Everything happens against this interface. */
export class Transport {
  async send() {
    throw new Error("send() not implemented");
  }
  async receive() {
    throw new Error("receive() not implemented");
  }
  async close() {}
}

/** One DC output port. */
export class PortStatus {
  constructor(name) {
    this.name = name;
    this.mode = 0;
    this.voltage = 0;
    this.current = 0;
  }
  get power() {
    return this.reportedPowerW ?? Math.round(this.voltage * this.current * 100) / 100;
  }
  get modeName() {
    return { 0: "off", 1: "input", 2: "output" }[this.mode] ?? `unknown(${this.mode})`;
  }
}

/** Decoded status payload. */
export class BatteryStatus {
  constructor() {
    this.batteryPercent = null;
    this.temperatureC = null;
    this.temperatureF = null;
    this.totalOutputW = null;
    this.totalInputW = null;
    /** @type {Object<string, PortStatus>} */
    this.ports = {};
    /** @type {Object<number, string>} */
    this.rawTags = {};
  }
}

/** Result of the plaintext handshake. */
export class DeviceInfo {
  constructor() {
    this.serialNumber = null;
    this.firmwareVersion = null;
    this.btMac = null;
    /**
     * Product SKU (e.g. "A1340"), when the device reports one. Several replies
     * carry it: TLV 0xAB/0xD1 on some models, and it is always derivable from
     * the advertised name. Used to pick the model-specific panel.
     */
    this.sku = null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AnkerSession {
  /**
   * @param {Transport} transport
   * @param {object} [opts]
   * @param {number} [opts.timeout=4000] per-command timeout in ms
   * @param {(dir: "tx"|"rx", frame: object, raw: Uint8Array) => void} [opts.onLog]
   */
  constructor(transport, opts = {}) {
    const { timeout = 4000, onLog = null, group = CommandGroup.MANAGEMENT,
      statusGroup = CommandGroup.POWER } = opts;
    this.transport = transport;
    this.timeout = timeout;
    this.onLog = onLog;
    this.group = group;
    this.statusGroup = statusGroup;

    this.info = new DeviceInfo();
    /** @type {AesContext|null} */
    this.crypto = null;
    this.sessionKey = null;
    /** Every frame seen, for the debug log. */
    this.history = [];
    this._exchangeQueue = Promise.resolve();
  }

  _log(dir, frame, raw) {
    this.history.push({ dir, frame, raw });
    if (this.history.length > 500) this.history.shift();
    if (this.onLog) this.onLog(dir, frame, raw);
  }

  /** Send one command and return the matching response frame. */
  _exchange(command, tlvs = [], opts = {}) {
    const result = this._exchangeQueue.then(() => this._exchangeOnce(command, tlvs, opts));
    this._exchangeQueue = result.catch(() => {});
    return result;
  }

  async _exchangeOnce(command, tlvs = [], opts = {}) {
    const { group = this.group, encrypted = this.crypto !== null } = opts;

    const plaintext = encodeTlv(tlvs);
    const payload = encrypted ? await attempt(() => this.crypto.encrypt(plaintext)) : plaintext;
    const raw = buildFrame(command, payload, { group, encrypted,
      sizeIncludesChecksum: this.transport.family?.name === "alt-8c85",
    });

    this._log("tx", {
      command, commandHex: `0x${command.toString(16).padStart(4, "0")}`,
      commandName: OPCODE_NAMES[command] ?? "?", group, encrypted, response: false,
      payload: plaintext,
    }, raw);

    await this.transport.send(raw);
    return this._awaitResponse(command);
  }

  async _awaitResponse(command) {
    const deadline = Date.now() + this.timeout;

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `no response to 0x${command.toString(16).padStart(4, "0")} within ${this.timeout}ms`,
        );
      }

      let raw;
      try {
        raw = await this.transport.receive(remaining);
      } catch (err) {
        if (err && err.name === "TimeoutError") throw err;
        throw err;
      }

      let parsed;
      try {
        parsed = parseFrame(raw, { sizeIncludesChecksum: this.transport.family?.name === "alt-8c85" });
      } catch (err) {
        // Malformed or partially-framed notification; keep listening.
        this._log("rx-error", { error: String(err?.message ?? err) }, raw);
        continue;
      }

      const decrypted = await this._maybeDecrypt(parsed);
      if (parsed.encrypted && this.crypto && !decrypted) {
        this._log("rx-error", { error: "Encrypted reply could not be decrypted with the active key." }, raw);
        continue;
      }
      const routed = decrypted ?? parsed;
      this._log("rx", routed, raw);

      if (routed.command === command && routed.response) return routed;
      // Unsolicited push (0x04xx) or an unrelated reply: surface it, keep waiting.
      if (this.onPush && routed.command >= 0x0400 && routed.command < 0x0500) {
        this.onPush(routed);
      }
    }
  }

  async _maybeDecrypt(frame) {
    if (!frame.encrypted || !this.crypto) return null;
    try {
      const plain = await this.crypto.decrypt(frame.payload);
      return { ...frame, payload: plain, encrypted: false };
    } catch {
      return null;
    }
  }

  /**
   * Run the plaintext handshake, then establish the session key.
   * After this resolves, `crypto` is the session context and `info` is filled.
   */
  async connect({ onProgress = null } = {}) {
    const step = (name) => onProgress?.(name);
    const timestamp = Math.floor(Date.now() / 1000);
    const tsBytes = new Uint8Array(4);
    new DataView(tsBytes.buffer).setUint32(0, timestamp, true);

    const a1 = new Tlv(0xa1, tsBytes);
    const a2 = new Tlv(0xa2, A2_STATIC_VALUE);

    step("startConnectReq");
    await this._exchange(Opcode.START_CONNECT_REQ, [a1, a2], { encrypted: false });

    step("capabilityNegotiationReq");
    await this._exchange(
      Opcode.CAPABILITY_NEGOTIATION_REQ,
      [a1, a2, new Tlv(0xa3, HANDSHAKE_A3_CAPABILITY), new Tlv(0xa4, HANDSHAKE_A4_CAPABILITY)],
      { encrypted: false },
    );

    step("getDeviceInfoReq");
    const infoFrame = await this._exchange(OP_GET_DEVICE_INFO, [a1, a2], { encrypted: false });
    this._parseDeviceInfo(infoFrame);

    step("setCapabilityReq");
    await this._exchange(
      Opcode.SET_CAPABILITY_REQ,
      [
        a1,
        a2,
        new Tlv(0xa3, HANDSHAKE_A3_CAPABILITY),
        new Tlv(0xa4, HANDSHAKE_A4_CAPABILITY),
        new Tlv(0xa5, HANDSHAKE_A5_CAPABILITY),
      ],
      { encrypted: false },
    );

    if (!this.info.serialNumber) {
      throw new Error("device did not report a serial number during the handshake");
    }

    step("getAesKeyReq");
    this.crypto = await initialContext(this.info.serialNumber);
    const chargerClock = this.info.sku === 'A2345' || /^A2345(?:_|$)/i.test(this.transport.device?.name ?? '');
    const keyFrame = await this._exchange(OP_GET_AES_KEY, [
      a1,
      a2,
      new Tlv(0xa3, chargerClock ? clockOffset() : new Uint8Array(4)),
      new Tlv(0xa5, chargerClock ? await clockTimezone() : new Uint8Array(40)),
    ]);

    const sessionKey = AnkerSession._extractSessionKey(keyFrame);
    if (!sessionKey) {
      const tags = decodeTlv(stripStatus(keyFrame.payload), { strict: false })
        .map((t) => `0x${t.tag.toString(16)}`)
        .join(", ");
      throw new Error(`device did not return a 16-byte session key in TLV 0xA1 (got ${tags})`);
    }

    this.sessionKey = sessionKey;
    this.crypto = await sessionContext(sessionKey, this.info.serialNumber);
    step("done");
    return this.info;
  }

  _parseDeviceInfo(frame) {
    for (const tag of decodeTlv(stripStatus(frame.payload), { strict: false })) {
      if (tag.tag === 0xa3) this.info.firmwareVersion = AnkerSession._trim(tag);
      else if (tag.tag === 0xa4) this.info.serialNumber = AnkerSession._trim(tag);
      else if (tag.tag === 0xa5) {
        const h = toHex(tag.value);
        this.info.btMac = (h.match(/../g) ?? []).join(":");
      } else if (tag.tag === 0xab) {
        // Some models report their product SKU as ASCII here. Validate it
        // against the registry before believing it: an unrecognised value is
        // more likely to be a different field with the same tag on a variant
        // firmware than an unknown product.
        const v = AnkerSession._trim(tag).toUpperCase();
        if (isKnownSku(v)) this.info.sku = v;
        else if (v) this._unrecognisedSku = v;
      }
    }
  }

  static _trim(tag) {
    return new TextDecoder().decode(tag.value).replace(/\0+$/, "").trim();
  }

  static _extractSessionKey(frame) {
    for (const tag of decodeTlv(stripStatus(frame.payload), { strict: false })) {
      if (tag.tag === 0xa1 && tag.value.length === 16) return tag.value;
    }
    return null;
  }

  // -- commands -------------------------------------------------------

  /** Full status dump (0x0500). */
  async readStatus() {
    const charger = this.info.sku === "A2345" && this.transport.family?.name === "alt-8c85";
    const tags = [new Tlv(0xa1, Uint8Array.of(0x21))];
    if (charger) {
      tags.push(new Tlv(0xa2, Uint8Array.of(4)));
      // ZXCommandTransformer appends the typed timestamp to every setting query.
      const timestamp = new Uint8Array(5);
      timestamp[0] = 3; // uint32 data type
      new DataView(timestamp.buffer).setUint32(1, Math.floor(Date.now() / 1000), true);
      tags.push(new Tlv(0xfe, timestamp));
    }
    // The recovered Dart list stores tagged 0x42, which represents byte 0x21.
    const frame = await this._exchange(charger ? 0x0200 : Opcode.POST_A17B1_DEVICE_INFO_REQ,
      tags, { group: charger ? 0x0f : this.statusGroup });
    const status = charger ? this.parseChargerStatus(frame.payload) : this.parseStatus(frame.payload, { live: false });
    if (this.transport.isDemo && this.info.sku === 'A2345') status.settings = { ...this.transport.settings };
    if (this.clockTheme && status.settings) status.settings.holiday = this.clockTheme.holiday;
    return status;
  }

  // Recovered A2345DeviceCommands::parseDeviceAllInfo / parseChargePortInfo.
  parseChargerStatus(payload) {
    const status = new BatteryStatus();
    const names = { 0xa4: "C1", 0xa5: "C2", 0xa6: "C3", 0xa7: "C4", 0xa8: "A1", 0xa9: "A2" };
    status.settings = decodeChargerSettings(decodeTlv(stripStatus(payload), { strict: false }));
    for (const tag of decodeTlv(stripStatus(payload), { strict: false })) {
      status.rawTags[tag.tag] = tag.asHex();
      if (!names[tag.tag]) continue;
      // Setting replies prefix raw bytes with data type 4.
      const v = tag.value.length === 8 && tag.value[0] === 4 ? tag.value.slice(1) : tag.value;
      if (v.length !== 7) continue;
      const port = new PortStatus(names[tag.tag]);
      port.mode = v[0] === 1 ? 2 : 0;
      port.voltage = (v[1] | v[2] << 8) / 1000;
      port.current = (v[3] | v[4] << 8) / 1000;
      port.reportedPowerW = (v[5] | v[6] << 8) / 100;
      status.ports[port.name] = port;
    }
    if (Object.keys(status.ports).length) {
      status.totalOutputW = Math.round(Object.values(status.ports).reduce((sum, port) => sum + port.power, 0) * 100) / 100;
    }
    return status;
  }

  /** Live per-port power (0x050E), faster than {@link readStatus}. */
  async readLivePower() {
    const frame = await this._exchange(OP_LIVE_POWER, [new Tlv(0xa1, Uint8Array.of(0x21))], {
      group: this.statusGroup,
    });
    return this.parseStatus(frame.payload, { live: true });
  }

  /** Dedicated temperature report (0x0522). */
  async readTemperature() {
    const frame = await this._exchange(OP_TEMPERATURE, [new Tlv(0xa1, Uint8Array.of(0x21))], {
      group: this.statusGroup,
    });
    for (const tag of decodeTlv(stripStatus(frame.payload), { strict: false })) {
      if (tag.tag === 0xa2 && tag.value.length >= 3) {
        return { celsius: tag.value[1], fahrenheit: tag.value[2] };
      }
    }
    return { celsius: null, fahrenheit: null };
  }

  /** A2345 app setting commands use the same typed envelope as telemetry. */
  async setChargerSetting(setting, value) {
    if (this.info.sku !== "A2345" || (!this.transport.isDemo && this.transport.family?.name !== "alt-8c85")) {
      throw new Error("These charger controls require an A2345 connection.");
    }
    const definition = settingBytes(setting, value);
    const timestamp = new Uint8Array(5);
    timestamp[0] = 3;
    new DataView(timestamp.buffer).setUint32(1, Math.floor(Date.now() / 1000), true);
    const frame = await this._exchange(definition.command, [new Tlv(0xa1, Uint8Array.of(0x21)),
      new Tlv(0xa2, definition.bytes), new Tlv(0xfe, timestamp)], { group: 0x0f });
    if (frame.payload[0] !== 0) throw new Error(`Device rejected setting (status ${frame.payload[0] ?? 'missing'}).`);
    if (setting === 'holiday') this.clockTheme = null;
  }

  async readClockTheme() {
    if (this.info.sku !== 'A2345' || (!this.transport.isDemo && this.transport.family?.name !== 'alt-8c85')) throw new Error('Clock themes require an A2345 connection.');
    if (this.transport.isDemo) return this.clockTheme = { ...(this.transport.clockTheme ?? { enabled: true, type: 0, id: 0, url: '' }), holiday: this.transport.settings.holiday ?? 0 };
    const timestamp = new Uint8Array(5); timestamp[0] = 3;
    new DataView(timestamp.buffer).setUint32(1, Math.floor(Date.now() / 1000), true);
    const frame = await this._exchange(0x0202, [new Tlv(0xa1, Uint8Array.of(0x21)), new Tlv(0xa2, Uint8Array.of(4)), new Tlv(0xfe, timestamp)], { group: 15 });
    if (frame.payload[0] !== 0) throw new Error('Charger rejected the clock settings query.');
    return this.clockTheme = decodeClockTheme(decodeTlv(stripStatus(frame.payload)));
  }

  async setClockTheme(theme) {
    if (this.info.sku !== 'A2345' || (!this.transport.isDemo && this.transport.family?.name !== 'alt-8c85')) throw new Error('Clock themes require an A2345 connection.');
    const timestamp = new Uint8Array(5);
    timestamp[0] = 3;
    new DataView(timestamp.buffer).setUint32(1, Math.floor(Date.now() / 1000), true);
    const fields = clockThemeFields(theme).map(([tag, value]) => new Tlv(tag, value));
    const frame = await this._exchange(0x0205, [new Tlv(0xa1, Uint8Array.of(0x21)), ...fields, new Tlv(0xfe, timestamp)], { group: 15 });
    if (frame.payload[0] !== 0) throw new Error(`Device rejected clock theme (status ${frame.payload[0] ?? 'missing'}).`);
    if (this.transport.isDemo) this.transport.clockTheme = { ...theme, holiday: this.transport.settings.holiday ?? 0 };
  }

  /** Display theme (0x0504). */
  async setTheme(advanced) {
    if (modelControls(this.info.sku).adapter !== 'prime') throw new Error('Display theme is not supported for this model.');
    await this._exchange(
      OP_SET_THEME,
      [
        new Tlv(0xa1, Uint8Array.of(0x21)),
        new Tlv(0xa2, Uint8Array.of(0x01, advanced ? 0x01 : 0x00)),
      ],
      { group: this.statusGroup },
    );
  }

  /** Beeper enable/disable (0x0505). */
  async setBeep(enabled) {
    if (modelControls(this.info.sku).adapter !== 'prime') throw new Error('Beeper is not supported for this model.');
    await this._exchange(
      OP_SET_BEEP,
      [
        new Tlv(0xa1, Uint8Array.of(0x21)),
        new Tlv(0xa2, Uint8Array.of(0x01, enabled ? 0x01 : 0x00)),
      ],
      { group: this.statusGroup },
    );
  }

  /**
   * Decode a status payload.
   *
   * `live=false` expects the 0x0500 layout (tags A2/A4/A5/A6/AE/B3);
   * `live=true` expects the 0x050E layout (tags A2/A3/A4/A6/A8).
   */
  parseStatus(payload, { live = false } = {}) {
    const body = stripStatus(payload);
    const status = new BatteryStatus();

    // Port-to-tag mapping. The 2215 family's 0x0500 reply puts C1/C2/A at
    // A4/A5/A6; models with a fourth connector (the A1340 has a "P" port) add
    // A7. Everything is keyed off what the device sends, so an unknown extra
    // tag is simply ignored rather than mislabelled.
    // A4..AA are port slots in the 0x0500 reply. A8 is the AC slot, which is why
    // it is not treated as a battery block on the non-live path (that is A2).
    // Slots A4..AA in the 0x0500 reply, following the app's own port naming.
    // A6 is the USB-A slot; on models with two USB-A ports the device reports
    // both there in sequence, so the two ids are disambiguated below rather
    // than overwriting each other.
    const portTags = live
      ? { 0xa2: "C1", 0xa3: "C2", 0xa4: "A", 0xa5: "P" }
      : {
          0xa4: "C1",
          0xa5: "C2",
          0xa6: "A",
          0xa7: "P",
          0xa8: "AC",
          0xa9: "C3",
          0xaa: "C4",
        };

    for (const tag of decodeTlv(body, { strict: false })) {
      status.rawTags[tag.tag] = tag.asHex();

      if (portTags[tag.tag]) {
        let name = portTags[tag.tag];
        // A second port landing on an already-used slot is a real occurrence
        // (two USB-A ports share slot A6), so number it instead of dropping it.
        if (status.ports[name]) {
          let n = 2;
          while (status.ports[`${name}${n}`]) n += 1;
          name = `${name}${n}`;
        }
        const port = AnkerSession._parsePort(name, tag.value);
        if (port) status.ports[port.name] = port;
      } else if (tag.tag === 0xa2 && !live && tag.value.length >= 10) {
        status.batteryPercent = tag.value[8] + tag.value[9] / 100;
      } else if (tag.tag === 0xa8 && live && tag.value.length >= 10) {
        status.batteryPercent = tag.value[8] + tag.value[9] / 100;
      } else if ((tag.tag === 0xae || (live && tag.tag === 0xa6)) && tag.value.length >= 5) {
        status.totalOutputW = ((tag.value[1] | (tag.value[2] << 8)) / 10);
        status.totalInputW = ((tag.value[3] | (tag.value[4] << 8)) / 10);
      } else if (tag.tag === 0xb3 && tag.value.length >= 3) {
        status.temperatureC = tag.value[1];
        status.temperatureF = tag.value[2];
      }
    }

    return status;
  }

  static _parsePort(name, value) {
    if (value.length < 12) return null;
    const port = new PortStatus(name);
    port.mode = value[2];
    if (port.mode !== 0) {
      port.voltage = Math.round(((value[3] | (value[4] << 8)) / 10) * 100) / 100;
      port.current = Math.round(((value[5] | (value[6] << 8)) / 10) * 1000) / 1000;
    }
    return port;
  }
}

export { sleep };
