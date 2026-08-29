// Isomorphic templates: pure (data -> HTML string) functions with no DOM and
// no Node APIs. Imported unchanged by the editor preview, the static site
// builder, and the PDF builder, so all three can never render differently.
//
// Callers supply a `ctx` describing how to resolve URLs for their target:
//   ctx.img(src, size)  -> URL for a photo at a size hint (thumb|full|print)
//   ctx.href(kind, arg) -> URL for 'index' | 'project' | 'testimonials' | 'about'
//   ctx.srcset          -> emit responsive srcset (static site only)
//   ctx.lazy            -> emit loading="lazy" (screen only; see below)
//   ctx.projects        -> override which projects a page lists (draft preview)
//   ctx.testimonials    -> likewise for testimonials
//   ctx.dims(src)       -> {width, height} for explicit image sizing, optional
//
// loading="lazy" MUST be off for the PDF. Paged.js chunks the document by
// moving nodes into off-screen page containers; a lazy image parked there
// never loads, so its box never settles and pagination spins forever. Explicit
// width/height does not rescue it -- the attribute itself has to go.

import {
  escapeText as esc, escapeAttr as attr, toPlainText,
  publishedProjects, publishedTestimonials, featurePhoto, allTags,
} from './model.js';

// --- context helpers --------------------------------------------------------

export function previewCtx(overrides = {}) {
  return {
    img: (src) => '/media/' + encodeURI(src),
    href: () => '#',
    srcset: false,
    ...overrides,
  };
}


// `html` may be a thunk, so expensive branches stay lazy.
// Which entries a page lists. Defaults to the published set, but a caller can
// override it -- the draft preview passes everything, including unpublished
// work. Every page-level template goes through these so a single caller-side
// decision cannot be silently re-filtered downstream.
const listProjects = (data, ctx) => ctx.projects || publishedProjects(data);
const listTestimonials = (data, ctx) => ctx.testimonials || publishedTestimonials(data);

const when = (cond, html) => (cond ? (typeof html === 'function' ? html() : html) : '');

// Loading hints and intrinsic sizing, per target. See the note above about
// why lazy loading is fatal in the paged/PDF context.
function imgAttrs(ctx, src) {
  let out = '';
  const d = ctx.dims?.(src);
  if (d && d.width && d.height) out += ` width="${d.width}" height="${d.height}"`;
  if (ctx.lazy !== false) out += ' loading="lazy" decoding="async"';
  return out;
}
const join = (arr, fn) => arr.map(fn).join('');

// --- pieces -----------------------------------------------------------------

export function photoFigure(photo, ctx, { size = 'full', index = 0, path = '' } = {}) {
  const alt = photo.alt || photo.caption || '';
  const src = ctx.img(photo.src, size);
  let img;
  if (ctx.srcset && ctx.imgSet) {
    const set = ctx.imgSet(photo.src);
    img = `<img src="${attr(set.fallback)}" srcset="${attr(set.srcset)}" sizes="${attr(set.sizes)}"`
        + ` alt="${attr(alt)}"`
        + (set.width ? ` width="${set.width}" height="${set.height}"` : '')
        + (ctx.lazy !== false ? ' loading="lazy" decoding="async"' : '') + '>';
  } else {
    img = `<img src="${attr(src)}" alt="${attr(alt)}"${imgAttrs(ctx, photo.src)}>`;
  }
  return `<figure class="photo" data-index="${index}">`
    + `<a class="photo-link" href="${attr(ctx.img(photo.src, 'full'))}" data-lightbox>${img}</a>`
    + when(photo.caption, () => `<figcaption>${esc(photo.caption)}</figcaption>`)
    + '</figure>';
}

export function photoGrid(project, ctx, { skipFeature = false, size = 'full' } = {}) {
  const feature = featurePhoto(project);
  const photos = project.photos
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !(skipFeature && p === feature));
  if (!photos.length) return '';
  const cls = photos.length === 1 ? 'photo-grid one' : 'photo-grid';
  return `<div class="${cls}">`
    + join(photos, ({ p, i }) =>
        photoFigure(p, ctx, { size, index: i, path: `photos.${i}` }))
    + '</div>';
}

