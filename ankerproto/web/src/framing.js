/**
 * Anker ZX wire framing. Mirrors `ankerproto/framing.py`.
 *
 * ```
 * <header 2B> <size 2B LE> <pattern 3B> <cmd 2B> <payload nB> <checksum 1B>
 *   FF 09      len+5        03 00 grp    cmdh cmdl   ...            XOR
 * ```
 *
 * The captured Prime format excludes the checksum from size; the recovered
 * alt-8c85 format includes it (sizeIncludesChecksum).
 *
 * The command's high byte carries flags: `0x40` = AES-encrypted payload,
 * `0x08` = this frame is a response.
 */

export const HEADER = Uint8Array.of(0xff, 0x09);
export const PATTERN_PREFIX = Uint8Array.of(0x03, 0x00);

export const FLAG_ENCRYPTED = 0x40;
export const FLAG_RESPONSE = 0x08;

/** Bytes of framing overhead subtracted from the negotiated MTU. */
export const MTU_OVERHEAD = 10;
export const DEFAULT_MTU = 200;

/** XOR-fold every byte. */
export function xorChecksum(bytes) {
  let out = 0;
  for (let i = 0; i < bytes.length; i++) out ^= bytes[i];
  return out;
}

/** Concatenate Uint8Arrays. */
export function concat(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

export function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex) {
  const clean = hex.replace(/[\s:-]/g, "");
  if (clean.length % 2) throw new Error(`hex string has odd length: ${clean.length}`);
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error("hex string contains non-hex characters");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Serialise one frame, appending the XOR checksum.
 * `payload` must already be encrypted when `encrypted` is true.
 */
export function buildFrame(command, payload = new Uint8Array(0), opts = {}) {
  const { group = 0x01, encrypted = false, response = false, sizeIncludesChecksum = false } = opts;
  if (!Number.isInteger(command) || command < 0 || command > 0xffff) {
    throw new Error(`command must fit in 16 bits, got ${command}`);
  }
  if (!Number.isInteger(group) || group < 0 || group > 0xff) {
    throw new Error(`group must fit in one byte, got ${group}`);
  }

  let cmdHigh = (command >> 8) & 0xff;
  const cmdLow = command & 0xff;
  if (encrypted) cmdHigh |= FLAG_ENCRYPTED;
  if (response) cmdHigh |= FLAG_RESPONSE;

  const body = concat(PATTERN_PREFIX, Uint8Array.of(group, cmdHigh, cmdLow), payload);
  const size = body.length + 4 + Number(sizeIncludesChecksum);
  const frame = concat(HEADER, Uint8Array.of(size & 0xff, (size >> 8) & 0xff), body);
  return concat(frame, Uint8Array.of(xorChecksum(frame)));
}

/**
 * Parse a frame received from the device. Throws on bad header, length or
 * checksum. Returns a plain object rather than a class so it serialises into
 * logs cleanly.
 */
export function parseFrame(data, { sizeIncludesChecksum = false } = {}) {
  if (data.length < 6) throw new Error(`frame too short: ${data.length} bytes`);
  if (data[0] !== 0xff || data[1] !== 0x09) {
    throw new Error(`bad header: ${toHex(data.subarray(0, 2))} (expected ff09)`);
  }

  const size = data[2] | (data[3] << 8);
  if (size !== data.length - (sizeIncludesChecksum ? 0 : 1)) {
    throw new Error(`length mismatch: header says ${size}, got ${data.length - 1}`);
  }

  const expected = xorChecksum(data.subarray(0, data.length - 1));
  const actual = data[data.length - 1];
  if (expected !== actual) {
    throw new Error(
      `checksum mismatch: computed 0x${expected.toString(16)}, got 0x${actual.toString(16)}`,
    );
  }

  if (data[4] !== 0x03 || data[5] !== 0x00) {
    throw new Error(`bad pattern prefix: ${toHex(data.subarray(4, 6))}`);
  }

  const cmdHigh = data[7];
  const cmdLow = data[8];
  const command = ((cmdHigh & ~(FLAG_ENCRYPTED | FLAG_RESPONSE)) << 8) | cmdLow;

  return {
    group: data[6],
    command,
    commandHex: `0x${command.toString(16).padStart(4, "0").toUpperCase()}`,
    payload: data.slice(9, data.length - 1),
    encrypted: Boolean(cmdHigh & FLAG_ENCRYPTED),
    response: Boolean(cmdHigh & FLAG_RESPONSE),
    raw: data.slice(),
  };
}

/** Split a payload into `mtu - MTU_OVERHEAD` byte chunks. */
export function splitFragments(payload, mtu = DEFAULT_MTU) {
  const chunk = Math.max(1, mtu - MTU_OVERHEAD);
  const out = [];
  for (let i = 0; i < payload.length; i += chunk) {
    out.push(payload.subarray(i, i + chunk));
  }
  return out;
}
