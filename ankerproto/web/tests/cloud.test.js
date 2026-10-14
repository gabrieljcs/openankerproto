import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { CloudClient, passwordPayload, wrap, unwrap } from '../scripts/cloud-client.mjs';
import { createCloudServer, accountDevices } from '../scripts/cloud-server.mjs';
import { cloudRegionDefaults } from '../src/cloud-region.js';

test('region defaults use the user locale and time zone without guessing unknown countries', () => {
  assert.deepEqual(cloudRegionDefaults(['pt_BR']), { country: 'BR', region: 'com' });
  assert.deepEqual(cloudRegionDefaults(['en-US'], 'America/Sao_Paulo'), { country: 'BR', region: 'com' });
  assert.deepEqual(cloudRegionDefaults(['de-DE']), { country: 'DE', region: 'eu' });
  assert.deepEqual(cloudRegionDefaults(['en-GB']), { country: 'GB', region: 'eu' });
  assert.deepEqual(cloudRegionDefaults(['en']), { country: '', region: '' });
  assert.deepEqual(cloudRegionDefaults(['zh-CN']), { country: 'CN', region: '' });
});

test('cloud encryption preserves UTF-8 and rejects corrupt envelopes', () => {
  const key = randomBytes(16), text = JSON.stringify({ value: 'São Paulo 🔒' });
  assert.equal(unwrap(key, wrap(key, text)).toString(), text);
  assert.notEqual(wrap(key, text), wrap(key, text));
  assert.throws(() => unwrap(key, 'bad'));
  const payload = passwordPayload('local-test-password');
  assert.match(payload.client_secret_info.public_key, /^04[0-9a-f]{128}$/);
  assert.ok(!JSON.stringify(payload).includes('local-test-password'));
});
test('login retains token internally; encrypted device read uses negotiated key', async () => {
  const preset = Buffer.from('e8ad18f61bbd3fbd52d5ed12d14d3b9c', 'hex'), server = createECDH('prime256v1'); server.generateKeys();
  let key, calls = 0;
  const client = new CloudClient({ fetchImpl: async (url, opts) => {
    calls++;
    if (url.endsWith('/passport/login')) {
      assert.equal(JSON.parse(opts.body).ab, 'BR');
      return { ok: true, json: async () => ({ code: 0, data: { auth_token: 'secret-token', user_id: 'test-user', country_code: 'BR' } }) };
    }
    assert.equal(opts.headers['x-auth-token'], 'secret-token');
    if (url.endsWith('/openapi/oauth/key/exchange')) {
      const point = unwrap(preset, JSON.parse(opts.body).client_public_key).toString();
      key = server.computeSecret(Buffer.from(point, 'hex')).subarray(0, 16);
      return { ok: true, json: async () => ({ code: 0, data: { server_public_key: wrap(preset, server.getPublicKey('hex')) } }) };
    }
    assert.ok(url.endsWith('/get_relate_and_bind_devices'));
    assert.deepEqual(JSON.parse(unwrap(key, opts.body)), {});
    return { ok: true, json: async () => ({ code: 0, data: wrap(key, JSON.stringify({ devices: [{ device_sn: 'fixture', device_sw_version: '1.2.3.4' }] })) }) };
  } });
  assert.deepEqual(await client.login('fixture@example.test', 'fake-password'), { authenticated: true, country: 'BR' });
  assert.equal((await client.devices()).devices[0].device_sw_version, '1.2.3.4');
  assert.equal(calls, 3); client.clear(); assert.equal(client.token, null); assert.equal(client.key, null);
});
test('account device output excludes arbitrary tokens and private fields', () => {
  assert.deepEqual(accountDevices({ list: [{ device_sn: 'fixture', product_code: 'A2345', auth_token: 'secret', email: 'private' }] }), [{ device_sn: 'fixture', product_code: 'A2345' }]);
});
test('firmware batch lookup uses the account serial and cannot query incomplete records', async () => {
  const client = new CloudClient(); let request;
  client.read = async (path, payload) => { request = { path, payload }; return { update_infos: [{ device_sn: 'FIXTURE123456', need_update: true, lastPackage: { version: 'v2.1.1.6' }, children: [{ device_type: 'A2345_mcu', rom_version_name: 'v2.1.1.6', needUpdate: true, full_package: { file_size: 461280, file_md5: 'fixture' } }] }] }; };
  const result = await client.firmware({ device_sn: 'FIXTURE123456', product_code: 'A2345', device_sw_version: 'v1.9.1.4' });
  assert.deepEqual(request, { path: '/app/ota/batch/check_update', payload: { device_list: [{ device_sn: 'FIXTURE123456', version: '' }] } });
  assert.equal(result.installedVersion, '1.9.1.4');
  assert.equal(result.available, true); assert.equal(result.latestVersion, 'v2.1.1.6'); assert.equal(result.components[0].bytes, 461280);
  request = null;
  await assert.rejects(client.firmware({ product_code: 'A2345', device_sw_version: '0.0.0.3' }));
  assert.equal(request, null);
});
test('local helper rejects cross-origin login and sanitizes upstream errors', async t => {
  const server = createCloudServer({ clientFactory: () => ({ login: async () => { throw Error('password=fake-secret token=hidden'); }, clear() {} }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(origin), cookie = page.headers.get('set-cookie').split(';')[0], html = await page.text(), csrf = /const csrf='([a-f0-9]+)'/.exec(html)[1];
  const request = (source, token) => fetch(origin + '/api/login', { method: 'POST', headers: { origin: source, cookie, 'content-type': 'application/json', 'x-local-csrf': token }, body: JSON.stringify({ email: 'fixture@example.test', password: 'fake-secret', country: 'BR', region: 'com' }) });
  assert.equal((await request('https://evil.example', csrf)).status, 403);
  assert.equal((await request(origin, 'wrong')).status, 403);
  const response = await request(origin, csrf); assert.equal(response.status, 502);
  const body = await response.text(); assert.ok(!body.includes('fake-secret')); assert.ok(!body.includes('hidden'));
});