export function specTable(project, ctx) {
  if (!project.specs.length) return '';
  return '<dl class="specs">'
    + join(project.specs, (s, i) =>
        `<div class="spec"><dt>${esc(s.label)}</dt>`
        + `<dd>${esc(s.value)}</dd></div>`)
    + '</dl>';
}

export function tagList(tags, ctx, { link = false } = {}) {
  if (!tags.length) return '';
  return '<ul class="tags">' + join(tags, (t) =>
    link
      ? `<li><a class="tag" href="${attr(ctx.href('index'))}?tag=${encodeURIComponent(t)}">${esc(t)}</a></li>`
      : `<li><span class="tag">${esc(t)}</span></li>`) + '</ul>';
}

export function projectMeta(project) {
  const bits = [project.date, project.subtitle].filter(Boolean);
  return bits.length ? `<p class="meta">${bits.map(esc).join(' &middot; ')}</p>` : '';
}

// --- project card (index grid) ---------------------------------------------

export function projectCard(project, ctx) {
  const photo = featurePhoto(project);
  const href = ctx.href('project', project);
  const thumb = photo
    ? (ctx.srcset && ctx.imgSet
        ? (() => { const s = ctx.imgSet(photo.src, 'thumb');
            return `<img src="${attr(s.fallback)}" srcset="${attr(s.srcset)}" sizes="(max-width:700px) 100vw, 360px" alt="${attr(photo.alt || project.title)}"`
              + (ctx.lazy !== false ? ' loading="lazy" decoding="async"' : '') + '>'; })()
        : `<img src="${attr(ctx.img(photo.src, 'thumb'))}" alt="${attr(photo.alt || project.title)}"${imgAttrs(ctx, photo.src)}>`)
    : '<div class="no-photo" aria-hidden="true"></div>';
  return `<article class="card${project.published ? '' : ' is-draft'}" data-tags="${attr(project.tags.join('|'))}" data-title="${attr(project.title.toLowerCase())}">`
    + `<a class="card-link" href="${attr(href)}">`
    + `<div class="card-media">${thumb}</div>`
    + '<div class="card-body">'
    + `<h3 class="card-title">${esc(project.title)}</h3>`
    + when(!project.published, '<p class="draft-flag">Draft</p>')
    + when(project.summary, `<p class="card-summary">${esc(toPlainText(project.summary, 140))}</p>`)
    + when(project.tags.length, `<p class="card-tags">${project.tags.map(esc).join(' &middot; ')}</p>`)
    + '</div></a></article>';
}

// --- full project article (project page + PDF) ------------------------------

export function projectArticle(project, ctx, { heading = 'h1', showFeature = true } = {}) {
  const feature = showFeature ? featurePhoto(project) : null;
  return `<article class="project" id="project-${attr(project.slug)}" data-project-id="${attr(project.id)}">`
    + '<header class="project-head">'
    + `<${heading} class="project-title">${esc(project.title)}</${heading}>`
    + when(project.subtitle || project.date, projectMeta(project))
    + when(project.summary,
        `<p class="lede">${esc(project.summary)}</p>`)
    + tagList(project.tags, ctx, { link: !!ctx.tagLinks })
    + '</header>'
    + when(feature, () => `<div class="feature-photo">${photoFigure(feature, ctx, { size: 'full', index: project.photos.indexOf(feature), path: `photos.${project.photos.indexOf(feature)}` })}</div>`)
    + specTable(project, ctx)
    + when(project.body, () => `<div class="body prose">${project.body}</div>`)
    + photoGrid(project, ctx, { skipFeature: showFeature })
    + '</article>';
}

// --- testimonials -----------------------------------------------------------

