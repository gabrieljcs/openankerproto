import { createECDH, createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

// Protocol reference: thomluther/anker-solix-api (MIT), session.py.
// This implementation deliberately keeps credentials and tokens in memory only.
const PUBLIC_KEY = '04c5c00c4f8d1197cc7c3167c52bf7acb054d722f0ef08dcd7e0883236e0d72a3868d9750cb47fa4619248f3d83f0f662671dadc6e2d31c2f41db0161651c7c076';
const PRESET = Buffer.from('e8ad18f61bbd3fbd52d5ed12d14d3b9c', 'hex');
const SERVERS = { com: 'https://ankerpower-api.anker.com', eu: 'https://ankerpower-api-eu.anker.com' };
export function wrap(key, text) {
  const iv = randomBytes(16), cipher = createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([iv, cipher.update(text), cipher.final()]).toString('base64');
}
export function unwrap(key, text) {
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length < 32 || bytes.length % 16) throw new Error('Invalid encrypted response.');
  const cipher = createDecipheriv('aes-128-cbc', key, bytes.subarray(0, 16));
  return Buffer.concat([cipher.update(bytes.subarray(16)), cipher.final()]);
}
export function passwordPayload(password) {
  const pair = createECDH('prime256v1'); pair.generateKeys();
  const secret = pair.computeSecret(Buffer.from(PUBLIC_KEY, 'hex'));
  const cipher = createCipheriv('aes-256-cbc', secret, secret.subarray(0, 16));
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]).toString('base64');
  secret.fill(0);
  return { password: encrypted, client_secret_info: { public_key: pair.getPublicKey('hex') } };
}
export class CloudClient {
  constructor({ country = 'BR', region = 'com', fetchImpl = fetch } = {}) {
    if (!/^[A-Z]{2}$/.test(country) || !SERVERS[region]) throw new Error('Choose a valid country and server region.');
    this.country = country; this.base = SERVERS[region]; this.fetch = fetchImpl;
    this.headers = { 'content-type': 'application/json', 'model-type': 'DESKTOP', 'app-name': 'anker_power', 'os-type': 'android', country };
  }
  clear() { this.token = null; this.gtoken = null; this.key?.fill(0); this.key = null; this.ident = null; }
  async post(path, body, extra = {}) {
    const response = await this.fetch(this.base + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { ...this.headers, ...(this.token ? { 'x-auth-token': this.token, gtoken: this.gtoken } : {}), ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    if (!response.ok) throw new Error(`Anker HTTP error ${response.status}.`);
    const value = await response.json();
    if (value.code !== 0) throw new Error(`Anker rejected the request (code ${Number.isFinite(value.code) ? value.code : 'unknown'}).`);
    return value;
  }
  async login(email, password, offsetMinutes = 180) {
    this.clear();
    if (typeof email !== 'string' || !email.includes('@') || typeof password !== 'string' || !password || password.length > 1024) throw new Error('Enter your Anker email and password.');
    const value = await this.post('/passport/login', { ...passwordPayload(password), email, ab: this.country, enc: 0, time_zone: -offsetMinutes * 60000, transaction: String(Date.now()) });
    const data = value.data;
    if (!data?.auth_token || !data.user_id) throw new Error('Anker did not return a usable session. Complete any verification in the official app.');
    this.token = data.auth_token; this.gtoken = createHash('md5').update(data.user_id).digest('hex');
    return { authenticated: true, country: data.country_code || this.country };
  }
  signed(body, key) {
    const ts = String(Math.floor(Date.now() / 1000)), once = randomBytes(16).toString('hex');
    return { 'x-app-key': '', 'x-encryption-info': 'algo_ecdh', 'x-replay-info': 'replay', 'x-key-ident': this.ident, 'x-request-once': once, 'x-request-ts': ts, 'x-signature': createHmac('sha256', key.toString('hex')).update(`${ts}+${once}+${body}`).digest('hex') };
  }
  async exchange() {
    if (!this.token) throw new Error('Sign in first.');
    const pair = createECDH('prime256v1'); pair.generateKeys(); this.ident = randomBytes(16).toString('hex');
    const publicKey = wrap(PRESET, pair.getPublicKey('hex'));
    const headers = this.signed(publicKey, PRESET);
    const value = await this.post('/openapi/oauth/key/exchange', { client_public_key: publicKey }, { ...headers, 'x-auth-ts': headers['x-request-ts'] });
    const point = unwrap(PRESET, value.data?.server_public_key).toString();
    if (!/^04[0-9a-f]{128}$/i.test(point)) throw new Error('Invalid Anker session public key.');
    const secret = pair.computeSecret(Buffer.from(point, 'hex')); this.key = Buffer.from(secret.subarray(0, 16)); secret.fill(0);
  }
  async read(path, payload = {}) {
    if (!this.key) await this.exchange();
    const body = wrap(this.key, JSON.stringify(payload));
    const value = await this.post(path, body, { ...this.signed(body, this.key), 'content-type': 'text/plain' });
    if (typeof value.data === 'string') return JSON.parse(unwrap(this.key, value.data).toString());
    return value.data;
  }
  async devices() { return this.read('/power_service/v1/app/get_relate_and_bind_devices'); }
  async firmware(device) {
    const model = device.product_code || device.device_pn;
    const version = device.device_sw_version || device.sw_version || '';
    if (!/^A[A-Z0-9]{4,12}$/.test(model || '') || !/^v?\d+(?:\.\d+){1,5}$/i.test(version)) throw new Error('Account device metadata is incomplete.');
    if (typeof device.device_sn !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(device.device_sn)) throw new Error('Account device serial is unavailable.');
    const response = await this.read('/app/ota/batch/check_update', { device_list: [{ device_sn: device.device_sn, version: '' }] });
    const update = response?.update_infos?.find(info => info.device_sn === device.device_sn);
    const components = (update?.children || []).map(child => ({ type: child.device_type, version: child.rom_version_name, available: child.needUpdate === true, bytes: child.full_package?.file_size, md5: child.full_package?.file_md5, url: child.full_package?.file_path }));
    return { model, installedVersion: version.replace(/^v/i, ''), source: 'Anker account firmware lookup', checkedAt: new Date().toISOString(), available: update ? update.need_update === true : null, latestVersion: update?.lastPackage?.version || '', components, response };
  }
}
