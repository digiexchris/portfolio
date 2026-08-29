// Data model: defaults, normalisation, validation, and HTML sanitising.
// Imported by the browser editor, the server, and both exporters.

export const SCHEMA_VERSION = 1;

export function emptyPortfolio() {
  return {
    version: SCHEMA_VERSION,
    profile: {
      name: '', tagline: '', location: '', email: '', phone: '',
      links: [], summary: '', photo: '',
    },
    skills: [],
    projects: [],
    testimonials: [],
    settings: {
      siteTitle: 'Portfolio',
      accent: '#b4531f',
      pdf: { paper: 'Letter', includeTestimonials: true, coverPhoto: '' },
    },
  };
}

export function emptyProject(overrides = {}) {
  return {
    id: newId(), slug: '', title: 'Untitled project', subtitle: '', date: '',
    summary: '', body: '', tags: [], specs: [], photos: [],
    published: false, order: 0,
    ...overrides,
  };
}

export function emptyTestimonial(overrides = {}) {
  return {
    id: newId(), quote: '', author: '', role: '', company: '', date: '',
    projectId: null, image: null, featured: false, published: true, order: 0,
    ...overrides,
  };
}

export function newId() {
  return 'x' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

// Guarantee slugs are present and unique across the project list.
export function ensureSlugs(projects) {
  const seen = new Set();
  for (const p of projects) {
    const base = p.slug || slugify(p.title);
    let slug = base, n = 2;
    while (seen.has(slug)) slug = `${base}-${n++}`;
    seen.add(slug);
    p.slug = slug;
  }
  return projects;
}

// Fill in any missing fields on data loaded from disk, so an older or
// hand-edited file never crashes the renderer.
export function normalise(raw) {
  const base = emptyPortfolio();
  const d = { ...base, ...(raw || {}) };
  d.version = SCHEMA_VERSION;
  d.profile = { ...base.profile, ...(raw?.profile || {}) };
  d.profile.links = asArray(d.profile.links)
    .map((l) => ({ label: str(l.label), url: str(l.url) }))
    .filter((l) => l.url);
  d.settings = { ...base.settings, ...(raw?.settings || {}) };
  d.settings.pdf = { ...base.settings.pdf, ...(raw?.settings?.pdf || {}) };
  d.skills = asArray(d.skills).map((g) => ({
    group: str(g.group), items: asArray(g.items).map(str).filter(Boolean),
  }));

  d.projects = asArray(d.projects).map((p, i) => ({
    ...emptyProject(),
    ...p,
    id: p.id || newId(),
    title: str(p.title) || 'Untitled project',
    subtitle: str(p.subtitle),
    date: str(p.date),
    tags: asArray(p.tags).map(str).filter(Boolean),
    specs: asArray(p.specs)
      .map((s) => ({ label: str(s.label), value: str(s.value) }))
      .filter((s) => s.label || s.value),
    photos: asArray(p.photos)
      .map((ph) => (typeof ph === 'string' ? { src: ph } : ph))
      .filter((ph) => ph && ph.src)
      .map((ph) => ({
        src: str(ph.src), caption: str(ph.caption),
        alt: str(ph.alt), feature: !!ph.feature,
      })),
    body: sanitiseHtml(p.body),
    summary: str(p.summary),
    published: !!p.published,
    order: Number.isFinite(p.order) ? p.order : i,
  }));
  ensureSlugs(d.projects);
  d.projects.sort((a, b) => a.order - b.order);

  d.testimonials = asArray(d.testimonials).map((t, i) => ({
    ...emptyTestimonial(),
    ...t,
    id: t.id || newId(),
    quote: sanitiseHtml(t.quote),
    author: str(t.author), role: str(t.role), company: str(t.company),
    date: str(t.date),
    image: t.image ? str(t.image) : null,
    featured: !!t.featured,
    published: t.published !== false,
    order: Number.isFinite(t.order) ? t.order : i,
  }));
  d.testimonials.sort((a, b) => a.order - b.order);

  d.profile.summary = sanitiseHtml(d.profile.summary);
  return d;
}

const asArray = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v == null ? '' : String(v));

// ---------------------------------------------------------------------------
// HTML sanitiser
//
// The rich-text editor produces contenteditable HTML that gets inlined
// verbatim into the exported site and PDF. Everything is stripped down to a
// small allow-list on save (in the browser AND again on the server), so the
// stored markup is always safe to inline.
// ---------------------------------------------------------------------------

const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'code',
  'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'a', 'sup', 'sub',
]);
// Browsers wrap contenteditable lines in <div>. Dropping those would keep the
// text but silently merge paragraphs, so they become <p> instead.
const TAG_MAP = { div: 'p' };
const ALLOWED_ATTRS = { a: new Set(['href', 'title']) };
const VOID_TAGS = new Set(['br']);
// Tags whose entire contents must go, not just the tag itself.
const DROP_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript']);

