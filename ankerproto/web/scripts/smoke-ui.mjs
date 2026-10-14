/**
 * Smoke-test the built site in a real browser: load `dist/index.html`, capture
 * any console errors or unhandled rejections, and assert the UI wired itself up.
 *
 * This catches the class of bug that unit tests cannot - a bad import path, a
 * typo in a DOM id, a module that throws at load time.
 *
 * Usage: node scripts/smoke-ui.mjs [--dir dist] [--chrome <path>] [--verbose]
 */

import { spawn } from "node:child_process";
import { rmSync, existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
].filter(Boolean);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

function serve(root) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (rel === "/" || rel === "\\" || rel === ".") rel = "/index.html";
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("404");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function waitForCdp(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`CDP never came up: ${lastErr?.message ?? "timeout"}`);
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP websocket did not open: ${wsUrl}`)), 10000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP websocket failed")); }, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const events = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Chrome did not answer ${method}: ${String(params.expression ?? params.url ?? '').slice(0, 90)}`));
        }, 15000);
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); } });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    events,
    close: () => ws.close(),
  };
}

/**
 * Drive demo mode end to end and assert every section appears with real data.
 *
 * Demo mode is the only way to review the post-connection UI without hardware,
 * and it exercises the same session code as a real device, so it is worth
 * asserting on rather than eyeballing.
 */
