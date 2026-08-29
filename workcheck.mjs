// The Work page intro: its own field, separate from the About text, rendered
// above the gallery. Restores data/portfolio.json afterwards.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const DATA='data/portfolio.json';
const backup=fs.readFileSync(DATA,'utf8');
let fail=0; const check=(n,ok,d='')=>{if(!ok)fail++;console.log(`${ok?'PASS':'FAIL'}  ${n}${d?'  — '+d:''}`);};

const b=await puppeteer.launch({executablePath:'/usr/bin/chromium',headless:'new',args:['--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage(); await p.setViewport({width:1500,height:1000});
const errs=[]; p.on('pageerror',e=>errs.push(e.message.slice(0,160)));
await p.goto('http://127.0.0.1:4321/editor/',{waitUntil:'networkidle0'});
await new Promise(r=>setTimeout(r,2200));

const row = await p.evaluate(()=>{const r=document.querySelector('.side-item.is-page');
  return r? r.textContent.trim() : null;});
check('the Work tab has a page row', !!row, row || 'not found');

await p.evaluate(()=>document.querySelector('.side-item.is-page').click());
await new Promise(r=>setTimeout(r,800));
const heading = await p.$eval('.form-pane h2', n=>n.textContent);
check('it opens a Work page editor', heading === 'Work page', heading);

const MARK='Shop work: engines, tooling, and motorcycle repair.';
await p.click('.form-pane .rt-editable');
await p.keyboard.type(MARK);
await new Promise(r=>setTimeout(r,700));

const inPreview = await p.evaluate(()=>{
  const d=document.getElementById('preview-frame').contentDocument;
  const intro=d.querySelector('.intro-summary');
  const grid=d.querySelector('.grid');
  if(!intro) return null;
  return { text:intro.textContent.trim(),
    aboveGallery: grid ? !!(intro.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING) : null };
});
check('it shows on the Work page preview', inPreview && inPreview.text.includes('Shop work'),
  inPreview? inPreview.text.slice(0,50) : 'not rendered');
check('  above the gallery', inPreview && inPreview.aboveGallery === true);

await p.keyboard.down('Control'); await p.keyboard.press('KeyS'); await p.keyboard.up('Control');
await new Promise(r=>setTimeout(r,1400));
const saved=JSON.parse(fs.readFileSync(DATA,'utf8'));
check('it saves to home.intro', (saved.home?.intro||'').includes('Shop work'), JSON.stringify(saved.home));
check('  and does not touch the About text',
  saved.profile.summary === JSON.parse(backup).profile.summary);

// The two must be independent in both directions.
check('the About text is not on the Work page',
  !(inPreview.text.includes('rural Alberta') || inPreview.text.includes('Standard Aero')));

execFileSync('node',['export/build-site.js'],{encoding:'utf8'});
const idx=fs.readFileSync('docs/index.html','utf8');
const about=fs.readFileSync('docs/about.html','utf8');
check('the exported index carries the Work intro', idx.includes('Shop work'));
check('the exported About page does not', !about.includes('Shop work'));
const aboutText=JSON.parse(backup).profile.summary.replace(/<[^>]+>/g,'').slice(0,40);
check('the About text stays on the About page', !aboutText || about.includes(aboutText.slice(0,30)));
// Check the rendered page, not the raw file: a meta description legitimately
// mentions the site, and matching on raw HTML would confuse the two.
const ip=await b.newPage();
await ip.goto('http://127.0.0.1:4321/docs/index.html',{waitUntil:'networkidle0'});
const shown=await ip.evaluate(()=>document.querySelector('main').innerText.replace(/\s+/g,' '));
const meta=await ip.evaluate(()=>document.querySelector('meta[name=description]')?.content||'');
await ip.close();
check('  and is gone from the index body', !aboutText || !shown.includes(aboutText.slice(0,30)),
  shown.slice(0,60));
check('the index meta description uses the Work intro', meta.includes('Shop work'), meta.slice(0,60));

check('no JavaScript errors', errs.length===0, errs.slice(0,2).join(' | '));

await b.close();
fs.writeFileSync(DATA, backup);
execFileSync('node',['export/build-site.js'],{encoding:'utf8'});
console.log('\nData restored, docs/ rebuilt.');
console.log(fail?`${fail} FAILED`:'All checks passed.');
process.exit(fail?1:0);
