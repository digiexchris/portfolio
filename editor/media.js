// Media drawer: browse the 136 source photos plus anything uploaded.
// Everything is shown through the server's cached thumbnail route, so opening
// this never pulls full-resolution originals.

import { el } from './forms.js';

export class MediaPicker {
  constructor(store) {
    this.store = store;
    this.opts = null;
    this.filter = '';

    this.drawer = document.getElementById('drawer');
    this.grid = document.getElementById('media-grid');
    this.search = document.getElementById('media-search');
    this.title = document.getElementById('drawer-title');

    this.search.addEventListener('input', () => { this.filter = this.search.value.toLowerCase(); this.refresh(); });
    document.getElementById('drawer-close').addEventListener('click', () => this.close());
    document.getElementById('media-upload').addEventListener('change', (e) => this.upload(e.target.files));

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.drawer.hidden) this.close();
    });
  }

  open(opts) {
    this.opts = { single: false, selected: [], ...opts };
    this.selected = new Set(this.opts.selected);
    this.title.textContent = opts.title || 'Photos';
    this.drawer.hidden = false;
    this.search.value = '';
    this.filter = '';
    this.refresh();
    this.search.focus();
  }

  close() {
    this.drawer.hidden = true;
    this.opts = null;
  }

  async upload(files) {
    if (!files || !files.length) return;
    for (const f of files) {
      try {
        const src = await this.store.upload(f);
        if (this.opts) {
          this.selected.add(src);
          this.opts.onToggle(src, true);
        }
      } catch (err) {
        alert('Upload failed: ' + err.message);
      }
    }
    this.refresh();
  }

  refresh() {
    if (!this.opts) return;
    const usage = this.store.usageMap();
    const items = this.store.media.filter((m) => !this.filter || m.src.toLowerCase().includes(this.filter));
    this.grid.textContent = '';

    for (const m of items) {
      const on = this.selected.has(m.src);
      const used = usage.get(m.src) || [];
      const node = el('div', {
        class: 'media-item' + (on ? ' is-on' : ''),
        title: m.src + (used.length ? '\nUsed in: ' + used.join(', ') : ''),
        onclick: () => this.toggle(m.src),
      },
        el('img', { src: '/thumbs/' + encodeURI(m.src), alt: '', loading: 'lazy' }),
        el('span', { class: 'name' }, m.src),
        used.length ? el('span', { class: 'used' }, used.length > 1 ? `used ${used.length}×` : 'used') : null);
      this.grid.append(node);
    }

    if (!items.length) {
      this.grid.append(el('p', { class: 'hint' }, this.filter ? 'No photos match that filter.' : 'No photos found.'));
    }
  }

  toggle(src) {
    const on = !this.selected.has(src);
    if (this.opts.single) {
      this.selected.clear();
      if (on) this.selected.add(src);
      this.opts.onToggle(src, on);
      this.refresh();
      if (on) this.close();
      return;
    }
    if (on) this.selected.add(src); else this.selected.delete(src);
    this.opts.onToggle(src, on);
    this.refresh();
  }
}
