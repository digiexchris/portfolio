// Types into the real editor the way the bug was triggered, saves, and reads
// the file back. Restores data/portfolio.json afterwards.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const DATA='data/portfolio.json';
const backup=fs.readFileSync(DATA,'utf8');
let fail=0; const check=(n,ok,d='')=>{if(!ok)fail++;console.log(`${ok?'PASS':'FAIL'}  ${n}${d?'  — '+d:''}`);};
const onDisk=()=>JSON.parse(fs.readFileSync(DATA,'utf8'));

const b=await puppeteer.launch({executablePath:'/usr/bin/chromium',headless:'new',args:['--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage(); await p.setViewport({width:1500,height:1000});
await p.goto('http://127.0.0.1:4321/editor/',{waitUntil:'networkidle0'});
await new Promise(r=>setTimeout(r,2200));

const rt='.form-pane .rt-editable';
await p.click(rt);
// Trailing space, double space, and an ampersand — the three triggers.
await p.keyboard.type('held flat ');
await p.keyboard.press('Enter');
await p.keyboard.type('4  very nice cams & counting ');
await new Promise(r=>setTimeout(r,500));

const domHtml=await p.evaluate((s)=>document.querySelector(s).innerHTML, rt);
check('the browser really does emit nbsp', /&nbsp;| /.test(domHtml), JSON.stringify(domHtml.slice(0,80)));

// Save three times — this is what used to compound the corruption.
for (let i=0;i<3;i++){
  await p.keyboard.down('Control'); await p.keyboard.press('KeyS'); await p.keyboard.up('Control');
  await new Promise(r=>setTimeout(r,900));
}

const raw=fs.readFileSync(DATA,'utf8');
check('no nbsp reaches the file', !/nbsp| /.test(raw));
check('no double-escaped entity', !/&amp;amp;/.test(raw));

const proj=onDisk().projects.find(x=>/held flat/.test(x.body||''));
check('the text saved', !!proj, proj? 'found' : 'not found');
if (proj) {
  console.log('       stored: ' + JSON.stringify(proj.body));
  check('trailing space cleaned', !/ <\/p>/.test(proj.body));
  check('double space collapsed', !/  /.test(proj.body.replace(/<[^>]+>/g,'')));
  check('the ampersand survived', /&amp; counting/.test(proj.body));
  check('no literal amp; visible', !/amp;amp/.test(proj.body));
}

await b.close();
fs.writeFileSync(DATA, backup);
console.log('\nData restored.');
console.log(fail?`${fail} FAILED`:'All checks passed.');
process.exit(fail?1:0);
