import { renderChargerSettings, wireChargerControls } from './charger-controls.js';
import { ProtocolDebug } from "./protocol-debug.js";
import { PollLoop } from "./polling.js";
import { modelControls } from './capabilities.js';
import { CHARGER_TAGS } from './charger-settings.js';
/**
 * UI logic for the Anker BLE web client.
 *
 * Deliberately framework-free and build-step-free so the page can be served
 * straight from GitHub Pages. All protocol work happens in `src/` modules that
 * are unit-tested independently of the DOM.
 */

import { TelemetryHistory, renderTimeline, sessionStatistics } from "./timeline.js";
import { AnkerSession } from "./session.js";
import { BluetoothTransport, bluetoothAvailable, bluetoothUnavailableReason } from "./bluetooth.js";
import { RESPONSE_TAGS, OPCODE_NAMES } from "./opcodes.js";
import { toHex } from "./framing.js";
import { decodeTlv, stripStatus } from "./tlv.js";
import { MODELS, modelBySku, modelFromName } from "./models.js";
import { renderDevicePanel } from "./schematic.js";

const $ = (id) => document.getElementById(id);

const el = {
  unsupported: $("unsupported"),
  unsupportedReason: $("unsupported-reason"),
  connectCard: $("connect-card"),
  connectBtn: $("connect-btn"),
  disconnectBtn: $("disconnect-btn"),
  connBadge: $("conn-badge"),
  connectStatus: $("connect-status"),
  deviceCard: $("device-card"),
  deviceFamily: $("device-family"),
  devName: $("dev-name"),
  devSerial: $("dev-serial"),
  devFirmware: $("dev-firmware"),
  devMac: $("dev-mac"),
  statusCard: $("status-card"),
  statBattery: $("stat-battery"),
  statTemp: $("stat-temp"),
  statOut: $("stat-out"),
  statIn: $("stat-in"),
  portsBody: $("ports-body"),
  portRowTemplate: $("port-row"),
  refreshBtn: $("refresh-btn"),
  pollToggle: $("poll-toggle"),
  lastUpdated: $("last-updated"),
  controlsCard: $("controls-card"),
  logCard: $("log-card"),
  log: $("log"),
  logClear: $("log-clear"),
  logDownload: $("log-download"),
  repoLink: $("repo-link"),
  panel: $("device-panel"),
  modelNote: $("model-note"),
  demoBanner: $("demo-banner"),
  demoModel: $("demo-model"),
  demoModelNote: $("demo-model-note"),
  demoBtn: $("demo-btn"),
  demoExit: $("demo-exit"),
};

/** @type {BluetoothTransport|null} */
let transport = null;
/** @type {AnkerSession|null} */
let session = null;
let busy = false;
let refreshing = false;
/** Name + UUID family of the active connection, from connect() or the demo. */
let connectionInfo = null;
/** Registry entry for the connected model, when we can identify it. */
let activeModel = null;

const MAX_LOG_LINES = 500;
const protocolDebug = new ProtocolDebug();
function updateProtocolDebug() {
  if ($("debug-toggle").checked) protocolDebug.render($("protocol-events"), $("protocol-summary"));
}
const telemetryHistory = new TelemetryHistory();
function updateTimeline() {
  if (!$("timeline-section").open) return;
  const stats = sessionStatistics(telemetryHistory.samples);
  $("session-statistics").textContent = `Session peak ${stats.peakW == null ? '—' : stats.peakW.toFixed(1) + ' W'} · Average ${stats.averageW == null ? '—' : stats.averageW.toFixed(1) + ' W'} · Estimated energy ${stats.energyWh == null ? '—' : stats.energyWh.toFixed(3) + ' Wh'}`;
  renderTimeline($("timeline-chart"), $("timeline-legend"), $("timeline-summary"),
    telemetryHistory.window(Number($("timeline-window").value)), $("timeline-metric").value);
}

/**
 * Demo mode is requested by `?demo=1`, or the `#demo` fragment.
 * Read fresh each time so the toggle takes effect without a reload.
 */
