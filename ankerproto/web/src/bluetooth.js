/**
 * Web Bluetooth transport for the Anker ZX protocol.
 *
 * Web Bluetooth is the browser API that makes this possible - not WebAssembly.
 * It is available in Chrome, Edge and Opera on desktop (Windows, macOS, Linux,
 * ChromeOS) and in Chrome on Android. It is NOT available in Safari, Firefox or
 * on iOS/iPadOS. See `support.js` for the capability probe used by the UI.
 *
 * Two browser-specific details drive this design:
 *
 *  1. `navigator.bluetooth.requestDevice()` must be called from a user gesture,
 *     so connecting is always an explicit button press.
 *  2. You must declare every service you will touch up front, via `filters`
 *     (for the advertised service) plus `optionalServices` (for the rest).
 *
 * The per-model service UUID cannot be known before connecting, so we advertise
 * a filter list covering all known families and probe them after connecting.
 */

import { buildFrame, xorChecksum } from "./framing.js";
import { MODELS } from "./models.js";
import { Transport } from "./session.js";
import { ADVERTISED_16BIT_UUIDS, UUID_FAMILIES } from "./uuids.js";

/** Is Web Bluetooth usable in this browser/context at all? */
export function bluetoothAvailable() {
  return typeof navigator !== "undefined" && Boolean(navigator.bluetooth);
}

/** Human-readable reason the API is missing, for the UI to show. */
export function bluetoothUnavailableReason() {
  if (typeof navigator === "undefined") return "Not running in a browser.";
  if (navigator.bluetooth) return null;

  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "Web Bluetooth requires HTTPS or localhost. Open this page on localhost or serve it over HTTPS.";
  }

  const ua = navigator.userAgent ?? "";
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isIOS) {
    return "iOS and iPadOS do not implement Web Bluetooth in any browser, including Chrome. " +
      "You would need a desktop or Android device.";
  }
  if (/Firefox/.test(ua)) {
    return "Firefox does not implement Web Bluetooth. Use Chrome, Edge or another " +
      "Chromium-based browser.";
  }
  if (/Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua)) {
    return "Safari does not implement Web Bluetooth. Use Chrome, Edge or another " +
      "Chromium-based browser.";
  }
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "Web Bluetooth requires a secure context. Serve this page over https:// " +
      "or open it on localhost.";
  }
  return "This browser does not expose navigator.bluetooth. Use Chrome or Edge.";
}

/**
 * Turn a 16-bit UUID into the Bluetooth base UUID form, which is what the
 * `filters` list expects.
 */
function fullUuid(uuid) {
  const s = String(uuid);
  if (s.includes("-")) return s.toLowerCase();
  return `0000${s.padStart(4, "0")}-0000-1000-8000-00805f9b34fb`;
}

/** Map a DOMException from requestDevice/connect onto a useful message. */
function describeError(err) {
  const name = err?.name ?? "Error";
  if (/globally disabled|permission has been blocked/i.test(err?.message ?? "")) {
    return "Web Bluetooth is disabled or blocked by this browser. Open this page in Google Chrome or Microsoft Edge; changing device filters will not fix a browser-level block.";
  }
  switch (name) {
    case "NotFoundError":
      return "The Bluetooth picker closed without selecting a device. This does not identify why a device was missing.";
    case "SecurityError":
    case "NotAllowedError":
      return "Bluetooth permission was denied. Check the browser's site permissions.";
    case "NetworkError":
      return "Connection lost or the GATT server is unreachable.";
    case "InvalidStateError":
      return "Bluetooth adapter is off or unavailable. Turn Bluetooth on and retry.";
    case "NotSupportedError":
      return "This browser or platform does not support the requested Bluetooth operation.";
    default:
      return err?.message ? `${name}: ${err.message}` : String(name);
  }
}

/**
 * Queue-backed transport over a GATT connection.
 *
 * Responses arrive as GATT notifications asynchronously, so inbound frames are
 * pushed into a queue that {@link receive} drains. Notifications can also arrive
 * split across packets, so a reassembly buffer is kept: frames declare their own
 * total length in the header, which makes framing unambiguous.
 */
export class BluetoothTransport extends Transport {
  /**
   * @param {object} [opts]
   * @param {() => void} [opts.onDisconnect]
   */
  constructor(opts = {}) {
    super();
    this.device = null;
    this.server = null;
    this.service = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.family = null;
    this.mtu = 200;

    /** @type {Uint8Array[]} */
    this._queue = [];
    /** @type {((v: Uint8Array) => void)|null} */
    this._waiter = null;
    this._rejectWaiter = null;
    this._buffer = new Uint8Array(0);
    this._closed = false;
    this._onDisconnect = opts.onDisconnect ?? null;
    this._onNotification = opts.onNotification ?? null;
  }

