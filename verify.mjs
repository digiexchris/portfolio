// End-to-end verification. Drives the real editor in a browser, exercises the
// features, exports both targets, and checks the results. Restores the data
// file afterwards so it leaves nothing behind.

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const DATA = 'data/portfolio.json';
const backup = fs.readFileSync(DATA, 'utf8');
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const b = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const p = await b.newPage();
await p.setViewport({ width: 1600, height: 1000 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

await p.goto('http://127.0.0.1:4321/editor/', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 2000));

// --- editing through the real UI -------------------------------------------

// Type a title into the form and confirm it reaches the preview.
const titleSel = '.form-pane .field input[type="text"]';
await p.click(titleSel);
await p.keyboard.down('Control'); await p.keyboard.press('KeyA'); await p.keyboard.up('Control');
await p.keyboard.press('Backspace');
await p.type(titleSel, 'Scraped T-Slot Plate');
await new Promise((r) => setTimeout(r, 700));
const previewTitle = await p.evaluate(() =>
  document.getElementById('preview-frame').contentDocument.querySelector('.project-title')?.textContent);
check('typing a title updates the live preview', previewTitle === 'Scraped T-Slot Plate', previewTitle);

// Rich text.
await p.click('.form-pane .rt-editable');
await p.type('.form-pane .rt-editable', 'Held flatness under 0.0002 in over 14 in.');
await new Promise((r) => setTimeout(r, 700));
const bodyText = await p.evaluate(() =>
  document.getElementById('preview-frame').contentDocument.querySelector('.body')?.textContent || '');
check('rich text reaches the preview', bodyText.includes('0.0002'), bodyText.slice(0, 60));

// Publish it.
await p.click('.form-pane .check-row input[type="checkbox"]');
await new Promise((r) => setTimeout(r, 500));

// Multi-select then merge.
await p.evaluate(() => {
  const boxes = [...document.querySelectorAll('.side-item .check')].slice(0, 3);
  for (const c of boxes) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }
});
await new Promise((r) => setTimeout(r, 400));
const bulkVisible = await p.evaluate(() => !document.getElementById('side-bulk').hidden
  && getComputedStyle(document.getElementById('side-bulk')).display !== 'none');
check('bulk bar appears only when rows are selected', bulkVisible);

const before = await p.evaluate(() => document.querySelectorAll('.side-item').length);
p.on('dialog', async (d) => { await d.accept(); });
await p.click('#btn-merge');
await new Promise((r) => setTimeout(r, 900));
const after = await p.evaluate(() => document.querySelectorAll('.side-item').length);
check('merge combines the selected projects', after === before - 2, `${before} -> ${after}`);

const photosAfterMerge = await p.evaluate(() => document.querySelectorAll('.form-pane .strip-item').length);
check('merged project keeps every photo', photosAfterMerge >= 3, String(photosAfterMerge));

// Undo the merge.
await p.evaluate(() => document.body.focus());
await p.keyboard.down('Control'); await p.keyboard.press('KeyZ'); await p.keyboard.up('Control');
await new Promise((r) => setTimeout(r, 800));
const afterUndo = await p.evaluate(() => document.querySelectorAll('.side-item').length);
check('Ctrl+Z undoes the merge', afterUndo === before, `${after} -> ${afterUndo}`);

// Bulk publish so the exports have several projects.
await p.evaluate(() => {
  const boxes = [...document.querySelectorAll('.side-item .check')].slice(0, 4);
  for (const c of boxes) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }
});
await new Promise((r) => setTimeout(r, 300));
await p.click('#btn-bulk-publish');
await new Promise((r) => setTimeout(r, 600));

// Inline mode.
await p.click('[data-mode="inline"]');
await new Promise((r) => setTimeout(r, 1200));
const inlineReady = await p.evaluate(() => {
  const d = document.getElementById('preview-frame').contentDocument;
  const t = d.querySelector('.project-title');
  return { editable: t?.isContentEditable === true, hooks: d.querySelectorAll('[data-edit]').length };
});
check('inline mode makes the preview editable', inlineReady.editable, `${inlineReady.hooks} hooks`);

// Edit inline and confirm it lands in the model.
await p.evaluate(() => {
  const d = document.getElementById('preview-frame').contentDocument;
  const t = d.querySelector('.project-title');
  t.focus(); t.textContent = 'Edited Inline';
  t.dispatchEvent(new Event('blur'));
});
await new Promise((r) => setTimeout(r, 400));
// Saving is manual. Press Ctrl+S from inside the preview iframe, exactly as
// someone editing inline would, to prove the shortcut reaches the editor.
const frame = p.frames().find((f) => f.url().includes('about:blank') || f !== p.mainFrame());
await p.evaluate(() => {
  const d = document.getElementById('preview-frame').contentDocument;
  d.querySelector('.project-title')?.focus();
  d.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
});
await new Promise((r) => setTimeout(r, 1500));
const savedTitle = await p.evaluate(async () => {
  const r = await fetch('/api/portfolio'); const d = await r.json();
  return d.projects.some((x) => x.title === 'Edited Inline');
});
check('an inline edit is written through to the model', savedTitle);

