import test from 'node:test';
import assert from 'node:assert/strict';
import { clockDays, clockThemeFields, decodeClockTheme } from '../src/clock.js';
import { settingBytes } from '../src/charger-settings.js';
import { AnkerSession } from '../src/session.js';
import { DemoDevice } from '../src/demo.js';

test('weekday schedules match the app’s most significant first encoding', () => {
  assert.equal(clockDays(124), 'Mon, Tue, Wed, Thu, Fri');
  assert.equal(clockDays(3), 'Sat, Sun');
  assert.equal(clockDays(64), 'Mon');
  assert.deepEqual([...settingBytes('clockSchedule', [22, 0, 7, 0, 3]).bytes], [4, 22, 0, 7, 0, 3]);
  for (const mask of [0, 128, -1, 1.5]) assert.throws(() => settingBytes('clockSchedule', [8, 0, 23, 0, mask]));
});

test('clock image command encodes switch, theme ID, color, CRC and URL independently', () => {
  const fields = Object.fromEntries(clockThemeFields({ enabled: true, type: 3, id: 0x12345678, crc: 0xabcdef01, color: 0xffaabbcc, url: 'https://example.com/clock.bin' }));
  assert.deepEqual([...fields[0xa2]], [1, 131]);
  assert.deepEqual([...fields[0xa3]], [4, 0x78, 0x56, 0x34, 0x12]);
  assert.deepEqual([...fields[0xa4]], [3, 0xcc, 0xbb, 0xaa, 0xff]);
  assert.deepEqual([...fields[0xa5]], [3, 1, 0xef, 0xcd, 0xab]);
  assert.equal(new TextDecoder().decode(fields[0xa6].slice(1)), 'https://example.com/clock.bin');
  assert.throws(() => clockThemeFields({ enabled: true, type: 3, url: 'javascript:alert(1)' }));
  assert.throws(() => clockThemeFields({ enabled: true, type: 3, url: 'https://user:password@example.com/x' }));
  assert.throws(() => clockThemeFields({ enabled: true, type: 3, crc: NaN, url: 'https://example.com/x' }));
});

test('built-in styles and weekday schedules work through an encrypted demo session', async () => {
  const transport = new DemoDevice({ sku: 'A2345', latency: 0 });
  const session = new AnkerSession(transport);
  await session.connect();
  await session.setClockTheme({ enabled: true, type: 2 });
  await session.setChargerSetting('clockSchedule', [22, 15, 6, 30, 124]);
  const status = await session.readStatus();
  assert.deepEqual(status.settings.clockTheme[0xa2], [1, 130]);
  assert.deepEqual(status.settings.clockSchedule, [22, 15, 6, 30, 124]);
  session.info.sku = 'A1340';
  const before = transport.sent.length;
  await assert.rejects(session.setClockTheme({ enabled: true, type: 0 }), /require/);
  assert.equal(transport.sent.length, before);
});

test('captured physical clock reply decodes current style and holiday flags', () => {
  const tags = [{tag: 0xa2, value: Uint8Array.of(1,128)}, {tag: 0xa3, value: Uint8Array.of(4,0,0,0,0)}, {tag: 0xa4, value: Uint8Array.of(4)}];
  assert.deepEqual(decodeClockTheme(tags), { enabled: true, holiday: 0, type: 0, id: 0, url: '' });
  tags[0].value[1] = 193;
  assert.equal(decodeClockTheme(tags).holiday, 1);
  assert.equal(decodeClockTheme(tags).type, 1);
  assert.throws(() => decodeClockTheme([]));
});

test('clock timezone offset uses signed UTC-minus-local seconds including fractional zones', async () => {
  const { clockOffset } = await import('../src/clock.js');
  const seconds = minutes => new DataView(clockOffset({ getTimezoneOffset: () => minutes }).buffer).getInt32(0, true);
  assert.equal(seconds(180), 10800);
  assert.equal(seconds(-330), -19800);
  assert.equal(seconds(0), 0);
});

test('A2345 encrypted key handshake includes the local clock offset', async () => {
  const { decodeTlv } = await import('../src/tlv.js');
  const original = Date.prototype.getTimezoneOffset;
  Date.prototype.getTimezoneOffset = () => 180;
  try {
    const session = new AnkerSession(new DemoDevice({ sku: 'A2345', latency: 0 }));
    await session.connect();
    const keyRequest = session.history.find(e => e.dir === 'tx' && e.frame.command === 0x0022);
    const offset = decodeTlv(keyRequest.frame.payload).find(t => t.tag === 0xa3).value;
    assert.equal(new DataView(offset.buffer, offset.byteOffset, 4).getInt32(0, true), 10800);
  } finally { Date.prototype.getTimezoneOffset = original; }
});
