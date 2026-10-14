// Evidence: model-specific controllers in work/blutter_out/asm/charging/ble/device.
// A method's presence does not establish that another model shares its wire format.
export function modelControls(sku) {
  if (sku === 'A2345') return { adapter: 'charger', features: ['Screen brightness', 'Screen timeout', 'USB-C priority', 'Charging presets', 'Knob direction', 'Holiday screensavers', 'Clock format', 'Weekly clock schedule', 'Clock styles and display switch', 'Clock image URL (experimental)'] };
  if (sku === 'A1340') return { adapter: 'prime', features: ['Display theme', 'Beeper'] };
  if (['A1770', 'A1780', 'A1781', 'A1722', 'A1723', 'A1725', 'A1726', 'A1727', 'A1728', 'A1729'].includes(sku)) {
    return { adapter: null, features: ['Screen brightness', 'Screen timeout'] };
  }
  return { adapter: null, features: [] };
}
