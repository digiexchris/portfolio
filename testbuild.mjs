// Test helper: builds go under .cache/test-build/ (via PORTFOLIO_BUILD_ROOT),
// never into the real docs/, preview/ or out/ -- those hold the author's own
// builds. Suites that build also snapshot docs/ and prove it was left alone.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const BUILD_ROOT = path.join(ROOT, '.cache', 'test-build');
export const TEST_DOCS = path.join(BUILD_ROOT, 'docs');
export const TEST_PREVIEW = path.join(BUILD_ROOT, 'preview');
export const TEST_OUT = path.join(BUILD_ROOT, 'out');
const env = () => ({ ...process.env, PORTFOLIO_BUILD_ROOT: BUILD_ROOT });

export function buildSite(args = []) {
  return execFileSync(process.execPath, ['export/build-site.js', ...args], { cwd: ROOT, env: env(), encoding: 'utf8' });
}
export function buildPdf(args = []) {
  return execFileSync(process.execPath, ['export/build-pdf.js', ...args], { cwd: ROOT, env: env(), encoding: 'utf8' });
}

// A page of the test build, opened straight from disk (the site is built to
// work from file://).
export const docsUrl = (rel = 'index.html') => pathToFileURL(path.join(TEST_DOCS, rel)).href;
export const previewUrl = (rel = 'index.html') => pathToFileURL(path.join(TEST_PREVIEW, rel)).href;

// The PDF is slow to build; borrow the author's existing one for site builds
// that only need *a* PDF to link (read, never written).
export function seedPdf() {
  const real = path.join(ROOT, 'out', 'portfolio.pdf');
  fs.mkdirSync(TEST_OUT, { recursive: true });
  if (fs.existsSync(real)) fs.copyFileSync(real, path.join(TEST_OUT, 'portfolio.pdf'));
  else buildPdf();
}

// Every file under docs/ with its size and modification time.
export function docsSnapshot() {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else { const st = fs.statSync(f); out.push(`${path.relative(ROOT, f)}|${st.size}|${st.mtimeMs}`); }
    }
  };
  walk(path.join(ROOT, 'docs'));
  return out.sort().join('\n');
}

// What changed between two snapshots, for the failure message.
export function docsChanges(before, after) {
  const a = new Set(before.split('\n'));
  const b = new Set(after.split('\n'));
  const changed = [...b].filter((x) => !a.has(x)).map((x) => x.split('|')[0]);
  const gone = [...a].filter((x) => !b.has(x) && !changed.includes(x.split('|')[0])).map((x) => x.split('|')[0] + ' (removed)');
  return [...changed, ...gone];
}
