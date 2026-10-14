import { decodeTlv, stripStatus } from './tlv.js';
import { toHex } from './framing.js';
import { OPCODE_NAMES } from './opcodes.js';
import { CHARGER_TAGS } from './charger-settings.js';
const chargerCommands = { 0x0202: 'Read clock theme', 0x0205: 'Set clock screensaver / image', 0x0206: 'Set charging mode', 0x020c: 'Set USB-C priority', 0x020e: 'Set knob direction', 0x020f: 'Set holiday screensavers', 0x0210: 'Set clock format', 0x0213: 'Set clock schedule' };
const element = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
export class ProtocolDebug {
  constructor() { this.clear(); }
  clear() { this.events = []; this.sent = 0; this.received = 0; this.errors = 0; this.notifications = 0; this.fragments = 0; this.pending = new Map(); }
  notification(bytes) { this.notifications++; if (bytes[7] & 0x80) this.fragments++; }
  record(direction, frame, raw, time = Date.now()) {
    if (direction === 'rx-error') this.errors++;
    else if (direction === 'tx') this.sent++;
    else this.received++;
    const key = `${frame.group}:${frame.command}`;
    if (direction === 'tx') this.pending.set(key, time);
    const latency = direction === 'rx' && this.pending.has(key) ? time - this.pending.get(key) : null;
    if (latency != null) this.pending.delete(key);
    this.events.push({ direction, frame, raw, time, latency });
    if (this.events.length > 40) this.events.shift();
  }
  render(host, summary) {
    summary.textContent = `${this.sent} requests · ${this.received} decoded replies · ${this.errors} decode errors · ${this.notifications} BLE notifications (${this.fragments} multipart packets)`;
    const expanded = new Set([...host.querySelectorAll('details[open]')].map(node => node.dataset.event));
    host.replaceChildren();
    for (const event of this.events.slice(-15).reverse()) {
      const { direction, frame, raw, time, latency } = event;
      const details = element('details', null, 'protocol-event');
      details.dataset.event = `${time}:${direction}:${frame.group}:${frame.command}`;
      details.open = expanded.has(details.dataset.event);
      const name = (frame.group === 15 ? chargerCommands[frame.command] : null) ?? OPCODE_NAMES[frame.command] ?? frame.commandHex ?? 'Decode error';
      details.append(element('summary', `${direction === 'tx' ? '→ Request' : direction === 'rx' ? '← Reply' : '⚠ Error'} · ${name} ${latency == null ? '' : `· ${latency} ms`}`));
      details.append(element('p', `${new Date(time).toLocaleTimeString()} · ${raw.length} bytes · Group 0x${(frame.group ?? 0).toString(16)} · ${raw[7] & 0x40 ? 'AES-encrypted on wire' : 'Unencrypted on wire'}`));
      if (direction === 'rx-error') { details.append(element('p', frame.error)); host.append(details); continue; }
      const layout = element('dl', null, 'protocol-layout');
      for (const [label, value] of [['Header', toHex(raw.slice(0, 2))], ['Packet length', String(raw[2] | raw[3] << 8)], ['Pattern / group', toHex(raw.slice(4, 7))], ['Command + flags', toHex(raw.slice(7, 9))], ['Checksum (XOR)', toHex(raw.slice(-1))]]) {
        layout.append(element('dt', label), element('dd', value));
      }
      details.append(layout);
      if (frame.command === 0x22) {
        details.append(element('p', 'Session-key exchange. Key material is hidden in this view.'));
      } else {
        const tags = decodeTlv(direction === 'rx' ? stripStatus(frame.payload ?? new Uint8Array()) : frame.payload ?? new Uint8Array(), { strict: false });
        const table = element('table', null, 'protocol-tags');
        const ports = { 164: 'C1', 165: 'C2', 166: 'C3', 167: 'C4', 168: 'A1', 169: 'A2' };
        for (const tag of tags) {
          const row = element('tr');
          const clockLabels = frame.command === 0x205 ? {162: 'Clock enable bit / style',163: 'Image theme ID',164: 'Clock text color',165: 'Image file CRC32',166: 'Image download URL'} : frame.command === 0x202 ? {162: 'Clock / holiday flags and style',163: 'Theme ID',164: 'Current image URL'} : {};
          const label = frame.group === 15 && clockLabels[tag.tag] ? clockLabels[tag.tag] : frame.group === 15 && frame.command === 0x200 && direction === 'rx' && CHARGER_TAGS[tag.tag] ? CHARGER_TAGS[tag.tag] : tag.tag === 254 ? 'Typed timestamp' : tag.tag === 161 ? 'Command envelope / handshake data' : 'Device field';
          row.append(element('td', `0x${tag.tag.toString(16).toUpperCase()}`), element('td', label), element('td', `${tag.length} B · ${tag.asHex()}`));
          table.append(row);
        }
        details.append(table);
        details.append(element('p', frame.group === 15 && frame.command === 0x200 ? 'Port bytes: data type 04, state, voltage (mV), current (mA), reported power (0.01 W). Multipart ciphertext is joined before AES decryption.' : 'Unknown fields remain labeled as device fields until their meaning is verified.'));
      }
      host.append(details);
    }
  }
}
