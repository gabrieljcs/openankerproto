/**
 * Device panel: the real product render plus live port indicators.
 *
 * Uses Anker's own imagery, extracted from the app by
 * `scripts/extract_assets.py`:
 *
 *  - the **product render** the app shows on the device home screen, and
 *  - the **port indicator badges** the app draws for each connector
 *    (`C1` with a direction arrow — filled for output, inverted for input,
 *    dimmed when idle).
 *
 * Those badges are exactly what the device's own screen shows, so the panel
 * mirrors the hardware rather than approximating it.
 *
 * The assets are generated at build time and are **not** in the repo (see
 * `web/README.md`), so everything here degrades gracefully: if an image is
 * missing the panel falls back to a drawn schematic rather than a broken image.
 */

const ASSET_BASE = new URL("../assets/device/", import.meta.url);

/** Path to a model's product render, if it was extracted. */
export function heroSrc(sku) {
  if (!sku) return null;
  return new URL(`${sku.toLowerCase()}-hero.webp`, ASSET_BASE).href;
}

/**
 * Which alternate render represents this device state.
 *
 * The app ships several real renders per model and swaps between them from live
 * state. The state names are the app's own (`lighton` / `lightoff`,
 * `lowbattery`), collapsed here into three buckets:
 *
 *  - **critical** — a fault or warning condition
 *  - **active** / **charging** — the device is doing something visible
 *  - **normal** — idle
 *
 * These renders are *physically different photographs*, not brightness
 * variants: the A1340's `charging` render shows the power bank seated on its
 * charging base, and the A1753's `active` render lights its LED bar. So the
 * choice is made from real telemetry, not applied as a CSS effect.
 *
 * @param {object|null} model
 * @param {object} state
 * @param {number|null} state.batteryPercent
 * @param {number|null} state.temperatureC
 * @param {boolean} state.anyActive  any port reporting input or output
 * @returns {string|null} variant name, or null to use the plain hero
 */
export function variantFor(model, state = {}) {
  if (!model?.sku) return null;
  const { batteryPercent = null, temperatureC = null, anyActive = false } = state;

  // Warning conditions first: they are the most informative thing to show.
  if (batteryPercent !== null && batteryPercent <= 10) return "lowBattery";
  if (temperatureC !== null && (temperatureC >= 45 || temperatureC <= 0)) return "lowTemp";

  // A model whose active render is its charging base (the A1340 is seated on it
  // while charging) is described as "charging"; others just light up.
  if (anyActive) return model.variantActiveName ?? "active";

  return "normal";
}

/**
 * Candidate paths for a port indicator badge, best first.
 *
 * The app ships a different image per port state, but not every combination
 * exists (the A1340 has no `p_output`), so the caller walks this list.
 */
export function portSrc(sku, portId, state) {
  if (!sku || !portId) return [];
  const base = `${sku.toLowerCase()}-port-${String(portId).toLowerCase()}`;
  const order = [state, "output", "input", "empty"].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const s of order) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(new URL(`${base}-${s}.webp`, ASSET_BASE).href);
  }
  return out;
}

const MODE_STATE = { off: "empty", input: "input", output: "output" };

/**
 * Port/state combinations the app actually ships artwork for.
 *
 * Derived from `scripts/extract_assets.py`'s PORT_ART map. Kept as data rather
 * than probing the network, so the panel knows up front whether the badge it
 * wants exists and can disclose when it is showing an approximation.
 */
const PORT_ART_STATES = {
  A1340: {
    C1: ["empty", "input", "output"],
    C2: ["empty", "input", "output"],
    P: ["empty", "input"],
    A: ["empty", "output"],
  },
  A2345: {
    C1: ["output"],
    C2: ["output"],
    C3: ["output"],
    C4: ["output"],
    A1: ["output"],
    A2: ["output"],
  },
};

