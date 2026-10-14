import test from 'node:test';
import assert from 'node:assert/strict';
import { AnkerSession } from '../src/session.js';
import { DemoDevice } from '../src/demo.js';
import { Tlv } from '../src/tlv.js';
import { decodeChargerSettings, settingBytes } from '../src/charger-settings.js';

test('charger demo accepts model-specific controls without granting beeper or theme support', async () => {
  const transport = new DemoDevice({ sku: 'A2345', latency: 0 });
  const session = new AnkerSession(transport);
  await session.connect();
  await session.setChargerSetting('priority', 5);
  await session.setChargerSetting('clockFormat', 1);
  await session.setChargerSetting('rotation', 0);
  await session.setChargerSetting('chargingMode', 3);
  await session.setChargerSetting('holiday', 1);
  await session.setChargerSetting('clockSchedule', [9, 30, 22, 15, 127]);
  const status = await session.readStatus();
  assert.equal(status.settings.chargingMode, 3);
  assert.equal(status.settings.rotation, 0);
  assert.deepEqual(status.settings.clockSchedule, [9, 30, 22, 15, 127]);
  const before = transport.sent.length;
  await assert.rejects(session.setBeep(true), /not supported/);
  await assert.rejects(session.setTheme(true), /not supported/);
  assert.equal(transport.sent.length, before, 'unsupported controls must not transmit');
});

test('charger settings decode the captured typed fields and ignore unsupported formats', () => {
  const tags = [[0xb1, [1, 1]], [0xb3, [1, 100]], [0xb4, [1, 0]], [0xb5, [1, 1]], [0xb9, [4, 8, 0, 23, 0, 127]]].map(([tag, value]) => new Tlv(tag, Uint8Array.from(value)));
  assert.deepEqual(decodeChargerSettings(tags), { chargingMode: 1, brightness: 100, timeout: 1, rotation: 0, clockSchedule: [8, 0, 23, 0, 127] });
  assert.deepEqual(decodeChargerSettings([new Tlv(0xb3, Uint8Array.of(4, 100)), new Tlv(0xb4, Uint8Array.of(1, 99))]), {});
  assert.throws(() => settingBytes('clockSchedule', [24, 0, 22, 0, 127]), /valid start/);
  assert.throws(() => settingBytes('chargingMode', 5), /Invalid/);
});

test('unknown models cannot use generic display or beeper commands', async () => {
  const session = new AnkerSession({ send() { throw new Error('must not send'); } });
  session.info.sku = 'A1770';
  await assert.rejects(session.setBeep(true), /not supported/);
  await assert.rejects(session.setTheme(true), /not supported/);
});