  /**
   * Prompt the user to pick an Anker device and connect to it.
   * Must be called from a user gesture.
   *
   * @param {object} [opts]
   * @param {number} [opts.mtu=200]
   * @param {(stage: string, detail?: string) => void} [opts.onStage]
   */
  async connect({ mtu = 200, onStage = null, acceptAllDevices = false, authorizedDevice = null } = {}) {
    if (!bluetoothAvailable()) {
      throw new Error(bluetoothUnavailableReason() ?? "Web Bluetooth unavailable");
    }
    const stage = (s, d) => onStage?.(s, d);

    stage("requestDevice", acceptAllDevices
      ? "Unfiltered BLE picker — showing devices Chrome makes available"
      : "Anker-filtered BLE picker — showing matching names and services");
    const filters = [
      ...UUID_FAMILIES.map((f) => ({ services: [f.service] })),
      ...ADVERTISED_16BIT_UUIDS.map((uuid) => ({ services: [uuid] })),
      ...MODELS.map((model) => ({ namePrefix: model.sku })),
      { namePrefix: "ANKER" },
      { namePrefix: "Anker" },
      { namePrefix: "Anker " },
      { namePrefix: "Prime" },
      { namePrefix: "SOLIX" },
      { namePrefix: "Soundcore" },
    ];

    try {
      this.device = authorizedDevice ?? await navigator.bluetooth.requestDevice({
        ...(acceptAllDevices ? { acceptAllDevices: true } : { filters }),
        optionalServices: [
          ...UUID_FAMILIES.map((f) => f.service),
          // Common generic services are harmless to request and help some
          // firmwares expose extra diagnostics.
          "generic_access",
        ],
      });
    } catch (err) {
      throw new Error(describeError(err));
    }

    this.device.addEventListener("gattserverdisconnected", () => {
      if (this._closed) return;
      this._closed = true;
      this._flushWaiter(new Error("device disconnected"));
      this._onDisconnect?.();
    });

    stage("connecting", this.device.name ?? this.device.id);
    try {
      this.server = await this.device.gatt.connect();
    } catch (err) {
      throw new Error(describeError(err));
    }

    stage("discovering", "locating the Anker protocol service");
    this.family = await this._discoverFamily(this.server);
    if (!this.family) {
      const names = (await this.server.getPrimaryServices()).map((s) => s.uuid);
      throw new Error(
        "Connected, but this device does not expose a known Anker protocol service. " +
          `Services found: ${names.join(", ") || "none"}.`,
      );
    }

    const service = await this.server.getPrimaryService(this.family.service);
    this.writeChar = await service.getCharacteristic(this.family.write);
    this.notifyChar = await service.getCharacteristic(this.family.notify);

    stage("notifications", "subscribing to responses");
    this.notifyChar.addEventListener("characteristicvaluechanged", (e) => this._onNotify(e));
    await this.notifyChar.startNotifications();

    // Best-effort MTU raise; browsers may not expose the negotiated value.
    if (mtu && this.device.gatt.connected) {
      this.mtu = mtu;
    }

    stage("connected", this.family.name);
    return { name: this.device.name ?? this.device.id, family: this.family };
  }

  /**
   * Probe the known families in turn. Web Bluetooth gives us no advertisement
   * payload after the fact, so service discovery is the only reliable way to
   * learn which family a device speaks.
   */
  async _discoverFamily(server) {
    for (const fam of UUID_FAMILIES) {
      try {
        await server.getPrimaryService(fam.service);
        return fam;
      } catch {
        // Not this family; try the next.
      }
    }
    return null;
  }

  _onNotify(event) {
    const value = event.target.value;
    const chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    this._onNotification?.(chunk);
    this._buffer = concatBytes(this._buffer, chunk);
    this._drainBuffer();
  }

  /** Extract every complete frame currently buffered. */
  _drainBuffer() {
    for (;;) {
      const buf = this._buffer;
      if (buf.length < 4) return;

      if (buf[0] !== 0xff || buf[1] !== 0x09) {
        this._buffer = buf.slice(1);
        continue;
      }

      // Prime captures exclude the checksum. The physically verified alt-8c85
      // family counts the complete packet, including its checksum.
      const size = buf[2] | (buf[3] << 8);
      const total = size + (this.family?.name === "alt-8c85" ? 0 : 1);

      if (size < 9 || total > 4096) {
        // Not a plausible frame: drop one byte and resync on the header.
        const next = buf.indexOf(0xff, 1);
        this._buffer = next === -1 ? new Uint8Array(0) : buf.slice(next);
        continue;
      }
      if (buf.length < total) return;

      const frame = buf.slice(0, total);
      this._buffer = buf.slice(total);
      this._deliverMultipart(frame);
    }
  }

