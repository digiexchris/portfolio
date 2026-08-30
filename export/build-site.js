// Static site export.
//
// Produces dist/ as a self-contained folder with relative paths throughout, so
// it works opened straight from file:// off a USB stick as well as served over
// HTTP. Only published projects are included.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalise, publishedProjects, publishedTestimonials, toPlainText } from '../shared/model.js';
import { htmlDocument, indexBody, projectBody, testimonialsBody, aboutBody } from '../shared/render.js';
import { ImagePipeline, SITE_WIDTHS, buildStemMap } from './images.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA_ROOT = path.join(ROOT, 'media');
// The published site is written to docs/ because that is one of only two
// locations GitHub Pages will serve from on a branch deploy (the other being
// the repository root, which would expose the source and put /docs in the URL).
//
// --drafts builds a local review copy that includes unpublished work. It goes
// to preview/ on purpose, and stays gitignored: a preview containing
// half-written entries must never be published.
const DRAFTS = process.argv.includes('--drafts');
const DIST = path.join(ROOT, DRAFTS ? 'preview' : 'docs');
const PDF_SOURCE = path.join(ROOT, 'out', 'portfolio.pdf');

// Anything in public/ is copied verbatim into the published folder. That is
// where files the host needs but this builder does not generate belong -- a
// CNAME for a custom domain, robots.txt, an ownership-verification file.
const PUBLIC_DIR = path.join(ROOT, 'public');

// The build wipes the output folder, which would take those files with it.
// GitHub writes CNAME straight into docs/ when a custom domain is set in its
// web UI, so they can arrive without ever passing through public/ -- losing one
// silently unpoints the domain.
const PRESERVE = [
  /^CNAME$/i, /^robots\.txt$/i, /^_headers$/, /^_redirects$/,
  /^\.well-known$/, /^google[0-9a-z]+\.html$/i, /^BingSiteAuth\.xml$/i,
];

const t0 = Date.now();

