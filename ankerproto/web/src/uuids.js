/**
 * Anker GATT service families and protocol constants.
 *
 * GENERATED from `ankerproto/uuids.py` - edit that file, not this one.
 * Recovered from the `libapp.so` Dart AOT object pool.
 *
 * All families share the same characteristic layout; only the first 32 bits
 * (model/SoC family) differ. The name part of the 128-bit UUID must be written
 * with a base UUID of `0000xxxx-0000-1000-8000-00805f9b34fb` for 16-bit ones.
 */

/** One Anker GATT service family. */
export class UuidFamily {
  constructor(name, service, write, notify, advertised16Bit = null) {
    this.name = name;
    this.service = service;
    this.write = write;
    this.notify = notify;
    this.advertised16Bit = advertised16Bit;
  }

  toString() {
    return `${this.name} (${this.service})`;
  }
}

/** The Anker Prime family - the one with public device captures. */
export const PRIMARY_FAMILY = new UuidFamily(
  "prime-2215",
  "22150001-4002-81c5-b46e-cf057c562025",
  "22150002-4002-81c5-b46e-cf057c562025",
  "22150003-4002-81c5-b46e-cf057c562025",
  0x2215,
);

export const UUID_FAMILIES = [
  PRIMARY_FAMILY,
  new UuidFamily(
    "gen2-2540",
    "25400001-4002-81c5-b46e-cf057c562025",
    "25400002-4002-81c5-b46e-cf057c562025",
    "25400003-4002-81c5-b46e-cf057c562025",
    0x2540,
  ),
  new UuidFamily(
    "station-4158",
    "41580001-4002-81c5-b46e-cf057c562025",
    "41580002-4002-81c5-b46e-cf057c562025",
    "41580003-4002-81c5-b46e-cf057c562025",
    null,
  ),
  new UuidFamily(
    "alt-8c85",
    "8c850001-0302-41c5-b46e-cf057c562025",
    "8c850002-0302-41c5-b46e-cf057c562025",
    "8c850003-0302-41c5-b46e-cf057c562025",
    null,
  ),
];

/** 16-bit shorthands the devices also advertise while scanning. */
export const ADVERTISED_16BIT_UUIDS = Object.freeze([0x2215, 0x2540, 0xFF09, 0xEF0A, 0xEF0B]);

/** Return the family a service or write UUID belongs to, case-insensitively. */
export function findFamily(uuid) {
  const needle = String(uuid).toLowerCase();
  for (const fam of UUID_FAMILIES) {
    if (fam.service === needle || fam.write === needle) return fam;
  }
  for (const fam of UUID_FAMILIES) {
    if (needle.endsWith(fam.service.slice(8))) return fam;
  }
  return null;
}

/** Match an advertised service UUID list against the known families. */
export function familiesFromAdvertised(uuids) {
  const out = [];
  for (const raw of uuids ?? []) {
    const u = String(raw).toLowerCase();
    let fam = null;
    for (const f of UUID_FAMILIES) {
      if (f.service === u) fam = f;
    }
    if (!fam) {
      const head = u.split("-")[0];
      if (/^[0-9a-f]{8}$/.test(head)) {
        const v = parseInt(head, 16);
        if (ADVERTISED_16BIT_UUIDS.includes(v)) {
          fam = UUID_FAMILIES.find((f) => f.advertised16Bit === v) ?? null;
        }
      }
    }
    if (fam && !out.includes(fam)) out.push(fam);
  }
  return out;
}
