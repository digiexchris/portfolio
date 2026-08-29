// The About photo: pick one in the editor, confirm it reaches the site and PDF.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const DATA='data/portfolio.json';
const backup=fs.readFileSync(DATA,'utf8');
let fail=0; const check=(n,ok,d='')=>{if(!ok)fail++;console.log(`${ok?'PASS':'FAIL'}  ${n}${d?'  — '+d:''}`);};

// --allow-file-access-from-files is needed to inspect the paginated print
// document, which loads its stylesheets, Paged.js and images over file://.
const b=await puppeteer.launch({executablePath:'/usr/bin/chromium',headless:'new',
  args:['--no-sandbox','--disable-dev-shm-usage','--allow-file-access-from-files']});
const p=await b.newPage(); await p.setViewport({width:1500,height:1000});
const errs=[]; p.on('pageerror',e=>errs.push(e.message.slice(0,160)));
await p.goto('http://127.0.0.1:4321/editor/',{waitUntil:'networkidle0'});
await new Promise(r=>setTimeout(r,2200));

check('the Split/Inline toggle is gone', await p.evaluate(()=>!document.querySelector('[data-mode]')));

// The project photo strip, on the Work tab where it lives.
const strip = await p.evaluate(()=>{
  const i=document.querySelector('.strip-item img'); if(!i) return null;
  const r=i.getBoundingClientRect(); const box=i.closest('.strip-item').getBoundingClientRect();
  return { h:r.height, ratio:r.width/r.height, fits:r.height<=box.height+1 };
});
check('the project photo strip is not collapsed',
  !!strip && strip.h > 50 && strip.ratio > 1.1 && strip.ratio < 1.9 && strip.fits,
  strip ? `${Math.round(strip.h)}px, ratio ${strip.ratio.toFixed(2)}` : 'no photo strip found');

await p.evaluate(()=>document.querySelector('.side-tab[data-section="profile"]').click());
await new Promise(r=>setTimeout(r,700));
const labels = await p.evaluate(()=>[...document.querySelectorAll('.form-pane .field-label, .form-pane .field > label, .form-pane legend')].map(n=>n.textContent.trim()));
check('the About editor now offers a Photo field', labels.includes('Photo'), labels.join(', '));

// Pick the first photo from the library.
await p.evaluate(()=>[...document.querySelectorAll('.strip-add')].pop().click());
await new Promise(r=>setTimeout(r,900));
check('the media picker opens', await p.evaluate(()=>!document.getElementById('drawer').hidden));

// The picker grid sits in a fixed-height flex column, where `auto` rows
// collapse instead of sizing to content: tiles got squashed to the height of
// the filename and the photo cropped to a strip.
const tiles = await p.evaluate(()=>[...document.querySelectorAll('.media-item')].slice(0,6).map(it=>{
  const box=it.getBoundingClientRect();
  const img=it.querySelector('img').getBoundingClientRect();
  const nm=it.querySelector('.name').getBoundingClientRect();
  return { tileH: box.height, imgH: img.height, imgRatio: img.width/img.height,
           nameVisible: nm.height > 0 && nm.bottom <= box.bottom + 1,
           imgFits: img.height <= box.height + 1 };
}));
check('picker tiles are not collapsed', tiles.every(t=>t.tileH > 100),
  `heights ${[...new Set(tiles.map(t=>Math.round(t.tileH)))].join(',')}`);
check('  thumbnails keep a photo-shaped ratio',
  tiles.every(t=>t.imgRatio > 1.1 && t.imgRatio < 1.6),
  `ratios ${[...new Set(tiles.map(t=>t.imgRatio.toFixed(2)))].join(',')}`);
check('  the whole thumbnail is visible', tiles.every(t=>t.imgFits));
check('  filenames are readable', tiles.every(t=>t.nameVisible));

const chosen = await p.evaluate(()=>{
  const item=document.querySelector('.media-item'); const name=item.querySelector('.name').textContent;
  item.click(); return name;
});
await new Promise(r=>setTimeout(r,900));
check('a photo is selected', !!chosen, chosen);

const inPreview = await p.evaluate(()=>{
  const d=document.getElementById('preview-frame').contentDocument;
  const f=d.querySelector('figure.portrait img');
  if(!f) return null;
  const prose=d.querySelector('.prose');
  return { src:f.getAttribute('src'), belowText: prose ? !!(prose.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING) : null };
});
check('it appears in the live preview', !!inPreview, inPreview? inPreview.src : 'not rendered');
if (inPreview && inPreview.belowText !== null) check('  below the About text', inPreview.belowText === true);

await p.keyboard.down('Control'); await p.keyboard.press('KeyS'); await p.keyboard.up('Control');
await new Promise(r=>setTimeout(r,1400));
check('it saves', !!JSON.parse(fs.readFileSync(DATA,'utf8')).profile.photo);