async function main() {
  const data = normalise(JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'portfolio.json'), 'utf8')));
  const projects = DRAFTS
    ? data.projects.slice().sort((a, b) => a.order - b.order)
    : publishedProjects(data);
  const testimonials = DRAFTS
    ? data.testimonials.slice().sort((a, b) => a.order - b.order)
    : publishedTestimonials(data);

  if (!projects.length) {
    console.log('Nothing to export: no projects are published yet.');
    console.log('Tick "Published" on the projects you want to include, then export again.');
    console.log('To review everything including drafts: npm run preview:site');
    process.exit(0);
  }

  if (DRAFTS) {
    const drafts = projects.filter((p) => !p.published).length;
    console.log(`DRAFT PREVIEW — ${projects.length} projects (${drafts} unpublished), ${testimonials.length} testimonials`);
  } else {
    console.log(`Exporting ${projects.length} projects, ${testimonials.length} testimonials`);
  }

  const rescued = await rescueHostFiles(DIST);
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(path.join(DIST, 'assets'), { recursive: true });
  await restoreHostFiles(DIST, rescued);
  const published = await copyPublic(DIST);
  const kept = [...new Set([...rescued, ...published])];
  if (kept.length) console.log(`Kept host files: ${kept.join(', ')}`);

  const pipe = new ImagePipeline({
    mediaRoot: MEDIA_ROOT,
    uploadsRoot: path.join(ROOT, 'data', 'uploads'),
    cacheDir: path.join(ROOT, '.cache', 'site'),
  });

  // --- images -------------------------------------------------------------
  // Every photo that actually ships gets one derivative per width, written to
  // dist/img/ under a name derived from the source file.
  const emitted = new Map();     // src -> { widths: {w: file}, dims }

  const wanted = new Set();
  for (const p of projects) for (const ph of p.photos) wanted.add(ph.src);
  for (const t of testimonials) if (t.image) wanted.add(t.image);
  if (data.profile.photo) wanted.add(data.profile.photo);

  // Export names are assigned from the whole set at once so two sources can
  // never claim the same filename.
  const stems = buildStemMap(wanted);

  console.log(`Processing ${wanted.size} photos…`);
  for (const src of wanted) {
    const stem = stems.get(src);
    const dims = await pipe.dimensions(src);
    const widths = {};
    for (const w of SITE_WIDTHS) {
      // Never upscale: skip widths larger than the source.
      if (dims && dims.width && w > dims.width && Object.keys(widths).length) continue;
      const name = `${stem}-${w}.jpg`;
      const out = await pipe.emit(src, w, path.join(DIST, 'img'), name);
      if (out) widths[w] = 'img/' + name;
    }
    if (Object.keys(widths).length) emitted.set(src, { widths, dims });
  }
  pipe.report('Images');

  // The printable version ships with the site, so someone browsing it can grab
  // the PDF without being sent anywhere else. Built separately, so it is only
  // linked when it actually exists.
  let hasPdf = false;
  if (fsSync.existsSync(PDF_SOURCE)) {
    await fs.mkdir(DIST, { recursive: true });
    await fs.copyFile(PDF_SOURCE, path.join(DIST, 'portfolio.pdf'));
    hasPdf = true;
    const pdfStat = await fs.stat(PDF_SOURCE);
    console.log(`Included portfolio.pdf (${(pdfStat.size / 1048576).toFixed(1)} MB)`);

    // The PDF is built separately, so it can lag behind the writing. Publishing
    // a stale one is silent and lands in docs/, which is committed.
    const dataStat = await fs.stat(path.join(ROOT, 'data', 'portfolio.json'));
    if (pdfStat.mtimeMs < dataStat.mtimeMs - 1000) {
      console.warn('  ! portfolio.pdf is older than data/portfolio.json —'
        + ' run `npm run build:pdf` (or `npm run build`) so it matches your writing.');
    }
  } else {
    console.log('No out/portfolio.pdf yet — run `npm run build:pdf` to include it.');
  }

  // --- render context -----------------------------------------------------
  // `depth` is how many directories deep the page being written is, so every
  // href and src comes out relative and the folder works from file://.
  const ctxFor = (depth) => {
    const up = depth ? '../'.repeat(depth) : '';
    const pick = (src, size) => {
      if (!src) return '';
      const e = emitted.get(src);
      if (!e) return up + 'img/' + (stems.get(src) || 'missing') + '-1200.jpg';
      const keys = Object.keys(e.widths).map(Number).sort((a, b) => a - b);
      const want = size === 'thumb' ? 480 : size === 'full' ? 2000 : 1200;
      const chosen = keys.find((k) => k >= want) ?? keys[keys.length - 1];
      return up + e.widths[chosen];
    };
    return {
      img: pick,
      srcset: true,
      imgSet: (src, size) => {
        const e = src ? emitted.get(src) : null;
        if (!e) return { fallback: pick(src, size), srcset: '', sizes: '' };
        const keys = Object.keys(e.widths).map(Number).sort((a, b) => a - b);
        return {
          fallback: up + e.widths[keys[Math.min(1, keys.length - 1)]],
          srcset: keys.map((k) => `${up}${e.widths[k]} ${k}w`).join(', '),
          sizes: size === 'thumb' ? '(max-width: 700px) 100vw, 360px' : '(max-width: 900px) 100vw, 820px',
          width: e.dims?.width, height: e.dims?.height,
        };
      },
      href: (kind, arg) => {
        if (kind === 'index') return up + 'index.html';
        if (kind === 'testimonials') return up + 'testimonials.html';
        if (kind === 'about') return up + 'about.html';
        if (kind === 'project') return up + `projects/${arg.slug}.html`;
        if (kind === 'pdf') return hasPdf ? up + 'portfolio.pdf' : '';
        return '#';
      },
      tagLinks: true,
      hasPdf,
      hasTestimonials: testimonials.length > 0,
      // In draft mode the pages must list everything, not just published work.
      projects: DRAFTS ? projects : undefined,
      testimonials: DRAFTS ? testimonials : undefined,
    };
  };

  const head = (depth) => {
    const up = depth ? '../'.repeat(depth) : '';
    return `<link rel="stylesheet" href="${up}assets/tokens.css">`
      + `<link rel="stylesheet" href="${up}assets/site.css">`
      + (DRAFTS ? '<style>'
          + 'body{border-top:5px solid #b4531f}'
          + '.draft-banner{position:sticky;top:0;z-index:50;background:#b4531f;color:#fff;'
          + 'font:600 12px/1 system-ui;letter-spacing:.06em;text-transform:uppercase;'
          + 'padding:7px 12px;text-align:center}'
          + '.card.is-draft .card-media{opacity:.75}'
          + '.draft-flag{display:inline-block;margin:.15rem 0 0;font:600 10px/1 system-ui;'
          + 'letter-spacing:.06em;text-transform:uppercase;color:#b4531f;'
          + 'border:1px solid #b4531f;border-radius:3px;padding:2px 5px}'
          + '</style>' : '<style>.draft-flag{display:none}</style>')
      + `<script defer src="${up}assets/site.js"></script>`;
  };

  const banner = DRAFTS
    ? '<p class="draft-banner">Draft preview — includes unpublished work. Not for sending.</p>'
    : '';

  const write = async (rel, html) => {
    const file = path.join(DIST, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, html);
  };

  const siteName = data.profile.name || data.settings.siteTitle;
  const accent = data.settings.accent;

  // --- pages ---------------------------------------------------------------
  await write('index.html', htmlDocument({
    title: siteName,
    // The front page describes the work, so prefer its own intro over the
    // biography on the About page.
    description: toPlainText(data.home.intro, 160)
      || data.profile.tagline
      || toPlainText(data.profile.summary, 160),
    accent, head: head(0), body: banner + indexBody(data, ctxFor(0)) + lightboxMarkup(),
  }));

  for (const p of projects) {
    await write(`projects/${p.slug}.html`, htmlDocument({
      title: `${p.title} — ${siteName}`,
      description: p.summary || toPlainText(p.body, 160),
      accent, head: head(1), body: banner + projectBody(data, p, ctxFor(1)) + lightboxMarkup(),
    }));
  }

  if (testimonials.length) {
    await write('testimonials.html', htmlDocument({
      title: `Testimonials — ${siteName}`,
      accent, head: head(0), body: banner + testimonialsBody(data, ctxFor(0)) + lightboxMarkup(),
    }));
  }

  await write('about.html', htmlDocument({
    title: `About — ${siteName}`,
    description: toPlainText(data.profile.summary, 160),
    accent, head: head(0), body: banner + aboutBody(data, ctxFor(0)) + lightboxMarkup(),
  }));

  // --- assets --------------------------------------------------------------
  for (const f of ['tokens.css', 'site.css']) {
    await fs.copyFile(path.join(ROOT, 'shared', 'styles', f), path.join(DIST, 'assets', f));
  }
  await fs.writeFile(path.join(DIST, 'assets', 'site.js'), siteScript());

  // GitHub Pages runs Jekyll over a branch deploy by default, which skips
  // anything whose name starts with an underscore and adds a build step this
  // output has no use for. This serves the files exactly as written.
  await fs.writeFile(path.join(DIST, '.nojekyll'), '');

  const size = await dirSize(DIST);
  const pages = 1 + projects.length + (testimonials.length ? 1 : 0) + 1;
  const dir = path.basename(DIST);
  console.log(`Wrote ${pages} pages to ${dir}/`);
  console.log(`Total size: ${(size / 1048576).toFixed(1)} MB (originals are 120 MB)`);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(DRAFTS
    ? `Review at http://127.0.0.1:4321/${dir}/index.html — drafts included, so do not send this folder.`
    : `Open ${dir}/index.html directly in a browser, or upload the folder as-is.`);
}

