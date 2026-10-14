/**
 * Capture screenshots of the built site for visual inspection.
 *
 * Renders the page at a few viewport sizes and writes PNGs to `screenshots/`.
 * Useful for reviewing layout changes without opening a browser, and for
 * checking the About section and long-page rendering.
 *
 * Usage: node scripts/screenshot.mjs [--dir dist] [--out screenshots] [--demo]
 */

import { spawn } from "node:child_process";
import { rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  ".svg": "image/svg+xml",
  ".png": "image/png",
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
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

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
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  return {
    send: (method, params = {}) =>
      new Promise((r) => {
        const i = id++;
        pending.set(i, r);
        ws.send(JSON.stringify({ id: i, method, params }));
      }),
    close: () => ws.close(),
  };
}

async function main() {
  const root = join(webRoot, arg("--dir", "dist"));
  const outDir = join(webRoot, arg("--out", "screenshots"));
  const demo = process.argv.includes("--demo");
  const chromePath = arg("--chrome") ?? CHROME_CANDIDATES.find((p) => p && existsSync(p));

  if (!chromePath) {
    console.error("No Chrome found. Set CHROME_PATH or pass --chrome <path>.");
    return 2;
  }
  if (!existsSync(join(root, "index.html"))) {
    console.error(`${root}/index.html not found. Run: npm run build`);
    return 2;
  }
  mkdirSync(outDir, { recursive: true });

  const { server, port } = await serve(root);
  const debugPort = 9600 + Math.floor(Math.random() * 300);
  const profile = join(webRoot, ".chrome-shots");
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
      "--hide-scrollbars",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    await waitForCdp(debugPort);
    const suffix = demo ? "?demo=1" : "";

    // Create each target with its URL directly. Navigating an existing target
    // means evaluating during the context swap, which silently yields undefined.
    let cdp = null;

    const viewports = [
      { name: "desktop", width: 1000, height: 900 },
      { name: "narrow", width: 420, height: 800 },
    ];

    for (const vp of viewports) {
      const res = await fetch(
        `http://127.0.0.1:${debugPort}/json/new?` +
          encodeURIComponent(`http://127.0.0.1:${port}/index.html${suffix}`),
        { method: "PUT" },
      );
      if (!res.ok) throw new Error(`could not open a tab: HTTP ${res.status}`);
      const target = await res.json();

      cdp?.close();
      cdp = await connectCdp(target.webSocketDebuggerUrl);
      await cdp.send("Runtime.enable");
      await cdp.send("Page.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 2,
        mobile: vp.width < 500,
      });
      await new Promise((r) => setTimeout(r, 1200));

      if (demo) {
        // The connect flow is deliberately asynchronous, so drive it and then
        // wait for the UI to actually settle before capturing.
        await cdp.send("Runtime.evaluate", {
          expression: "document.getElementById('connect-btn').click()",
        });
        const deadline = Date.now() + 15000;
        let ready = false;
        while (Date.now() < deadline) {
          const res = await cdp.send("Runtime.evaluate", {
            expression:
              "!document.getElementById('status-card').hidden && " +
              "!document.getElementById('log-card').hidden && " +
              "document.getElementById('stat-battery').textContent !== '—'",
            returnByValue: true,
          });
          if (res?.result?.result?.value === true) {
            ready = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        if (!ready) console.error("warning: demo UI did not settle; screenshot may be incomplete");
        // The simulated device keeps producing frames; one more tick is enough.
        await cdp.send("Runtime.evaluate", {
          expression: "document.getElementById('refresh-btn').click()",
        });
        await new Promise((r) => setTimeout(r, 800));
      }

      if (process.argv.includes("--timeline")) {
        await cdp.send("Runtime.evaluate", {
          expression: "document.getElementById('timeline-section').open = true; document.getElementById('poll-toggle').click()",
        });
        await new Promise(r => setTimeout(r, 6500));
      }

      // Full page.
      let shot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      });
      const file = join(outDir, `${vp.name}${demo ? "-demo" : ""}.png`);
      writeFileSync(file, Buffer.from(shot.result.data, "base64"));
      console.log(`wrote ${file}`);

      // About section, scrolled into view, to check that anchor.
      await cdp.send("Runtime.evaluate", {
        expression: "document.getElementById('about').scrollIntoView()",
      });
      await new Promise((r) => setTimeout(r, 400));
      shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      const aboutFile = join(outDir, `${vp.name}${demo ? "-demo" : ""}-about.png`);
      writeFileSync(aboutFile, Buffer.from(shot.result.data, "base64"));
      console.log(`wrote ${aboutFile}`);
    }

    cdp?.close();
  } finally {
    chrome.kill("SIGKILL");
    server.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