  // ZX multipart replies carry a packet index/count byte before ciphertext.
  // Assemble the ciphertext before decrypting: packet boundaries are not AES blocks.
  _deliverMultipart(frame) {
    if (!(frame[7] & 0x80)) {
      // A2345 setting acknowledgements use 03 01 without multipart flags.
      // Normalize a validated physical reply into the same logical framing as
      // reassembled responses. The original bytes remain in notification logs.
      if (this.family?.name === 'alt-8c85' && frame.length >= 10 && frame[4] === 3 && frame[5] === 1 && (frame[7] & 8) && xorChecksum(frame) === 0) {
        const command = ((frame[7] & ~0x48) << 8) | frame[8];
        this._deliver(buildFrame(command, frame.slice(9, -1), {
          group: frame[6], encrypted: Boolean(frame[7] & 0x40), response: true, sizeIncludesChecksum: true,
        }));
      } else this._deliver(frame);
      return;
    }
    if (frame.length < 11 || frame[4] !== 3 || frame[5] !== 1 || xorChecksum(frame) !== 0) {
      this._multipart = null;
      return;
    }
    const index = frame[9] >> 4;
    const count = frame[9] & 15;
    const id = `${frame[6]}:${frame[7]}:${frame[8]}`;
    if (!count || !index || index > count) { this._multipart = null; return; }
    if (index === 1) this._multipart = { id, count, next: 1, parts: [], at: Date.now() };
    const pending = this._multipart;
    if (!pending || pending.id !== id || pending.count !== count || pending.next !== index ||
        Date.now() - pending.at > 4000) { this._multipart = null; return; }
    pending.parts.push(frame.slice(10, -1));
    pending.next++;
    if (index !== count) return;
    this._multipart = null;
    const payload = pending.parts.reduce((all, part) => concatBytes(all, part), new Uint8Array(0));
    const command = ((frame[7] & ~0xc8) << 8) | frame[8];
    this._deliver(buildFrame(command, payload, {
      group: frame[6], encrypted: Boolean(frame[7] & 0x40), response: Boolean(frame[7] & 8),
      sizeIncludesChecksum: this.family?.name === "alt-8c85",
    }));
  }

  _deliver(frame) {
    if (this._waiter) {
      const resolve = this._waiter;
      this._waiter = null;
      this._rejectWaiter = null;
      resolve(frame);
    } else {
      this._queue.push(frame);
    }
  }

  _flushWaiter(err) {
    if (this._rejectWaiter) {
      const reject = this._rejectWaiter;
      this._waiter = null;
      this._rejectWaiter = null;
      reject(err);
    }
  }

  async send(data) {
    if (this._closed) throw new Error("transport is closed");
    if (!this.writeChar) throw new Error("not connected");
    // Write without response: the Anker protocol acknowledges at the
    // application layer, and with-response writes are much slower here.
    if (this.writeChar.properties?.writeWithoutResponse) {
      await this.writeChar.writeValueWithoutResponse(data);
    } else if (this.writeChar.properties?.write) {
      await this.writeChar.writeValueWithResponse(data);
    } else {
      throw new Error("The protocol characteristic does not support writes.");
    }
  }

  /**
   * Wait for the next inbound frame.
   * @param {number} timeoutMs
   * @returns {Promise<Uint8Array>}
   */
  async receive(timeoutMs = 4000) {
    if (this._queue.length) return this._queue.shift();
    if (this._closed) throw new Error("device disconnected");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiter = null;
        this._rejectWaiter = null;
        const err = new Error("timed out waiting for a notification");
        err.name = "TimeoutError";
        reject(err);
      }, timeoutMs);

      this._waiter = (v) => {
        clearTimeout(timer);
        resolve(v);
      };
      this._rejectWaiter = (e) => {
        clearTimeout(timer);
        reject(e);
      };
    });
  }

  /** Send a raw command outside the session (used by the advanced panel). */
  async sendRaw(frame) {
    return this.send(frame);
  }

  async close() {
    this._closed = true;
    this._flushWaiter(new Error("transport closed"));
    this._queue = [];
    this._multipart = null;
    this._buffer = new Uint8Array(0);
    try {
      if (this.notifyChar) await this.notifyChar.stopNotifications();
    } catch {
      /* ignore */
    }
    try {
      if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    } catch {
      /* ignore */
    }
    this.writeChar = null;
    this.notifyChar = null;
  }

  get connected() {
    return Boolean(this.device?.gatt?.connected) && !this._closed;
  }

  get deviceName() {
    return this.device?.name ?? null;
  }
}

function concatBytes(a, b) {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export { fullUuid, describeError };