// Move host control files out of the way of the wipe, and back afterwards.
const STAGING = path.join(ROOT, '.cache', 'preserve');

async function rescueHostFiles(dir) {
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  await fs.rm(STAGING, { recursive: true, force: true });
  const saved = [];
  for (const e of entries) {
    if (!PRESERVE.some((re) => re.test(e.name))) continue;
    await fs.mkdir(STAGING, { recursive: true });
    await fs.cp(path.join(dir, e.name), path.join(STAGING, e.name), { recursive: true });
    saved.push(e.name);
  }
  return saved;
}

async function restoreHostFiles(dir, names) {
  for (const name of names) {
    await fs.cp(path.join(STAGING, name), path.join(dir, name), { recursive: true });
  }
  await fs.rm(STAGING, { recursive: true, force: true });
}

// public/ wins over anything rescued: it is the version under version control.
async function copyPublic(dir) {
  let entries = [];
  try { entries = await fs.readdir(PUBLIC_DIR, { withFileTypes: true }); } catch { return []; }
  const copied = [];
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.well-known') continue;
    await fs.cp(path.join(PUBLIC_DIR, e.name), path.join(dir, e.name), { recursive: true });
    copied.push(e.name);
  }
  return copied;
}

// Lightbox container, appended once per page.
function lightboxMarkup() {
  return '<div class="lb" id="lb" role="dialog" aria-modal="true" aria-label="Photo viewer">'
    + '<button class="lb-close" aria-label="Close">&times;</button>'
    + '<button class="lb-nav lb-prev" aria-label="Previous">&lsaquo;</button>'
    + '<img id="lb-img" alt="">'
    + '<button class="lb-nav lb-next" aria-label="Next">&rsaquo;</button>'
    + '<p class="lb-cap" id="lb-cap"></p></div>';
}

