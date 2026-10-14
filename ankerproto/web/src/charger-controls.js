import { wirePhotoControls } from './photo-controls.js';
import { clockDays } from './clock.js';
const $ = id => document.getElementById(id);

export function renderChargerSettings(settings) {
  for (const name of ['brightness', 'timeout', 'chargingMode', 'rotation', 'clockFormat', 'holiday']) {
    const input = $('charger-' + name);
    let readout = input.closest('.control').querySelector('.current-setting');
    if (!readout) { readout = document.createElement('p'); readout.className = 'current-setting muted small'; input.closest('.control').append(readout); }
    if (settings[name] == null) { readout.textContent = 'Current value not decoded'; continue; }
    if (!input.dataset.dirty) input.value = settings[name];
    const option = [...(input.options ?? [])].find(option => Number(option.value) === settings[name]);
    readout.textContent = `Device: ${option?.textContent ?? settings[name] + '%'}`;
  }
  const times = settings.clockSchedule;
  if (times) {
    for (const box of document.querySelectorAll("[data-clock-day]")) if (!box.dataset.dirty) box.checked = !!(times[4] & Number(box.dataset.clockDay));
    const time = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    for (const [id, value] of [['clock-start', time(times[0], times[1])], ['clock-end', time(times[2], times[3])]]) {
      if (!$(id).dataset.dirty) $(id).value = value;
    }
    let readout = $('clock-start').closest('.control').querySelector('.current-setting');
    if (!readout) { readout = document.createElement('p'); readout.className = 'current-setting muted small'; $('clock-start').closest('.control').append(readout); }
    readout.textContent = `Device: ${time(times[0], times[1])}–${time(times[2], times[3])} · ${clockDays(times[4])}`;
  }
}


