import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateFirmware, reportHtml } from '../scripts/firmware-dry-run.mjs';
const bytes = Buffer.from('Anker\xff\xff\x01A2345 payload', 'latin1');
const manifest = { update_infos: [{ device_sn: 'fixture', device_type: 'A2345', current_version: 'v1', children: [{ device_type: 'A2345_mcu', rom_version_name: 'v2', full_package: { file_size: bytes.length, file_md5: createHash('md5').update(bytes).digest('hex') } }] }] };
const validate = (data = bytes, m = manifest) => validateFirmware(m, { A2345_mcu: data }, { model: 'A2345', serial: 'fixture' });
test('valid image remains blocked for installation despite matching integrity', () => { const report = validate(); assert.equal(report.integrityPassed, true); assert.equal(report.installationReady, false); assert.match(report.packages[0].header, /A2345/); });
test('wrong serial, corruption, missing files and product mismatch fail closed', () => {
  assert.throws(() => validateFirmware(manifest, {}, { model: 'A2345', serial: 'another' }));
  assert.equal(validate(bytes.subarray(1)).integrityPassed, false);
  assert.equal(validateFirmware(manifest, {}, { model: 'A2345', serial: 'fixture' }).integrityPassed, false);
  const wrong = Buffer.from(bytes); wrong.write('A9999', 8); const m = structuredClone(manifest); m.update_infos[0].children[0].full_package.file_md5 = createHash('md5').update(wrong).digest('hex');
  assert.equal(validate(wrong, m).integrityPassed, false);
});
test('report escapes manifest text rather than executing it', () => { const report = validate(); report.model = '<script>bad()</script>'; assert.ok(!reportHtml(report).includes('<script>')); });
