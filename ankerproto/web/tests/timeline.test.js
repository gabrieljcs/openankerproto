import test from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryHistory, sessionStatistics } from '../src/timeline.js';

test('history keeps unavailable measurements distinct from zero and captures port getter values', () => {
  const history = new TelemetryHistory();
  history.record({ totalOutputW: 0, totalInputW: null, temperatureC: NaN, ports: { C1: { name: 'C1', get power() { return 42; } } } }, 1000);
  assert.deepEqual(history.samples[0], { time: 1000, output: 0, input: null, battery: null, temperature: null, ports: { C1: 42 }, voltages: { C1: null }, currents: { C1: null } });
});
test('history evicts oldest readings and supports a time window and reset', () => {
  const history = new TelemetryHistory(2);
  for (const time of [1000, 2000, 3000]) history.record({ ports: {} }, time);
  assert.deepEqual(history.samples.map(sample => sample.time), [2000, 3000]);
  assert.deepEqual(history.window(500, 3200).map(sample => sample.time), [3000]);
  assert.equal(history.window(0, 3200).length, 2);
  history.clear();
  assert.equal(history.samples.length, 0);
});

test('session statistics integrate sampled energy and exclude long gaps', () => {
  const samples = [{time: 0, output: 10}, {time: 3600, output: 30}, {time: 100000, output: 0}];
  const stats = sessionStatistics(samples);
  assert.equal(stats.peakW, 30);
  assert.equal(stats.averageW, 40 / 3);
  assert.equal(stats.energyWh, .02);
  assert.deepEqual(sessionStatistics([]), {peakW: null, averageW: null, energyWh: null});
});
