import test from 'node:test';
import assert from 'node:assert/strict';
import { BluetoothTransport, describeError } from '../src/bluetooth.js';
import { buildFrame, concat } from '../src/framing.js';
import { PRIMARY_FAMILY } from '../src/uuids.js';
import { AnkerSession } from '../src/session.js';

test('discovery includes registered model prefixes and all recovered advertising IDs; broad scan keeps service permission', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const requests = [];
  const notify = { addEventListener() {}, async startNotifications() {} };
  const service = { async getCharacteristic() { return notify; } };
  const gatt = { connected: true, async connect() { return this; }, async getPrimaryService(uuid) {
    if (uuid !== PRIMARY_FAMILY.service) throw new Error('missing');
    return service;
  } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { bluetooth: {
    async requestDevice(options) { requests.push(options); return { name: 'A2345', gatt, addEventListener() {} }; }
  } } });
  try {
    await new BluetoothTransport().connect();
    await new BluetoothTransport().connect({ acceptAllDevices: true });
    for (const sku of ['A2345', 'A1340', 'A1753']) {
      assert.ok(requests[0].filters.some(f => f.namePrefix === sku));
    }
    assert.ok(requests[0].filters.some(f => f.services?.includes(0xef0a)));
    assert.equal(requests[1].acceptAllDevices, true);
    assert.equal(requests[1].filters, undefined);
    assert.ok(requests[1].optionalServices.includes(PRIMARY_FAMILY.service));
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
});

test('notification reassembly respects DataView offsets and skips garbage before split frames', async () => {
  const t = new BluetoothTransport();
  const frame = buildFrame(0x0500, Uint8Array.of(0), { response: true });
  const notify = bytes => {
    const padded = concat(Uint8Array.of(88, 99), bytes, Uint8Array.of(77));
    t._onNotify({ target: { value: new DataView(padded.buffer, 2, bytes.length) } });
  };
  notify(concat(Uint8Array.of(9, 0, 32, 0), frame.slice(0, 6)));
  notify(frame.slice(6));
  assert.deepEqual(await t.receive(), frame);
});

test('writes follow characteristic properties', async () => {
  const t = new BluetoothTransport();
  const calls = [];
  t.writeChar = { properties: { write: true }, async writeValueWithResponse(data) { calls.push(data); } };
  const bytes = Uint8Array.of(1, 2);
  await t.send(bytes);
  assert.deepEqual(calls, [bytes]);
  t.writeChar = { properties: {} };
  await assert.rejects(t.send(bytes), /does not support writes/);
});

test('closing rejects an outstanding notification wait immediately', async () => {
  const t = new BluetoothTransport();
  const rejected = assert.rejects(t.receive(10000), /transport closed/);
  await t.close();
  await rejected;
});

test('session serializes commands and recovers its queue after failure', async () => {
  const session = new AnkerSession({});
  let active = 0;
  let maximum = 0;
  session._exchangeOnce = async command => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    if (command === 1) throw new Error('unsupported');
    return command;
  };
  const results = await Promise.allSettled([session._exchange(1), session._exchange(2), session._exchange(3)]);
  assert.equal(maximum, 1);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].value, 2);
  assert.equal(results[2].value, 3);
});

test('live power totals are decoded from A6', () => {
  const session = new AnkerSession({});
  const status = session.parseStatus(Uint8Array.of(0, 0xa6, 5, 0, 0xd2, 4, 0x30, 2), { live: true });
  assert.equal(status.totalOutputW, 123.4);
  assert.equal(status.totalInputW, 56);
});

test('browser-level Bluetooth blocks differ from picker cancellation', () => {
  assert.match(describeError({ name: 'NotFoundError', message: 'Web Bluetooth API globally disabled.' }), /disabled or blocked/);
  assert.match(describeError({ name: 'NotFoundError', message: 'User cancelled' }), /closed without selecting/);
});

test('charger notifications use checksum-inclusive lengths across split packets', async () => {
  const transport = new BluetoothTransport();
  transport.family = { name: 'alt-8c85' };
  const raw = buildFrame(1, Uint8Array.of(0, 0xa1, 1, 1), { response: true, sizeIncludesChecksum: true });
  for (const chunk of [raw.slice(0, 8), raw.slice(8)]) {
    transport._onNotify({ target: { value: new DataView(chunk.buffer) } });
  }
  assert.deepEqual(await transport.receive(20), raw);
  assert.equal(transport._buffer.length, 0);
});

