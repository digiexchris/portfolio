// Media drawer: browse the 136 source photos plus anything uploaded.
// Everything is shown through the server's cached thumbnail route, so opening
// this never pulls full-resolution originals.

import { el } from './forms.js';
import { IMAGE_SRC_RE } from '../shared/model.js';

const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

export class MediaPicker {
  constructor(store) {
    this.store = store;
    this.opts = null;
    this.filter = '';

    this.drawer = document.getElementById('drawer');
    this.grid = document.getElementById('media-grid');
    this.search = document.getElementById('media-search');
    this.title = document.getElementById('drawer-title');
    this.uploadButton = document.querySelector('label[for="media-upload"]');
    this.report = document.getElementById('media-report');
    this.busy = null;                 // the progress tile while something uploads

    this.search.addEventListener('input', () => { this.filter = this.search.value.toLowerCase(); this.refresh(); });
    document.getElementById('drawer-close').addEventListener('click', () => this.close());
    document.getElementById('media-upload').addEventListener('change', async (e) => {
      await this.upload(e.target.files);
      e.target.value = '';          // so the same file can be chosen again
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.drawer.hidden) this.close();
    });
  }

  // opts.imagesOnly: a picker for a single image (poster, portrait, cover,
  // testimonial scan) -- videos are not offered.
  open(opts) {
    this.opts = { single: false, imagesOnly: false, selected: [], ...opts };
    this.selected = new Set(this.opts.selected);
    this.title.textContent = opts.title || 'Photos';
    this.drawer.hidden = false;
    this.report.hidden = true;
    this.search.value = '';
    this.filter = '';
    this.refresh();
    this.search.focus();
  }

  close() {
    this.drawer.hidden = true;
    this.opts = null;
  }

  // Photos upload as before. Videos are converted by the server and zips
  // unpacked, both with progress on a tile at the head of the grid. Only a
  // gallery (multi-select) picker adds what was imported; a single-image
  // picker keeps the old behaviour for a photo and selects nothing else.
  async upload(files) {
    if (!files || !files.length) return;
    const lines = [];
    const add = (src) => {
      if (!this.opts || !src) return;
      if (this.opts.single && !IMAGE_SRC_RE.test(src)) return;
      this.selected.add(src);
      this.opts.onToggle(src, true);
    };
    for (const f of [...files]) {
      try {
        if (/\.zip$/i.test(f.name)) {
          this.setBusy(`Unpacking ${f.name}…`, 0);
          const r = await this.store.uploadStreaming(f, 'zip', (e) => {
            if (e.entry) this.setBusy(`${e.index} of ${e.total} — ${e.entry}`, 0);
            if (typeof e.progress === 'number') this.setBusy(null, e.progress);
          });
          if (!this.opts?.single) r.imported.forEach(add);
          lines.push(`${f.name}: ${r.imported.length} imported`
            + (r.skipped.length ? `; skipped ${r.skipped.join(', ')}` : '')
            + (r.failed.length ? `; failed ${r.failed.map((x) => `${x.name} (${x.error})`).join(', ')}` : ''));
        } else if (VIDEO_RE.test(f.name)) {
          this.setBusy(`Converting ${f.name}…`, 0);
          const r = await this.store.uploadStreaming(f, 'video', (e) => {
            if (typeof e.progress === 'number') this.setBusy(null, e.progress);
          });
          add(r.src);
          lines.push(`${f.name}: converted`);
        } else if (IMAGE_SRC_RE.test(f.name)) {
          add(await this.store.upload(f));
        } else {
          lines.push(`${f.name}: not a photo, video or zip — skipped`);
        }
      } catch (err) {
        lines.push(`${f.name}: failed — ${err.message}`);
      }
    }
    this.setBusy();
    this.showReport(lines);
    this.refresh();
  }

  // The progress tile. setBusy() with no arguments removes it.
  setBusy(label, fraction) {
    if (label === undefined) { this.busy = null; this.busyNode?.remove(); this.busyNode = null; return; }
    this.busy = { label: label ?? this.busy?.label ?? '', fraction: fraction ?? 0 };
    if (!this.busyNode) {
      this.busyNode = el('div', { class: 'media-item is-busy' },
        el('div', { class: 'busy-bar' }, el('span')), el('span', { class: 'name' }));
    }
    this.busyNode.querySelector('.name').textContent = this.busy.label;
    this.busyNode.querySelector('.busy-bar span').style.width = Math.round(this.busy.fraction * 100) + '%';
    if (this.busyNode.parentNode !== this.grid) this.grid.prepend(this.busyNode);
  }

  // What happened, until dismissed. Replaces alert() for uploads.
  showReport(lines) {
    if (!lines.length) return;
    this.report.textContent = '';
    this.report.append(
      el('ul', {}, ...lines.map((l) => el('li', {}, l))),
      el('button', { class: 'btn small', onclick: () => { this.report.hidden = true; } }, 'Dismiss'));
    this.report.hidden = false;
  }

  // Without ffmpeg on the server, video uploads (and videos inside zips)
  // can only fail, so say so before anyone tries.
  showVideoSupport() {
    const ok = this.store.videoSupport !== false;
    this.uploadButton.classList.toggle('warn', !ok);
    this.uploadButton.title = ok ? ''
      : '⚠ ffmpeg isn\'t installed, so video uploads will fail (videos inside zips are skipped as failed). '
        + 'Photos and zips of photos still upload. Install ffmpeg (see Development.md), then reload this page.';
  }

  refresh() {
    if (!this.opts) return;
    this.showVideoSupport();
    const usage = this.store.usageMap();
    const items = this.store.media.filter((m) => (!this.filter || m.src.toLowerCase().includes(this.filter))
      && !(this.opts.imagesOnly && m.kind === 'video'));
    this.grid.textContent = '';
    if (this.busyNode) this.grid.append(this.busyNode);

    for (const m of items) {
      const on = this.selected.has(m.src);
      const used = usage.get(m.src) || [];
      const node = el('div', {
        class: 'media-item' + (on ? ' is-on' : '') + (m.kind === 'video' ? ' is-video' : ''),
        title: m.src + (used.length ? '\nUsed in: ' + used.join(', ') : ''),
        onclick: () => this.toggle(m.src),
      },
        el('img', { src: '/thumbs/' + encodeURI(m.src), alt: '', loading: 'lazy' }),
        m.kind === 'video' ? el('span', { class: 'play-badge', 'aria-hidden': 'true' }, '▶') : null,
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