export function testimonialCard(t, ctx, projectsById = new Map()) {
  const project = t.projectId ? projectsById.get(t.projectId) : null;
  const attribution = [t.author, [t.role, t.company].filter(Boolean).join(', ')]
    .filter(Boolean);
  return `<figure class="testimonial${t.featured ? ' featured' : ''}" data-testimonial-id="${attr(t.id)}">`
    + when(t.image, () => `<div class="testimonial-scan"><a href="${attr(ctx.img(t.image, 'full'))}" data-lightbox>`
        + `<img src="${attr(ctx.img(t.image, 'thumb'))}" alt="Note from ${attr(t.author || 'a client')}"${imgAttrs(ctx, t.image)}></a></div>`)
    + `<blockquote class="quote">${t.quote || ''}</blockquote>`
    + '<figcaption class="attribution">'
    + when(attribution.length, `<span class="who">${esc(attribution[0])}</span>`)
    + when(attribution[1], `<span class="role">${esc(attribution[1])}</span>`)
    + when(t.date, `<span class="when">${esc(t.date)}</span>`)
    + when(project, () => `<span class="re">re: ${esc(project.title)}</span>`)
    + '</figcaption></figure>';
}

export function testimonialsSection(data, ctx, { heading = 'h1' } = {}) {
  const list = listTestimonials(data, ctx);
  if (!list.length) return '';
  const byId = new Map(data.projects.map((p) => [p.id, p]));
  return '<section class="testimonials" id="testimonials">'
    + `<${heading} class="section-title">Testimonials</${heading}>`
    + '<div class="testimonial-list">'
    + join(list, (t) => testimonialCard(t, ctx, byId))
    + '</div></section>';
}

// --- page shells ------------------------------------------------------------

export function contactLine(profile, ctx) {
  const bits = [];
  if (profile.location) bits.push(`<span>${esc(profile.location)}</span>`);
  if (profile.email) bits.push(`<a href="mailto:${attr(profile.email)}">${esc(profile.email)}</a>`);
  if (profile.phone) bits.push(`<a href="tel:${attr(profile.phone.replace(/[^+\d]/g, ''))}">${esc(profile.phone)}</a>`);
  for (const l of profile.links) bits.push(`<a href="${attr(l.url)}">${esc(l.label || l.url)}</a>`);
  return bits.length ? `<p class="contact">${bits.join('<span class="sep">&middot;</span>')}</p>` : '';
}

export function siteHeader(data, ctx, active = '') {
  const p = data.profile;
  return '<header class="site-head"><div class="wrap">'
    + `<a class="brand" href="${attr(ctx.href('index'))}">`
    + `<span class="brand-name">${esc(p.name || data.settings.siteTitle)}</span>`
    + when(p.tagline, `<span class="brand-tagline">${esc(p.tagline)}</span>`)
    + '</a>'
    + '<nav class="site-nav">'
    + `<a href="${attr(ctx.href('index'))}"${active === 'index' ? ' aria-current="page"' : ''}>Work</a>`
    // The testimonials page is only built when there is something to put on
    // it, so the link must not appear otherwise -- it would 404 on the live
    // site. Undefined means "editor preview", where the page always exists.
    + when(ctx.hasTestimonials !== false,
        () => `<a href="${attr(ctx.href('testimonials'))}"${active === 'testimonials' ? ' aria-current="page"' : ''}>Testimonials</a>`)
    + `<a href="${attr(ctx.href('about'))}"${active === 'about' ? ' aria-current="page"' : ''}>About</a>`
    // The printable version, when the site was built with one alongside it.
    + when(ctx.hasPdf, () =>
        `<a class="pdf-link" href="${attr(ctx.href('pdf'))}" download>PDF</a>`)
    + '</nav></div></header>';
}

export function siteFooter(data, ctx) {
  const p = data.profile;
  return '<footer class="site-foot"><div class="wrap">'
    + contactLine(p, ctx)
    + `<p class="colophon">${esc(p.name || data.settings.siteTitle)}</p>`
    + '</div></footer>';
}

export function skillsBlock(data, ctx) {
  if (!data.skills.length) return '';
  return '<section class="skills"><h2 class="section-title">Skills</h2><div class="skill-groups">'
    + join(data.skills, (g) =>
        `<div class="skill-group"><h3>${esc(g.group)}</h3><ul>`
        + join(g.items, (it) => `<li>${esc(it)}</li>`)
        + '</ul></div>')
    + '</div></section>';
}

// --- whole documents --------------------------------------------------------