test('physical A2345 status uses its recovered command and function group', async () => {
  const session = new AnkerSession({ family: { name: 'alt-8c85' } });
  session.info.sku = 'A2345';
  let request;
  session._exchange = async (...args) => { request = args; return { payload: Uint8Array.of(0) }; };
  await session.readStatus();
  assert.equal(request[0], 0x0200);
  assert.equal(request[2].group, 0x0f);
  assert.deepEqual(request[1].slice(0, 2).map(t => [...t.value]), [[0x21], [4]]);
  assert.equal(request[1][2].tag, 0xfe);
  assert.equal(request[1][2].value.length, 5);
  assert.equal(request[1][2].value[0], 3);
});

test('charger telemetry uses millivolts, milliamps and reported centiwatts', () => {
  const session = new AnkerSession({});
  const status = session.parseChargerStatus(Uint8Array.of(0, 0xa4, 8, 4, 1, 0x20, 0x4e, 0xd0, 7, 0xa0, 0x0f));
  assert.equal(status.ports.C1.voltage, 20);
  assert.equal(status.ports.C1.current, 2);
  assert.equal(status.ports.C1.power, 40);
  assert.equal(status.totalOutputW, 40);
  assert.equal(status.batteryPercent, null);
});

test('multipart charger reply is assembled before decrypting, across non-block-aligned packet boundaries', async () => {
  const { xorChecksum, parseFrame } = await import('../src/framing.js');
  const payload = Uint8Array.from({ length: 304 }, (_, i) => i & 255);
  const transport = new BluetoothTransport();
  transport.family = { name: 'alt-8c85' };
  const packet = (index, bytes) => {
    const raw = buildFrame(0x0200, concat(Uint8Array.of(index << 4 | 2), bytes),
      { group: 15, encrypted: true, response: true, sizeIncludesChecksum: true });
    raw[5] = 1;
    raw[7] |= 0x80;
    raw[raw.length - 1] = xorChecksum(raw.slice(0, -1));
    return raw;
  };
  for (const raw of [packet(1, payload.slice(0, 242)), packet(2, payload.slice(242))]) {
    transport._onNotify({ target: { value: new DataView(raw.buffer) } });
  }
  const frame = parseFrame(await transport.receive(20), { sizeIncludesChecksum: true });
  assert.equal(frame.command, 0x0200);
  assert.equal(frame.encrypted, true);
  assert.equal(frame.response, true);
  assert.deepEqual(frame.payload, payload);
  assert.equal(transport._queue.length, 0);
});

test('captured A2345 single-packet setting ACK with 03 01 becomes a valid encrypted reply', async () => {
  const { parseFrame } = await import('../src/framing.js');
  const raw = Uint8Array.from('ff091a0003010f4a0458a382625dce6e3d7acafe3d88ec1c542b'.match(/../g), byte => parseInt(byte, 16));
  const transport = new BluetoothTransport();
  transport.family = { name: 'alt-8c85' };
  transport._onNotify({ target: { value: new DataView(raw.buffer) } });
  const reply = parseFrame(await transport.receive(20), { sizeIncludesChecksum: true });
  assert.equal(reply.command, 0x0204);
  assert.equal(reply.response, true);
  assert.equal(reply.encrypted, true);
  assert.deepEqual(reply.payload, raw.slice(9, -1));
  raw[raw.length - 1] ^= 1;
  transport._onNotify({ target: { value: new DataView(raw.buffer) } });
  assert.throws(() => parseFrame(transport._queue.shift(), { sizeIncludesChecksum: true }), /checksum/);
});

test('charger settings validate values, use typed byte commands and require device acknowledgement', async () => {
  const session = new AnkerSession({family: {name: 'alt-8c85'}});
  session.info.sku = 'A2345';
  let request;
  session._exchange = async (...args) => { request = args; return {payload: Uint8Array.of(0)}; };
  await session.setChargerSetting('priority', 5);
  assert.equal(request[0], 0x020c);
  assert.equal(request[2].group, 15);
  assert.deepEqual([...request[1][1].value], [1, 5]);
  await assert.rejects(session.setChargerSetting('priority', 16), /Invalid/);
  session._exchange = async () => ({payload: Uint8Array.of(1)});
  await assert.rejects(session.setChargerSetting('brightness', 50), /rejected/);
});
