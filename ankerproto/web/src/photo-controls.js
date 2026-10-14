import { preparePhoto } from './photo.js';
const $ = id => document.getElementById(id);
const helper = 'http://127.0.0.1:8081';

export function wirePhotoControls({ getTransport }) {
  let image, prepared, generation = 0, timer;
  const result = $('photo-result');
  const update = async () => {
    const version = ++generation;
    prepared = null; $('photo-save').disabled = true; $('photo-share').disabled = true;
    if (!image) return;
    try {
      const next = await preparePhoto(image, { width: Number($('photo-width').value), height: Number($('photo-height').value), format: $('photo-format').value,
        fit: $('photo-fit').value, zoom: Number($('photo-zoom').value), x: Number($('photo-x').value) / 100, y: Number($('photo-y').value) / 100 });
      if (version !== generation) return;
      prepared = next;
      const preview = $('photo-preview'); preview.width = next.width; preview.height = next.height;
      preview.getContext('2d').drawImage(next.canvas, 0, 0);
      $('photo-preview-wrap').hidden = false;
      result.textContent = `${next.width} × ${next.height} · ${Math.ceil(next.blob.size / 1024)} KB · CRC32 ${next.crc.toString(16).padStart(8, '0')}. Prepared locally; nothing sent yet.`;
      $('photo-save').disabled = false; $('photo-share').disabled = false;
    } catch (error) { if (version === generation) result.textContent = error.message; }
  };
  $('photo-file').addEventListener('change', async () => {
    const selection = ++generation; clearTimeout(timer); image?.close(); image = null; prepared = null;
    $('photo-preview-wrap').hidden = true; $('photo-save').disabled = true; $('photo-share').disabled = true;
    const file = $('photo-file').files[0]; if (!file) return;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('Choose a photo smaller than 20 MB.');
      const next = await createImageBitmap(file, { imageOrientation: 'from-image' });
      if (selection !== generation) { next.close(); return; }
      if (next.width * next.height > 40000000) { next.close(); throw new Error('Choose a photo smaller than 40 megapixels.'); }
      image = next; await update();
    } catch (error) { if (selection === generation) result.textContent = 'Could not open photo: ' + error.message; }
  });
  for (const input of document.querySelectorAll('[data-photo-option]')) input.addEventListener('input', () => {
    ++generation; prepared = null; $('photo-save').disabled = true; $('photo-share').disabled = true;
    clearTimeout(timer); timer = setTimeout(update, 100);
  });
  $('photo-save').addEventListener('click', () => {
    if (!prepared) return;
    const url = URL.createObjectURL(prepared.blob), a = document.createElement('a');
    a.href = url; a.download = `clock-${prepared.crc.toString(16)}.${prepared.blob.type === 'image/png' ? 'png' : 'jpg'}`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('photo-share').addEventListener('click', async () => {
    if (!prepared) return;
    const photo = prepared, version = generation; $('photo-share').disabled = true;
    try {
      let url;
      if (getTransport()?.isDemo) url = 'http://192.0.2.1/demo-clock.jpg';
      else {
        const response = await fetch(helper + '/api/image', { method: 'POST', headers: { 'Content-Type': photo.blob.type }, body: photo.blob, signal: AbortSignal.timeout(10000) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error);
        if (!data.addresses.length) throw new Error('Connect this computer to the same Wi-Fi network as the charger.');
        if (data.crc !== photo.crc) throw new Error('The prepared image checksum changed during transfer.');
        const preferred = $('photo-address').value.trim();
        const address = preferred || data.addresses[0];
        if (!data.addresses.includes(address)) throw new Error('Choose this computer’s Wi-Fi address: ' + data.addresses.join(', '));
        url = `http://${address}:${data.port}${data.path}`;
      }
      // Populating the command is separate from sending it to the device.
      if (version !== generation) throw new Error('The photo changed during preparation. Make the new photo available again.');
      for (const [id, value] of [['clock-image-url', url], ['clock-image-crc', photo.crc.toString(16).padStart(8, '0')], ['clock-image-id', photo.crc]]) {
        $(id).value = value; $(id).dataset.dirty = 'true';
      }
      result.textContent = getTransport()?.isDemo ? 'Demo photo prepared. Apply clock style simulates the device request.' : 'Photo available to your charger for 10 minutes. Press Apply clock style to request its download. Keep this computer awake on the same Wi-Fi network.';
    } catch (error) { result.textContent = error instanceof TypeError ? 'Start the local photo helper with npm run photo:serve, then try again. The website alone cannot serve a file to the charger.' : error.message; }
    finally { $('photo-share').disabled = !prepared; }
  });
}
