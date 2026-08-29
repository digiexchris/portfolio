// Live preview. Renders into a same-origin iframe using the very same
// shared/render.js templates the exporters use, so what is on screen here is
// what lands in dist/ and in the PDF.
//
// Screen view  -> site.css
// Print view   -> print.css + Paged.js, i.e. the actual paginated document,
//                 page numbers and all.

import { htmlDocument, indexBody, projectBody, testimonialsBody, aboutBody, printBody, previewCtx }
  from '../shared/render.js';

export class Preview {
  constructor(frame, store) {
    this.frame = frame;
    this.store = store;
    this.view = 'screen';       // 'screen' | 'print'
    this.page = 'auto';         // 'auto' follows the sidebar; else a site page
    this.onNavigate = null;     // clicking a link in the preview routes here
    this.onShortcut = null;     // key events inside the iframe route here
    this._pending = null;
    this._scroll = 0;
    this._lastKey = '';
  }

  ctx() {
    return previewCtx({
      img: (src) => (src ? '/media/' + encodeURI(src) : ''),
      // Links resolve to an internal scheme the click handler below routes,
      // so the preview navigates like the real site instead of being inert.
      href: (kind, arg) =>
        kind === 'project' ? `#nav:project:${arg.slug}` : `#nav:${kind || 'index'}`,
      tagLinks: false,
    });
  }

  // What the preview shows follows the sidebar selection, so the pane always
  // reflects whatever is being edited.
  buildBody() {
    const { store } = this;
    const ctx = this.ctx();
    const sel = store.selection;

    if (this.view === 'print') return printBody(store.data, this.ctx());

    // An explicit page wins; otherwise the preview follows the sidebar.
    if (this.page === 'index') return indexBody(store.data, ctx);
    if (this.page === 'testimonials') return testimonialsBody(store.data, ctx);
    if (this.page === 'about') return aboutBody(store.data, ctx);

    if (sel.section === 'projects') {
      const p = store.currentProject;
      return p ? projectBody(store.data, p, ctx) : indexBody(store.data, ctx);
    }
    if (sel.section === 'testimonials') return testimonialsBody(store.data, ctx);
    if (sel.section === 'profile') return aboutBody(store.data, ctx);
    return indexBody(store.data, ctx);
  }

  head() {
    const css = this.view === 'print'
      ? ['/shared/styles/tokens.css', '/shared/styles/print.css']
      : ['/shared/styles/tokens.css', '/shared/styles/site.css'];
    let out = css.map((h) => `<link rel="stylesheet" href="${h}">`).join('');

    if (this.view === 'print') {
      // Paged.js paginates in the iframe, exactly as it will for the PDF.
      out += '<style>'
        + 'body{background:#e9e4db}'
        + '.pagedjs_pages{padding:14px 0;display:flex;flex-direction:column;align-items:center;gap:14px}'
        + '.pagedjs_page{background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.18)}'
        + '</style>';
    }
    return out;
  }

  // Rebuild the whole document. Debounced by the caller.
  render() {
    const doc = this.frame.contentDocument;
    if (doc && doc.body) this._scroll = doc.documentElement.scrollTop || doc.body.scrollTop || 0;

    const html = htmlDocument({
      title: 'Preview',
      accent: this.store.data.settings.accent || '#b4531f',
      bodyClass: this.view === 'print' ? 'print-preview' : 'screen-preview',
      head: this.head(),
      body: this.buildBody(),
    });

    // Rewriting via document.write keeps the iframe same-origin, so the editor
    // can read back into it.
    const f = this.frame;
    const d = f.contentDocument;
    d.open();
    d.write(html);
    d.close();

    // document.write() parses synchronously, so the DOM is ready here even
    // though stylesheets and scripts are still loading.
    // Key events inside this document never reach the editor window, so
    // forward the shortcuts -- Ctrl+S must work with the preview focused.
    d.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey) this.onShortcut?.(e);
    });

    // Route the preview's own links rather than letting them navigate the
    // iframe away from the editor.
    d.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      const m = /^#nav:([a-z]+)(?::(.+))?$/.exec(a.getAttribute('href') || '');
      if (m) this.onNavigate?.(m[1], m[2] ? decodeURIComponent(m[2]) : null);
    }, true);

    if (this.view === 'print') {
      this._runPaged(d);
    } else {
      d.documentElement.scrollTop = this._scroll;
    }
  }

  async _runPaged(d) {
    try {
      const script = d.createElement('script');
      script.src = '/vendor/paged.polyfill.js';
      script.onload = () => {
        d.documentElement.scrollTop = this._scroll;
      };
      script.onerror = () => {
        d.body.insertAdjacentHTML('afterbegin',
          '<p style="padding:1rem;background:#fdecea;color:#b3261e;font:13px sans-serif">'
          + 'Paged.js is missing from vendor/. Run <code>npm run vendor</code>.</p>');
      };
      d.head.append(script);
    } catch (err) {
      console.error('Paged.js failed', err);
    }
  }

  setView(view) {
    if (this.view === view) return;
    this.view = view;
    this._scroll = 0;
    this.render();
  }

  setPage(page) {
    if (this.page === page) return;
    this.page = page;
    this._scroll = 0;
    this.render();
  }


  // Scroll the preview to the element for a given project.
  revealProject(slug) {
    const d = this.frame.contentDocument;
    const el = d && d.getElementById('project-' + slug);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
