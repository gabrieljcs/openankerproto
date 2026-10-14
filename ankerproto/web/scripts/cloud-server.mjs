import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CloudClient } from './cloud-client.mjs';
import { cloudRegionDefaults } from '../src/cloud-region.js';

const page = readFileSync(new URL('./cloud-login.html', import.meta.url), 'utf8');
export function accountDevices(data) {
  const devices = [], seen = new Set();
  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 12) return;
    if (typeof value.device_sn === 'string' && !seen.has(value.device_sn)) {
      seen.add(value.device_sn);
      const device = {};
      for (const field of ['device_sn', 'product_code', 'device_pn', 'device_name', 'alias_name', 'device_sw_version', 'sw_version', 'bt_ble_mac']) if (typeof value[field] === 'string') device[field] = value[field];
      devices.push(device);
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  }
  visit(data); return devices;
}
export function createCloudServer({ clientFactory = opts => new CloudClient(opts) } = {}) {
  const sessions = new Map();
  const server = createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    const host = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== host || req.socket.remoteAddress !== '127.0.0.1') return json(403, { error: 'Use the helper through its 127.0.0.1 address.' });
    for (const [id, session] of sessions) if (Date.now() - session.created > 30 * 60000 && !session.busy) { session.client?.clear(); sessions.delete(id); }
    const cookie = /(?:^|;\s*)anker_local=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    let session = sessions.get(cookie);
    if (req.url === '/' && req.method === 'GET') {
      if (!session) {
        if (sessions.size >= 16) return json(429, { error: 'Too many local sessions. Restart the helper.' });
        const id = randomBytes(24).toString('hex'); session = { csrf: randomBytes(24).toString('hex'), created: Date.now() }; sessions.set(id, session);
        res.setHeader('Set-Cookie', `anker_local=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`);
      }
      const nonce = randomBytes(18).toString('base64');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` });
      return res.end(page.replaceAll('__NONCE__', nonce).replaceAll('__CSRF__', session.csrf).replace('__REGION_FUNCTION__', cloudRegionDefaults.toString()));
    }
    if (req.method !== 'POST' || !['/api/login', '/api/devices', '/api/logout', '/api/firmware'].includes(req.url)) return json(404, { error: 'Unknown local request.' });
    if (!session || req.headers.origin !== `http://${host}` || req.headers['x-local-csrf'] !== session.csrf || req.headers['content-type'] !== 'application/json') return json(403, { error: 'Open the local sign-in page first.' });
    if (session.busy) return json(409, { error: 'A request is already in progress.' });
    session.busy = true;
    try {
      let length = 0; const chunks = [];
      for await (const chunk of req) { length += chunk.length; if (length > 8192) return json(413, { error: 'Request too large.' }); chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return json(400, { error: 'Invalid local request.' }); }
      if (req.url === '/api/logout') { session.client?.clear(); session.client = null; return json(200, { signedOut: true }); }
      if (req.url === '/api/login') {
        session.client?.clear(); session.client = null;
        const client = clientFactory({ country: body.country, region: body.region });
        try {
          const result = await client.login(body.email, body.password, Number.isFinite(body.offsetMinutes) ? body.offsetMinutes : 180);
          session.client = client; return json(200, result);
        } finally { body.password = ''; if (!session.client) client.clear(); }
      }
      if (!session.client) return json(401, { error: 'Sign in first.' });
      if (req.url === '/api/firmware') {
        const device = session.devices?.find(device => device.device_sn === body.serial);
        if (!device) return json(404, { error: 'Read account devices before checking firmware.' });
        // Reload the read-only query implementation without discarding login tokens.
        const revision = statSync(new URL('./cloud-client.mjs', import.meta.url)).mtimeMs;
        const { CloudClient: CurrentClient } = await import(`./cloud-client.mjs?revision=${revision}`);
        return json(200, await CurrentClient.prototype.firmware.call(session.client, device));
      }
      session.devices = accountDevices(await session.client.devices());
      return json(200, { devices: session.devices });
    } catch (error) {
      // Never forward upstream bodies, credentials, token data or network exception details.
      const safe = /^Anker (HTTP error \d+\.|rejected the request \(code [\w-]+\)\.)$/.test(error.message) ? error.message : 'The Anker request could not be completed. Check your account region and login details; any verification must be completed in the official app.';
      return json(502, { error: safe });
    } finally { session.busy = false; }
  });
  server.on('close', () => { for (const session of sessions.values()) session.client?.clear(); sessions.clear(); });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createCloudServer().listen(8082, '127.0.0.1', () => console.log('Local Anker sign-in: http://127.0.0.1:8082/ — credentials and tokens are never logged or saved.'));
}