execFileSync('node',['export/build-site.js'],{encoding:'utf8'});
const about=fs.readFileSync('docs/about.html','utf8');
check('it reaches the exported About page', /<figure class="portrait"><img src="[^"]+"/.test(about));
const m=about.match(/<figure class="portrait"><img src="([^"]+)"/);
check('  and the image file exists', m && fs.existsSync('docs/'+m[1]), m? m[1] : '');

// The photo must span the same column as the text above it -- no narrower cap.
const ap=await b.newPage();
await ap.goto('http://127.0.0.1:4321/docs/about.html',{waitUntil:'networkidle0'});
const w=await ap.evaluate(()=>{
  const g=s=>{const e=document.querySelector(s);return e?e.getBoundingClientRect().width:null;};
  return {prose:g('.about .prose'), para:g('.about .prose p'), img:g('figure.portrait img'), about:g('.about')};
});
await ap.close();
// Contact details belong above the prose, not buried after it.
const order=await b.newPage();
await order.goto('http://127.0.0.1:4321/docs/about.html',{waitUntil:'networkidle0'});
const seq=await order.evaluate(()=>{
  const about=document.querySelector('.about');
  const pick=s=>about.querySelector(s);
  const top=e=>e?e.getBoundingClientRect().top:null;
  return {h1:top(pick('h1')), contact:top(pick('.contact')),
          prose:top(pick('.prose')), photo:top(pick('figure.portrait'))};
});
await order.close();
check('contact details sit above the About text',
  seq.contact !== null && seq.prose !== null && seq.contact < seq.prose,
  `contact ${Math.round(seq.contact)}px, prose ${Math.round(seq.prose)}px`);
check('  and below the name', seq.h1 < seq.contact);
check('  with the photo last', seq.photo === null || seq.photo > seq.prose);

check('the About photo is as wide as the text',
  w.img !== null && Math.abs(w.img - w.prose) <= 1,
  `img ${Math.round(w.img)} vs prose ${Math.round(w.prose)}`);
check('  and fills the About column', Math.abs(w.img - w.about) <= 1,
  `img ${Math.round(w.img)} vs column ${Math.round(w.about)}`);

// The PDF builder collects its own image set, and used to leave this one out
// entirely -- the portrait rendered with an empty src.
execFileSync('node',['export/build-pdf.js'],{encoding:'utf8'});
const printDoc=fs.readFileSync('out/print/index.html','utf8');
const pm=printDoc.match(/<figure class="portrait"><img src="([^"]*)"/);
check('the PDF includes the About photo', !!pm && pm[1].length > 0, pm? `src="${pm[1]}"` : 'no portrait in the print document');
check('  and its file was produced', !!pm && pm[1] && fs.existsSync('out/print/'+pm[1]));

// An image cannot split across pages, so one placed after a full page of text
// gets pushed whole onto the next and lands there alone. Check the paginated
// document rather than the PDF: it is the same layout, and inspectable.
const pg=await b.newPage();
await pg.goto('file://'+process.cwd()+'/out/print/index.html',{waitUntil:'networkidle0'});
await pg.waitForFunction('window.__PAGED_READY === true',{timeout:60000});
const pages=await pg.evaluate(()=>[...document.querySelectorAll('.pagedjs_page')].map((box,i)=>{
  const c=box.querySelector('.pagedjs_page_content') || box;
  return { n:i+1,
    words:(c.innerText||'').trim().split(/\s+/).filter(Boolean).length,
    imgs:c.querySelectorAll('img').length,
    hasPortrait: !!c.querySelector('figure.portrait') };
}));
await pg.close();

const blank=pages.filter(x=>x.words===0 && x.imgs===0);
check('no page is completely blank', blank.length===0,
  blank.length? 'pages '+blank.map(x=>x.n).join(',') : `${pages.length} pages`);

const orphan=pages.filter(x=>x.hasPortrait && x.words<10 && x.imgs===1);
check('the About photo is not alone on a page', orphan.length===0,
  orphan.length? `page ${orphan[0].n} holds only the portrait` : 'shares its page with text');

const portraitPage=pages.find(x=>x.hasPortrait);
check('  it shares a page with the About text',
  !portraitPage || portraitPage.words > 20,
  portraitPage? `page ${portraitPage.n}, ${portraitPage.words} words` : 'no portrait');

check('no JavaScript errors', errs.length===0, errs.slice(0,2).join(' | '));

await b.close();
fs.writeFileSync(DATA, backup);
// This suite builds a PDF from a temporary About photo. Rebuild it from the
// real data, or the published docs/portfolio.pdf keeps the test's photo.
execFileSync('node',['export/build-pdf.js'],{encoding:'utf8'});
execFileSync('node',['export/build-site.js'],{encoding:'utf8'});
console.log('\nData restored, docs/ and out/ rebuilt.');
console.log(fail?`${fail} FAILED`:'All checks passed.');
process.exit(fail?1:0);
