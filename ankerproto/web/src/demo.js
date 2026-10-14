/**
 * Demo mode transport — a simulated Anker device for the browser.
 *
 * Why this exists: the interesting parts of the UI (device info, telemetry,
 * per-port power, settings, protocol log) are all hidden until a device is
 * connected. Reviewing a change, or viewing the site without hardware to hand,
 * therefore showed a nearly empty page. Demo mode drives the *real* session
 * code and the *real* UI from a synthetic device, so everything can be seen
 * without hardware.
 *
 * This module is **only imported when demo mode is requested** (`?demo=1` or the
 * header toggle), so the connect path for real devices - and `scripts/smoke-ui.mjs`,
 * which asserts a disconnected start state - is unaffected. It is never loaded
 * on a normal visit, which is also why it is not part of the shipped app bundle
 * in any meaningful sense.
 *
 * The frames are genuine: `AnkerSession` really handshakes and really encrypts.
 * Only the device end is simulated.
 */

import { A2_STATIC_VALUE, OP_GET_AES_KEY, initialContext, sessionContext } from "./crypto.js";
import { MODELS, modelBySku } from "./models.js";
import { buildFrame, parseFrame } from "./framing.js";
import { CommandGroup, Opcode } from "./opcodes.js";
import { Transport } from "./session.js";
import { encodeTlv, decodeTlv } from "./tlv.js";
import { CHARGER_SETTINGS } from './charger-settings.js';

/** A plausible Anker Prime. */
/** Default model for demo mode: the one with a confirmed port layout. */
export const DEFAULT_DEMO_SKU = "A1340";

const BASE_DEVICE = {
  serialNumber: "APC9FE0E27300275",
  firmwareVersion: "1.6.2",
  btMac: "a4c138b27f01",
  sessionKey: Uint8Array.from([
    0x9e, 0x1c, 0x4b, 0x77, 0xa2, 0x3f, 0x60, 0xd8, 0x05, 0xbb, 0x4e, 0x91, 0x73, 0xc0, 0x2a, 0x6d,
  ]),
};

/**
 * Models that can be simulated, for the demo picker.
 *
 * Filtered to entries with a real measured form factor, which excludes the
 * components in the registry (microinverters, battery modules) that are not
 * devices you would connect to from here.
 */
export function demoModels() {
  return MODELS.filter((m) => m.demoable && m.demoPorts.length > 0);
}

/** Build the simulated device description for a registry model. */
function deviceFor(model) {
  return {
    ...BASE_DEVICE,
    sku: model.sku,
    name: `${model.name} (demo)`,
    /** Ports to simulate: confirmed where known, otherwise synthesised. */
    ports: model.demoPorts,
  };
}

/**
 * Generate a telemetry payload that looks like a real device's.
 *
 * Ports are synthesised from a plausible load so the numbers move between
 * refreshes instead of being frozen. Real devices report these as
 * `<datatype 0x02><int16 LE>` blocks with voltage and current scaled by 10.
 *
 * @param {number} tick monotonically increasing counter driving the simulation
 */
