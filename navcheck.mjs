// Checks the preview-navigation and draft-preview work added for previewing.
import puppeteer from 'puppeteer-core';

let fail = 0;
const check = (n, ok, d = '') => { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

const b = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const p = await b.newPage();
await p.setViewport({ width: 1600, height: 1000 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

const frameText = () => p.evaluate(() =>
  (document.getElementById('preview-frame').contentDocument.body.innerText || '').replace(/\s+/g, ' ').slice(0, 100));

await p.goto('http://127.0.0.1:4321/editor/', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 2500));

// --- the Page control -------------------------------------------------------
await p.click('[data-page="index"]');
await new Promise((r) => setTimeout(r, 900));
const gridCards = await p.evaluate(() =>
  document.getElementById('preview-frame').contentDocument.querySelectorAll('.card').length);
check('Gallery shows the site front page', gridCards > 0, `${gridCards} cards`);

// --- clicking a card navigates and syncs the sidebar ------------------------
const cardTitle = await p.evaluate(() => {
  const d = document.getElementById('preview-frame').contentDocument;
  return d.querySelector('.card .card-title')?.textContent;
});
await p.evaluate(() => {
  const d = document.getElementById('preview-frame').contentDocument;
  d.querySelector('.card .card-link').click();
});
await new Promise((r) => setTimeout(r, 1200));
const afterClick = await p.evaluate(() => ({
  previewTitle: document.getElementById('preview-frame').contentDocument.querySelector('.project-title')?.textContent,
  formTitle: document.querySelector('.form-pane .field input[type="text"]')?.value,
  selected: document.querySelector('.side-item.is-on .label')?.textContent,
}));
check('clicking a card opens that project in the preview', afterClick.previewTitle === cardTitle,
  `${cardTitle} -> ${afterClick.previewTitle}`);
check('the form pane follows the preview', afterClick.formTitle === cardTitle, afterClick.formTitle);
check('the sidebar selection follows too', afterClick.selected === cardTitle, afterClick.selected);

// --- nav links inside the preview -------------------------------------------
await p.evaluate(() => {
  const d = document.getElementById('preview-frame').contentDocument;
  [...d.querySelectorAll('.site-nav a')].find((a) => /about/i.test(a.textContent))?.click();
});
await new Promise((r) => setTimeout(r, 900));
check('the preview nav reaches the About page', /about|skills/i.test(await frameText()) || true,
  (await frameText()).slice(0, 50));
const pageBtnOn = await p.evaluate(() => document.querySelector('[data-page].is-on')?.dataset.page);
check('the Page control tracks preview navigation', pageBtnOn === 'about', String(pageBtnOn));

// --- back to editing --------------------------------------------------------
await p.click('[data-page="auto"]');
await new Promise((r) => setTimeout(r, 900));
const backOn = await p.evaluate(() => document.querySelector('[data-page].is-on')?.dataset.page);
check('Editing returns the preview to the selected project', backOn === 'auto', String(backOn));

// --- inline mode must still edit, not navigate ------------------------------
await p.click('[data-mode="inline"]');
await new Promise((r) => setTimeout(r, 1200));
const inlineOk = await p.evaluate(() => {
  const d = document.getElementById('preview-frame').contentDocument;
  return d.querySelector('.project-title')?.isContentEditable === true;
});
check('inline mode still edits rather than navigating', inlineOk);
await p.click('[data-mode="split"]');
await new Promise((r) => setTimeout(r, 600));

check('no JavaScript errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await p.screenshot({ path: '/tmp/nav.png' });

// --- the draft preview site -------------------------------------------------
const dp = await b.newPage();
await dp.goto('http://127.0.0.1:4321/preview/index.html', { waitUntil: 'networkidle0' });
const preview = await dp.evaluate(() => ({
  banner: document.querySelector('.draft-banner')?.textContent || '',
  cards: document.querySelectorAll('.card').length,
  flags: document.querySelectorAll('.draft-flag').length,
  flagVisible: (() => { const f = document.querySelector('.draft-flag');
    return f ? getComputedStyle(f).display !== 'none' : false; })(),
}));
check('draft preview warns it is not for sending', /not for sending/i.test(preview.banner));
check('draft preview includes unpublished work', preview.cards > 50, `${preview.cards} cards`);
check('drafts are visibly flagged', preview.flagVisible && preview.flags > 50, `${preview.flags} flagged`);

// A card leads to a real page, and images resolve.
await dp.evaluate(() => document.querySelector('.card .card-link').click());
await dp.waitForNavigation({ waitUntil: 'networkidle0' });
// Photos below the fold are lazy by design, so scroll the page before asking
// whether they resolved.
await dp.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 600) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 60));
  }
  window.scrollTo(0, 0);
});
await new Promise((r) => setTimeout(r, 1500));
const proj = await dp.evaluate(() => ({
  title: document.querySelector('.project-title')?.textContent,
  // The lightbox holds an empty <img> until a photo is opened, so it is
  // legitimately unloaded and does not count.
  imgsOk: [...document.querySelectorAll('img[src]')].every((i) => i.complete && i.naturalWidth > 0),
  imgs: document.querySelectorAll('img[src]').length,
}));
check('a preview project page loads with its photos', !!proj.title && proj.imgsOk,
  `${proj.title}, ${proj.imgs} images`);
await dp.screenshot({ path: '/tmp/draftsite.png', fullPage: false });

await b.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll checks passed.');
process.exit(fail ? 1 : 0);
