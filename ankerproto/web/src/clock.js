// A2345 app: weekdays are a seven-element binary array, most significant first.
export const CLOCK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// CmdUtil.getTimeStampDifference sends UTC minus local time, in seconds.
export function clockOffset(date = new Date()) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, date.getTimezoneOffset() * 60, true);
  return bytes;
}
let timezoneMap;
export async function clockTimezone(date = new Date()) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    timezoneMap ??= fetch(new URL('./timezones.json', import.meta.url)).then(r => { if (!r.ok) throw new Error('Timezone data unavailable'); return r.json(); });
    const name = (await timezoneMap)[zone];
    if (name) return new TextEncoder().encode(name);
  } catch { timezoneMap = null; }
  // POSIX offsets use UTC minus local, the opposite sign of ISO offsets.
  const minutes = date.getTimezoneOffset(), absolute = Math.abs(minutes);
  return new TextEncoder().encode(`<LOCAL>${minutes < 0 ? '-' : ''}${Math.floor(absolute / 60)}${absolute % 60 ? ':' + String(absolute % 60).padStart(2, '0') : ''}`);
}
export function clockDays(mask) {
  return mask === 127 ? 'Every day' : CLOCK_DAYS.filter((_, i) => mask & (64 >> i)).join(', ') || 'No days';
}
export function decodeClockTheme(tags) {
  const fields = new Map(tags.map(tag => [tag.tag, tag.value]));
  const flags = fields.get(0xa2);
  if (flags?.length !== 2 || flags[0] !== 1) throw new Error('Clock theme reply is not recognized.');
  const id = fields.get(0xa3), url = fields.get(0xa4);
  return { enabled: !!(flags[1] & 128), holiday: Number(!!(flags[1] & 64)), type: flags[1] & 63,
    id: id?.length === 5 && id[0] === 4 ? new DataView(id.buffer, id.byteOffset + 1, 4).getUint32(0, true) : null,
    url: url?.[0] === 4 ? new TextDecoder().decode(url.slice(1)) : null };
}

// setScreenSaverSwitchAndThemeByUrl: raw values are typed by ZXCommandTransformer.
export function clockThemeFields({ enabled, type, id = 0, crc = 0, color = 0xffffffff, url = '' }) {
  const uint = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
  if (typeof enabled !== 'boolean' || !Number.isInteger(type) || type < 0 || type > 3 || !uint(id) || !uint(crc) || !uint(color)) throw new Error('Invalid clock theme metadata.');
  if (type === 3) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Enter a valid downloadable image URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || new TextEncoder().encode(url).length > 200) throw new Error('Use an HTTP(S) image URL of at most 200 bytes without credentials.');
  } else if (url) throw new Error('Built-in clock styles do not use an image URL.');
  const le = value => { const bytes = new Uint8Array(5); bytes[0] = 3; new DataView(bytes.buffer).setUint32(1, value, true); return bytes; };
  return [[0xa2, Uint8Array.of(1, (enabled ? 128 : 0) | type)],
    [0xa3, type === 3 ? Uint8Array.of(4, ...le(id).slice(1)) : Uint8Array.of(4)],
    [0xa4, le(color)], [0xa5, le(crc)], [0xa6, Uint8Array.of(4, ...new TextEncoder().encode(url))]];
}
