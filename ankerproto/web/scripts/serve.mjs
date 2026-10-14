/**
 * Zero-dependency static file server for local development.
 *
 * Web Bluetooth requires a secure context: `https://` or `localhost`. Serving on
 * 127.0.0.1 counts, so no certificates are needed.
 *
 * Usage:
 *   node scripts/serve.mjs [--port 8080]
 *   node scripts/serve.mjs --base /repo-name/     # emulate a Pages project site
 *
 * With `--base`, `dist/` is served under that prefix (as GitHub Pages does for a
 * project site) instead of the working directory. Build first with the same
 * base: `npm run build -- --base /repo-name/`.
 */

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/** Numeric CLI argument. */
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]) || fallback;
}

/** String CLI argument (paths must not go through Number()). */
function strArg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const port = arg("--port", 8080);
const rawBase = strArg("--base", null);
const base = rawBase ? `/${String(rawBase).replace(/^\/+|\/+$/g, "")}` : null;
const root = base ? resolve(join(webRoot, "dist")) : webRoot;

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let path = decodeURIComponent(url.pathname);
  if (base) {
    if (path === base) path = "/";
    else if (path.startsWith(`${base}/`)) path = path.slice(base.length);
    else {
      res.writeHead(404, { "content-type": "text/plain" }).end("outside base path");
      return;
    }
  }
  let rel = normalize(path).replace(/^(\.\.[/\\])+/, "");
  if (rel === "/" || rel === "\\" || rel === ".") rel = "/index.html";

  const file = join(root, rel);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("404 not found");
    return;
  }

  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(readFileSync(file));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Anker BLE web client: http://127.0.0.1:${port}${base ?? "/"}`);
  if (base) console.log(`serving dist/ under the ${base}/ prefix (GitHub Pages project-site layout)`);
  console.log("Open in Chrome or Edge. Web Bluetooth needs a secure context;");
  console.log("127.0.0.1 counts as one, so no certificate is required.");
});
