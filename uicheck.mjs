// Read-only tour of the existing editors. Clicks "+ New" to reveal the
// testimonial form but never saves, so data/portfolio.json is untouched.
import puppeteer from 'puppeteer-core';
const b=await puppeteer.launch({executablePath:'/usr/bin/chromium',headless:'new',args:['--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage(); await p.setViewport({width:1500,height:1050});
await p.goto('http://127.0.0.1:4321/editor/',{waitUntil:'networkidle0'});
await new Promise(r=>setTimeout(r,2000));

// Testimonials: click + New to show the form that appears.
await p.evaluate(()=>document.querySelector('.side-tab[data-section="testimonials"]').click());
await new Promise(r=>setTimeout(r,600));
await p.click('#btn-add');
await new Promise(r=>setTimeout(r,900));
const tFields = await p.evaluate(()=>[...document.querySelectorAll('.form-pane .field > label, .form-pane .field-label, .form-pane .check-row label')].map(n=>n.textContent.trim()));
console.log('TESTIMONIAL form fields:', JSON.stringify(tFields));
await p.screenshot({path:'/tmp/tour-testimonials.png'});

// Profile = the About page.
await p.evaluate(()=>document.querySelector('.side-tab[data-section="profile"]').click());
await new Promise(r=>setTimeout(r,900));
const pFields = await p.evaluate(()=>[...document.querySelectorAll('.form-pane .field > label, .form-pane .field-label, .form-pane legend')].map(n=>n.textContent.trim()));
console.log('PROFILE form fields:', JSON.stringify(pFields));
await p.screenshot({path:'/tmp/tour-profile.png'});

console.log('dirty (unsaved, will be discarded):', await p.evaluate(()=>/unsaved/i.test(document.getElementById('status').textContent)));
await b.close();
