/**
 * In-memory transports for tests and offline development.
 *
 * `ReplayTransport` serves a scripted list of inbound frames and records what
 * the client wrote, which is how the whole handshake is tested without a device.
 * `ScriptedDevice` is a tiny device simulator: it answers the Anker handshake
 * properly, including encrypting the session key with the initial context.
 */

import { A2_STATIC_VALUE, OP_GET_AES_KEY, initialContext } from "./crypto.js";
import { buildFrame, parseFrame } from "./framing.js";
import { Opcode } from "./opcodes.js";
import { Transport } from "./session.js";
import { encodeTlv, stripStatus, decodeTlv } from "./tlv.js";

/** Serve canned inbound bytes; record what the client wrote. */
export class ReplayTransport extends Transport {
  constructor(responses = []) {
    super();
    this._responses = [...responses];
    /** @type {Uint8Array[]} */
    this.sent = [];
  }

  async send(data) {
    this.sent.push(data.slice());
  }

  async receive() {
    if (!this._responses.length) {
      const err = new Error("replay exhausted");
      err.name = "TimeoutError";
      throw err;
    }
    return this._responses.shift();
  }

  /** Every command the client sent, in order. */
  sentCommands() {
    return this.sent.map((raw) => parseFrame(raw).command);
  }
}

/**
 * A minimal simulated Anker device. Answers the handshake and the status poll,
 * so the client can be exercised end to end without hardware.
 */
export class ScriptedDevice extends Transport {
  /**
   * @param {object} [opts]
   * @param {string} [opts.serialNumber]
   * @param {string} [opts.firmwareVersion]
   * @param {Uint8Array} [opts.sessionKey]
   */
  constructor(opts = {}) {
    super();
    const {
      serialNumber = "A8B9C0D1E2F30001",
      firmwareVersion = "1.6.2",
      btMac = "aabbccddeeff",
      sessionKey = Uint8Array.from({ length: 16 }, (_, i) => i),
    } = opts;
    this.serialNumber = serialNumber;
    this.firmwareVersion = firmwareVersion;
    this.btMac = btMac;
    this.sessionKey = sessionKey;
    this.sent = [];
    this._out = [];
    this._keyContext = null;
  }

  async send(data) {
    this.sent.push(data.slice());
    const req = parseFrame(data);

    // Decrypt inbound once a session is established, so we can assert on it.
    if (req.encrypted) {
      const ctx = this._sessionContext ?? this._keyContext;
      if (ctx) {
        try {
          this.lastPlaintext = await ctx.decrypt(req.payload);
        } catch {
          this.lastPlaintext = null;
        }
      }
    } else {
      this.lastPlaintext = req.payload;
    }

    this._out.push(await this._respond(req));
  }

  async receive(timeoutMs = 4000) {
    if (!this._out.length) {
      const err = new Error("simulated device has nothing queued");
      err.name = "TimeoutError";
      throw err;
    }
    // A tiny delay makes the async paths behave like the real thing.
    await new Promise((r) => setTimeout(r, 0));
    return this._out.shift();
  }

  async _respond(req) {
    if (req.command === Opcode.GET_DEVICE_INFO_REQ) {
      const tlvs = encodeTlv([
        [0xa3, new TextEncoder().encode(this.firmwareVersion)],
        [0xa4, new TextEncoder().encode(this.serialNumber)],
        [0xa5, Uint8Array.from(this.btMac.match(/../g).map((h) => parseInt(h, 16)))],
      ]);
      return buildFrame(req.command, concatBytes(Uint8Array.of(0x00), tlvs), {
        group: req.group,
        response: true,
      });
    }

    if (req.command === OP_GET_AES_KEY) {
      this._keyContext = await initialContext(this.serialNumber);
      const inner = encodeTlv([[0xa1, this.sessionKey]]);
      const cipher = await this._keyContext.encrypt(inner);
      return buildFrame(req.command, cipher, {
        group: req.group,
        encrypted: true,
        response: true,
      });
    }

    // Status poll: synthesise a plausible 0x0500 payload.
    if (req.command === Opcode.POST_A17B1_DEVICE_INFO_REQ) {
      const port = new Uint8Array(12);
      port[2] = 2;
      port[3] = 0xd0;
      port[4] = 0x07; // 200.0 V
      port[5] = 0x0f; // 1.5 A
      const battery = new Uint8Array(10);
      battery[8] = 87;
      battery[9] = 50;
      const total = new Uint8Array(5);
      total[1] = 0xd2;
      total[2] = 0x04; // 123.4 W
      total[3] = 0x30;
      total[4] = 0x02; // 56.0 W
      const tlvs = encodeTlv([
        [0xa2, battery],
        [0xa4, port],
        [0xae, total],
        [0xb3, Uint8Array.of(0x00, 25, 77)],
      ]);
      const plain = concatBytes(Uint8Array.of(0x00), tlvs);
      const ctx = this._sessionContext;
      const body = ctx && req.encrypted ? await ctx.encrypt(plain) : plain;
      return buildFrame(req.command, body, {
        group: req.group,
        encrypted: Boolean(req.encrypted && ctx),
        response: true,
      });
    }

    return buildFrame(req.command, Uint8Array.of(0x00), { group: req.group, response: true });
  }

  /**
   * Give the simulator the session context the client derived, so it can both
   * decrypt inbound commands and encrypt session-phase replies.
   */
  useSessionContext(ctx) {
    this._sessionContext = ctx;
  }

  /** Build the session context for the key this simulator issues. */
  async makeSessionContext(sessionContextFactory) {
    this._sessionContext = await sessionContextFactory(this.sessionKey, this.serialNumber);
    return this._sessionContext;
  }

  /** Commands received, in order. */
  sentCommands() {
    return this.sent.map((raw) => parseFrame(raw).command);
  }

  /** Decoded TLV of the last received frame. */
  lastTags() {
    return decodeTlv(stripStatus(this.lastPlaintext ?? new Uint8Array(0)), { strict: false });
  }
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export { A2_STATIC_VALUE };