async function demoChecks(cdp, { expectBluetooth = true } = {}) {
  const evalJson = async (expr) => {
    const res = await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify(${expr})`,
      returnByValue: true,
      awaitPromise: true,
    });
    const raw = res?.result?.result?.value;
    return raw ? JSON.parse(raw) : null;
  };

  await cdp.send("Runtime.evaluate", {
    expression: "document.getElementById('connect-btn').click()",
  });

  const deadline = Date.now() + 20000;
  let state = null;
  while (Date.now() < deadline) {
    state = await evalJson(`({
      badge: document.getElementById('conn-badge').textContent,
      bannerHidden: document.getElementById('demo-banner').hidden,
      deviceHidden: document.getElementById('device-card').hidden,
      statusHidden: document.getElementById('status-card').hidden,
      controlsHidden: document.getElementById('controls-card').hidden,
      logHidden: document.getElementById('log-card').hidden,
      name: document.getElementById('dev-name').textContent,
      serial: document.getElementById('dev-serial').textContent,
      firmware: document.getElementById('dev-firmware').textContent,
      mac: document.getElementById('dev-mac').textContent,
      battery: document.getElementById('stat-battery').textContent,
      temp: document.getElementById('stat-temp').textContent,
      outW: document.getElementById('stat-out').textContent,
      inW: document.getElementById('stat-in').textContent,
      portRows: document.querySelectorAll('#ports-body tr').length,
      panelPorts: document.querySelectorAll('#device-panel .port-cell').length,
      heroLoaded: (() => { const i = document.querySelector('.panel-hero'); return !!i && i.complete && i.naturalWidth > 0; })(),
      heroVariant: document.querySelector('.panel-hero')?.dataset.variant ?? '',
      badgesLoaded: [...document.querySelectorAll('.port-badge')].filter((i) => i.complete && i.naturalWidth > 0).length,
      panelTitle: document.querySelector('#device-panel .nameplate-title')?.textContent ?? '',
      panelMeta: document.querySelector('#device-panel .nameplate-meta')?.textContent ?? '',
      modelNote: document.getElementById('model-note')?.textContent ?? '',
      pickerOptions: [...document.querySelectorAll('#demo-model option')].map((o) => o.value),
      pickerValue: document.getElementById('demo-model')?.value ?? '',
      pickerNote: document.getElementById('demo-model-note')?.textContent ?? '',
      logLength: document.getElementById('log').textContent.length,
      connectDisabled: document.getElementById('connect-btn').disabled,
    })`);
    if (state && state.badge === "connected" && !state.statusHidden && !state.logHidden) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const label = expectBluetooth ? "demo" : "demo without bluetooth";
  if (process.argv.includes('--verbose')) {
    console.log(`${label} connection: ${state?.badge}`);
    for (const event of cdp.events.filter(event => event.method === 'Runtime.exceptionThrown')) console.log(event.params.exceptionDetails.exception?.description);
  }
  const checks = [
    [`${label}: reaches connected state`, state?.badge === "connected", state?.badge],
    [`${label}: banner visible`, state?.bannerHidden === false],
    [`${label}: device card visible`, state?.deviceHidden === false],
    [`${label}: status card visible`, state?.statusHidden === false],
    [`${label}: settings card visible`, state?.controlsHidden === false],
    [`${label}: log card visible`, state?.logHidden === false],
    // The demo names itself after the selected registry model, so derive the
    // expectation rather than hardcoding a string that drifts.
    [`${label}: device name populated`, /^.+ \(demo\)$/.test(state?.name ?? ""), state?.name],
    [`${label}: serial populated`, state?.serial === "APC9FE0E27300275", state?.serial],
    [`${label}: firmware populated`, state?.firmware === "1.6.2", state?.firmware],
    [`${label}: bluetooth mac populated`, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(state?.mac ?? ""), state?.mac],
    [`${label}: battery has a percentage`, /^[\d.]+ %$/.test(state?.battery ?? ""), state?.battery],
    [`${label}: temperature populated`, /°C \/ \d+ °F/.test(state?.temp ?? ""), state?.temp],
    [`${label}: total output populated`, /[\d.]+ W/.test(state?.outW ?? ""), state?.outW],
    [`${label}: total input populated`, /[\d.]+ W/.test(state?.inW ?? ""), state?.inW],
    [`${label}: per-port rows rendered`, (state?.portRows ?? 0) >= 3, `rows=${state?.portRows}`],
    [`${label}: panel renders every connector`, (state?.panelPorts ?? 0) === 4, `connectors=${state?.panelPorts}`],
    [`${label}: panel nameplate shows the model`, state?.panelTitle === "Prime Power Bank", state?.panelTitle],
    [`${label}: nameplate shows sku and port count`, /A1340/.test(state?.panelMeta ?? "") && /4 ports/.test(state?.panelMeta ?? ""), state?.panelMeta],
    [`${label}: model note names the identified model`, /Prime Power Bank \(A1340\)/.test(state?.modelNote ?? ""), state?.modelNote],
    // Imagery is generated locally and gitignored, so it may legitimately be
    // absent. Assert its presence only when it was actually extracted.
    ...(existsSync(join(webRoot, "assets", "device", "a1340-hero.webp"))
      ? [
          [`${label}: render variant chosen from state`, state?.heroVariant === 'charging', `variant=${state?.heroVariant}`],
          [`${label}: real product render loaded`, state?.heroLoaded === true],
          [`${label}: real port badges loaded`, (state?.badgesLoaded ?? 0) === 4, `badges=${state?.badgesLoaded}`],
        ]
      : [[`${label}: imagery absent, panel degrades cleanly`, state?.panelPorts === 4, "run scripts/extract_assets.py"]]),
    [`${label}: model picker is populated`, (state?.pickerOptions?.length ?? 0) >= 5, `options=${state?.pickerOptions?.length}`],
    [`${label}: picker defaults to the confirmed model`, state?.pickerValue === "A1340", state?.pickerValue],
    [`${label}: picker explains layout provenance`, /confirmed from the app/.test(state?.pickerNote ?? ""), state?.pickerNote],
    [`${label}: protocol log is decoding frames`, (state?.logLength ?? 0) > 500, `chars=${state?.logLength}`],
    [`${label}: connect button disabled while connected`, state?.connectDisabled === true],
  ];
  await cdp.send("Runtime.evaluate", {expression: "window.pollTestHero = document.querySelector('.panel-hero'); document.getElementById('timeline-section').open = true; document.getElementById('debug-toggle').click()"});
  await new Promise(resolve => setTimeout(resolve, 4200));
  const live = await evalJson(`({
    enabled: document.getElementById('poll-toggle').checked,
    samples: document.getElementById('timeline-summary').textContent,
    stableHero: window.pollTestHero === document.querySelector('.panel-hero'),
    debug: document.querySelectorAll('.protocol-event').length,
    debugText: document.getElementById('protocol-summary').textContent
  })`);
  checks.push([`${label}: auto-refresh records multiple samples`, live.enabled && Number.parseInt(live.samples) >= 2, live.samples]);
  checks.push([`${label}: refresh preserves product image node`, live.stableHero]);
  checks.push([`${label}: protocol debug explains requests and replies`, live.debug > 0 && /decoded replies/.test(live.debugText)]);
  return checks;
}

async function main() {
  const verbose = process.argv.includes("--verbose");
  const root = join(webRoot, arg("--dir", "dist"));
  const chromePath = arg("--chrome") ?? CHROME_CANDIDATES.find((p) => p && existsSync(p));

  if (!existsSync(join(root, "index.html"))) {
    console.error(`${root}/index.html not found. Run: npm run build`);
    return 2;
  }
  if (!chromePath) {
    console.error("No Chrome/Chromium found. Set CHROME_PATH or pass --chrome <path>.");
    return 2;
  }

  const { server, port } = await serve(root);
  const debugPort = 9200 + Math.floor(Math.random() * 700);
  const profile = mkdtempSync(join(tmpdir(), "openankerproto-smoke-"));
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      // Linux Chrome gates Web Bluetooth behind experimental web features.
      ...(process.platform === "linux" ? ["--enable-experimental-web-platform-features"] : []),
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let exitCode = 0;
  let cdp = null;

  try {
    const version = await waitForCdp(debugPort);
    if (verbose) console.log(`using ${version.Browser}`);

    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("no page target in Chrome");

    cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html` });

    // Let modules load and the init() run.
    await new Promise((r) => setTimeout(r, 2500));

    // Collect console errors and uncaught exceptions.
    const problems = [];
    for (const ev of cdp.events) {
      if (ev.method === "Runtime.exceptionThrown") {
        problems.push(`uncaught: ${ev.params?.exceptionDetails?.exception?.description ?? "?"}`);
      }
      if (ev.method === "Runtime.consoleAPICalled" && ev.params?.type === "error") {
        problems.push(
          `console.error: ${(ev.params.args ?? []).map((a) => a.value ?? a.description).join(" ")}`,
        );
      }
      if (ev.method === "Log.entryAdded" && ev.params?.entry?.level === "error") {
        problems.push(`log: ${ev.params.entry.text}`);
      }
    }

    // Assert the UI actually initialised.
    const probe = await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify({
        title: document.title,
        connectBtn: !!document.getElementById('connect-btn'),
        connectEnabled: !document.getElementById('connect-btn').disabled,
        unsupportedHidden: document.getElementById('unsupported').hidden,
        badge: document.getElementById('conn-badge').textContent,
        status: document.getElementById('connect-status').textContent,
        deviceCardHidden: document.getElementById('device-card').hidden,
        statusCardHidden: document.getElementById('status-card').hidden,
        btApis: typeof navigator.bluetooth === 'object',
        modulesLoaded: !!document.querySelector('script[type=module]'),
      })`,
      returnByValue: true,
    });
    const ui = JSON.parse(probe.result.result.value);

    const checks = [
      ["page title set", ui.title.includes("openankerproto")],
      ["connect button present", ui.connectBtn === true],
      ["connect button enabled (Bluetooth available)", ui.connectEnabled === true],
      ["unsupported notice hidden in Chrome", ui.unsupportedHidden === true],
      ["connection badge initialised", ui.badge === "disconnected"],
      ["device card hidden before connect", ui.deviceCardHidden === true],
      ["status card hidden before connect", ui.statusCardHidden === true],
      ["Web Bluetooth present", ui.btApis === true],
      ["no console errors or uncaught exceptions", problems.length === 0, problems.join("\n       ")],
    ];

    // Opening index.html straight from disk must explain itself rather than
    // rendering a page whose buttons are silently dead (ES modules are blocked
    // by CORS over file://). This is the single most likely way a user gets a
    // "nothing happens when I click" experience.
    const fileTarget = await fetch(
      `http://127.0.0.1:${debugPort}/json/new?` +
        encodeURIComponent(`file://${root}/index.html`),
      { method: "PUT" },
    );
    if (fileTarget.ok) {
      const ft = await fileTarget.json();
      const cdpF = await connectCdp(ft.webSocketDebuggerUrl);
      await cdpF.send("Runtime.enable");
      // The probe waits 2.5s before concluding the app never booted.
      await new Promise((r) => setTimeout(r, 4000));
      const res = await cdpF.send("Runtime.evaluate", {
        expression:
          "JSON.stringify({shown: !document.getElementById('load-error').hidden, " +
          "title: document.getElementById('load-error-title').textContent})",
        returnByValue: true,
      });
      const info = JSON.parse(res.result.result.value);
      checks.push([
        "file:// shows a serve-this-page explanation",
        info.shown === true,
        `shown=${info.shown} title="${info.title}"`,
      ]);
      cdpF.close();
    }

    // Now do the same in demo mode, in a fresh tab.
    // Verify checkbox-to-transport wiring without relying on nearby hardware.
    const pickerProbe = await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const requests = [];
        const original = navigator.bluetooth.requestDevice;
        navigator.bluetooth.requestDevice = async options => {
          requests.push(options);
          throw new DOMException('Test picker cancelled', 'NotFoundError');
        };
        try {
          for (const broad of [false, true]) {
            document.getElementById('scan-all').checked = broad;
            document.getElementById('connect-btn').click();
            await new Promise(r => setTimeout(r, 100));
          }
          return JSON.stringify({
            filtered: requests[0]?.filters?.length > 0 && !requests[0]?.acceptAllDevices,
            broad: requests[1]?.acceptAllDevices === true && !('filters' in requests[1]),
            logged: document.getElementById('log').textContent.includes('Unfiltered BLE picker'),
          });
        } finally { navigator.bluetooth.requestDevice = original; }
      })()`, awaitPromise: true, returnByValue: true,
    });
    const picker = JSON.parse(pickerProbe.result.result.value);
    checks.push(
      ['picker: normal mode sends Anker filters', picker.filtered],
      ['picker: show all removes every device filter', picker.broad],
      ['picker: selected scan mode appears in diagnostics', picker.logged],
    );

    const demoRes = await fetch(
      `http://127.0.0.1:${debugPort}/json/new?` +
        encodeURIComponent(`http://127.0.0.1:${port}/index.html?demo=1`),
      { method: "PUT" },
    );
    if (demoRes.ok) {
      const demoTarget = await demoRes.json();
      const demoCdp = await connectCdp(demoTarget.webSocketDebuggerUrl);
      await demoCdp.send("Runtime.enable");
      await new Promise((r) => setTimeout(r, 1000));
      checks.push(...(await demoChecks(demoCdp)));

      const timelineProbe = await demoCdp.send("Runtime.evaluate", {
        expression: `(async () => {
          const section = document.getElementById('timeline-section');
          section.open = true;
          await new Promise(r => setTimeout(r, 100));
          const svg = !!document.querySelector('#timeline-chart svg');
          const powerSeries = document.getElementById('timeline-legend').textContent;
          document.getElementById('refresh-btn').click();
          await new Promise(r => setTimeout(r, 400));
          const samples = document.querySelectorAll('#timeline-chart circle').length;
          const metric = document.getElementById('timeline-metric');
          metric.value = 'ports'; metric.dispatchEvent(new Event('change'));
          const ports = document.getElementById('timeline-legend').textContent;
          metric.value = 'temperature'; metric.dispatchEvent(new Event('change'));
          const temperature = document.querySelector('#timeline-chart svg')?.getAttribute('aria-label');
          document.getElementById('timeline-clear').click();
          const cleared = document.getElementById('timeline-chart').textContent.includes('Waiting for readings');
          return JSON.stringify({ svg, powerSeries, samples, ports, temperature, cleared });
        })()`,
        awaitPromise: true, returnByValue: true,
      });
      const timeline = JSON.parse(timelineProbe.result.result.value);
      checks.push(
        ['timeline: opens a power chart', timeline.svg && /Output/.test(timeline.powerSeries) && /Input/.test(timeline.powerSeries)],
        ['timeline: refresh adds points', timeline.samples >= 4],
        ['timeline: per-port view shows connector series', /C1/.test(timeline.ports) && /C2/.test(timeline.ports)],
        ['timeline: temperature has the correct unit', /°C/.test(timeline.temperature)],
        ['timeline: clearing returns to an empty state', timeline.cleared],
      );

      // Switching model must re-resolve the panel, not just relabel it.
      await demoCdp.send("Runtime.evaluate", {
        expression: `(() => {
          const s = document.getElementById('demo-model');
          s.value = 'A2345';
          s.dispatchEvent(new Event('change'));
        })()`,
      });
      const switchDeadline = Date.now() + 20000;
      let swapped = null;
      while (Date.now() < switchDeadline) {
        const res = await demoCdp.send("Runtime.evaluate", {
          expression: `JSON.stringify({
            title: document.querySelector('#device-panel .nameplate-title')?.textContent ?? '',
            meta: document.querySelector('#device-panel .nameplate-meta')?.textContent ?? '',
            ports: [...document.querySelectorAll('#device-panel .port-name')].map(e => e.textContent).join(','),
            note: document.getElementById('demo-model-note')?.textContent ?? '',
            url: location.href,
          })`,
          returnByValue: true,
        });
        swapped = JSON.parse(res.result.result.value);
        if (swapped.title === "250W Prime Charger") break;
        await new Promise((r) => setTimeout(r, 250));
      }
      checks.push([
        "demo: switching model re-resolves the panel",
        swapped?.title === "250W Prime Charger",
        swapped?.title,
      ]);
      checks.push([
        "demo: switched model shows its own ports",
        swapped?.ports === "C1,C2,C3,C4,A,A2",
        swapped?.ports,
      ]);
      checks.push([
        "demo: switched model is reflected in the URL for sharing",
        /model=A2345/.test(swapped?.url ?? ""),
        swapped?.url,
      ]);
      checks.push([
        "demo: picker reports the layout provenance after switching",
        /confirmed from the app|synthesised/.test(swapped?.note ?? ""),
        swapped?.note,
      ]);
      const controlsProbe = await demoCdp.send('Runtime.evaluate', {
        expression: `(async () => {
          const visible = !document.getElementById('charger-controls').hidden;
          const genericHidden = document.getElementById('generic-controls').hidden;
          document.querySelector('[data-charger-setting="priority"]').click();
          await new Promise(resolve => setTimeout(resolve, 800));
          const device = document.getElementById('device-card').getBoundingClientRect();
          const settings = document.getElementById('controls-card').getBoundingClientRect();
          const columns = getComputedStyle(document.getElementById('charger-controls')).gridTemplateColumns.split(' ').length;
          return JSON.stringify({visible, genericHidden, result: document.getElementById('charger-setting-result').textContent, under: settings.top >= device.bottom, width: Math.abs(settings.width - device.width) < 2, columns, current: [...document.querySelectorAll('.current-setting')].map(e => e.textContent).join(' '), presets: document.getElementById('charger-chargingMode').options.length});
        })()`, awaitPromise: true, returnByValue: true,
      });
      const chargerControls = JSON.parse(controlsProbe.result.result.value);
      checks.push(['demo: A2345 shows its own settings and hides beeper/theme', chargerControls.visible && chargerControls.genericHidden]);
      checks.push(['demo: priority control simulates an acknowledged command', /simulated successfully/.test(chargerControls.result), chargerControls.result]);
      checks.push(['settings: full width under device details with horizontal controls', chargerControls.under && chargerControls.width && chargerControls.columns > 1]);
      checks.push(['settings: charger current values and four presets shown', /Device: 100%/.test(chargerControls.current) && chargerControls.presets === 4]);
      const timeProbe = await demoCdp.send('Runtime.evaluate', {
        expression: `(async () => {
          document.getElementById('sync-clock').click();
          for(let i=0;i<100 && document.getElementById('sync-clock').disabled;i++) await new Promise(r=>setTimeout(r,50));
          return JSON.stringify({result:document.getElementById('clock-sync-result').textContent,zone:document.getElementById('clock-local-time').textContent});
        })()`, awaitPromise:true, returnByValue:true,
      });
      const syncedTime = JSON.parse(timeProbe.result.result.value);
      checks.push(['clock: reconnect sync works in demo', /simulated/.test(syncedTime.result), syncedTime.result]);
      checks.push(['clock: computer timezone is visible', /Computer:/.test(syncedTime.zone)]);
      const clockProbe = await demoCdp.send('Runtime.evaluate', {
        expression: `(async () => {
          document.querySelector('[data-clock-days="124"]').click();
          const days = [...document.querySelectorAll('[data-clock-day]:checked')].map(e => e.dataset.clockDay);
          document.querySelector('[data-charger-setting="clockSchedule"]').click();
          await new Promise(r => setTimeout(r, 800));
          const schedule = document.getElementById('charger-setting-result').textContent;
          document.getElementById('clock-style').value = '2';
          document.getElementById('clock-style').dispatchEvent(new Event('change'));
          document.getElementById('apply-clock-theme').click();
          await new Promise(r => setTimeout(r, 800));
          return JSON.stringify({days, schedule, result: document.getElementById('clock-theme-result').textContent, current: document.getElementById('clock-current').textContent});
        })()`, awaitPromise: true, returnByValue: true,
      });
      const clock = JSON.parse(clockProbe.result.result.value);
      checks.push(['clock: weekdays preset selects Monday through Friday', clock.days.join(',') === '64,32,16,8,4']);
      checks.push(['clock: weekly schedule works in demo', /simulated successfully/.test(clock.schedule), clock.schedule]);
      checks.push(['clock: style application and readback work in demo', /simulated/.test(clock.result) && /built-in style 3/.test(clock.current), clock.current]);
      const photoProbe = await demoCdp.send('Runtime.evaluate', {
        expression: `(async () => {
          document.getElementById('clock-style').value = '3';
          document.getElementById('clock-style').dispatchEvent(new Event('change'));
          const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 200;
          canvas.getContext('2d').fillRect(0, 0, 100, 200);
          const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
          const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'test.png', {type:'image/png'}));
          const file = document.getElementById('photo-file'); file.files = transfer.files; file.dispatchEvent(new Event('change'));
          for (let i=0;i<50 && document.getElementById('photo-share').disabled;i++) await new Promise(r => setTimeout(r, 50));
          const ready = !document.getElementById('photo-share').disabled;
          document.getElementById('photo-share').click();
          await new Promise(r => setTimeout(r, 100));
          return JSON.stringify({ready, width: document.getElementById('photo-preview').width, crc: document.getElementById('clock-image-crc').value, url: document.getElementById('clock-image-url').value, message: document.getElementById('photo-result').textContent, note: document.querySelector('.clock-theme-control').textContent});
        })()`, awaitPromise: true, returnByValue: true,
      });
      const photo = JSON.parse(photoProbe.result.result.value);
      checks.push(['photo: image selection prepares a crop and checksum', photo.ready && photo.width === 420 && /^[0-9a-f]{8}$/.test(photo.crc), photo.message]);
      checks.push(['photo: demo prepares URL without network delivery', photo.url.includes('192.0.2.1') && /Demo photo prepared/.test(photo.message), photo.message]);
      checks.push(['clock: explains rest and Always on requirement', /when the screen rests/.test(photo.note) && /Always on/.test(photo.note)]);
      await demoCdp.send("Runtime.evaluate", {
        expression: "document.getElementById('disconnect-btn').click()",
      });
      await new Promise(r => setTimeout(r, 100));
      const homeLabel = await demoCdp.send("Runtime.evaluate", {
        expression: "document.getElementById('demo-btn').textContent", returnByValue: true,
      });
      checks.push(['demo: home action stays available after disconnect', homeLabel.result.result.value === 'Back to home']);
      await demoCdp.send("Runtime.evaluate", {
        expression: "document.getElementById('demo-btn').click()",
      });
      await new Promise(r => setTimeout(r, 1000));
      const homeProbe = await demoCdp.send("Runtime.evaluate", {
        expression: `JSON.stringify({
          normalUrl: !new URL(location.href).searchParams.has('demo') && !new URL(location.href).searchParams.has('model'),
          demoHidden: document.getElementById('demo-banner').hidden,
          statusHidden: document.getElementById('status-card').hidden,
          logHidden: document.getElementById('log-card').hidden,
          label: document.getElementById('demo-btn').textContent,
          connect: document.getElementById('connect-btn').textContent,
        })`, returnByValue: true,
      });
      const home = JSON.parse(homeProbe.result.result.value);
      checks.push(['demo: back to home resets URL and simulated panels', home.normalUrl && home.demoHidden && home.statusHidden && home.logHidden]);
      checks.push(['demo: normal connection controls restored', home.label === 'Try demo' && home.connect === 'Connect to a device']);
      demoCdp.close();
    } else {
      checks.push(["demo: could not open a demo tab", false, `HTTP ${demoRes.status}`]);
    }

    // Demo mode must also work where Web Bluetooth does not exist at all, since
    // that is exactly where it is most useful (Safari, Firefox, iPad).
    const noBtTarget = await fetch(
      `http://127.0.0.1:${debugPort}/json/new?` + encodeURIComponent("about:blank"),
      { method: "PUT" },
    );
    if (noBtTarget.ok) {
      const t2 = await noBtTarget.json();
      const cdp2 = await connectCdp(t2.webSocketDebuggerUrl);
      await cdp2.send("Runtime.enable");
      await cdp2.send("Page.enable");
      // Remove navigator.bluetooth before any module runs, emulating Safari.
      await cdp2.send("Page.addScriptToEvaluateOnNewDocument", {
        source:
          "Object.defineProperty(navigator,'bluetooth',{get(){return undefined},configurable:true});",
      });
      await cdp2.send("Page.navigate", {
        url: `http://127.0.0.1:${port}/index.html?demo=1`,
      });
      await new Promise((r) => setTimeout(r, 1500));
      checks.push(...(await demoChecks(cdp2, { expectBluetooth: false })));
      cdp2.close();
    }

    for (const [name, pass, detail] of checks) {
      const extra = detail && (!pass || verbose) ? `\n       ${detail}` : "";
      console.log(`${pass ? "ok  " : "FAIL"}  ${name}${extra}`);
    }
    const failed = checks.filter(([, pass]) => !pass).length;
    console.log(`\n${checks.length - failed}/${checks.length} UI checks passed`);
    if (failed) exitCode = 1;
  } catch (err) {
    console.error(`ui smoke test failed: ${err?.name}: ${err?.message}`);
    if (verbose) console.error(err?.stack);
    exitCode = 1;
  } finally {
    try {
      cdp?.close();
    } catch {
      /* ignore */
    }
    if (chrome.exitCode === null && chrome.signalCode === null) {
      await new Promise(resolve => {
        const timeout = setTimeout(resolve, 3000);
        chrome.once("exit", () => { clearTimeout(timeout); resolve(); });
        chrome.kill("SIGTERM");
      });
      if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
    }
    server.close();
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      // A transient profile cleanup race must not replace the test result.
      if (error.code !== "ENOTEMPTY" && error.code !== "EBUSY") throw error;
      console.warn(`Temporary Chrome profile cleanup deferred: ${error.code}`);
    }
  }

  return exitCode;
}

const HARD_TIMEOUT = setTimeout(() => {
  console.error("smoke test hard-timeout after 120s");
  process.exit(1);
}, 120000);
HARD_TIMEOUT.unref();

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
