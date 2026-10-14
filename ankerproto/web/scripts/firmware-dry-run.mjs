import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const updateSteps = [
  { step: 'Discover account firmware', evidence: 'Verified live: authenticated batch lookup returns installed version and component packages.' },
  { step: 'Validate each package', evidence: 'Verify supplied size and MD5; calculate SHA-256 for diagnostics. Checksums do not prove publisher authenticity.' },
  { step: 'Resolve component order and update transport', evidence: 'Unverified. A2345 has MCU and ESP32 packages; array order is not installation order.' },
  { step: 'Start Bluetooth OTA', evidence: 'Recovered app command 0x002e; not executed. Payload inherits timestamp, user identity and package parameters.' },
  { step: 'Announce sub-package', evidence: 'Recovered app command 0x002f; not executed. Complete parameter mapping remains unverified.' },
  { step: 'Transfer and acknowledge', evidence: 'Shared ZX updater reads an initial file block. Its header probe is not proof of the negotiated data chunk size. Resume, retries and state meanings remain unverified.' },
  { step: 'Restart and verify installed versions', evidence: 'Required but not verified. Acknowledgement alone must not be reported as installation success.' },
];
export function validateFirmware(manifest, packages, { model, serial } = {}) {
  if (!model || !serial) throw Error('Provide the intended model and serial explicitly.');
  const reports = Array.isArray(manifest) ? manifest : [manifest];
  const records = reports.flatMap(report => (report.response || report).update_infos || []);
  const record = records.find(record => record.device_sn === serial);
  if (!record || record.device_type !== model) throw Error('Manifest does not match the intended model and serial.');
  if (!Array.isArray(record.children) || !record.children.length) throw Error('Manifest has no component packages.');
  const results = record.children.map(component => {
    const type = component.device_type, metadata = component.full_package;
    if (typeof type !== 'string' || !type.startsWith(model + '_') || !metadata || !Number.isSafeInteger(metadata.file_size) || metadata.file_size <= 0 || !/^[a-f0-9]{32}$/i.test(metadata.file_md5 || '')) throw Error('Invalid component metadata.');
    const bytes = packages[type];
    if (!(bytes instanceof Uint8Array)) return { type, version: component.rom_version_name, integrity: false, errors: ['Package file not supplied.'] };
    const buffer = Buffer.from(bytes), md5 = createHash('md5').update(buffer).digest('hex'), sha256 = createHash('sha256').update(buffer).digest('hex');
    const errors = [];
    if (buffer.length !== metadata.file_size) errors.push(`Size mismatch: expected ${metadata.file_size}, received ${buffer.length}.`);
    if (md5 !== metadata.file_md5.toLowerCase()) errors.push('MD5 differs from Anker metadata.');
    let header = 'Unknown image header; product targeting not established.';
    if (buffer.subarray(0, 5).toString() === 'Anker') {
      const product = buffer.subarray(8, 13).toString('ascii');
      header = `Anker header, product ${product}.`;
      if (product !== model) errors.push('Image header targets another model.');
    } else if (buffer[0] === 0xe9) header = 'ESP image header; this header alone does not identify the charger model.';
    return { type, version: component.rom_version_name, bytes: buffer.length, md5, sha256, header, integrity: errors.length === 0, errors };
  });
  return { mode: 'Offline dry run — no device commands', model, serial, installedVersion: record.current_version, checkedAt: new Date().toISOString(), integrityPassed: results.every(result => result.integrity), installationReady: false, packages: results, steps: updateSteps, blockers: ['Publisher signature verification is not implemented.', 'Component order, transport, acknowledgements and restart recovery are not hardware verified.'] };
}
export function reportHtml(report) {
  const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>openankerproto · Firmware dry run</title><style>body{background:#111a1e;color:#e7eff1;font:16px system-ui;max-width:950px;margin:40px auto;padding:24px}p,li{line-height:1.6}article{background:#1b2a30;padding:20px;border-radius:12px;margin:20px 0}code{overflow-wrap:anywhere}small{color:#b8cbd2}</style><h1>Firmware dry run</h1><p>${escape(report.model)} · installed ${escape(report.installedVersion)}</p><p><strong>${report.integrityPassed ? 'Package sizes and checksums match the supplied manifest.' : 'Package validation failed.'}</strong> Installation is blocked. No Bluetooth, Wi-Fi or cloud commands were sent by this diagnostic.</p><small>This is a snapshot validated against supplied metadata, not a live latest-version check.</small>${report.packages.map(p => `<article><h2>${escape(p.type)} · ${escape(p.version)}</h2><p>${p.integrity ? 'Integrity checks passed' : 'Validation failed'} · ${escape(p.bytes || 'missing')} bytes</p><p>${escape(p.header || '')}</p><p>MD5 <code>${escape(p.md5 || '')}</code><br>SHA-256 <code>${escape(p.sha256 || '')}</code></p>${p.errors.map(error => `<p>${escape(error)}</p>`).join('')}</article>`).join('')}<h2>Protocol evidence</h2><ol>${report.steps.map(step => `<li><strong>${escape(step.step)}</strong><br>${escape(step.evidence)}</li>`).join('')}</ol><h2>What remains unverified</h2><ul>${report.blockers.map(blocker => `<li>${escape(blocker)}</li>`).join('')}</ul></html>`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), option = key => args[args.indexOf(key) + 1];
    for (const key of ['--manifest', '--model', '--serial']) if (!args.includes(key)) throw Error(`Required: ${key}`);
    const files = {};
    for (let i = 0; i < args.length; i++) if (args[i] === '--package') { const spec = args[++i], separator = spec?.indexOf('='); if (!(separator > 0)) throw Error('Package syntax: --package COMPONENT=/absolute/file.bin'); files[spec.slice(0, separator)] = readFileSync(spec.slice(separator + 1)); }
    const report = validateFirmware(JSON.parse(readFileSync(option('--manifest'), 'utf8')), files, { model: option('--model'), serial: option('--serial') });
    if (args.includes('--html')) writeFileSync(option('--html'), reportHtml(report));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.integrityPassed) process.exitCode = 1;
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
