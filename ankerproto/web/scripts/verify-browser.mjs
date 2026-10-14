/**
 * Verify the protocol implementation inside a real browser.
 *
 * This exists because WebCrypto's AES-CBC padding behaviour differs between
 * runtimes and the difference is **silent**: both accept the call and return a
 * plausible-length result. Browsers strip PKCS#7 padding on decrypt; Node's
 * WebCrypto does not. A Node-only suite therefore missed a real bug that
 * produced a spurious extra ciphertext block in the browser. The only
 * trustworthy check is the browser the app actually ships to.
 *
 * Drives headless Chrome over the DevTools Protocol against `tests/browser.html`,
 * which imports the same `src/` modules the app uses.
 *
 * Usage: node scripts/verify-browser.mjs [--chrome <path>] [--verbose]
 * Exit code is non-zero if any check fails, so this is CI-usable.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
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

/** Wait for the CDP HTTP endpoint, retrying while Chrome boots. */
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
  throw new Error(`CDP endpoint never came up: ${lastErr?.message ?? "timeout"}`);
}

/** Minimal CDP client over Node's built-in WebSocket. */
async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed")), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, { resolve });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

async function main() {
  const verbose = process.argv.includes("--verbose");
  const chromePath = arg("--chrome") ?? CHROME_CANDIDATES.find((p) => p && existsSync(p));

  if (!chromePath) {
    console.error("No Chrome/Chromium found. Set CHROME_PATH or pass --chrome <path>.");
    console.error("Searched:\n  " + CHROME_CANDIDATES.join("\n  "));
    return 2;
  }

  const { server, port } = await serve(webRoot);
  const url = `http://127.0.0.1:${port}/tests/browser.html`;
  const debugPort = 9100 + Math.floor(Math.random() * 800);
  const profile = join(webRoot, ".chrome-profile");

  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      // Linux Chrome gates Web Bluetooth behind experimental web features.
      ...(process.platform === "linux" ? ["--enable-experimental-web-platform-features"] : []),
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
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

    // Open the test page as a fresh target. Creating it with the URL directly
    // avoids a navigation step entirely, which sidesteps evaluating in the
    // wrong execution context while the document is still swapping.
    const newTargetRes = await fetch(
      `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`,
      { method: "PUT" },
    );
    if (!newTargetRes.ok) {
      throw new Error(
        `could not open a tab (HTTP ${newTargetRes.status}); ` +
          "Chrome >= 111 requires PUT for /json/new",
      );
    }
    const target = await newTargetRes.json();

    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");

    const deadline = Date.now() + 45000;
    let result = null;
    while (Date.now() < deadline) {
      const res = await cdp.send("Runtime.evaluate", {
        expression: "JSON.stringify(window.__RESULT ?? null)",
        returnByValue: true,
      });
      // `send` resolves with the whole CDP message `{id, result}`, so a
      // `Runtime.evaluate` value sits at `result.result.value`.
      const value = res?.result?.result?.value;
      if (value && value !== "null") {
        result = JSON.parse(value);
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!result) {
      console.error("Browser checks did not finish within 45s.");
      exitCode = 1;
    } else {
      for (const check of result.checks) {
        const mark = check.pass ? "ok  " : "FAIL";
        const detail = check.detail && (!check.pass || verbose) ? `\n       ${check.detail}` : "";
        console.log(`${mark}  ${check.name}${detail}`);
      }
      const failed = result.checks.filter((c) => !c.pass).length;
      console.log(`\n${result.checks.length - failed}/${result.checks.length} browser checks passed`);
      if (result.error) {
        console.error(`\nbrowser error: ${result.error}`);
        exitCode = 1;
      }
      if (failed) exitCode = 1;
    }
  } catch (err) {
    console.error(`browser verification failed: ${err?.name}: ${err?.message}`);
    if (verbose) console.error(err?.stack);
    exitCode = 1;
  } finally {
    // Hard deadline: never leave Chrome or the socket hanging.
    try {
      cdp?.close();
    } catch {
      /* ignore */
    }
    chrome.kill("SIGKILL");
    server.close();
    // Chrome leaves tens of MB of profile behind; it is disposable.
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  return exitCode;
}

// Guarantee the process exits even if a socket keeps the loop alive.
const HARD_TIMEOUT = setTimeout(() => {
  console.error("verification hard-timeout after 90s");
  process.exit(1);
}, 90000);
HARD_TIMEOUT.unref();

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
