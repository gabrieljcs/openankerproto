export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function photoRect(sourceWidth, sourceHeight, width, height, { fit = 'cover', zoom = 1, x = 0.5, y = 0.5 } = {}) {
  if (![sourceWidth, sourceHeight, width, height, zoom, x, y].every(Number.isFinite) || Math.min(sourceWidth, sourceHeight, width, height) <= 0 || zoom < 1 || zoom > 4 || x < 0 || x > 1 || y < 0 || y > 1 || !['cover', 'contain'].includes(fit)) throw new Error('Invalid photo crop.');
  const scale = (fit === 'cover' ? Math.max(width / sourceWidth, height / sourceHeight) : Math.min(width / sourceWidth, height / sourceHeight)) * zoom;
  const w = sourceWidth * scale, h = sourceHeight * scale;
  return { x: (width - w) * x, y: (height - h) * y, width: w, height: h };
}

export async function preparePhoto(image, { width, height, format = 'image/jpeg', quality = 0.9, ...crop }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width > 1024 || height > 1024 || !['image/jpeg', 'image/png'].includes(format)) throw new Error('Choose dimensions between 16 and 1024 pixels and JPEG or PNG.');
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = '#000'; context.fillRect(0, 0, width, height);
  const rect = photoRect(image.width, image.height, width, height, crop);
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, format, quality));
  if (!blob) throw new Error('This browser could not encode the image.');
  const checksum = crc32(new Uint8Array(await blob.arrayBuffer()));
  return { blob, canvas, crc: checksum, width, height };
}
