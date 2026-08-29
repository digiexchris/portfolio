// PDF export.
//
// Chromium's own print engine does not implement CSS cross-references, so
// `target-counter()` -- and therefore a table of contents with real page
// numbers -- cannot work from Chrome alone. Paged.js paginates the document in
// the DOM first, resolving every TOC entry to the page its project actually
// lands on; Chromium then just prints the already-paginated result.
//
//   node export/build-pdf.js              build out/portfolio.pdf
//   node export/build-pdf.js --html-only  write the print page, skip Chromium

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalise, publishedProjects, publishedTestimonials } from '../shared/model.js';
import { htmlDocument, printBody } from '../shared/render.js';
import sharp from 'sharp';
import { ImagePipeline, PRINT_WIDTH, COVER_WIDTH, buildStemMap } from './images.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA_ROOT = path.join(ROOT, 'media');
const OUT = path.join(ROOT, 'out');
const WORK = path.join(OUT, 'print');

const HTML_ONLY = process.argv.includes('--html-only');
const t0 = Date.now();

// Where a system Chromium usually lives. puppeteer-core ships no browser of
// its own, which is deliberate: this uses the one already on the machine.
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/brave-browser',
  '/usr/bin/microsoft-edge',
  '/snap/bin/chromium',
  '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
  `${os.homedir()}/.local/bin/chromium`,
].filter(Boolean);

function findChrome() {
  return CHROME_CANDIDATES.find((p) => { try { return fsSync.statSync(p).isFile(); } catch { return false; } }) || null;
}