function telemetryPayload(tick, ports) {
  // Smooth but fast enough to visibly change between polls: `tick` advances once
  // per 0x0500 request, and the UI polls every few seconds. Periods are in ticks
  // and kept short so no two consecutive reads are identical.
  const wobble = (period, phase = 0) => Math.sin((tick / period) * Math.PI * 2 + phase);

  // Battery moves once per poll, so consecutive reads always differ. That makes
  // "the simulation is alive" a deterministic property rather than a coincidence
  // of which ports happen to wobble apart.
  const battery = 87.5 - (tick % 40) * 0.05;
  const socHundredths = Math.round((battery - Math.floor(battery)) * 100);
  const socWhole = Math.floor(battery);

  /** Build one 12-byte port block. mode 0 = off, 1 = input, 2 = output. */
  const port = (mode, volts, amps) => {
    const b = new Uint8Array(12);
    b[0] = 0x00;
    b[1] = 0x01;
    b[2] = mode;
    const v = Math.round(volts * 10);
    const a = Math.round(amps * 10);
    b[3] = v & 0xff;
    b[4] = (v >> 8) & 0xff;
    b[5] = a & 0xff;
    b[6] = (a >> 8) & 0xff;
    // Remaining bytes are model-specific; real devices send non-zero tails.
    b[7] = 0x64;
    b[8] = 0x00;
    return b;
  };

  // Give each port a plausible role: one input (being charged), the rest putting
  // power out, with USB-A ports carrying lighter loads than USB-C.
  // Periods are deliberately co-prime so no two ports move in lockstep, and
  // none repeat on a short cycle.
  const PROFILES = [
    { mode: 1, volts: 20.1, vw: 11, ampBase: 2.45, aw: 5 },   // input
    { mode: 2, volts: 8.94, vw: 7, ampBase: 1.85, aw: 9 },    // fast charge
    { mode: 2, volts: 9.0, vw: 13, ampBase: 1.1, aw: 4 },
    { mode: 2, volts: 5.12, vw: 17, ampBase: 0.42, aw: 11 },
    { mode: 2, volts: 5.0, vw: 19, ampBase: 0.3, aw: 6 },
    { mode: 0, volts: 0, vw: 23, ampBase: 0, aw: 8 },          // idle
  ];

  // Status tag per port, matching the 0x0500 layout. Every port needs its own
  // tag: reusing one silently drops a port from the parsed status (which showed
  // up as the panel counting fewer ports than the note claimed).
  // A6 is the USB-A slot, A7 the "P" slot on models that have one, and A8 is
  // reserved for AC.
  // Slots follow the app's own convention: A4/A5 are the C1/C2 slots, A6 the
  // USB-A slot, A7 the "P" slot on models that have one, A9/AA the C3/C4 slots.
  // Models with two USB-A ports (the A2345) report them as A1/A2 on the same
  // slot, so both spellings map to A6.
  const TAG_FOR_PORT = {
    C1: 0xa4,
    C2: 0xa5,
    A: 0xa6,
    A1: 0xa6,
    A2: 0xa6,
    P: 0xa7,
    AC: 0xa8,
    C3: 0xa9,
    C4: 0xaa,
    C5: 0xab,
  };

  let outWatts = 0;
  let inWatts = 0;
  const portTlvs = [];

  ports.forEach((p, i) => {
    const prof = PROFILES[i % PROFILES.length];
    const id = String(p.id).toUpperCase();
    // USB-A cannot carry a 100 W load, so keep its numbers believable.
    const isA = id.startsWith("A");
    const volts = isA ? 5.12 : prof.volts;
    const amps = prof.ampBase === 0 ? 0 : prof.ampBase + wobble(prof.aw, i) * 0.2;
    const block = port(prof.mode, volts, amps);
    if (prof.mode === 1) inWatts += volts * amps;
    if (prof.mode === 2) outWatts += volts * amps;
    portTlvs.push([TAG_FOR_PORT[id] ?? 0xa6, block]);
  });

  const batteryBlock = new Uint8Array(10);
  batteryBlock[8] = socWhole;
  batteryBlock[9] = socHundredths;

  const total = new Uint8Array(5);
  const outTenths = Math.max(0, Math.round((outWatts + wobble(6) * 1.5) * 10));
  const inTenths = Math.max(0, Math.round((inWatts + wobble(8, 1) * 2) * 10));
  total[1] = outTenths & 0xff;
  total[2] = (outTenths >> 8) & 0xff;
  total[3] = inTenths & 0xff;
  total[4] = (inTenths >> 8) & 0xff;

  const tempC = 31 + Math.round(wobble(7) * 3);
  const tempF = Math.round(tempC * 1.8 + 32);

  return concat(
    // Status byte 0x00 = OK, as every real 0x0500 reply carries.
    Uint8Array.of(0x00),
    encodeTlv([
      [0xa1, Uint8Array.of(0x31)],
      [0xa2, batteryBlock],
      [0xa3, new Uint8Array(5)],
      ...portTlvs,
      [0xae, total],
      [0xb3, Uint8Array.of(0x00, tempC & 0xff, tempF & 0xff)],
      [0xd0, concat(Uint8Array.of(0x00), ascii(ports.length ? "" : ""))],
    ]),
  );
}

const ascii = (s) => new TextEncoder().encode(s);

