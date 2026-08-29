// Checks the published docs/ folder is servable by GitHub Pages as-is.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

let fail = 0;
const check = (n, ok, d = '') => { if (!ok) fail++; console.log(`${ok?'PASS':'FAIL'}  ${n}${d?'  — '+d:''}`); };

check('docs/ exists', fs.existsSync('docs/index.html'));
check('.nojekyll present', fs.existsSync('docs/.nojekyll'));
check('portfolio.pdf published', fs.existsSync('docs/portfolio.pdf'),
  fs.existsSync('docs/portfolio.pdf') ? `${(fs.statSync('docs/portfolio.pdf').size/1048576).toFixed(1)} MB` : '');
check('no draft preview leaked into docs/', !fs.existsSync('docs/preview'));

// Nothing may reference a path outside docs/, or Pages would 404 it.
const pages = [];
const walk = (d) => { for (const e of fs.readdirSync(d, {withFileTypes:true})) {
  const f = path.join(d, e.name);
  if (e.isDirectory()) walk(f); else if (e.name.endsWith('.html')) pages.push(f); } };
walk('docs');
check('every page built', pages.length >= 4, `${pages.length} pages`);

const bad = [];
for (const f of pages) {
  const html = fs.readFileSync(f, 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const u = m[1];
    if (/^(https?:|mailto:|tel:|data:|#)/.test(u)) continue;
    if (u.startsWith('/')) { bad.push(`${f}: absolute ${u}`); continue; }
    const abs = path.resolve(path.dirname(f), u.split('#')[0].split('?')[0]);
    if (!abs.startsWith(path.resolve('docs'))) { bad.push(`${f}: escapes docs/ -> ${u}`); continue; }
    if (!fs.existsSync(abs)) bad.push(`${f}: missing ${u}`);
  }
}
check('every link and asset resolves inside docs/', bad.length === 0, bad.slice(0,4).join(' | '));

// Serve docs/ the way Pages would — as a plain static root — and load it.
const http = await import('node:http');
const MIME = {'.html':'text/html','.css':'text/css','.js':'text/javascript','.jpg':'image/jpeg','.png':'image/png','.pdf':'application/pdf'};
const srv = http.createServer((req,res)=>{
  let f = path.join('docs', decodeURIComponent(req.url.split('?')[0]));
  if (f.endsWith('/')) f += 'index.html';
  if (!path.resolve(f).startsWith(path.resolve('docs'))) { res.writeHead(403); return res.end(); }
  fs.readFile(f,(e,b)=>{ if(e){res.writeHead(404);return res.end('nf');}
    res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'}); res.end(b); });
});
await new Promise(r=>srv.listen(4399,'127.0.0.1',r));

const b = await puppeteer.launch({executablePath:'/usr/bin/chromium',headless:'new',args:['--no-sandbox','--disable-dev-shm-usage']});
const p = await b.newPage();
const missing = [];
p.on('response', r => { if (r.status() >= 400) missing.push(`${r.status()} ${r.url().replace('http://127.0.0.1:4399','')}`); });
await p.goto('http://127.0.0.1:4399/', {waitUntil:'networkidle0'});
const home = await p.evaluate(()=>({cards:document.querySelectorAll('.card').length,
  pdf:document.querySelector('.pdf-link')?.getAttribute('href')}));
check('home page serves and lists work', home.cards > 0, `${home.cards} cards`);
check('PDF link present in the nav', home.pdf === 'portfolio.pdf', String(home.pdf));

await p.evaluate(()=>document.querySelector('.card-link').click());
await p.waitForNavigation({waitUntil:'networkidle0'});
await p.evaluate(async()=>{for(let y=0;y<document.body.scrollHeight;y+=600){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,50));}});
await new Promise(r=>setTimeout(r,1200));
const proj = await p.evaluate(()=>({title:document.querySelector('.project-title')?.textContent,
  imgs:[...document.querySelectorAll('img[src]')].filter(i=>i.complete&&i.naturalWidth>0).length,
  total:document.querySelectorAll('img[src]').length}));
check('a project page serves with its photos', !!proj.title && proj.imgs===proj.total,
  `${proj.title}, ${proj.imgs}/${proj.total} images`);

const pdfRes = await p.goto('http://127.0.0.1:4399/portfolio.pdf');
check('the PDF is fetchable over HTTP', pdfRes.status()===200, `HTTP ${pdfRes.status()}`);

check('no 404s while browsing', missing.length===0, missing.slice(0,3).join(' | '));

// The Testimonials link is conditional, so prove both directions: it must
// appear -- with a page behind it -- as soon as there is one to show.
const DATA = 'data/portfolio.json';
const backup = fs.readFileSync(DATA, 'utf8');
try {
  const { execFileSync } = await import('node:child_process');
  const d = JSON.parse(backup);
  d.testimonials.push({ id: 'pagescheck-tmp', quote: '<p>Good work.</p>', author: 'A Client',
    role: '', company: '', date: '', projectId: null, image: null, featured: false,
    published: true, order: 0 });
  fs.writeFileSync(DATA, JSON.stringify(d, null, 2));
  execFileSync('node', ['export/build-site.js'], { encoding: 'utf8' });

  check('testimonials page is built when there is one', fs.existsSync('docs/testimonials.html'));
  const nav = fs.readFileSync('docs/index.html', 'utf8');
  check('and the nav links to it', /href="testimonials\.html"/.test(nav));

  const tp = await b.newPage();
  const r = await tp.goto('http://127.0.0.1:4399/testimonials.html', { waitUntil: 'networkidle0' });
  const quote = await tp.evaluate(() => document.querySelector('.quote')?.textContent?.trim());
  check('the page serves with the quote on it', r.status() === 200 && /Good work/.test(quote || ''),
    `HTTP ${r.status()}, ${JSON.stringify(quote)}`);
  await tp.close();
} finally {
  fs.writeFileSync(DATA, backup);
  const { execFileSync } = await import('node:child_process');
  execFileSync('node', ['export/build-site.js'], { encoding: 'utf8' });
}
check('docs/ restored to the real data', !fs.existsSync('docs/testimonials.html'));

await b.close(); srv.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll checks passed.');
process.exit(fail?1:0);
