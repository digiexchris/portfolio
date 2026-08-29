// Checks manual-save behaviour: nothing saves on its own, typing is never
// clobbered by a save, and leaving with pending edits is blocked.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const DATA = 'data/portfolio.json';
const backup = fs.readFileSync(DATA, 'utf8');
let fail = 0;
const check = (n, ok, d = '') => { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const onDisk = () => JSON.parse(fs.readFileSync(DATA, 'utf8'));

const b = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const p = await p0(b);
async function p0(br) {
  const pg = await br.newPage();
  await pg.setViewport({ width: 1600, height: 1000 });
  return pg;
}
const errs = [];
p.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

await p.goto('http://127.0.0.1:4321/editor/', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 2500));

const titleSel = '.form-pane .field input[type="text"]';
const MARK = 'AUTOSAVE-PROBE-' + Date.now();

// --- nothing saves on its own ----------------------------------------------
await p.click(titleSel);
await p.keyboard.down('Control'); await p.keyboard.press('KeyA'); await p.keyboard.up('Control');
await p.keyboard.press('Backspace');
await p.type(titleSel, MARK);

// Wait well past the old 1200ms autosave debounce.
await new Promise((r) => setTimeout(r, 4000));
check('nothing is written to disk without an explicit save',
  !JSON.stringify(onDisk()).includes(MARK));
check('the UI reports unsaved changes',
  /unsaved/i.test(await p.$eval('#status', (n) => n.textContent)));
check('the Save button calls for attention',
  await p.$eval('#btn-save', (n) => n.classList.contains('primary')));

// --- the reset bug: keep typing across a save ------------------------------
// Save while the caret is in the field, then keep typing. The old code swapped
// the whole document for the server's reply and rebuilt the form pane, which
// wiped whatever was mid-entry.
await p.click(titleSel);
await p.keyboard.press('End');
await p.keyboard.down('Control'); await p.keyboard.press('KeyS'); await p.keyboard.up('Control');
await p.keyboard.type('-TAIL');
await new Promise((r) => setTimeout(r, 1200));
const fieldNow = await p.$eval(titleSel, (n) => n.value);
check('typing straight through a save is not clobbered',
  fieldNow === MARK + '-TAIL', fieldNow);
check('the field keeps focus across a save',
  await p.evaluate((s) => document.activeElement === document.querySelector(s), titleSel));

// --- explicit save does persist --------------------------------------------
await p.click('#btn-save');
await new Promise((r) => setTimeout(r, 1200));
check('an explicit save writes to disk', JSON.stringify(onDisk()).includes(MARK + '-TAIL'));
check('the UI returns to a saved state',
  /saved/i.test(await p.$eval('#status', (n) => n.textContent)));
check('the Save button settles', !await p.$eval('#btn-save', (n) => n.classList.contains('primary')));

// --- leaving with pending edits is blocked ---------------------------------
await p.type(titleSel, '-MORE');
await new Promise((r) => setTimeout(r, 400));
let prompted = false;
p.on('dialog', async (d) => { prompted = true; await d.dismiss(); });
await p.evaluate(() => { window.location.reload(); }).catch(() => {});
await new Promise((r) => setTimeout(r, 2500));
const stillHere = await p.$eval(titleSel, (n) => n.value).catch(() => null);
check('leaving with unsaved changes is challenged',
  prompted || stillHere === null || /MORE/.test(stillHere || ''),
  prompted ? 'dialog shown' : `field=${stillHere}`);

check('no JavaScript errors', errs.length === 0, errs.slice(0, 3).join(' | '));

await b.close();
fs.writeFileSync(DATA, backup);
console.log('\nData file restored.');
console.log(fail ? `${fail} FAILED` : 'All checks passed.');
process.exit(fail ? 1 : 0);