function demoMode() {
  const params = new URLSearchParams(location.search);
  const flag = params.get("demo");
  return flag === "1" || flag === "true" || location.hash === "#demo";
}

/** Leave demo mode even while a simulated connection is in progress. */
function exitDemo() {
  // A fresh normal-mode page also cancels an in-flight demo handshake and
  // clears simulated telemetry, settings, and diagnostics.
  const url = new URL(location.href);
  url.searchParams.delete("demo");
  url.searchParams.delete("model");
  if (url.hash === "#demo") url.hash = "";
  location.assign(url.href);
}

/** SKU selected for demo mode, from `?model=` or the default. */
function selectedDemoSku() {
  const params = new URLSearchParams(location.search);
  return params.get("model");
}

/**
 * Fill the demo model picker.
 *
 * The list comes from the generated registry, so it is the real set of products
 * the binary knows about - not a hand-written menu that can drift.
 */
async function populateDemoModels() {
  if (!el.demoModel) return;
  const { demoModels, DEFAULT_DEMO_SKU } = await import("./demo.js");
  const models = demoModels();

  el.demoModel.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.sku;
    opt.textContent = `${m.name} — ${m.sku}`;
    el.demoModel.appendChild(opt);
  }

  const wanted = selectedDemoSku();
  const initial = models.some((m) => m.sku === wanted) ? wanted : DEFAULT_DEMO_SKU;
  el.demoModel.value = initial;

  const describeSelection = () => {
    const m = models.find((x) => x.sku === el.demoModel.value);
    if (!m || !el.demoModelNote) return;
    el.demoModelNote.textContent = m.portLayoutConfirmed
      ? `${m.demoPorts.length} ports (layout confirmed from the app)`
      : `${m.demoPorts.length} ports (layout synthesised for the demo)`;
  };
  describeSelection();

  el.demoModel.addEventListener("change", async () => {
    const url = new URL(location.href);
    url.searchParams.set("model", el.demoModel.value);
    history.replaceState(null, "", url);
    describeSelection();
    // Reconnect so the panel reflects the newly chosen hardware.
    if (transport) {
      await disconnect();
      await connect();
    }
  });
}