/** Does the app ship art for this exact port and state? */
export function hasPortArt(sku, portId, state) {
  const states = PORT_ART_STATES[sku?.toUpperCase()]?.[String(portId).toUpperCase()];
  return Boolean(states?.includes(state));
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * Attach an image, walking `candidates` until one loads.
 * Calls `onAllFailed` when none do.
 */
function loadWithFallback(img, candidates, onAllFailed) {
  let i = 0;
  img.addEventListener("error", () => {
    if (i >= candidates.length) {
      img.remove();
      onAllFailed?.();
      return;
    }
    img.src = candidates[i++];
  });
  if (!candidates.length) {
    img.remove();
    onAllFailed?.();
    return;
  }
  img.src = candidates[i++];
}

/**
 * Render the panel.
 *
 * @param {HTMLElement} host
 * @param {object} opts
 * @param {object|null} opts.model registry entry
 * @param {Array} opts.ports ports the device reported
 * @param {number|null} opts.batteryPercent
 * @param {string|null} opts.deviceName
 */
export function renderDevicePanel(host, opts) {
  const { model, ports = [], batteryPercent = null, temperatureC = null, deviceName = null } = opts;
  const sku = model?.sku ?? null;

  const panelKey = JSON.stringify([sku, deviceName, ports.map(p => [p.id, p.modeName]),
    variantFor(model, { batteryPercent, temperatureC, anyActive: ports.some(p => p.modeName !== "off") })]);
  if (host.dataset.panelKey === panelKey && host.querySelectorAll(".port-cell").length === ports.length) {
    host.querySelectorAll(".port-cell").forEach((cell, i) => {
      const port = ports[i];
      cell.querySelector(".port-reading").textContent = port.modeName === "off" ? "idle" : `${port.power.toFixed(1)} W`;
      const sub = cell.querySelector(".port-sub");
      if (sub) sub.textContent = `${port.voltage.toFixed(2)} V · ${port.current.toFixed(2)} A · ${port.modeName}`;
    });
    const meta = host.querySelector(".nameplate-meta");
    if (meta) meta.textContent = [sku, `${ports.length} ports`, batteryPercent == null ? null : `${batteryPercent.toFixed(1)}%`].filter(Boolean).join(" · ");
    return;
  }
  host.dataset.panelKey = panelKey;
  host.textContent = "";

  // --- nameplate ------------------------------------------------------
  const plate = el("div", "nameplate");
  plate.appendChild(el("div", "nameplate-title", model?.name ?? deviceName ?? "Anker device"));

  const bits = [];
  if (sku) bits.push(sku);
  if (ports.length) bits.push(`${ports.length} ${ports.length === 1 ? "port" : "ports"}`);
  if (batteryPercent !== null && batteryPercent !== undefined) {
    bits.push(`${batteryPercent.toFixed(1)}%`);
  }
  plate.appendChild(el("div", "nameplate-meta", bits.join(" · ")));

  if (!model) {
    plate.appendChild(
      el(
        "div",
        "nameplate-note",
        "Model not in the registry yet — showing what the device reports.",
      ),
    );
  }
  host.appendChild(plate);

  // --- body -----------------------------------------------------------
  const body = el("div", "panel-body");

  // Product render.
  const shot = el("div", "panel-shot");
  const anyActive = ports.some((p) => p.modeName === "input" || p.modeName === "output");

  // The app does not ship every port/state combination - the A1340 has no
  // `p_output` badge, for instance. Rather than silently drawing the wrong
  // artwork, note which ports had to fall back so the UI can say so.
  const approximate = ports
    .filter((p) => {
      const want = MODE_STATE[p.modeName] ?? "empty";
      return want !== "empty" && !hasPortArt(sku, p.id, want);
    })
    .map((p) => p.id);
  const variant = variantFor(model, {
    batteryPercent,
    temperatureC,
    anyActive,
  });

  const hero = document.createElement("img");
  hero.className = "panel-hero";
  hero.alt = model?.name ? `${model.name} product render` : "Product render";
  hero.decoding = "async";
  // Try the state-specific render first, then the plain one. A model may ship a
  // variant we did not extract, so the fallback matters.
  if (approximate.length && sku !== "A2345") {
    plate.appendChild(
      el(
        "div",
        "nameplate-note",
        `The app ships no ${approximate.join("/")} state artwork for this model, ` +
          "so those indicators show the nearest available state.",
      ),
    );
  }

  const heroCandidates = [];
  if (variant && sku) heroCandidates.push(new URL(`${sku.toLowerCase()}-${variant.toLowerCase()}.webp`, ASSET_BASE).href);
  heroCandidates.push(heroSrc(sku));
  loadWithFallback(hero, heroCandidates.filter(Boolean), () => {
    shot.appendChild(el("div", "panel-shot-missing", "product render unavailable"));
  });
  hero.dataset.variant = variant ?? "hero";
  shot.appendChild(hero);
  body.appendChild(shot);

  // Live port indicators.
  const rack = el("div", "port-rack");
  if (!ports.length) {
    rack.appendChild(el("p", "muted small", "This model did not report per-port data."));
  }

  for (const port of ports) {
    const cell = el("div", `port-cell port-${port.modeName ?? "off"}`);

    const icon = el("div", "port-icon");
    if (sku === "A2345") {
      const usbC = port.id.startsWith("C");
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", "0 0 64 48");
      svg.setAttribute("class", "connector-icon");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", `${port.id} USB-${usbC ? 'C' : 'A'} ${port.modeName ?? 'off'}`);
      const shape = (name, attrs) => {
        const element = document.createElementNS(ns, name);
        for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
        svg.append(element);
      };
      shape("rect", { x: 5, y: 10, width: 54, height: 28, rx: usbC ? 14 : 4, fill: "none", stroke: "currentColor", "stroke-width": 3 });
      shape("rect", { x: 15, y: usbC ? 21 : 17, width: 34, height: usbC ? 6 : 10, rx: usbC ? 3 : 1, fill: "currentColor" });
      for (const x of [21, 28, 35, 42]) shape("line", { x1: x, x2: x, y1: usbC ? 21 : 17, y2: usbC ? 27 : 23, stroke: "var(--surface)", "stroke-width": 2 });
      icon.append(svg);
    } else {
      const img = document.createElement("img");
      img.className = "port-badge";
      img.alt = `${port.id} ${port.modeName ?? ""}`.trim();
      img.decoding = "async";
      const candidates = portSrc(sku, port.id, MODE_STATE[port.modeName] ?? "empty");
      loadWithFallback(img, candidates, () => icon.appendChild(el("span", "port-pill", port.id)));
      icon.appendChild(img);
    }
    cell.appendChild(icon);

    const info = el("div", "port-info");
    const reading = el("div", "port-reading");
    if (port.modeName === "off") {
      reading.textContent = "idle";
      info.appendChild(el("div", "port-name", port.id));
    } else {
      reading.textContent = `${port.power.toFixed(1)} W`;
      info.appendChild(el("div", "port-name", port.id));
      info.appendChild(
        el(
          "div",
          "port-sub",
          `${port.voltage.toFixed(2)} V · ${port.current.toFixed(2)} A · ${port.modeName}`,
        ),
      );
    }
    info.appendChild(reading);
    cell.appendChild(info);

    rack.appendChild(cell);
  }

  body.appendChild(rack);
  host.appendChild(body);
}