function concat(...arrays) {
  let n = 0;
  for (const a of arrays) n += a.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/**
 * A simulated device that answers the Anker handshake correctly, including
 * encrypting the session key with the initial context.
 */
export class DemoDevice extends Transport {
  constructor(opts = {}) {
    super();
    this.isDemo = true;
    this.settings = { brightness: 100, timeout: 0, chargingMode: 1, rotation: 1, clockSchedule: [8, 0, 23, 0, 127] };
    const model = modelBySku(opts.sku) ?? modelBySku(DEFAULT_DEMO_SKU);
    this.model = model;
    this.device = { ...deviceFor(model), ...opts };
    this.sent = [];
    /** @type {Uint8Array[]} */
    this._out = [];
    this._keyContext = null;
    /** @type {import("./crypto.js").AesContext|null} */
    this._sessionContext = null;
    this._tick = 0;
    this._latency = opts.latency ?? 35;
  }

  async send(data) {
    this.sent.push(data.slice());
    const req = parseFrame(data);

    // Derive the session context the first time the client uses it, so inbound
    // encrypted commands can be decrypted and replies encrypted in kind.
    if (req.encrypted && !this._sessionContext && this._keyContext) {
      this._sessionContext = await sessionContext(this.device.sessionKey, this.device.serialNumber);
    }

    this._out.push(await this._respond(req));
  }

  async receive() {
    if (!this._out.length) {
      const err = new Error("demo device has nothing queued");
      err.name = "TimeoutError";
      throw err;
    }
    // A little latency makes the progress messages visible, like a real device.
    await new Promise((r) => setTimeout(r, this._latency));
    return this._out.shift();
  }

  async _respond(req) {
    if (this.device.sku === 'A2345' && req.group === 15) {
      if (req.command === 0x0205) {
        const payload = req.encrypted ? await this._sessionContext.decrypt(req.payload) : req.payload;
        this.settings.clockTheme = Object.fromEntries(decodeTlv(payload).filter(tag => tag.tag >= 0xa2 && tag.tag <= 0xa6).map(tag => [tag.tag, [...tag.value]]));
      }
      const name = Object.keys(CHARGER_SETTINGS).find(name => CHARGER_SETTINGS[name][0] === req.command) ?? (req.command === 0x0213 ? 'clockSchedule' : null);
      if (name) {
        const payload = req.encrypted ? await this._sessionContext.decrypt(req.payload) : req.payload;
        const value = decodeTlv(payload).find(tag => tag.tag === 0xa2)?.value;
        if (value) this.settings[name] = name === 'clockSchedule' ? [...value.slice(1)] : value[1];
      }
    }
    const reply = (command, payload, encrypted = false) =>
      buildFrame(command, payload, {
        group: req.group,
        response: true,
        encrypted,
      });

    switch (req.command) {
      case Opcode.GET_DEVICE_INFO_REQ:
        return reply(
          req.command,
          concat(
            Uint8Array.of(0x00), // OK status byte
            encodeTlv([
              [0xa3, ascii(this.device.firmwareVersion)],
              [0xa4, ascii(this.device.serialNumber)],
              [0xa5, fromHex(this.device.btMac)],
              // Product SKU, as models that support it report it.
              [0xab, ascii(this.device.sku)],
            ]),
          ),
        );

      case OP_GET_AES_KEY: {
        this._keyContext = await initialContext(this.device.serialNumber);
        const inner = encodeTlv([[0xa1, this.device.sessionKey]]);
        return reply(req.command, await this._keyContext.encrypt(inner), true);
      }

      case Opcode.POST_A17B1_DEVICE_INFO_REQ: {
        this._tick += 1;
        const plain = telemetryPayload(this._tick, this.device.ports);
        const ctx = this._sessionContext;
        return reply(req.command, ctx ? await ctx.encrypt(plain) : plain, Boolean(ctx));
      }

      // Settings commands acknowledge with an empty OK.
      case 0x0504:
      case 0x0505:
        return reply(req.command, Uint8Array.of(0x00));

      default:
        return reply(req.command, Uint8Array.of(0x00));
    }
  }

  async close() {
    this._out.length = 0;
  }

  /** Commands received, in order - mirrors ScriptedDevice. */
  sentCommands() {
    return this.sent.map((raw) => parseFrame(raw).command);
  }

  /** The client sent `A2_STATIC_VALUE`, exactly as with a real device. */
  get handshakeBlob() {
    return A2_STATIC_VALUE;
  }
}

function fromHex(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/**
 * Connect the UI to a simulated device.
 * @returns {Promise<{name: string, family: {name: string}}>}
 */
export async function connectDemoDevice(opts = {}) {
  const device = new DemoDevice(opts);
  return {
    transport: device,
    info: {
      name: device.device.name,
      family: { name: "prime-2215" },
    },
    model: device.model,
  };
}

export { CommandGroup };
