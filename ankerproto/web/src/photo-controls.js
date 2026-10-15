import { preparePhoto, photoRect, panPhoto } from './photo.js';
const $ = id => document.getElementById(id);
const helper = 'http://127.0.0.1:8081';

export function wirePhotoControls({ getTransport }) {
  let image, prepared, generation = 0, timer, drag, sharing = false, sharedUrl = null;
  const result = $('photo-result'), preview = $('photo-preview');
  const local = ['http://127.0.0.1:8080', 'http://localhost:8080'].includes(location.origin);
  const message = (text, state = '') => { result.textContent = text; result.dataset.state = state; };
  const options = () => ({ width: Number($('photo-width').value), height: Number($('photo-height').value), format: $('photo-format').value,
    fit: $('photo-fit').value, zoom: Number($('photo-zoom').value), x: Number($('photo-x').value) / 100, y: Number($('photo-y').value) / 100 });
  const delivery = () => {
    const demo = getTransport()?.isDemo;
    $('photo-share').textContent = demo ? 'Simulate photo sharing' : local ? 'Make available to charger' : 'How to send to charger';
    $('photo-delivery-note').textContent = demo ? 'Demo mode: sharing and applying are simulated. You can still save the edited photo.' : local
      ? 'Save your photo, or share it on Wi-Fi for 10 minutes. Sharing prepares the download; Apply clock style sends the request.'
      : 'Save your edited photo here. To send it to the charger, open the local workspace with the photo helper running.';
  };
  const readouts = () => {
    for (const name of ['zoom', 'x', 'y']) $('photo-' + name + '-value').textContent = name === 'zoom' ? Number($('photo-zoom').value).toFixed(2) + '×' : $('photo-' + name).value + '%';
    $('photo-clock-overlay').style.color = $('clock-text-color').value;
    $('photo-clock-overlay').hidden = !$('photo-show-clock').checked;
  };
  const invalidate = () => {
    ++generation; clearTimeout(timer); prepared = null;
    $('photo-save').disabled = true; $('photo-share').disabled = true;
    if (sharedUrl && $('clock-image-url').value === sharedUrl) {
      $('clock-image-url').value = ''; $('clock-image-crc').value = ''; $('clock-image-id').value = '0';
      $('clock-theme-result').textContent = 'Your photo changed. Make the updated photo available before applying it.';
    }
    sharedUrl = null;
  };
  const draw = () => {
    if (!image) return;
    const opts = options();
    if (!Number.isInteger(opts.width) || !Number.isInteger(opts.height) || opts.width < 16 || opts.width > 1024 || opts.height < 16 || opts.height > 1024) return;
    const rect = photoRect(image.width, image.height, opts.width, opts.height, opts);
    preview.width = opts.width; preview.height = opts.height;
    const ctx = preview.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, opts.width, opts.height); ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    $('photo-preview-wrap').hidden = false;
  };
  const update = async () => {
    const version = ++generation;
    prepared = null; $('photo-save').disabled = true; $('photo-share').disabled = true;
    if (!image) return;
    preview.setAttribute('aria-busy', 'true');
    try {
      const next = await preparePhoto(image, options());
      if (version !== generation) return;
      prepared = next; draw(); delivery();
      message(`${next.width} × ${next.height} · ${Math.max(1, Math.ceil(next.blob.size / 1024))} KB · Ready to save. Nothing sent yet.`, 'ready');
      $('photo-save').disabled = false; $('photo-share').disabled = sharing;
    } catch (error) { if (version === generation) message(error.message, 'error'); }
    finally { if (version === generation) preview.setAttribute('aria-busy', 'false'); }
  };
  const changed = () => {
    invalidate(); readouts();
    if (!image) return;
    draw(); message('Preparing your updated photo…');
    timer = setTimeout(update, 100);
  };
  const reset = () => {
    $('photo-zoom').value = '1'; $('photo-x').value = '50'; $('photo-y').value = '50'; $('photo-fit').value = 'cover'; readouts();
  };
  const loadFile = async file => {
    if (!file) return; // Cancelling the chooser preserves the current edit.
    invalidate(); const selection = generation;
    image?.close(); image = null; $('photo-preview-wrap').hidden = true;
    $('photo-crop-controls').disabled = true; $('photo-reset').disabled = true;
    $('photo-filename').textContent = file.name; message('Opening photo…');
    try {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPEG, PNG or WebP image.');
      if (file.size > 20 * 1024 * 1024) throw new Error('Choose a photo smaller than 20 MB.');
      const next = await createImageBitmap(file, { imageOrientation: 'from-image' });
      if (selection !== generation) { next.close(); return; }
      if (next.width * next.height > 40000000) { next.close(); throw new Error('Choose a photo smaller than 40 megapixels.'); }
      image = next; reset(); draw();
      $('photo-crop-controls').disabled = false; $('photo-reset').disabled = false;
      await update();
    } catch (error) { if (selection === generation) message('Could not open photo: ' + error.message, 'error'); }
  };
  $('photo-file').addEventListener('change', () => loadFile($('photo-file').files[0]));
  const dropzone = $('photo-dropzone');
  for (const type of ['dragenter', 'dragover']) dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.add('is-dragging'); });
  for (const type of ['dragleave', 'drop']) dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.remove('is-dragging'); });
  dropzone.addEventListener('drop', event => loadFile(event.dataTransfer.files[0]));
  for (const input of document.querySelectorAll('[data-photo-option]')) input.addEventListener('input', changed);
  $('photo-reset').addEventListener('click', () => { reset(); changed(); });
  $('photo-show-clock').addEventListener('change', readouts);
  $('clock-text-color').addEventListener('input', readouts);
  $('clock-style').addEventListener('change', delivery);
  preview.addEventListener('pointerdown', event => {
    if (!image || !prepared || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const opts = options(), rect = photoRect(image.width, image.height, opts.width, opts.height, opts);
    drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, ...opts, rect, bounds: preview.getBoundingClientRect() };
    preview.setPointerCapture(event.pointerId);
  });
  preview.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const pos = panPhoto(drag, (event.clientX - drag.startX) * drag.width / drag.bounds.width, (event.clientY - drag.startY) * drag.height / drag.bounds.height);
    $('photo-x').value = String(Math.round(pos.x * 100)); $('photo-y').value = String(Math.round(pos.y * 100)); changed();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) preview.addEventListener(type, () => { drag = null; });
  $('photo-save').addEventListener('click', () => {
    if (!prepared) return;
    const url = URL.createObjectURL(prepared.blob), a = document.createElement('a');
    a.href = url; a.download = `clock-${prepared.crc.toString(16)}.${prepared.blob.type === 'image/png' ? 'png' : 'jpg'}`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    message('Photo saved. To display it on the charger, share it locally or use a hosted image URL.', 'ready');
  });
  $('photo-share').addEventListener('click', async () => {
    if (!prepared || sharing) return;
    if (!getTransport()?.isDemo && !local) {
      $('photo-delivery-help').open = true; $('photo-delivery-help').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      message('Save the photo first, then follow the local delivery steps below.'); return;
    }
    const photo = prepared, version = generation; sharing = true; $('photo-share').disabled = true;
    message(getTransport()?.isDemo ? 'Preparing a simulated download…' : 'Sharing through the local photo helper…');
    try {
      let url;
      if (getTransport()?.isDemo) url = 'http://192.0.2.1/demo-clock.jpg';
      else {
        const response = await fetch(helper + '/api/image', { method: 'POST', headers: { 'Content-Type': photo.blob.type }, body: photo.blob, signal: AbortSignal.timeout(10000) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error);
        if (!data.addresses.length) throw new Error('Connect this computer to the same Wi-Fi network as the charger.');
        if (data.crc !== photo.crc) throw new Error('The prepared image checksum changed during transfer.');
        const address = $('photo-address').value.trim() || data.addresses[0];
        if (!data.addresses.includes(address)) throw new Error('Choose this computer’s Wi-Fi address: ' + data.addresses.join(', '));
        url = `http://${address}:${data.port}${data.path}`;
      }
      if (version !== generation) return;
      for (const [id, value] of [['clock-image-url', url], ['clock-image-crc', photo.crc.toString(16).padStart(8, '0')], ['clock-image-id', photo.crc]]) {
        $(id).value = value; $(id).dataset.dirty = 'true';
      }
      sharedUrl = url;
      message(getTransport()?.isDemo ? 'Demo photo prepared. Apply clock style simulates the device request.' : 'Photo available for 10 minutes. Choose Apply clock style below. Keep this computer awake on the same Wi-Fi network.', 'ready');
      $('clock-theme-result').textContent = 'Photo ready. Apply clock style to request the download.';
    } catch (error) {
      if (version !== generation) return;
      $('photo-delivery-help').open = true;
      message(error instanceof TypeError || error.name === 'TimeoutError' ? 'Could not reach the photo helper. Start npm run photo:serve, then try again. Your edits are still here.' : error.message, 'error');
    } finally { sharing = false; $('photo-share').disabled = !prepared; }
  });
  delivery(); readouts();
}