function showDemoBanner(visible) {
  if (!el.demoBanner) return;
  el.demoBanner.hidden = !visible;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function setBadge(text, state) {
  el.connBadge.textContent = text;
  if (state) el.connBadge.dataset.state = state;
  else delete el.connBadge.dataset.state;
}

function setConnectStatus(text, state) {
  if (!session) $("retry-status").hidden = true;
  el.connectStatus.textContent = text;
  if (state) el.connectStatus.dataset.state = state;
  else delete el.connectStatus.dataset.state;
}

let logLines = [];
let logRenderPending = false;
function logLine(text, cls = "") {
  logLines.push(cls ? `[${cls}] ${text}` : text);
  if (logLines.length > MAX_LOG_LINES) logLines = logLines.slice(-MAX_LOG_LINES);
  if (logRenderPending) return;
  logRenderPending = true;
  setTimeout(() => {
    logRenderPending = false;
    const follow = el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 80;
    el.log.textContent = logLines.join("\n");
    if (follow) el.log.scrollTop = el.log.scrollHeight;
  }, 16);
}

function clearLog() {
  logLines = [];
  protocolDebug.clear();
  updateProtocolDebug();
  el.log.textContent = "";
}

function describeFrame(dir, frame) {
  const arrow = dir === "tx" ? "-->" : "<--";
  const who = frame.response ? "response" : "request";
  const flags = [frame.encrypted ? "encrypted" : "plaintext", who].join(", ");
  const name = OPCODE_NAMES[frame.command] ?? "unknown";
  return `${arrow} ${frame.commandHex} ${name} [group 0x${(frame.group ?? 0).toString(16).padStart(2, "0")}, ${flags}]`;
}

/**
 * Render one frame into the log.
 *
 * Raw hex is shown for encrypted payloads (it is genuinely opaque) and for the
 * handshake, where seeing the exact bytes matters. Decrypted and plaintext
 * payloads are TLV-decoded instead, because a wall of hex is unreadable and the
 * `decode` tool exists for exactly this reason.
 */
function onProtocolLog(dir, frame, raw) {
  protocolDebug.record(dir, frame, raw);
  updateProtocolDebug();
  if (dir === "rx-error") {
    logLine(`    dropped malformed frame: ${frame.error}`, "warn");
    return;
  }

  const arrow = dir === "tx" ? "--> " : "<-- ";
  const who = frame.response ? "response" : "request";
  const flags = `${frame.encrypted ? "encrypted" : "plaintext"}, ${who}`;
  const name = OPCODE_NAMES[frame.command] ?? "unknown";
  const group = `0x${(frame.group ?? 0).toString(16).padStart(2, "0")}`;

  logLine(`${arrow}${frame.commandHex}  ${name}  [group ${group}, ${flags}]`);
  logLine(`      ${toHex(raw)}`);

  const payload = frame.payload;
  if (!payload || !payload.length) return;

  if (frame.encrypted) {
    logLine(`      payload (encrypted, ${payload.length}B): ${toHex(payload)}`);
    return;
  }

  // Plaintext: decode the TLVs so the log is legible.
  const body = stripStatus(payload);
  let tags;
  try {
    tags = decodeTlv(body, { strict: false });
  } catch {
    logLine(`      payload: ${toHex(payload)}`);
    return;
  }
  if (!tags.length) {
    logLine(`      payload: ${toHex(payload)}`);
    return;
  }

  if (body !== payload) logLine("      status 0x00 (OK)");
  for (const tag of tags) {
    const tagHex = `0x${tag.tag.toString(16).padStart(2, "0").toUpperCase()}`;
    const description = frame.group === 15 && frame.command === 0x0200 ? CHARGER_TAGS[tag.tag] : RESPONSE_TAGS[tag.tag];
    const meaning = description ? `  ${description}` : "";
    const ascii = tag.asAscii();
    const printable = ascii && /^[\x20-\x7e]+$/.test(ascii) ? `  "${ascii}"` : "";
    logLine(`      TLV ${tagHex} len=${String(tag.length).padEnd(3)} ${tag.asHex()}${printable}${meaning}`);
  }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function renderDevice(info, familyName, deviceName) {
  el.deviceCard.hidden = false;
  el.devName.textContent = deviceName || connectionInfo?.name || "(unnamed)";
  el.deviceFamily.textContent = familyName ?? "";
  el.devSerial.textContent = info.serialNumber ?? "—";
  el.devFirmware.textContent = info.firmwareVersion ?? "—";
  if (info.sku === 'A2345') $('clock-sync-result').textContent = 'Time and time zone sent during connection. Check the hour on the resting screen.';
  el.devMac.textContent = info.btMac ?? "—";
}

/**
 * Explain, briefly, how confident the panel is about this model.
 *
 * Worth surfacing: the port list always comes from the device, but *which*
 * model it is may be a guess, and saying so is better than implying certainty.
 */
function renderModelNote(ports) {
  if (!el.modelNote) return;
  const lines = [];
  if (activeModel) {
    lines.push(`Identified as ${activeModel.name} (${activeModel.sku}).`);
    if (activeModel.portLayoutConfirmed) {
      lines.push("Port layout confirmed against the app's per-model artwork.");
    }
  } else {
    lines.push(
      "Model not identified yet. Ports shown are exactly what the device reported.",
    );
  }
  if (ports.length) {
    lines.push(`Device reports ${ports.length} active connector${ports.length === 1 ? "" : "s"}.`);
  }
  el.modelNote.textContent = lines.join(" ");
}

function resolveModel(deviceInfo, deviceName) {
  // Prefer an explicit SKU from the device, then the advertised name.
  return modelBySku(deviceInfo?.sku) ?? modelFromName(deviceName) ?? null;
}

function renderStatus(status) {
  telemetryHistory.record(status);
  updateTimeline();
  el.statusCard.hidden = false;
  el.controlsCard.hidden = false;
  const controls = modelControls(activeModel?.sku);
  const chargerControls = controls.adapter === 'charger' && (transport?.isDemo || connectionInfo?.family.name === "alt-8c85");
  $("charger-controls").hidden = !chargerControls;
  $("generic-controls").hidden = controls.adapter !== 'prime';
  if (chargerControls) renderChargerSettings(status.settings ?? {});
  $("preview-charger-controls").hidden = !transport?.isDemo || activeModel?.sku === 'A2345';
  $("settings-model-note").textContent = `${activeModel?.sku ?? 'Unknown model'}${transport?.isDemo ? ' · simulated controls' : ''}: ` +
    (chargerControls || controls.adapter === 'prime' ? 'Only controls recovered for this model are shown.' : controls.features.length ? `The app has ${controls.features.join(', ').toLowerCase()}. This website does not yet implement their model-specific commands.` : 'No setting commands have been verified for this model.');
  el.logCard.hidden = false;

  el.statBattery.textContent =
    status.batteryPercent == null ? "—" : `${status.batteryPercent.toFixed(2)} %`;
  el.statTemp.textContent =
    status.temperatureC == null ? "—" : `${status.temperatureC} °C / ${status.temperatureF} °F`;
  el.statOut.textContent = status.totalOutputW == null ? "—" : `${status.totalOutputW.toFixed(1)} W`;
  el.statIn.textContent = status.totalInputW == null ? "—" : `${status.totalInputW.toFixed(1)} W`;

  const entries = Object.values(status.ports);

  // The panel is the primary view: the real product render plus the connectors
  // the device reported, lit by their live state.
  //
  // PortStatus exposes `power` and `modeName` as **prototype getters**, so object
  // spread silently drops them. Copy the fields explicitly instead - the device
  // tells us which ports exist, the registry tells us what shape they are.
  const panelPorts = entries.map((p) => {
    const known = activeModel?.ports?.find((m) => m.id === p.name);
    return {
      id: p.name,
      name: p.name,
      mode: p.mode,
      modeName: p.modeName,
      voltage: p.voltage,
      current: p.current,
      power: p.power,
      type: known?.type ?? "usb-c",
      label: known?.label ?? p.name,
    };
  });

  try {
    renderDevicePanel(el.panel, {
      model: activeModel,
      ports: panelPorts,
      batteryPercent: status.batteryPercent,
      temperatureC: status.temperatureC,
      deviceName: connectionInfo?.name ?? null,
    });
  } catch (err) {
    // A panel failure must never take the whole status view down with it, and it
    // must not fail silently either - log it where the user can see it.
    logLine(`panel render failed: ${err?.message ?? err}`, "error");
    console.error("panel render failed", err);
  }
  renderModelNote(entries);

  // The table stays as the precise numeric readout.
  el.portsBody.innerHTML = "";
  if (!entries.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "muted";
    td.textContent = "This model did not report per-port data.";
    tr.appendChild(td);
    el.portsBody.appendChild(tr);
  } else {
    for (const port of entries) {
      const row = el.portRowTemplate.content.firstElementChild.cloneNode(true);
      row.querySelector(".port-name").textContent = port.name;
      const modeCell = row.querySelector(".port-mode");
      modeCell.textContent = port.modeName;
      modeCell.classList.add(`mode-${port.modeName}`);
      row.querySelector(".port-volt").textContent =
        port.mode === 0 ? "—" : `${port.voltage.toFixed(2)} V`;
      row.querySelector(".port-amp").textContent =
        port.mode === 0 ? "—" : `${port.current.toFixed(3)} A`;
      row.querySelector(".port-watt").textContent =
        port.mode === 0 ? "—" : `${port.power.toFixed(2)} W`;
      el.portsBody.appendChild(row);
    }
  }

  el.lastUpdated.textContent = `updated ${new Date().toLocaleTimeString()}`;
}


// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function connect(_event, authorizedDevice = null) {
  if (busy || transport) return;

  // Demo mode drives the real session and the real UI from a simulated device,
  // so the whole interface can be seen without hardware. The module is imported
  // lazily so a normal visit never loads it.
  const isDemo = demoMode();
  busy = true;
  el.connectBtn.disabled = true;
  setBadge("connecting", "connecting");

  try {
    for (const input of document.querySelectorAll('#charger-controls input, #charger-controls select')) delete input.dataset.dirty;
    telemetryHistory.clear();
    updateTimeline();
    clearLog();
    el.logCard.hidden = false;
    logLine(`Browser: ${navigator.userAgent}`, "info");

    if (isDemo) {
      const demo = await import("./demo.js");
      const sku = selectedDemoSku() ?? el.demoModel?.value ?? undefined;
      const { transport: demoTransport, info, model } =
        await demo.connectDemoDevice({ sku });
      transport = demoTransport;
      connectionInfo = info;
      // The demo device knows which model it is emulating, so the panel resolves
      // straight from the registry rather than by guessing at a name.
      activeModel = model;
      showDemoBanner(true);
      logLine("DEMO MODE — no real device is connected", "info");
      logLine("frames below are produced by a simulated device", "info");
    } else {
      transport = new BluetoothTransport({ onDisconnect: handleDisconnect,
        onNotification: (bytes) => { protocolDebug.notification(bytes); logLine(`BLE notification (${bytes.length} bytes): ${toHex(bytes)}`, "info"); },
      });
      connectionInfo = await transport.connect({
        acceptAllDevices: $("scan-all").checked,
        authorizedDevice,
        onStage: (stage, detail) => {
          setConnectStatus(`${stage}${detail ? ` — ${detail}` : ""}`, "connecting");
          logLine(`${stage}: ${detail ?? ""}`, "info");
        },
      });
    }

    logLine(`connected to ${connectionInfo.name} (${connectionInfo.family.name})`, "info");

    session = new AnkerSession(transport, { timeout: 5000, onLog: onProtocolLog });
    setConnectStatus("Handshaking… do not touch the device.", "connecting");

    const device = await session.connect({
      onProgress: (stage) => setConnectStatus(`handshake: ${stage}`, "connecting"),
    });

    // Demo mode already knows the model exactly; otherwise identify it from the
    // SKU the device reported, falling back to the advertised name.
    if (!activeModel) activeModel = resolveModel(device, connectionInfo.name);
    device.sku ??= activeModel?.sku ?? null;
    renderDevice(device, connectionInfo.family.name, connectionInfo.name);
    if (activeModel) {
      logLine(`model identified: ${activeModel.name} (${activeModel.sku})`, "info");
    } else {
      logLine(`model not in registry; using device-reported ports`, "info");
    }
    setBadge(isDemo ? "connected" : "initializing", isDemo ? "connected" : "connecting");
    setConnectStatus(
      isDemo
        ? "Demo device connected. This is simulated data."
        : "Bluetooth handshake complete. Waiting for device measurements…",
      "connected",
    );
    el.disconnectBtn.disabled = false;
    el.connectBtn.disabled = true;
    el.connectBtn.classList.add("is-connected");

    logLine(`serial=${device.serialNumber} fw=${device.firmwareVersion} mac=${device.btMac}`, "info");


    await refresh();
    startPolling();
  } catch (err) {
    const message = err?.message ?? String(err);
    const failedTransport = transport;
    transport = null;
    if (failedTransport) await failedTransport.close().catch(() => {});
    connectionInfo = null;
    activeModel = null;
    session = null;
    const suggestion = $("scan-all").checked
      ? " Unfiltered discovery was already selected. Check browser support and the device’s advertising state."
      : " Try ‘Show all nearby devices’ if your device is missing.";
    setConnectStatus(message + suggestion + " Connection diagnostics are available below.", "error");
    setBadge("error", "error");
    el.logCard.hidden = false;
    logLine(`ERROR ${message}`, "error");
    el.connectBtn.classList.remove("is-connected");
    el.deviceCard.hidden = true;
    el.statusCard.hidden = true;
    el.controlsCard.hidden = true;
    el.connectBtn.disabled = false;
    el.disconnectBtn.disabled = true;
  } finally {
    busy = false;
  }
}

function handleDisconnect() {
  stopPolling();
  el.deviceCard.hidden = true;
  el.statusCard.hidden = true;
  el.controlsCard.hidden = true;
  connectionInfo = null;
  activeModel = null;
  el.connectBtn.classList.remove("is-connected");
  setBadge("disconnected");
  setConnectStatus("Device disconnected.");
  el.connectBtn.disabled = false;
  el.disconnectBtn.disabled = true;
  transport = null;
  session = null;
  showDemoBanner(false);
}

async function disconnect() {
  stopPolling();
  if (transport) await transport.close().catch(() => {});
  transport = null;
  session = null;
  connectionInfo = null;
  activeModel = null;
  el.connectBtn.classList.remove("is-connected");
  setBadge("disconnected");
  setConnectStatus("Disconnected.");
  el.connectBtn.disabled = false;
  el.disconnectBtn.disabled = true;
  showDemoBanner(false);
  el.deviceCard.hidden = true;
  el.statusCard.hidden = true;
  el.controlsCard.hidden = true;
}

async function refresh() {
  if (!session || refreshing) return;
  const currentSession = session;
  refreshing = true;
  el.refreshBtn.disabled = true;
  $("poll-status").textContent = "Reading device…";
  $("retry-status").hidden = true;
  try {
    const status = await currentSession.readStatus();
    if (session === currentSession) {
      if (!Object.keys(status.ports).length && status.batteryPercent === null && status.totalOutputW === null) {
        throw new Error("The device reply did not contain supported measurements.");
      }
      renderStatus(status);
      setBadge("connected", "connected");
      setConnectStatus(demoMode() ? "Demo device connected. This is simulated data." : "Connected. Device measurements received.", "connected");
      return status;
    }
  } catch (err) {
    logLine(`status read failed: ${err?.message ?? err}`, "error");
    if (session !== currentSession) return;
    setBadge(telemetryHistory.samples.length ? "read delayed" : "setup incomplete", "error");
    $("retry-status").hidden = false;
    setConnectStatus(telemetryHistory.samples.length
      ? `Latest read failed: ${err.message}. ${el.pollToggle.checked ? 'Auto-refresh will retry.' : 'Press Refresh now to retry.'}`
      : "Bluetooth handshake completed, but the device is not ready: measurements could not be read. Connection setup is incomplete.", "error");
  } finally {
    refreshing = false;
    el.refreshBtn.disabled = false;
    $("poll-status").textContent = el.pollToggle.checked ? "Live · next read in 3 seconds" : "Paused";
  }
}

const pollLoop = new PollLoop(async () => {
  if (session) await refresh();
});
function startPolling() {
  el.pollToggle.checked = true;
  $("poll-status").textContent = "Live · updates every 3 seconds";
  pollLoop.start();
}
function stopPolling() {
  pollLoop.stop();
  if (el.pollToggle) el.pollToggle.checked = false;
  $("poll-status").textContent = "Paused";
}

async function sendSetting(what, value) {
  if (!session) return;
  try {
    if (what === "theme") await session.setTheme(value === "advanced");
    else await session.setBeep(value === "on");
    logLine(`${what} set to ${value}`, "info");
    setConnectStatus(`${what} set to ${value}.`, "connected");
  } catch (err) {
    logLine(`${what} command failed: ${err?.message ?? err}`, "error");
    setConnectStatus(`${what} failed — this model may not support it.`, "error");
  }
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

function init() {
  // Signals the boot probe in index.html that the module loaded and ran.
  window.__ankerReady = true;
  if (navigator.brave?.isBrave) {
    Promise.resolve(navigator.brave.isBrave()).then(isBrave => {
      if (isBrave) $("browser-warning").hidden = false;
    }).catch(() => {});
  }

  // Point at the real repo if the deployer set one.
  const repo = document.querySelector('meta[name="repo-url"]')?.content;
  if (repo && el.repoLink) {
    el.repoLink.href = repo;
    el.repoLink.hidden = false;
  }

  // Demo mode needs no Bluetooth, so it must stay reachable in Safari/Firefox -
  // which is precisely where it is most useful, since a real connection is
  // impossible there.
  if (!bluetoothAvailable()) {
    el.unsupported.hidden = false;
    el.unsupportedReason.textContent = bluetoothUnavailableReason() ?? "";
    const note = document.createElement("p");
    note.className = "small";
    note.innerHTML =
      "You can still explore the full interface in <strong>demo mode</strong> below.";
    el.unsupportedReason.after(note);
    el.connectBtn.disabled = !demoMode();
  }

  // Demo mode: `?demo=1` enters it immediately; the header button toggles it.
  if (demoMode()) {
    el.demoBtn.textContent = "Back to home";
    el.connectBtn.textContent = "Connect to the demo device";
    const hint = $("demo-hint");
    if (hint) hint.hidden = false;
  }

  el.demoBtn?.addEventListener("click", () => {
    if (demoMode()) { exitDemo(); return; }
    if (transport || busy) return;
    el.demoBtn.textContent = "Back to home";
    el.connectBtn.textContent = "Connect to the demo device";
    // Demo mode needs no Bluetooth, so enable the button even in Safari/Firefox.
    el.connectBtn.disabled = false;
    const hint = $("demo-hint");
    if (hint) hint.hidden = false;
    // Reflect demo mode in the URL so it survives a reload and can be shared.
    const url = new URL(location.href);
    url.searchParams.set("demo", "1");
    history.replaceState(null, "", url);
    connect();
  });

  el.demoExit?.addEventListener("click", exitDemo);

  el.connectBtn.addEventListener("click", connect);

  // The picker is populated either way, so "Try demo" can be used immediately.
  populateDemoModels();

  // Entering via a demo link should just work, rather than leaving the visitor to
  // find the connect button after the interface has already changed under them.
  if (demoMode()) {
    connect();
  }
  el.disconnectBtn.addEventListener("click", disconnect);
  el.refreshBtn.addEventListener("click", refresh);
  $("retry-status").addEventListener("click", refresh);
  $("timeline-section").addEventListener("toggle", updateTimeline);
  $("timeline-metric").addEventListener("change", updateTimeline);
  $("timeline-window").addEventListener("change", updateTimeline);
  $("timeline-clear").addEventListener("click", () => { telemetryHistory.clear(); updateTimeline(); });
  el.pollToggle.addEventListener("change", (e) => {
    if (e.target.checked) startPolling();
    else stopPolling();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && session && el.pollToggle.checked) startPolling();
  });
  $("debug-toggle").addEventListener("change", () => { $("protocol-debug").hidden = !$("debug-toggle").checked; updateProtocolDebug(); });
  $("preview-charger-controls").addEventListener('click', () => {
    $("demo-model").value = 'A2345';
    $("demo-model").dispatchEvent(new Event('change'));
  });
  el.logClear.addEventListener("click", clearLog);
  el.logDownload.addEventListener("click", () => {
    const blob = new Blob([logLines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `anker-ble-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });

  wireChargerControls({ getSession: () => session, getTransport: () => transport, refresh, syncClock: async () => {
    const device = transport?.device;
    await disconnect();
    if (device) await new Promise(resolve => setTimeout(resolve, 750));
    await connect(null, device);
    if (!session) throw new Error("Reconnect failed. Press Connect to retry clock synchronization.");
  } });
  for (const btn of document.querySelectorAll("[data-theme]")) {
    btn.addEventListener("click", () => sendSetting("theme", btn.dataset.theme));
  }
  for (const btn of document.querySelectorAll("[data-beep]")) {
    btn.addEventListener("click", () => sendSetting("beep", btn.dataset.beep));
  }

  // Disconnecting on navigation away avoids leaving the device in a connected
  // state, which would block the phone app from reconnecting.
  window.addEventListener("pagehide", () => {
    transport?.close().catch(() => {});
  });
}

init();
