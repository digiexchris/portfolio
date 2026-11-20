// Drag-to-reorder in the sidebar, with and without the filter active. Drops
// are dispatched as real DragEvents in the page. Never saves; the data file is
// restored afterwards regardless.

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const DATA = 'data/portfolio.json';
const backup = fs.readFileSync(DATA, 'utf8');
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const b = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const p = await b.newPage();
await p.setViewport({ width: 1500, height: 1000 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
p.on('dialog', async (d) => { await d.dismiss(); });

try {
  await p.goto('http://127.0.0.1:4321/editor/', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1500));

  const labels = () => p.evaluate(() =>
    [...document.querySelectorAll('#side-list .side-item[draggable="true"] .label')].map((n) => n.title || n.textContent));
  const setFilter = async (v) => {
    await p.evaluate((v) => {
      const s = document.getElementById('side-search');
      s.value = v; s.dispatchEvent(new Event('input', { bubbles: true }));
    }, v);
    await new Promise((r) => setTimeout(r, 300));
  };
  // Drag visible row `from` onto visible row `to` (indices in the current sidebar).
  const drag = async (from, to) => {
    await p.evaluate((from, to) => {
      const rows = [...document.querySelectorAll('.side-item[draggable="true"]')];
      const dt = new DataTransfer();
      rows[from].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      rows[to].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      rows[to].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, from, to);
    await new Promise((r) => setTimeout(r, 300));
  };
  const undo = async () => {
    await p.evaluate(() => document.body.focus());
    await p.keyboard.down('Control'); await p.keyboard.press('KeyZ'); await p.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 400));
  };
  // Expected result of moving item a onto item b in `list` (same rule as the store).
  const moved = (list, a, b) => {
    const out = list.slice(); const [x] = out.splice(out.indexOf(a), 1);
    out.splice(list.indexOf(b), 0, x); return out;
  };

  const full = await labels();
  if (full.length < 3) {
    console.log('SKIP  drag reorder — fewer than 3 projects');
  } else {
    // Unfiltered: drag down and up.
    await drag(0, 2);
    let got = await labels();
    check('drag down (unfiltered) lands after the target', JSON.stringify(got) === JSON.stringify(moved(full, full[0], full[2])),
      got.slice(0, 3).join(' | '));
    await undo();
    await drag(2, 0);
    got = await labels();
    check('drag up (unfiltered) lands before the target', JSON.stringify(got) === JSON.stringify(moved(full, full[2], full[0])),
      got.slice(0, 3).join(' | '));
    await undo();
    check('undo restores the original order', JSON.stringify(await labels()) === JSON.stringify(full));

    // Filtered: find a word that matches >= 2 projects which are not adjacent,
    // so hidden projects sit between them — the case the old index bug broke.
    const lower = full.map((t) => t.toLowerCase());
    let word = null;
    for (const w of new Set(lower.flatMap((t) => t.split(/\s+/)).filter((w) => w.length >= 2))) {
      const idx = lower.map((t, i) => (t.includes(w) ? i : -1)).filter((i) => i >= 0);
      if (idx.length >= 2 && idx.length < full.length && idx.some((v, k) => k && v !== idx[k - 1] + 1)) { word = w; break; }
    }
    if (!word) {
      console.log('SKIP  filtered drag — no filter word separates projects');
    } else {
      await setFilter(word);
      // Drop the first match onto the last: hidden rows sit before the target,
      // so its visible index differs from its real one.
      const vis = await labels();
      const a = vis[0], z = vis[vis.length - 1];
      await drag(0, vis.length - 1);
      await setFilter('');
      got = await labels();
      const want = moved(full, a, z);
      check(`filtered drag ("${word}") lands next to the target in the full list`,
        JSON.stringify(got) === JSON.stringify(want),
        `${a} -> index ${got.indexOf(a)}, expected ${want.indexOf(a)}`);
      await undo();
    }
  }

  check('no page errors', errs.length === 0, errs.join(' / '));
} finally {
  await b.close();
  fs.writeFileSync(DATA, backup);
}

process.exit(failures ? 1 : 0);
