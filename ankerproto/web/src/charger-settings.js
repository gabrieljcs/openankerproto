// Recovered from A2345DeviceController / A2345DeviceCommands in the app binary.
export const CHARGER_SETTINGS = {
  brightness: [0x0204, 0, 100], timeout: [0x0203, 0, 4], priority: [0x020c, 0, 15],
  clockFormat: [0x0210, 0, 1], chargingMode: [0x0206, 1, 4], rotation: [0x020e, 0, 1], holiday: [0x020f, 0, 1],
};
export const CHARGER_TAGS = { 0xb1: 'Charging mode', 0xb3: 'Screen brightness (%)', 0xb4: 'Knob direction', 0xb5: 'Screen timeout', 0xb9: 'Clock schedule', 0xb7: 'Device feature flags', 0xa4: 'C1 measurements', 0xa5: 'C2 measurements', 0xa6: 'C3 measurements', 0xa7: 'C4 measurements', 0xa8: 'A1 measurements', 0xa9: 'A2 measurements' };
export function settingBytes(setting, value) {
  if (setting === 'clockSchedule') {
    if (!Array.isArray(value) || value.length !== 5 || value.some(v => !Number.isInteger(v)) ||
      value[0] < 0 || value[0] > 23 || value[2] < 0 || value[2] > 23 ||
      value[1] < 0 || value[1] > 59 || value[3] < 0 || value[3] > 59 || value[4] < 1 || value[4] > 127) throw new Error('Choose valid start/end times and at least one repeat day.');
    if (value[0] === value[2] && value[1] === value[3]) throw new Error('Clock start and end must differ.');
    return { command: 0x0213, bytes: Uint8Array.of(4, ...value) };
  }
  const def = CHARGER_SETTINGS[setting];
  if (!def || !Number.isInteger(value) || value < def[1] || value > def[2]) throw new Error('Invalid charger setting value.');
  return { command: def[0], bytes: Uint8Array.of(1, value) };
}
export function decodeChargerSettings(tags) {
  const settings = {};
  const fields = { 0xb1: 'chargingMode', 0xb3: 'brightness', 0xb4: 'rotation', 0xb5: 'timeout' };
  for (const tag of tags) {
    if (fields[tag.tag] && tag.value.length === 2 && tag.value[0] === 1) {
      const name = fields[tag.tag], value = tag.value[1], def = CHARGER_SETTINGS[name];
      if (value >= def[1] && value <= def[2]) settings[name] = value;
    }
    if (tag.tag === 0xb9 && tag.value.length === 6 && tag.value[0] === 4) {
      const value = [...tag.value.slice(1)];
      if (value[0] < 24 && value[2] < 24 && value[1] < 60 && value[3] < 60) settings.clockSchedule = value;
    }
  }
  return settings;
}
