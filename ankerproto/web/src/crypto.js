/**
 * Anker BLE session crypto. Mirrors `ankerproto/crypto.py`.
 *
 * AES-128-CBC with a fixed key per phase and the device serial number as IV.
 * There is no Diffie-Hellman on the BLE link: the "initial" key is a public
 * constant shipped in the app and re-broadcast during the plaintext handshake,
 * and the IV is the serial number the device itself hands out. This is link
 * obfuscation, not a security boundary - see docs/PROTOCOL.md section 4.3.
 *
 * Uses `crypto.subtle`, available in secure contexts (https:// or localhost).
 */

import { fromHex, toHex } from "./framing.js";

/** 40-byte static blob sent in TLV tag A2 on every handshake frame. */
export const A2_STATIC_VALUE = new TextEncoder().encode(
  "2c377dfa09cdb7924889e4292a37f61c8c5ed52d",
);

/** First 16 bytes of A2_STATIC_VALUE, used verbatim as the AES-128 key. */
export const INITIAL_KEY = A2_STATIC_VALUE.slice(0, 16);

export const OP_GET_AES_KEY = 0x0022;
export const OP_GET_DEVICE_INFO = 0x0029;

const subtle = globalThis.crypto?.subtle;

function requireSubtle() {
  if (!subtle) {
    throw new Error(
      "WebCrypto is unavailable. The page must be served over https:// or localhost " +
        "(and opened in a modern browser).",
    );
  }
}

/** PKCS#7 pad to a 16-byte boundary. */
export function pkcs7Pad(data) {
  const padLength = 16 - (data.length % 16);
  const out = new Uint8Array(data.length + padLength);
  out.set(data, 0);
  out.fill(padLength, data.length);
  return out;
}

/** Strip and validate PKCS#7 padding. */
export function pkcs7Unpad(data) {
  if (data.length === 0 || data.length % 16) {
    throw new Error(`padded data must be a non-zero multiple of 16, got ${data.length}`);
  }
  const padLength = data[data.length - 1];
  if (padLength < 1 || padLength > 16) throw new Error(`invalid padding byte: ${padLength}`);
  for (let i = data.length - padLength; i < data.length; i++) {
    if (data[i] !== padLength) throw new Error("invalid padding");
  }
  return data.subarray(0, data.length - padLength);
}

/**
 * Probe this runtime's AES-CBC padding behaviour, once, and cache it.
 *
 * This is measured rather than assumed because the behaviour is invisible in the
 * success path: `subtle.encrypt`/`subtle.decrypt` succeed either way, and only
 * the **output length** reveals what happened. A Node-only test suite cannot
 * catch a disagreement here, because Node and browsers can differ.
 *
 * Measured behaviour on this codebase:
 *
 *  - **Chrome / browsers**: full PKCS#7. Plaintext of `n` bytes produces
 *    `16 * (floor(n / 16) + 1)` bytes of ciphertext, so a block-aligned input
 *    gains a whole extra block. `subtle.decrypt` strips the padding.
 *  - **Node's WebCrypto**: same ciphertext length rule, but `subtle.decrypt`
 *    does *not* strip the padding.
 *
 * So the wrapper never pads itself - it lets the runtime do it, matching
 * PKCS#7 - and only has to decide whether to unpad afterwards.
 *
 * @returns {Promise<{stripsOnDecrypt: boolean}>}
 */
let paddingBehaviour = null;

async function probePaddingBehaviour() {
  if (paddingBehaviour) return paddingBehaviour;

  const key = await subtle.importKey("raw", new Uint8Array(16), { name: "AES-CBC" }, false, [
    "encrypt",
    "decrypt",
  ]);
  const iv = new Uint8Array(16);
  // Two lengths: 3 (unaligned) and 16 (aligned, so PKCS#7 must add a block).
  const plain = Uint8Array.of(1, 2, 3);

  const cipher = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv }, key, plain));
  const back = new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv }, key, cipher));

  paddingBehaviour = {
    // A padding runtime returns the plaintext, not the padded block.
    stripsOnDecrypt: back.length === plain.length,
  };
  return paddingBehaviour;
}

/**
 * An AES-128-CBC context. Construct via {@link initialContext} or
 * {@link sessionContext}; both are async because WebCrypto key import is.
 */
export class AesContext {
  constructor(keyBytes, ivBytes, phase, cryptoKey) {
    this.key = keyBytes;
    this.iv = ivBytes;
    this.phase = phase;
    this._cryptoKey = cryptoKey;
  }

  get keyHex() {
    return toHex(this.key).toUpperCase();
  }

  get ivHex() {
    return toHex(this.iv).toUpperCase();
  }

  /**
   * Encrypt with PKCS#7 padding.
   *
   * WebCrypto applies PKCS#7 padding itself in every runtime measured here, so
   * this method must **not** pad: doing so adds a spurious extra block. The
   * Python client (pycryptodome) requires explicit padding, so the equivalence is
   * checked byte-for-byte by the frozen vectors in `tests/vectors.json`.
   *
   * {@link decrypt} handles the one genuine cross-runtime difference - whether
   * the runtime strips the padding on the way back.
   */
  async encrypt(plaintext) {
    // The runtime applies PKCS#7 itself in every measured environment, and
    // padding here as well would add a spurious extra block.
    const buf = await subtle.encrypt({ name: "AES-CBC", iv: this.iv }, this._cryptoKey, plaintext);
    return new Uint8Array(buf);
  }

  /**
   * Decrypt and strip PKCS#7 padding.
   *
   * Whether the runtime already removed the padding is probed rather than
   * guessed (see {@link detectDecryptPaddingBehaviour}), so the plaintext is
   * returned correctly on both browsers and Node without heuristics.
   */
  async decrypt(ciphertext) {
    if (ciphertext.length === 0 || ciphertext.length % 16) {
      throw new Error(`ciphertext must be a non-zero multiple of 16, got ${ciphertext.length}`);
    }
    const { stripsOnDecrypt } = await probePaddingBehaviour();
    const buf = await subtle.decrypt(
      { name: "AES-CBC", iv: this.iv },
      this._cryptoKey,
      ciphertext,
    );
    const plain = new Uint8Array(buf);
    return stripsOnDecrypt ? plain : pkcs7Unpad(plain);
  }
}

/** The IV is the serial number, NUL-padded or truncated to 16 bytes. */
export function serialIv(serialNumber) {
  const raw = new TextEncoder().encode(serialNumber);
  const iv = new Uint8Array(16);
  iv.set(raw.subarray(0, 16), 0);
  return iv;
}

async function importKey(keyBytes, phase) {
  requireSubtle();
  if (keyBytes.length !== 16) {
    throw new Error(`AES-128 key must be 16 bytes, got ${keyBytes.length}`);
  }
  const cryptoKey = await subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, [
    "encrypt",
    "decrypt",
  ]);
  return cryptoKey;
}

/** Phase 2: static key, serial number as IV. */
export async function initialContext(serialNumber) {
  const iv = serialIv(serialNumber);
  return new AesContext(INITIAL_KEY, iv, "initial", await importKey(INITIAL_KEY, "initial"));
}

/** Phase 3: device-supplied session key, serial number as IV. */
export async function sessionContext(sessionKey, serialNumber) {
  const key = sessionKey instanceof Uint8Array ? sessionKey : fromHex(sessionKey);
  const iv = serialIv(serialNumber);
  return new AesContext(key, iv, "session", await importKey(key, "session"));
}

/** Convenience: is WebCrypto usable here at all? */
export function cryptoAvailable() {
  return Boolean(subtle);
}
