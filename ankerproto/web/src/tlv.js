/**
 * TLV encoding/decoding for Anker payloads. Mirrors `ankerproto/tlv.py`.
 *
 * `<type 1B> <length 1B> <value length B> ...`, all integers little-endian.
 * The device prefixes decrypted payloads with a status byte (`0x00` = OK).
 */

import { toHex } from "./framing.js";

/** One decoded record. */
export class Tlv {
  constructor(tag, value) {
    this.tag = tag;
    this.value = value;
  }

  get length() {
    return this.value.length;
  }

  /** Little-endian integer interpretation of the raw value. */
  asInt({ signed = false } = {}) {
    let out = 0;
    for (let i = this.value.length - 1; i >= 0; i--) out = out * 256 + this.value[i];
    if (signed && this.value.length) {
      const bits = this.value.length * 8;
      const limit = 2 ** (bits - 1);
      if (out >= limit) out -= 2 ** bits;
    }
    return out;
  }

  asAscii() {
    let s = "";
    for (const b of this.value) s += b >= 32 && b < 127 ? String.fromCharCode(b) : ".";
    return s;
  }

  asHex() {
    return toHex(this.value);
  }
}

/**
 * Serialise TLV records. Accepts `Tlv` instances, `[tag, Uint8Array]` pairs, or
 * `[tag, int]` pairs (stored in the fewest little-endian bytes, minimum one).
 */
export function encodeTlv(items) {
  const chunks = [];
  let total = 0;

  for (const item of items) {
    let tag;
    let value;
    if (item instanceof Tlv) {
      tag = item.tag;
      value = item.value;
    } else if (Array.isArray(item)) {
      tag = item[0];
      const raw = item[1];
      if (typeof raw === "number") {
        if (!Number.isInteger(raw) || raw < 0) {
          throw new Error(`numeric TLV value must be a non-negative integer, got ${raw}`);
        }
        const width = Math.max(1, Math.ceil((raw.toString(2).length || 1) / 8));
        value = new Uint8Array(width);
        let v = raw;
        for (let i = 0; i < width; i++) {
          value[i] = v & 0xff;
          v = Math.floor(v / 256);
        }
      } else {
        value = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
      }
    } else {
      throw new Error("TLV item must be a Tlv or a [tag, value] pair");
    }

    if (!Number.isInteger(tag) || tag < 0 || tag > 0xff) {
      throw new Error(`tag out of range: ${tag}`);
    }
    if (value.length > 0xff) {
      throw new Error(`value for tag 0x${tag.toString(16)} exceeds 255 bytes`);
    }

    chunks.push(Uint8Array.of(tag, value.length), value);
    total += 2 + value.length;
  }

  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Decode a TLV stream.
 *
 * @param {Uint8Array} data
 * @param {object} [opts]
 * @param {number} [opts.offset=0]
 * @param {Map<number,number>|object} [opts.lengthOverrides] tags whose length
 *   field is wider than one byte
 * @param {boolean} [opts.strict=true] throw on a truncated trailing record
 *   instead of dropping it (the device's own parser drops it)
 */
export function decodeTlv(data, opts = {}) {
  const { offset = 0, lengthOverrides = null, strict = true } = opts;
  const overrides = lengthOverrides
    ? lengthOverrides instanceof Map
      ? lengthOverrides
      : new Map(Object.entries(lengthOverrides).map(([k, v]) => [Number(k), v]))
    : new Map();

  const out = [];
  let i = offset;

  while (i < data.length) {
    if (i + 2 > data.length) {
      if (strict) throw new Error(`truncated TLV header at offset ${i}`);
      break;
    }
    const tag = data[i];
    const width = overrides.get(tag) ?? 1;

    if (i + 1 + width > data.length) {
      if (strict) throw new Error(`truncated length field for tag 0x${tag.toString(16)} at ${i}`);
      break;
    }

    let length = 0;
    for (let b = 0; b < width; b++) length += data[i + 1 + b] * 2 ** (8 * b);

    const start = i + 1 + width;
    const end = start + length;
    if (end > data.length) {
      if (strict) {
        throw new Error(
          `tag 0x${tag.toString(16)} at offset ${i} declares ${length} bytes but only ` +
            `${data.length - start} remain`,
        );
      }
      break;
    }

    out.push(new Tlv(tag, data.slice(start, end)));
    i = end;
  }

  return out;
}

/** Drop the leading status byte (`0x00` = OK) when present. */
export function stripStatus(payload) {
  return payload.length > 0 && payload[0] === 0x00 ? payload.subarray(1) : payload;
}
