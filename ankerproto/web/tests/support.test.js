import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSupport, browserName, detectSupport } from '../src/support.js';
const nav = { userAgent:'Mozilla/5.0 Chrome/154.0 Safari/537.36', bluetooth:{requestDevice(){}} };
test('browser labels distinguish Chromium variants and iOS browsers', () => {
  assert.equal(browserName({userAgent:'Chrome/154 Safari/537 Edg/154'}), 'Microsoft Edge');
  assert.equal(browserName({userAgent:'Chrome/154 Safari/537 OPR/100'}), 'Opera');
  assert.equal(browserName({userAgent:'iPhone FxiOS/100 Safari/605'}), 'Firefox');
  assert.equal(browserName({userAgent:'iPhone CriOS/154 Safari/605'}), 'Google Chrome / Chromium');
});
test('capability detection rejects missing methods, insecure contexts and policy blocks', () => {
  assert.equal(assessSupport({nav,secure:false}).canConnect,false);
  assert.equal(assessSupport({nav,secure:true,policyAllowed:false}).canConnect,false);
  assert.equal(assessSupport({nav:{...nav,bluetooth:{}},secure:true}).canConnect,false);
  assert.equal(assessSupport({nav,secure:true,available:true}).state,'supported');
});
test('unavailable adapter and Brave warn without asserting hardware incompatibility', () => {
  for (const extra of [{available:false},{brave:true}]) {
    const result=assessSupport({nav,secure:true,...extra});
    assert.equal(result.state,'warning'); assert.equal(result.canConnect,true);
  }
});
test('iPad desktop user agent and Linux get targeted missing-API guidance', () => {
  assert.match(assessSupport({secure:true,nav:{platform:'MacIntel',maxTouchPoints:5}}).message,/iPad/);
  assert.match(assessSupport({secure:true,nav:{userAgent:'Linux Chrome/154'}}).message,/chrome:\/\/flags/);
});
test('probe handles unavailable adapter, policy and rejected probes without a picker', async () => {
  let pickerCalls=0;
  const n={...nav,bluetooth:{requestDevice(){pickerCalls++;},async getAvailability(){return false;}}};
  assert.equal((await detectSupport(n,{},true)).state,'warning');
  assert.equal((await detectSupport(n,{permissionsPolicy:{allowsFeature:()=>false}},true)).canConnect,false);
  n.bluetooth.getAvailability=async()=>{throw Error('blocked');};
  assert.equal((await detectSupport(n,{},true)).state,'supported');
  assert.equal(pickerCalls,0);
});
