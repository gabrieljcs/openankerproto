/** Session-local telemetry history. Missing readings stay missing. */
export class TelemetryHistory {
  constructor(limit = 1200) {
    this.limit = limit;
    this.samples = [];
  }
  record(status, time = Date.now()) {
    const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
    const ports = Object.fromEntries(Object.values(status.ports ?? {}).map(port => [port.name, finite(port.power)]));
    this.samples.push({ time, output: finite(status.totalOutputW), input: finite(status.totalInputW),
      battery: finite(status.batteryPercent), temperature: finite(status.temperatureC), ports,
      voltages: Object.fromEntries(Object.values(status.ports ?? {}).map(port => [port.name, finite(port.voltage)])),
      currents: Object.fromEntries(Object.values(status.ports ?? {}).map(port => [port.name, finite(port.current)])) });
    if (this.samples.length > this.limit) this.samples.splice(0, this.samples.length - this.limit);
  }
  clear() { this.samples = []; }
  window(duration, now = Date.now()) {
    return this.samples.filter(sample => !duration || sample.time >= now - duration);
  }
}

/** Integrate only adjacent readings without gaps; this is sampled energy, not a meter. */
export function sessionStatistics(samples) {
  const output = samples.map(s => s.output).filter(v => v != null);
  let energyWh = 0, observedMs = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i], dt = b.time - a.time;
    if (dt <= 0 || dt > 10000 || a.output == null || b.output == null) continue;
    energyWh += (a.output + b.output) / 2 * dt / 3600000;
    observedMs += dt;
  }
  return { peakW: output.length ? Math.max(...output) : null,
    averageW: output.length ? output.reduce((a, b) => a + b, 0) / output.length : null,
    energyWh: observedMs ? energyWh : null };
}

const SVG = 'http://www.w3.org/2000/svg';
const colors = ['#335e43', '#508bb6', '#967036', '#8064a3', '#af5f6d', '#4b8a7a'];
function node(tag, attributes = {}, text) {
  const element = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (text != null) element.textContent = text;
  return element;
}

/** Render an SVG timeline without dependencies or network requests. */
export function renderTimeline(container, legend, summary, samples, metric) {
  container.replaceChildren();
  legend.replaceChildren();
  const definitions = ['ports', 'voltages', 'currents'].includes(metric)
    ? [...new Set(samples.flatMap(sample => Object.keys(sample[metric] ?? {})))].map(name => ({ name, value: sample => sample[metric]?.[name] ?? null }))
    : metric === 'power'
      ? [{ name: 'Output', value: sample => sample.output }, { name: 'Input', value: sample => sample.input }]
      : [{ name: metric === 'battery' ? 'Battery' : 'Temperature', value: sample => sample[metric] }];
  const unit = metric === 'voltages' ? 'V' : metric === 'currents' ? 'A' : metric === 'battery' ? '%' : metric === 'temperature' ? '°C' : 'W';
  const values = samples.flatMap(sample => definitions.map(series => series.value(sample))).filter(value => value != null);
  if (!values.length) {
    const message = document.createElement('p');
    message.className = 'timeline-empty muted';
    message.textContent = samples.length ? 'Your device has not reported this measurement. Try a different view.' : 'Waiting for readings. Refresh now or enable auto-refresh to build a timeline.';
    container.append(message);
    summary.textContent = `${samples.length} readings · History stays in this browser tab.`;
    return;
  }
  const width = 800, height = 240, left = 55, right = 18, top = 20, bottom = 35;
  const peak = Math.max(...values);
  const min = Math.min(0, ...values), max = Math.max(1, peak) * 1.18;
  const start = samples[0].time, end = Math.max(start + 1000, samples.at(-1).time);
  const x = time => left + (time - start) / (end - start) * (width - left - right);
  const y = value => top + (max - value) / (max - min) * (height - top - bottom);
  const svg = node('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${metric} timeline in ${unit}, ${samples.length} readings` });
  for (let i = 0; i <= 4; i++) {
    const value = min + (max - min) * i / 4, position = y(value);
    svg.append(node('line', { x1: left, x2: width - right, y1: position, y2: position, class: 'timeline-grid' }));
    svg.append(node('text', { x: left - 9, y: position + 4, 'text-anchor': 'end', class: 'timeline-axis' }, `${value.toFixed(metric === 'currents' ? 2 : metric === 'voltages' ? 1 : 0)} ${unit}`));
  }
  const formatTime = time => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  svg.append(node('text', { x: left, y: height - 8, class: 'timeline-axis' }, formatTime(start)));
  if (samples.length > 1) svg.append(node('text', { x: width - right, y: height - 8, 'text-anchor': 'end', class: 'timeline-axis' }, formatTime(samples.at(-1).time)));
  const peakLine = node('line', { x1: left, x2: width - right, y1: y(peak), y2: y(peak), class: 'timeline-peak' });
  svg.append(peakLine);
  svg.append(node('text', { x: width - right, y: y(peak) - 7, 'text-anchor': 'end', class: 'timeline-peak-label' }, `Peak ${peak.toFixed(metric === 'currents' ? 3 : 2)} ${unit}`));
  definitions.forEach((series, index) => {
    const color = colors[index % colors.length];
    let path = '', previous = null, hasData = false;
    for (const sample of samples) {
      const value = series.value(sample);
      if (value == null) { previous = null; continue; }
      hasData = true;
      // Avoid joining readings across long pauses or failed refreshes.
      const connected = previous != null && sample.time - previous <= 10000;
      path += `${connected ? 'L' : 'M'}${x(sample.time).toFixed(2)},${y(value).toFixed(2)} `;
      previous = sample.time;
      const point = node('circle', { cx: x(sample.time), cy: y(value), r: samples.length < 40 ? 3 : 2, fill: color });
      point.append(node('title', {}, `${formatTime(sample.time)} · ${series.name}: ${value.toFixed(metric === 'currents' ? 3 : metric === 'voltages' ? 2 : 1)} ${unit}`));
      svg.append(point);
    }
    if (!hasData) return;
    svg.append(node('path', { d: path, fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }));
    const item = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.style.background = color;
    item.append(swatch, document.createTextNode(`${series.name} · max ${Math.max(...samples.map(series.value).filter(v => v != null)).toFixed(metric === 'currents' ? 3 : 1)} ${unit}`));
    legend.append(item);
  });
  container.append(svg);
  summary.textContent = `${samples.length} readings · ${formatTime(start)}–${formatTime(samples.at(-1).time)} · Hover over a point for its value. History stays in this tab.`;
}
