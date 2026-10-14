/**
 * Build the static site into `dist/`.
 *
 * The app is plain ES modules with no bundler, so "building" means: copy the
 * static files, stamp in the repository URL so the Source link works, and add a
 * 404 fallback. Keeping this trivial means a fork can be deployed by pushing to
 * a branch - no toolchain, no lockfile, no supply chain.
 *
 * Usage:
 *   node scripts/build.mjs [--out dist] [--base /repo-name/]
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

/** Include only what the site needs; tests and scripts stay out. */
// `assets/` holds imagery extracted from the Anker app by
// scripts/extract_assets.py. It is gitignored, so it is included only when the
// build machine has run that script.
const INCLUDE = ["index.html", "styles.css", "src", "assets", "LICENSE", "README.md"];

function resolveRepoUrl() {
  // GitHub Actions provides these; fall back to the package.json repository
  // field or an explicit override.
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  if (server && repo) return `${server}/${repo}`;
  if (process.env.REPO_URL) return process.env.REPO_URL;
  return null;
}

function main() {
  const outDir = join(webRoot, arg("--out", "dist"));
  const base = arg("--base", process.env.BASE_PATH ?? "/");

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  for (const entry of INCLUDE) {
    const src = join(webRoot, entry);
    if (!existsSync(src)) continue;
    cpSync(src, join(outDir, entry), { recursive: true });
  }

  // Stamp the repo URL into index.html so the header link points somewhere real.
  const repoUrl = resolveRepoUrl();
  const indexPath = join(outDir, "index.html");
  let html = readFileSync(indexPath, "utf8");

  if (repoUrl) {
    html = html.replace(
      "<head>",
      `<head>\n    <meta name="repo-url" content="${repoUrl}" />`,
    );
  }
  // Make asset paths work when served from a project subpath.
  if (base !== "/") {
    const prefix = base.endsWith("/") ? base.slice(0, -1) : base;
    html = html.replace('href="styles.css"', `href="${prefix}/styles.css"`);
    html = html.replace('src="src/app.js"', `src="${prefix}/src/app.js"`);
  }

  writeFileSync(indexPath, html);

  // A copy of index.html as 404.html gives GitHub Pages SPA-ish behaviour and
  // keeps deep links working.
  writeFileSync(join(outDir, "404.html"), html);

  // GitHub Pages runs Jekyll unless told not to; this keeps `src/` directories.
  writeFileSync(join(outDir, ".nojekyll"), "");

  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else files.push(p.slice(outDir.length + 1));
    }
  })(outDir);

  console.log(`built ${outDir}`);
  console.log(`  base      : ${base}`);
  console.log(`  repo link : ${repoUrl ?? "(none — set GITHUB_REPOSITORY or REPO_URL)"}`);
  console.log(`  files     : ${files.length}`);
  for (const f of files.slice(0, 20)) console.log(`    ${f}`);
  if (files.length > 20) console.log(`    … and ${files.length - 20} more`);
}

main();