async function main() {
  const data = normalise(JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'portfolio.json'), 'utf8')));
  const projects = publishedProjects(data);
  const testimonials = data.settings.pdf.includeTestimonials ? publishedTestimonials(data) : [];

  if (!projects.length) {
    console.log('Nothing to export: no projects are published yet.');
    console.log('Tick "Published" on the projects you want to include, then export again.');
    process.exit(0);
  }

  console.log(`Building PDF: ${projects.length} projects, ${testimonials.length} testimonials`);

  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(path.join(WORK, 'img'), { recursive: true });

  const pipe = new ImagePipeline({
    mediaRoot: MEDIA_ROOT,
    uploadsRoot: path.join(ROOT, 'data', 'uploads'),
    cacheDir: path.join(ROOT, '.cache', 'print'),
    quality: 85,
  });

  // --- images -------------------------------------------------------------
  const cover = data.settings.pdf.coverPhoto
    || (projects[0].photos.find((p) => p.feature) || projects[0].photos[0] || {}).src || '';

  const wanted = new Set();
  for (const p of projects) for (const ph of p.photos) wanted.add(ph.src);
  for (const t of testimonials) if (t.image) wanted.add(t.image);
  if (cover) wanted.add(cover);

  const stems = buildStemMap(wanted);

  console.log(`Processing ${wanted.size} photos at print resolution…`);
  const local = new Map();
  const dims = new Map();
  for (const src of wanted) {
    const width = src === cover ? COVER_WIDTH : PRINT_WIDTH;
    const name = `${stems.get(src)}-${width}.jpg`;
    const out = await pipe.emit(src, width, path.join(WORK, 'img'), name);
    if (!out) continue;
    local.set(src, 'img/' + name);
    // Real dimensions of the emitted file, so the layout is settled before
    // Paged.js measures anything.
    const meta = await sharp(out).metadata();
    dims.set(src, { width: meta.width, height: meta.height });
  }
  pipe.report('Images');

  // --- document -----------------------------------------------------------
  const ctx = {
    img: (src) => (src && local.get(src)) || '',
    href: () => '#',
    editable: false,
    srcset: false,
    tagLinks: false,
    // Both of these matter for pagination, not looks. Paged.js chunks by
    // moving nodes into off-screen page containers: a lazy image parked there
    // never loads, so its box never settles and pagination spins forever.
    // Explicit width/height then lets every page be measured in one pass.
    lazy: false,
    dims: (src) => dims.get(src),
  };

  const paper = data.settings.pdf.paper === 'A4' ? 'A4' : 'Letter';

  const head =
      '<link rel="stylesheet" href="tokens.css">'
    + '<link rel="stylesheet" href="print.css">'
    + `<style>@page { size: ${paper}; }</style>`
    // Paged.js must be configured before the polyfill loads. `after` fires
    // once every page box exists and all target-counters are resolved, which
    // is the only reliable signal that the TOC page numbers are final.
    + '<script>window.PagedConfig = { auto: true, after: () => { window.__PAGED_READY = true; } };</script>'
    + '<script src="paged.polyfill.js"></script>';

  const html = htmlDocument({
    title: (data.profile.name || data.settings.siteTitle) + ' — Portfolio',
    accent: data.settings.accent,
    bodyClass: 'pdf',
    head,
    body: printBody(data, ctx),
  });

  await fs.writeFile(path.join(WORK, 'index.html'), html);
  for (const f of ['tokens.css', 'print.css']) {
    await fs.copyFile(path.join(ROOT, 'shared', 'styles', f), path.join(WORK, f));
  }
  await fs.copyFile(path.join(ROOT, 'vendor', 'paged.polyfill.js'), path.join(WORK, 'paged.polyfill.js'));

  const pageUrl = pathToFileURL(path.join(WORK, 'index.html')).href;
  console.log(`Print document: ${path.relative(ROOT, path.join(WORK, 'index.html'))}`);

  if (HTML_ONLY) {
    console.log(`\nOpen this in any browser and use Print -> Save as PDF:\n  ${pageUrl}`);
    return;
  }

  // --- print --------------------------------------------------------------
  const chrome = findChrome();
  if (!chrome) {
    console.error('\nNo Chromium or Chrome found. Install one, then export again:');
    console.error('    sudo apt install chromium');
    console.error('\nOr point at an existing install:');
    console.error('    CHROME_PATH=/path/to/chrome node export/build-pdf.js');
    console.error(`\nIn the meantime the paginated document -- table of contents and all -- is ready at:\n  ${pageUrl}`);
    console.error('Open it in Firefox and use Print -> Save as PDF.');
    process.exit(1);
  }
  console.log(`Chromium: ${chrome}`);

  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files', '--font-render-hinting=none'],
  });

  try {
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error') console.warn('  browser: ' + m.text()); });
    page.on('pageerror', (e) => console.warn('  page error: ' + e.message));

    await page.goto(pageUrl, { waitUntil: 'networkidle0', timeout: 120000 });

    // Wait for Paged.js to finish laying out every page box.
    await page.waitForFunction('window.__PAGED_READY === true', { timeout: 180000 });

    const pageCount = await page.evaluate(() => document.querySelectorAll('.pagedjs_page').length);
    // Verify the TOC actually resolved. Paged.js rewrites target-counter into
    // a named counter and sets it via an injected `counter-reset` rule; if the
    // link target is never found the counter silently stays at 0, which is
    // exactly what a broken TOC looks like. Catch that here rather than in a
    // PDF someone has already emailed out.
    const toc = await page.evaluate(() => {
      const out = [];
      for (const a of document.querySelectorAll('.pagedjs_page .toc-item a')) {
        const rendered = getComputedStyle(a, '::after').content;
        const m = /counter\(([^,)]+)/.exec(rendered);
        let value = null;
        if (m) {
          // Paged.js injects the counter-reset onto the ::after pseudo, which
          // is where the number is rendered -- not onto the anchor itself.
          const reset = getComputedStyle(a, '::after').counterReset;
          const mm = new RegExp(m[1].trim() + '\\s+(-?\\d+)').exec(reset);
          value = mm ? Number(mm[1]) : null;
        } else if (/^["'].*["']$/.test(rendered)) {
          value = Number(rendered.slice(1, -1)) || null;
        }
        out.push({ href: a.getAttribute('href'), value });
      }
      return out;
    });
    const unresolved = toc.filter((t) => !t.value);
    console.log(`Paged.js laid out ${pageCount} pages; ${toc.length - unresolved.length}/${toc.length} contents entries numbered`);
    if (unresolved.length) {
      console.warn('  ! these contents entries did not resolve to a page: '
        + unresolved.map((t) => t.href).join(', '));
    }

    await fs.mkdir(OUT, { recursive: true });
    const pdfPath = path.join(OUT, 'portfolio.pdf');
    await page.pdf({
      path: pdfPath,
      printBackground: true,
      preferCSSPageSize: true,     // honour the @page size Paged.js used
      displayHeaderFooter: false,  // headers and folios come from print.css
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });

    const size = (await fs.stat(pdfPath)).size;
    console.log(`\nWrote out/portfolio.pdf — ${pageCount} pages, ${(size / 1048576).toFixed(1)} MB`);
    console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