export function sanitiseHtml(input) {
  const html = str(input);
  if (!html) return '';
  let out = '';
  let i = 0;
  const openStack = [];

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { out += escapeText(html.slice(i)); break; }
    out += escapeText(html.slice(i, lt));

    // Skip comments wholesale.
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    // Only treat '<' as markup when a tag name actually follows it. Writeups
    // are full of things like `tolerance < 0.001"` and `< 2 thou`, and those
    // must survive as literal text rather than being eaten as a bogus tag.
    if (!/^<\/?[a-zA-Z]/.test(html.slice(lt, lt + 3))) {
      out += '&lt;';
      i = lt + 1;
      continue;
    }

    const gt = html.indexOf('>', lt);
    if (gt === -1) { out += escapeText(html.slice(lt)); break; }

    const raw = html.slice(lt + 1, gt).trim();
    const closing = raw.startsWith('/');
    const found = (closing ? raw.slice(1) : raw).match(/^[a-zA-Z0-9]+/)?.[0]?.toLowerCase();
    i = gt + 1;
    if (!found) continue;
    const name = TAG_MAP[found] || found;

    if (DROP_CONTENT.has(name)) {
      // Drop through to the matching close tag, contents and all.
      const rest = html.slice(i);
      const m = rest.match(new RegExp(`</\\s*${found}\\s*>`, 'i'));
      i = m ? i + m.index + m[0].length : html.length;
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue;

    if (closing) {
      const idx = openStack.lastIndexOf(name);
      if (idx === -1) continue;          // stray close tag
      while (openStack.length > idx) out += `</${openStack.pop()}>`;
      continue;
    }

    const attrs = sanitiseAttrs(name, raw.slice(found.length));
    out += `<${name}${attrs}>`;
    if (!VOID_TAGS.has(name) && !raw.endsWith('/')) openStack.push(name);
  }
  while (openStack.length) out += `</${openStack.pop()}>`;
  return blockify(out.trim());
}

// Ensure the writeup is made of real block elements.
//
// A contenteditable left to itself produces loose text separated by <br><br>.
// That renders acceptably on screen by accident, but it means `.prose p` never
// applies, and in the PDF the orphan/widow and break-inside rules -- which are
// written against <p> -- do nothing at all. So loose runs are promoted to
// paragraphs, splitting on runs of two or more <br>.
const BLOCK_TAGS = new Set(['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'blockquote']);

export function blockify(html) {
  if (!html) return '';
  const parts = [];
  let loose = '';
  let i = 0;

  const flush = () => {
    for (const chunk of loose.split(/(?:<br>\s*){2,}/)) {
      const t = chunk.replace(/^(?:<br>\s*)+|(?:<br>\s*)+$/g, '').trim();
      if (t) parts.push(`<p>${t}</p>`);
    }
    loose = '';
  };

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { loose += html.slice(i); break; }

    const gt = html.indexOf('>', lt);
    const name = gt === -1 ? null : html.slice(lt + 1, gt).match(/^([a-zA-Z0-9]+)/)?.[1]?.toLowerCase();
    if (!name || !BLOCK_TAGS.has(name)) { loose += html.slice(i, gt === -1 ? html.length : gt + 1); i = gt === -1 ? html.length : gt + 1; continue; }

    // A top-level block: take it whole, including any nesting of its own kind.
    loose += html.slice(i, lt);
    flush();
    let depth = 0, j = lt;
    for (;;) {
      const next = html.indexOf('<', j);
      if (next === -1) { parts.push(html.slice(lt)); j = html.length; break; }
      const ng = html.indexOf('>', next);
      if (ng === -1) { parts.push(html.slice(lt)); j = html.length; break; }
      const tag = html.slice(next + 1, ng);
      const tName = tag.replace(/^\//, '').match(/^([a-zA-Z0-9]+)/)?.[1]?.toLowerCase();
      if (tName === name) depth += tag.startsWith('/') ? -1 : 1;
      j = ng + 1;
      if (depth === 0) { parts.push(html.slice(lt, j)); break; }
    }
    i = j;
  }
  flush();
  return parts.join('');
}

function sanitiseAttrs(tag, attrText) {
  const allowed = ALLOWED_ATTRS[tag];
  if (!allowed || !attrText.trim()) return '';
  let out = '';
  const re = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(attrText))) {
    const key = m[1].toLowerCase();
    if (!allowed.has(key)) continue;
    const val = m[3] ?? m[4] ?? m[5] ?? '';
    if (key === 'href' && !safeUrl(val)) continue;
    out += ` ${key}="${escapeAttr(val)}"`;
  }
  return out;
}

// Block javascript:, data:, vbscript: and friends; allow the ordinary ones.
// Whitespace and control characters are stripped first so that obfuscated
// schemes like "java\nscript:" cannot slip past.
function safeUrl(url) {
  const v = String(url).replace(/[\u0000-\u0020]/g, "").toLowerCase();
  if (/^(https?:|mailto:|tel:|#|\/|\.)/.test(v)) return true;
  return !v.includes(':');
}

export const escapeText = (s) =>
  str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const escapeAttr = (s) =>
  escapeText(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Plain-text excerpt of rich text, for meta descriptions and the TOC.
export function toPlainText(html, limit = 0) {
  const text = str(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  if (!limit || text.length <= limit) return text;
  const cut = text.slice(0, limit);
  return cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : limit) + '…';
}

// A project is exportable only when published. Used identically by the site
// and PDF builders so the two can never disagree about what ships.
export function publishedProjects(data) {
  return data.projects.filter((p) => p.published).slice().sort((a, b) => a.order - b.order);
}

export function publishedTestimonials(data) {
  return data.testimonials.filter((t) => t.published).slice().sort((a, b) => a.order - b.order);
}

export function featurePhoto(project) {
  return project.photos.find((p) => p.feature) || project.photos[0] || null;
}

export function allTags(projects) {
  const counts = new Map();
  for (const p of projects) for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