export function htmlDocument({ title, description = '', bodyClass = '', head = '', body, accent = '#b4531f', lang = 'en' }) {
  return '<!doctype html>\n'
    + `<html lang="${attr(lang)}"><head><meta charset="utf-8">`
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${esc(title)}</title>`
    + when(description, `<meta name="description" content="${attr(description)}">`)
    + `<style>:root{--accent:${attr(accent)}}</style>`
    + '<link rel="icon" href="data:image/svg+xml,'
    + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        + `<rect width="32" height="32" rx="6" fill="${accent}"/>`
        + '<path d="M16 7a9 9 0 100 18 9 9 0 000-18zm0 4.2a4.8 4.8 0 110 9.6 4.8 4.8 0 010-9.6z" fill="#fff"/>'
        + '<path d="M16 3.6l1.7 2.9h-3.4zM16 28.4l-1.7-2.9h3.4zM3.6 16l2.9-1.7v3.4zM28.4 16l-2.9 1.7v-3.4z" fill="#fff"/>'
        + '</svg>')
    + '">'
    + head
    + `</head><body class="${attr(bodyClass)}">${body}</body></html>`;
}

export function indexBody(data, ctx) {
  const projects = listProjects(data, ctx);
  const tags = allTags(projects);
  const p = data.profile;
  return siteHeader(data, ctx, 'index')
    + '<main class="wrap">'
    + '<section class="intro">'
    + `<h1>${esc(p.name || data.settings.siteTitle)}</h1>`
    + when(p.tagline, `<p class="tagline">${esc(p.tagline)}</p>`)
    // The Work page's own intro, not the About text.
    + when(data.home.intro, () => `<div class="prose intro-summary">${data.home.intro}</div>`)
    + contactLine(p, ctx)
    + '</section>'
    + when(projects.length > 3, '<div class="controls">'
        + '<input type="search" id="q" class="search" placeholder="Search work" aria-label="Search work">'
        + when(tags.length, '<div class="tag-filter" role="group" aria-label="Filter by tag">'
            + '<button class="tag-btn is-on" data-tag="">All</button>'
            + join(tags, ([t, n]) => `<button class="tag-btn" data-tag="${attr(t)}">${esc(t)} <span class="n">${n}</span></button>`)
            + '</div>')
        + '</div>')
    + `<section class="grid" id="grid">${join(projects, (pr) => projectCard(pr, ctx))}</section>`
    + '<p class="empty" id="empty" hidden>No work matches that filter.</p>'
    + '</main>'
    + siteFooter(data, ctx);
}

export function projectBody(data, project, ctx) {
  const list = listProjects(data, ctx);
  const i = list.findIndex((p) => p.id === project.id);
  const prev = i > 0 ? list[i - 1] : null;
  const next = i >= 0 && i < list.length - 1 ? list[i + 1] : null;
  return siteHeader(data, ctx, '')
    + '<main class="wrap narrow">'
    + `<p class="crumb"><a href="${attr(ctx.href('index'))}">&larr; All work</a></p>`
    + projectArticle(project, ctx, { heading: 'h1' })
    + '<nav class="pager">'
    + when(prev, () => `<a class="prev" href="${attr(ctx.href('project', prev))}"><span>Previous</span>${esc(prev.title)}</a>`)
    + when(next, () => `<a class="next" href="${attr(ctx.href('project', next))}"><span>Next</span>${esc(next.title)}</a>`)
    + '</nav></main>'
    + siteFooter(data, ctx);
}

export function testimonialsBody(data, ctx) {
  return siteHeader(data, ctx, 'testimonials')
    + '<main class="wrap narrow">'
    + testimonialsSection(data, ctx, { heading: 'h1' })
    + '</main>'
    + siteFooter(data, ctx);
}

export function aboutBody(data, ctx) {
  const p = data.profile;
  return siteHeader(data, ctx, 'about')
    + '<main class="wrap narrow"><section class="about">'
    + `<h1>${esc(p.name || 'About')}</h1>`
    + when(p.tagline, `<p class="tagline">${esc(p.tagline)}</p>`)
    // Contact details sit directly under the name, so someone deciding whether
    // to get in touch does not have to read to the end first.
    + contactLine(p, ctx)
    + when(p.summary, () => `<div class="prose">${p.summary}</div>`)
    // Below the text: images cannot live inside the prose, since the sanitiser
    // allows no <img> in stored HTML.
    + when(p.photo, () => `<figure class="portrait"><img src="${attr(ctx.img(p.photo, 'full'))}" alt="${attr(p.name)}"${imgAttrs(ctx, p.photo)}></figure>`)
    + '</section>'
    + skillsBlock(data, ctx)
    + '</main>'
    + siteFooter(data, ctx);
}

// --- print / PDF document ---------------------------------------------------
//
// Paged.js consumes this. `target-counter(attr(href url), page)` in print.css
// is what turns the TOC links into real page numbers, which Chromium's own
// print engine cannot do on its own.

export function printBody(data, ctx) {
  const projects = listProjects(data, ctx);
  const testimonials = data.settings.pdf.includeTestimonials ? listTestimonials(data, ctx) : [];
  const p = data.profile;
  const cover = data.settings.pdf.coverPhoto
    || (projects.length ? (featurePhoto(projects[0]) || {}).src : '');

  return '<div class="pdf-cover">'
    + when(cover, () => `<div class="cover-photo"><img src="${attr(ctx.img(cover, 'print'))}" alt=""${imgAttrs(ctx, cover)}></div>`)
    + '<div class="cover-text">'
    + `<h1 class="cover-name">${esc(p.name || data.settings.siteTitle)}</h1>`
    + when(p.tagline, `<p class="cover-tagline">${esc(p.tagline)}</p>`)
    + '<div class="cover-contact">'
    + join([p.location, p.email, p.phone].filter(Boolean), (b) => `<span>${esc(b)}</span>`)
    + join(p.links, (l) => `<span>${esc(l.url)}</span>`)
    + '</div></div></div>'

    + when(p.summary || data.skills.length || p.photo, () => '<section class="pdf-about">'
        + '<h2 class="section-title">About</h2>'
        // In print the photo leads, unlike the web page where it closes the
        // section. An image cannot be split across pages, so placed after a
        // full page of text it gets pushed whole onto the next one and lands
        // there alone. Leading with it keeps the text flowing behind it.
        + when(p.photo, () => `<figure class="portrait"><img src="${attr(ctx.img(p.photo, 'print'))}" alt=""${imgAttrs(ctx, p.photo)}></figure>`)
        + when(p.summary, () => `<div class="prose">${p.summary}</div>`)
        + when(data.skills.length, '<div class="skill-groups">'
            + join(data.skills, (g) => `<div class="skill-group"><h3>${esc(g.group)}</h3><ul>`
                + join(g.items, (it) => `<li>${esc(it)}</li>`) + '</ul></div>')
            + '</div>')
        + '</section>')

    // The page number is emitted by print.css as `.toc-item a::after`, NOT on
    // an inner span: Paged.js resolves `target-counter(attr(href), page)` by
    // reading the href off the very element the rule selects, so the counter
    // has to sit on the anchor that carries it.
    + '<section class="pdf-toc" id="toc">'
    + '<h2 class="section-title">Contents</h2><ol class="toc-list">'
    + join(projects, (pr) =>
        `<li class="toc-item"><a href="#project-${attr(pr.slug)}">`
        + `<span class="toc-title">${esc(pr.title)}</span>`
        + '<span class="toc-dots" aria-hidden="true"></span>'
        + '</a></li>')
    + when(testimonials.length,
        '<li class="toc-item toc-section"><a href="#testimonials">'
        + '<span class="toc-title">Testimonials</span>'
        + '<span class="toc-dots" aria-hidden="true"></span>'
        + '</a></li>')
    + '</ol></section>'

    + '<section class="pdf-projects">'
    + join(projects, (pr) => projectArticle(pr, ctx, { heading: 'h2' }))
    + '</section>'

    + when(testimonials.length,
        '<section class="testimonials" id="testimonials">'
        + '<h2 class="section-title">Testimonials</h2>'
        + '<div class="testimonial-list">'
        + join(testimonials, (t) => testimonialCard(t, ctx, new Map(data.projects.map((x) => [x.id, x]))))
        + '</div></section>');
}
