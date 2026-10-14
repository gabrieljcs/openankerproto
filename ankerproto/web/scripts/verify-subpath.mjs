/**
 * Verify the built site works when served from a **subpath**, which is how
 * GitHub Pages serves a project site (`https://user.github.io/repo-name/`).
 *
 * This is not covered by the other checks: they all serve `dist/` at the domain
 * root. A project page is different in a way that breaks things for real - the
 * build rewrites asset paths to `/<repo>/...`, the app's ES modules use relative
 * specifiers (`./demo.js`) that must resolve to `/<repo>/src/demo.js`, and a 404
 * on any one of them leaves a page that renders but does nothing.
 *
 * It also exercises the flow a real visitor takes: click "Try demo" and confirm
 * the interface populates, with no console errors.
 *
 * Usage: node scripts/verify-subpath.mjs [--dir dist] [--base /repo-name/]
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
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
].filter(Boolean);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

async function waitForCdp(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* booting */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("CDP never came up");
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
  });
  let id = 1;
  const pending = new Map();
  const events = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method) {
      events.push(m);
    }
  });
  return {
    send: (method, params = {}) =>
      new Promise((r) => {
        const i = id++;
        pending.set(i, r);
        ws.send(JSON.stringify({ id: i, method, params }));
      }),
    events,
    close: () => ws.close(),
  };
}

