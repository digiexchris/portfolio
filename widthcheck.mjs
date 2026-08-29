import puppeteer from 'puppeteer-core';
let fail=0; const check=(n,ok,d='')=>{if(!ok)fail++;console.log(`${ok?'PASS':'FAIL'}  ${n}${d?'  — '+d:''}`);};
const b=await puppeteer.launch({executablePath:'/usr/bin/chromium',headless:'new',args:['--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage(); await p.setViewport({width:1400,height:1200});
const errs=[]; p.on('pageerror',e=>errs.push(e.message.slice(0,150)));

const base='http://127.0.0.1:4321/preview/';
await p.goto(base+'index.html',{waitUntil:'networkidle0'});
const idx=await p.evaluate(()=>({cards:document.querySelectorAll('.card').length,
  overflow:document.documentElement.scrollWidth>window.innerWidth+1}));
check('index still renders',idx.cards>50,`${idx.cards} cards`);
check('index does not scroll sideways',!idx.overflow);

const href=await p.evaluate(()=>{const a=[...document.querySelectorAll('.card-link')];
  return (a.find(x=>/cubic/i.test(x.textContent))||a[0]).href;});
await p.goto(href,{waitUntil:'networkidle0'});
const w=await p.evaluate(()=>{const g=s=>{const e=document.querySelector(s);
  return e?Math.round(e.getBoundingClientRect().width):null;};
  return {img:g('.feature-photo img'),lede:g('.lede'),prose:g('.body'),grid:g('.photo-grid'),
    overflow:document.documentElement.scrollWidth>window.innerWidth+1};});
check('summary matches the photo width',w.lede===w.img,`lede ${w.lede} vs img ${w.img}`);
check('writeup matches the photo width',w.prose===w.img,`prose ${w.prose} vs img ${w.img}`);
check('photo grid matches too',w.grid===w.img,`grid ${w.grid} vs img ${w.img}`);
check('project page does not scroll sideways',!w.overflow);

// Line length stays in a sane range.
const chars=await p.evaluate(()=>{
  const par=document.querySelector('.body p'); if(!par) return null;
  const cs=getComputedStyle(par);
  const cv=document.createElement('canvas').getContext('2d');
  cv.font=`${cs.fontSize} ${cs.fontFamily}`;
  const avg=cv.measureText('abcdefghijklmnopqrstuvwxyz ').width/27;
  return Math.round(par.getBoundingClientRect().width/avg);
});
check('line length stays readable',chars!==null&&chars>=60&&chars<=95,`${chars} characters`);

// A testimonials page only exists once there is a testimonial, so skip it
// rather than reporting a missing page as a layout failure.
for (const [page,sel] of [['about.html','.about'],['testimonials.html','.testimonial-list']]) {
  const res=await p.goto(base+page,{waitUntil:'networkidle0'}).catch(()=>null);
  if(!res||res.status()>=400){console.log(`SKIP  ${page} not built (nothing to show yet)`);continue;}
  const ok=await p.evaluate((s)=>{const e=document.querySelector(s);
    return !!e && document.documentElement.scrollWidth<=window.innerWidth+1;},sel).catch(()=>false);
  check(`${page} renders without sideways scroll`,ok);
}

// Narrow viewport.
await p.setViewport({width:420,height:900});
await p.goto(href,{waitUntil:'networkidle0'});
const mob=await p.evaluate(()=>({overflow:document.documentElement.scrollWidth>window.innerWidth+1,
  img:Math.round(document.querySelector('.feature-photo img').getBoundingClientRect().width)}));
check('mobile width does not overflow',!mob.overflow,`img ${mob.img}px in 420px`);

check('no JavaScript errors',errs.length===0,errs.slice(0,2).join(' | '));
await b.close();
console.log(fail?`\n${fail} FAILED`:'\nAll checks passed.');
process.exit(fail?1:0);
