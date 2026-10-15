import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, photoRect, panPhoto } from '../src/photo.js';
import { createPhotoServer } from '../scripts/photo-server.mjs';

test('photo checksum uses standard CRC32 and unsigned output', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});
test('photo crop fills landscape screen and preserves whole photo in fit mode', () => {
  assert.deepEqual(photoRect(100, 200, 400, 200), { x: 0, y: -300, width: 400, height: 800 });
  assert.deepEqual(photoRect(100, 200, 400, 200, { fit: 'contain' }), { x: 150, y: 0, width: 100, height: 200 });
  assert.throws(() => photoRect(100, 200, 400, 200, { zoom: 0 }));
});
test('photo helper restricts uploads, serves exact bytes and expires images', async () => {
  const server = createPhotoServer({ ttl: 200 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: 'http://127.0.0.1:8080', 'Content-Type': 'image/jpeg' };
  const bytes = Uint8Array.of(255, 216, 255, 224, 1, 2, 3);
  try {
    assert.equal((await fetch(base + '/api/status')).status, 403);
    assert.equal((await fetch(base + '/api/image', { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: bytes })).status, 403);
    assert.equal((await fetch(base + '/api/image', { method: 'POST', headers, body: 'invalid' })).status, 422);
    const upload = await fetch(base + '/api/image', { method: 'POST', headers, body: bytes });
    assert.equal(upload.status, 201);
    const data = await upload.json();
    assert.equal(data.crc, crc32(bytes));
    assert.deepEqual(new Uint8Array(await (await fetch(base + data.path)).arrayBuffer()), bytes);
    assert.equal((await fetch(base + '/src/session.js')).status, 404);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal((await fetch(base + data.path)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

 test('dragging photo follows the pointer, clamps edges, and keeps fitted axes stable', () => {
   const crop = { x: .5, y: .5, width: 400, height: 200, rect: photoRect(100, 200, 400, 200) };
   assert.deepEqual(panPhoto(crop, 100, 60), { x: .5, y: .4 });
   assert.equal(panPhoto(crop, 0, 1000).y, 0);
   assert.equal(panPhoto(crop, 0, -1000).y, 1);
 });