async function main() {
  const verbose = process.argv.includes("--verbose");
  const root = join(webRoot, arg("--dir", "dist"));
  const base = arg("--base", "/anker-web-client");
  // Normalise to a single leading slash and no trailing slash.
  const normalizedBase = `/${base.replace(/^\/+|\/+$/g, "")}`;
  const chromePath = arg("--chrome") ?? CHROME_CANDIDATES.find((p) => p && existsSync(p));

  if (!chromePath) {
    console.error("No Chrome/Chromium found. Set CHROME_PATH or pass --chrome <path>.");
    return 2;
  }
  // Ensure the precondition rather than trusting it. Other test steps rebuild
  // dist/ at the root base, so a stale build here would otherwise fail with a
  // confusing "nothing happens" instead of building what it needs.
  const expectedRef = `${normalizedBase}/src/app.js`;
  const indexPath = join(root, "index.html");
  const builtForBase = () =>
    existsSync(indexPath) && readFileSync(indexPath, "utf8").includes(`"${expectedRef}"`);

  if (!builtForBase()) {
    if (verbose) console.log(`dist/ not built for ${normalizedBase}; building it now`);
    const { spawnSync } = await import("node:child_process");
    const built = spawnSync(
      process.execPath,
      [join(webRoot, "scripts", "build.mjs"), "--base", `${normalizedBase}/`],
      { cwd: webRoot, stdio: verbose ? "inherit" : "pipe" },
    );
    if (built.status !== 0) {
      console.error(`could not build dist/ for ${normalizedBase}`);
      if (!verbose && built.stderr) console.error(built.stderr.toString().slice(0, 500));
      return 2;
    }
  }

  // If it still does not match, a build genuinely produced the wrong paths and
  // that is worth reporting loudly rather than debugging from symptoms.
  if (!builtForBase()) {
    const actual = (readFileSync(indexPath, "utf8").match(/src="([^"]*app\.js)"/) ?? [])[1] ?? "(none)";
    console.error(
      `dist/ was built, but not for base "${normalizedBase}".\n` +
        `  expected a script tag for: ${expectedRef}\n` +
        `  found:                     ${actual}`,
    );
    return 2;
  }

  // Serve dist/ only under the base path, 404ing anything outside it - the same
  // shape as a GitHub Pages project site.
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = decodeURIComponent(url.pathname);
    if (path !== normalizedBase && !path.startsWith(`${normalizedBase}/`)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("outside base path");
      return;
    }
    let rel = path.slice(normalizedBase.length) || "/index.html";
    if (rel === "/") rel = "/index.html";
    const file = join(root, normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}${normalizedBase}/`;

  const debugPort = 9400 + Math.floor(Math.random() * 400);
  const profile = join(webRoot, ".chrome-subpath");
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
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let exitCode = 0;
  let cdp = null;

  try {
    await waitForCdp(debugPort);
    if (verbose) console.log(`serving ${url}`);

    const res = await fetch(
      `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`,
      { method: "PUT" },
    );
    if (!res.ok) throw new Error(`could not open a tab: HTTP ${res.status}`);
    const target = await res.json();

    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");

    const evaluate = async (expression) => {
      const r = await cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      return r?.result?.result?.value;
    };

    // Wait for the module to boot before clicking.
    const bootDeadline = Date.now() + 15000;
    while (Date.now() < bootDeadline) {
      if ((await evaluate("!!window.__ankerReady")) === true) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    // Click "Try demo" like a visitor, rather than deep-linking into demo mode.
    const rect = JSON.parse(
      await evaluate(
        "JSON.stringify((()=>{const b=document.getElementById('demo-btn').getBoundingClientRect();" +
          "return {x:b.x+b.width/2, y:b.y+b.height/2}})())",
      ),
    );
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1,
    });

    const deadline = Date.now() + 20000;
    let state = null;
    while (Date.now() < deadline) {
      state = JSON.parse(
        await evaluate(`JSON.stringify({
          booted: !!window.__ankerReady,
          loadErrorShown: !document.getElementById('load-error').hidden,
          badge: document.getElementById('conn-badge').textContent,
          banner: !document.getElementById('demo-banner').hidden,
          name: document.getElementById('dev-name').textContent,
          battery: document.getElementById('stat-battery').textContent,
          portRows: document.querySelectorAll('#ports-body tr').length,
          logChars: document.getElementById('log').textContent.length,
          pickerOptions: [...document.querySelectorAll('#demo-model option')].length,
          panelPorts: document.querySelectorAll('#device-panel .port-cell').length,
          heroLoaded: (() => { const i = document.querySelector('.panel-hero'); return !!i && i.complete && i.naturalWidth > 0; })(),
          heroVariant: document.querySelector('.panel-hero')?.dataset.variant ?? '',
        })`),
      );
      // Connection precedes the first telemetry response and image loading.
      const imageryReady = !existsSync(join(root, "assets", "device", "a1340-hero.webp")) || state.heroLoaded;
      if (state.badge === "connected" && state.battery !== "—" && state.panelPorts === 4 && imageryReady) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    const problems = [];
    for (const e of cdp.events) {
      if (e.method === "Runtime.exceptionThrown") {
        problems.push(`uncaught: ${e.params?.exceptionDetails?.exception?.description ?? "?"}`);
      }
      if (e.method === "Log.entryAdded" && e.params?.entry?.level === "error") {
        problems.push(`log: ${e.params.entry.text}`);
      }
    }

    // Imagery is generated locally and gitignored, so it may legitimately be
    // absent from a CI build. Only assert it when the assets are actually there.
    const hasImagery = existsSync(join(root, "assets", "device", "a1340-hero.webp"));

    const checks = [
      ["app module booted under the subpath", state?.booted === true],
      ["no load-error notice", state?.loadErrorShown === false],
      ["clicking 'Try demo' connects", state?.badge === "connected", state?.badge],
      ["demo banner visible", state?.banner === true],
      ["device name populated", /^.+ \(demo\)$/.test(state?.name ?? ""), state?.name],
      ["telemetry populated", /^[\d.]+ %$/.test(state?.battery ?? ""), state?.battery],
      ["every port row rendered", state?.portRows === 4, `rows=${state?.portRows}`],
      ["protocol log decoding", (state?.logChars ?? 0) > 500, `chars=${state?.logChars}`],
      ["model picker populated", (state?.pickerOptions ?? 0) >= 5, `options=${state?.pickerOptions}`],
      ["panel rendered", (state?.panelPorts ?? 0) === 4, `connectors=${state?.panelPorts}`],
      ...(hasImagery
        ? [
            ["real product render loaded", state?.heroLoaded === true],
            ["render variant chosen from state", (state?.heroVariant ?? "") !== "", `variant=${state?.heroVariant}`],
          ]
        : [["imagery absent, panel degrades cleanly", (state?.panelPorts ?? 0) === 4, "run scripts/extract_assets.py"]]),
      ["no console errors", problems.length === 0, problems.join("\n         ")],
    ];

    for (const [name, pass, detail] of checks) {
      const extra = detail && (!pass || verbose) ? `\n         ${detail}` : "";
      console.log(`${pass ? "ok  " : "FAIL"}  ${name}${extra}`);
    }
    const failed = checks.filter(([, pass]) => !pass).length;
    console.log(`\n${checks.length - failed}/${checks.length} subpath checks passed`);
    if (failed) exitCode = 1;
  } catch (err) {
    console.error(`subpath verification failed: ${err?.name}: ${err?.message}`);
    if (verbose) console.error(err?.stack);
    exitCode = 1;
  } finally {
    try {
      cdp?.close();
    } catch {
      /* ignore */
    }
    chrome.kill("SIGKILL");
    server.close();
    // Chrome may still be flushing its profile; a failure here is irrelevant.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* leave it; it is gitignored */
    }
  }

  return exitCode;
}

const HARD_TIMEOUT = setTimeout(() => {
  console.error("subpath verification hard-timeout after 90s");
  process.exit(1);
}, 90000);
HARD_TIMEOUT.unref();

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