export function wireChargerControls({ getSession, getTransport, refresh, syncClock }) {
  const clockLocal = () => $('clock-local-time').textContent = `Computer: ${new Date().toLocaleString()} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}. The charger uses this time zone when connecting or syncing.`;
  clockLocal();
  setInterval(() => { if (!document.hidden && $('clock-local-time')?.isConnected) clockLocal(); }, 1000);
  $('sync-clock').addEventListener('click', async () => {
    const session = getSession(), button = $('sync-clock'), result = $('clock-sync-result');
    if (!session) { result.textContent = 'Connect a charger first.'; return; }
    button.disabled = true;
    try {
      await syncClock(); clockLocal();
      result.textContent = getTransport()?.isDemo ? 'Time synchronization simulated.' : 'Time and time zone sent; connection verified. Check the hour on the resting screen.';
    } catch (error) { result.textContent = error.message; }
    finally { button.disabled = false; }
  });
  wirePhotoControls({ getTransport });
  for (const btn of document.querySelectorAll("[data-charger-setting]")) {
    btn.addEventListener("click", async () => {
      const session = getSession();
      if (!session) return;
      const transport = getTransport();
      const setting = btn.dataset.chargerSetting;
      const label = setting === 'priority' ? 'Port priority' : setting === 'clockSchedule' ? 'Clock schedule' : document.querySelector(`label[for="charger-${setting}"]`)?.textContent ?? setting;
      if (setting !== 'priority' && setting !== 'clockSchedule' && !$('charger-' + setting).value.trim()) {
        $('charger-setting-result').textContent = 'Enter a setting value before applying.'; return;
      }
      const value = setting === 'clockSchedule' ? [...$('clock-start').value.split(':').map(Number), ...$('clock-end').value.split(':').map(Number), [...document.querySelectorAll('[data-clock-day]:checked')].reduce((mask, box) => mask | Number(box.dataset.clockDay), 0)] : setting === "priority" ? [...document.querySelectorAll("[data-priority]:checked")].reduce((mask, box) => mask | Number(box.dataset.priority), 0) : Number($("charger-" + setting).value);
      btn.disabled = true;
      $("charger-setting-result").textContent = "Waiting for the charger to acknowledge…";
      try {
        await session.setChargerSetting(setting, value);
        $("charger-setting-result").textContent = transport?.isDemo ? `${label} simulated successfully. No physical device was changed.` : `${label} acknowledged by the charger.`;
        if (setting === 'holiday') await readClock();
        const status = await refresh();
        const actual = status?.settings?.[setting];
        if (!transport?.isDemo && actual != null) $('charger-setting-result').textContent = JSON.stringify(actual) === JSON.stringify(value) ? `${label} confirmed by device readback.` : `${label} acknowledged, but readback differs. Device reports ${JSON.stringify(actual)}; check the charger.`;
      } catch (error) { $("charger-setting-result").textContent = error.message; }
      finally { btn.disabled = false; }
    });
  }
  for (const button of document.querySelectorAll('[data-clock-days]')) button.addEventListener('click', () => {
    for (const box of document.querySelectorAll('[data-clock-day]')) { box.checked = !!(Number(button.dataset.clockDays) & Number(box.dataset.clockDay)); box.dataset.dirty = 'true'; }
  });
  $('clock-style').addEventListener('change', () => { $('clock-image-fields').hidden = $('clock-style').value !== '3'; });
  const readClock = async () => {
    const theme = await getSession().readClockTheme();
    if (!$('clock-style').dataset.dirty && theme.type <= 3) $('clock-style').value = theme.type;
    if (!$('clock-enabled').dataset.dirty) $('clock-enabled').checked = theme.enabled;
    $('clock-image-fields').hidden = $('clock-style').value !== '3';
    if (theme.id != null && !$('clock-image-id').dataset.dirty) $('clock-image-id').value = theme.id;
    if (theme.url != null && !$('clock-image-url').dataset.dirty) $('clock-image-url').value = theme.url;
    if (!$('charger-holiday').dataset.dirty) $('charger-holiday').value = theme.holiday;
    $('clock-current').textContent = `Device: clock ${theme.enabled ? 'on' : 'off'} · ${theme.type === 3 ? 'image theme ' + theme.id : 'built-in style ' + (theme.type + 1)} · holiday screensavers ${theme.holiday ? 'on' : 'off'}`;
    return theme;
  };
  $('read-clock-theme').addEventListener('click', async () => {
    if (!getSession()) return;
    const button = $('read-clock-theme'); button.disabled = true;
    try { await readClock(); $('clock-theme-result').textContent = 'Clock settings read from the device.'; }
    catch (error) { $('clock-theme-result').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('apply-clock-theme').addEventListener('click', async () => {
    const session = getSession(); if (!session) return;
    const button = $('apply-clock-theme'), result = $('clock-theme-result');
    try {
      const type = Number($('clock-style').value), crcText = $('clock-image-crc').value.trim();
      if (type === 3 && !/^[0-9a-fA-F]{8}$/.test(crcText)) throw new Error('Enter the device-ready file’s CRC32 as eight hex digits.');
      if (type === 3 && !$('clock-image-id').value.trim()) throw new Error('Enter a theme ID.');
      button.disabled = true; result.textContent = 'Waiting for the charger…';
      await session.setClockTheme({ enabled: $('clock-enabled').checked, type,
        id: type === 3 ? Number($('clock-image-id').value) : 0, crc: type === 3 ? parseInt(crcText, 16) : 0,
        color: type === 3 ? 0xff000000 + parseInt($('clock-text-color').value.slice(1), 16) : 0xffffffff,
        url: type === 3 ? $('clock-image-url').value.trim() : '' });
      const actual = await readClock();
      result.textContent = getTransport()?.isDemo ? 'Clock style simulated. No device was changed.' : type === 3 ? 'Download request acknowledged. Check the charger for completion; acknowledgment does not confirm image installation.' : actual.type === type && actual.enabled === $('clock-enabled').checked ? 'Clock style confirmed by device readback.' : 'Clock command acknowledged, but device readback differs. Check the display.';
    } catch (error) { result.textContent = error.message; }
    finally { button.disabled = false; }
  });
  for (const input of document.querySelectorAll('#charger-controls input, #charger-controls select')) input.addEventListener('input', () => { input.dataset.dirty = 'true'; });
}