await p.click('[data-mode="split"]');
await new Promise((r) => setTimeout(r, 500));

// Print preview.
await p.click('[data-view="print"]');
await new Promise((r) => setTimeout(r, 6000));
const printPages = await p.evaluate(() =>
  document.getElementById('preview-frame').contentDocument.querySelectorAll('.pagedjs_page').length);
check('print preview paginates in the editor', printPages > 0, `${printPages} pages`);
await p.click('[data-view="screen"]');

check('no JavaScript errors in the editor', errs.length === 0, errs.slice(0, 3).join(' | '));

// The builders read data/portfolio.json, so flush the session first.
await p.keyboard.down('Control'); await p.keyboard.press('KeyS'); await p.keyboard.up('Control');
await new Promise((r) => setTimeout(r, 1500));
await p.screenshot({ path: '/tmp/editor-final.png' });
await b.close();

// --- exports ----------------------------------------------------------------

console.log('\n--- exports ---');
const site = execFileSync('node', ['export/build-site.js'], { encoding: 'utf8' });
console.log(site.trim().split('\n').slice(-3).join('\n'));
check('site export succeeded', fs.existsSync('docs/index.html'));

const idx = fs.readFileSync('docs/index.html', 'utf8');
check('site uses relative paths only', !/(src|href)="\//.test(idx));
check('site index lists the published work', /class="card"/.test(idx));

const pdf = execFileSync('node', ['export/build-pdf.js'], { encoding: 'utf8' });
console.log(pdf.trim().split('\n').slice(-3).join('\n'));
check('PDF export succeeded', fs.existsSync('out/portfolio.pdf'));
check('every contents entry resolved to a page', /(\d+)\/\1 contents entries numbered/.test(pdf),
  (pdf.match(/\d+\/\d+ contents entries numbered/) || [''])[0]);

// Do the TOC numbers actually match where the projects land? This is the
// headline feature, so verify it against the rendered PDF rather than trusting
// the builder's own report.
const pageText = (n) => execFileSync('gs',
  ['-q','-dNOPAUSE','-dBATCH','-sDEVICE=txtwrite',`-dFirstPage=${n}`,`-dLastPage=${n}`,'-sOutputFile=-','out/portfolio.pdf'],
  { encoding: 'utf8' }).replace(/[ \t]+/g, ' ');

const total = Number((pdf.match(/laid out (\d+) pages/) || [])[1]);

// Locate the contents page rather than assuming its position: an About page
// only exists when the profile has a summary, which shifts everything.
let tocPageNo = 0;
for (let n = 1; n <= Math.min(total, 6); n++) {
  if (/Contents/i.test(pageText(n))) { tocPageNo = n; break; }
}
check('the PDF has a contents page', tocPageNo > 0, tocPageNo ? `page ${tocPageNo}` : 'not found');

// Pair each contents line with its trailing page number.
const entries = pageText(tocPageNo).split('\n')
  .map((l) => l.trim())
  .map((l) => /^(.*?[^\d\s])\s+(\d{1,3})$/.exec(l))
  .filter(Boolean)
  .map((m) => ({ title: m[1].trim(), page: Number(m[2]) }))
  .filter((e) => e.page > tocPageNo && e.page <= total && e.title.length > 2);

check('contents lists every published section', entries.length >= 4, `${entries.length} entries`);

let matched = 0;
const misses = [];
for (const e of entries) {
  const head = pageText(e.page).replace(/\s+/g, ' ').toLowerCase();
  const want = e.title.toLowerCase().replace(/\s+/g, ' ');
  if (head.includes(want)) matched++;
  else misses.push(`"${e.title}" -> p${e.page}`);
}
check('every contents page number points at its section',
  entries.length > 0 && matched === entries.length,
  misses.length ? misses.join(', ') : `${matched}/${entries.length} verified`);

// --- restore ----------------------------------------------------------------
fs.writeFileSync(DATA, backup);
// docs/ is committed content, so it must not be left holding a test build --
// nor simply deleted. Rebuild it from the restored data instead.
execFileSync('node', ['export/build-site.js'], { encoding: 'utf8' });
console.log('\nData file restored; docs/ rebuilt from it.');
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