// Small, dependency-free client script: tag/search filtering and the lightbox.
function siteScript() {
  return `(function () {
  'use strict';

  // --- index filtering ---
  var grid = document.getElementById('grid');
  if (grid) {
    var cards = [].slice.call(grid.querySelectorAll('.card'));
    var q = document.getElementById('q');
    var empty = document.getElementById('empty');
    var tag = '';

    function apply() {
      var term = (q && q.value || '').trim().toLowerCase();
      var shown = 0;
      cards.forEach(function (c) {
        var tags = (c.dataset.tags || '').split('|');
        var okTag = !tag || tags.indexOf(tag) > -1;
        var okTerm = !term || c.textContent.toLowerCase().indexOf(term) > -1;
        var on = okTag && okTerm;
        c.hidden = !on;
        if (on) shown++;
      });
      if (empty) empty.hidden = shown > 0;
    }

    if (q) q.addEventListener('input', apply);
    [].forEach.call(document.querySelectorAll('.tag-btn'), function (b) {
      b.addEventListener('click', function () {
        tag = b.dataset.tag || '';
        [].forEach.call(document.querySelectorAll('.tag-btn'), function (o) {
          o.classList.toggle('is-on', o === b);
        });
        apply();
      });
    });

    // Deep link from a tag on a project page: index.html?tag=turning
    var param = new URLSearchParams(location.search).get('tag');
    if (param) {
      var btn = document.querySelector('.tag-btn[data-tag="' + param.replace(/"/g, '') + '"]');
      if (btn) btn.click();
    }
  }

  // --- lightbox ---
  var lb = document.getElementById('lb');
  if (!lb) return;
  var img = document.getElementById('lb-img');
  var cap = document.getElementById('lb-cap');
  var links = [].slice.call(document.querySelectorAll('a[data-lightbox]'));
  var at = 0;

  function show(i) {
    at = (i + links.length) % links.length;
    var a = links[at];
    img.src = a.getAttribute('href');
    var fig = a.closest('figure');
    var c = fig && fig.querySelector('figcaption');
    cap.textContent = c ? c.textContent : '';
    lb.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }
  function hide() {
    lb.classList.remove('is-open');
    img.src = '';
    document.body.style.overflow = '';
  }

  links.forEach(function (a, i) {
    a.addEventListener('click', function (e) { e.preventDefault(); show(i); });
  });
  lb.addEventListener('click', function (e) {
    if (e.target === lb || e.target.classList.contains('lb-close')) hide();
  });
  lb.querySelector('.lb-prev').addEventListener('click', function (e) { e.stopPropagation(); show(at - 1); });
  lb.querySelector('.lb-next').addEventListener('click', function (e) { e.stopPropagation(); show(at + 1); });
  document.addEventListener('keydown', function (e) {
    if (!lb.classList.contains('is-open')) return;
    if (e.key === 'Escape') hide();
    if (e.key === 'ArrowLeft') show(at - 1);
    if (e.key === 'ArrowRight') show(at + 1);
  });
})();
`;
}

async function dirSize(dir) {
  let total = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    total += e.isDirectory() ? await dirSize(f) : (await fs.stat(f)).size;
  }
  return total;
}

main().catch((err) => { console.error(err); process.exit(1); });
