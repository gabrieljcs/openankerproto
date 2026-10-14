import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { crc32 } from '../src/photo.js';

const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
export function createPhotoServer({ port = 8081, ttl = 600000, origins = ['http://127.0.0.1:8080', 'http://localhost:8080'] } = {}) {
  const images = new Map();
  const addresses = () => [...new Set(Object.values(networkInterfaces()).flat().filter(a => a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)).map(a => a.address))];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const origin = req.headers.origin;
    const now = Date.now();
    for (const [key, image] of images) if (image.expires < now) images.delete(key);
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (path.startsWith('/api/')) {
      if (!loopback(req.socket.remoteAddress) || !origins.includes(origin)) return json(403, { error: 'Photo preparation API is restricted to the local website.' });
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
      if (path === '/api/status' && req.method === 'GET') return json(200, { addresses: addresses(), port: server.address().port });
      if (path !== '/api/image' || req.method !== 'POST') return json(404, { error: 'Unknown photo request.' });
      const mime = req.headers['content-type'];
      if (!['image/jpeg', 'image/png'].includes(mime)) return json(415, { error: 'Only JPEG and PNG are accepted.' });
      try {
        const chunks = []; let length = 0;
        for await (const chunk of req) { length += chunk.length; if (length > 2 * 1024 * 1024) return json(413, { error: 'Prepared image exceeds 2 MB.' }); chunks.push(chunk); }
        const bytes = Buffer.concat(chunks);
        const valid = mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        if (!valid) return json(422, { error: 'Image signature does not match its format.' });
        // One prepared image at a time; no files, accounts or persistent storage.
        images.clear();
        const path = '/photo/' + randomBytes(18).toString('hex') + (mime === 'image/jpeg' ? '.jpg' : '.png');
        images.set(path, { bytes, mime, expires: now + ttl, downloads: 0 });
        return json(201, { path, crc: crc32(bytes), bytes: bytes.length, expires: now + ttl, addresses: addresses(), port: server.address().port });
      } catch { return json(400, { error: 'Photo transfer was interrupted.' }); }
    }
    const image = images.get(path);
    if (!image || !['GET', 'HEAD'].includes(req.method)) return json(404, { error: 'Image is unavailable or has expired.' });
    res.writeHead(200, { 'content-type': image.mime, 'content-length': image.bytes.length, 'cache-control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    image.downloads++;
    res.end(image.bytes);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf('--port'); const port = index < 0 ? 8081 : Number(process.argv[index + 1]);
  const server = createPhotoServer({ port });
  server.listen(port, '0.0.0.0', () => console.log(`Photo helper ready on port ${port}. Only the prepared image is served to the local network; it expires after 10 minutes.`));
}
