// Editor state: the portfolio document, selection, dirty tracking, explicit
// saving, and undo. Every mutation goes through here so that split mode and
// inline mode can never diverge -- they are two views onto one store.

import { normalise, emptyProject, emptyTestimonial, newId, slugify } from '../shared/model.js';

const UNDO_LIMIT = 80;

export class Store extends EventTarget {
  constructor() {
    super();
    this.data = normalise({});
    this.media = [];
    this.selection = { section: 'projects', id: null };
    this.dirty = false;
    this.saving = false;
    this.error = null;
    this._undo = [];
    this._redo = [];
    this._snapshotPending = null;
  }

  emit(type = 'change', detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async load() {
    const [dataRes, mediaRes] = await Promise.all([
      fetch('/api/portfolio'),
      fetch('/api/media'),
    ]);
    if (!dataRes.ok) throw new Error('Could not load portfolio.json');
    this.data = normalise(await dataRes.json());
    this.media = (await mediaRes.json()).media || [];
    if (!this.selection.id && this.data.projects.length) {
      this.selection.id = this.data.projects[0].id;
    }
    this.emit('load');
    this.emit('change');
  }

  // --- mutation ------------------------------------------------------------

  // All edits funnel through here. `label` groups rapid successive edits to
  // the same field into a single undo step, so typing a title is one undo
  // rather than forty.
  update(fn, { label = null, silent = false } = {}) {
    this._pushUndo(label);
    fn(this.data);
    this.dirty = true;
    if (!silent) this.emit('change');
    this.emit('status');
  }

  _pushUndo(label) {
    const snap = JSON.stringify(this.data);
    const top = this._undo[this._undo.length - 1];
    if (label && top && top.label === label && Date.now() - top.at < 900) {
      top.at = Date.now();
      return;                       // coalesce into the existing step
    }
    this._undo.push({ snap, label, at: Date.now() });
    if (this._undo.length > UNDO_LIMIT) this._undo.shift();
    this._redo.length = 0;
  }

  undo() {
    const step = this._undo.pop();
    if (!step) return false;
    this._redo.push({ snap: JSON.stringify(this.data), label: step.label, at: Date.now() });
    this.data = normalise(JSON.parse(step.snap));
    this.dirty = true;
    this.emit('change');
    this.emit('status');
    return true;
  }

  redo() {
    const step = this._redo.pop();
    if (!step) return false;
    this._undo.push({ snap: JSON.stringify(this.data), label: step.label, at: Date.now() });
    this.data = normalise(JSON.parse(step.snap));
    this.dirty = true;
    this.emit('change');
    this.emit('status');
    return true;
  }

  // --- saving --------------------------------------------------------------

  // Saving is explicit: the Save button, or Ctrl+S. There is deliberately no
  // autosave -- a save that fires mid-sentence used to re-render the form pane
  // underneath the caret and throw away what was being typed.
  async save() {
    if (this.saving) return false;
    this.saving = true;
    this.error = null;
    this.emit('status');
    try {
      const sent = JSON.stringify(this.data);
      const res = await fetch('/api/portfolio', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: sent,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const saved = await res.json();

      // The server fills in slugs and other derived fields. Copy just those
      // back, in place -- never swap out `this.data` wholesale, because that
      // would rebuild the form pane and discard whatever is being typed.
      const bySlugId = new Map(saved.projects.map((p) => [p.id, p]));
      for (const p of this.data.projects) {
        const s = bySlugId.get(p.id);
        if (s && s.slug) p.slug = s.slug;
      }

      // Anything changed since the request went out stays unsaved.
      this.dirty = JSON.stringify(this.data) !== sent;
      return true;
    } catch (err) {
      this.error = err.message;
      return false;
    } finally {
      this.saving = false;
      this.emit('status');
    }
  }

  // --- selection -----------------------------------------------------------

  select(section, id = null) {
    this.selection = { section, id };
    this.emit('select');
    this.emit('change');
  }

  get currentProject() {
    return this.data.projects.find((p) => p.id === this.selection.id) || null;
  }
  get currentTestimonial() {
    return this.data.testimonials.find((t) => t.id === this.selection.id) || null;
  }

  // --- projects ------------------------------------------------------------

  addProject(overrides = {}) {
    const p = emptyProject({ order: this.data.projects.length, ...overrides });
    p.slug = slugify(p.title);
    this.update((d) => d.projects.push(p));
    this.select('projects', p.id);
    return p;
  }

  removeProject(id) {
    const i = this.data.projects.findIndex((p) => p.id === id);
    if (i === -1) return;
    this.update((d) => { d.projects.splice(i, 1); d.projects.forEach((p, n) => { p.order = n; }); });
    const next = this.data.projects[Math.min(i, this.data.projects.length - 1)];
    this.select('projects', next ? next.id : null);
  }

  duplicateProject(id) {
    const src = this.data.projects.find((p) => p.id === id);
    if (!src) return;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = newId();
    copy.title = src.title + ' (copy)';
    copy.slug = '';
    copy.published = false;
    copy.order = src.order + 0.5;
    this.update((d) => { d.projects.push(copy); d.projects.sort((a, b) => a.order - b.order);
                         d.projects.forEach((p, n) => { p.order = n; }); });
    this.select('projects', copy.id);
  }

  // Combine several projects into the first. The seeder deliberately splits
  // finely (1cu_crank, 1cu_piston, 1cu_assembled are separate families), so
  // this is how those get recombined into the single job they really were.
  mergeProjects(ids) {
    if (ids.length < 2) return null;
    const keep = this.data.projects.find((p) => p.id === ids[0]);
    if (!keep) return null;
    const rest = ids.slice(1)
      .map((id) => this.data.projects.find((p) => p.id === id))
      .filter(Boolean);

    this.update((d) => {
      const target = d.projects.find((p) => p.id === keep.id);
      for (const other of rest) {
        const src = d.projects.find((p) => p.id === other.id);
        if (!src) continue;
        for (const ph of src.photos) {
          if (!target.photos.some((x) => x.src === ph.src)) {
            target.photos.push({ ...ph, feature: false });
          }
        }
        for (const t of src.tags) if (!target.tags.includes(t)) target.tags.push(t);
        for (const s of src.specs) target.specs.push(s);
        if (src.body) target.body = (target.body || '') + src.body;
        if (!target.summary && src.summary) target.summary = src.summary;
      }
      if (!target.photos.some((p) => p.feature) && target.photos[0]) target.photos[0].feature = true;
      const drop = new Set(rest.map((r) => r.id));
      d.projects = d.projects.filter((p) => !drop.has(p.id));
      d.projects.forEach((p, n) => { p.order = n; });
      // Any testimonial pointing at a merged-away project follows the merge.
      for (const t of d.testimonials) if (drop.has(t.projectId)) t.projectId = target.id;
    });
    this.select('projects', keep.id);
    return keep;
  }

  reorderProjects(fromId, toIndex) {
    const list = this.data.projects;
    const from = list.findIndex((p) => p.id === fromId);
    if (from === -1) return;
    this.update((d) => {
      const [item] = d.projects.splice(from, 1);
      d.projects.splice(Math.max(0, Math.min(toIndex, d.projects.length)), 0, item);
      d.projects.forEach((p, n) => { p.order = n; });
    });
  }

  // --- testimonials --------------------------------------------------------

  addTestimonial(overrides = {}) {
    const t = emptyTestimonial({ order: this.data.testimonials.length, ...overrides });
    this.update((d) => d.testimonials.push(t));
    this.select('testimonials', t.id);
    return t;
  }

  removeTestimonial(id) {
    const i = this.data.testimonials.findIndex((t) => t.id === id);
    if (i === -1) return;
    this.update((d) => { d.testimonials.splice(i, 1); d.testimonials.forEach((t, n) => { t.order = n; }); });
    const next = this.data.testimonials[Math.min(i, this.data.testimonials.length - 1)];
    this.select('testimonials', next ? next.id : null);
  }

  reorderTestimonials(fromId, toIndex) {
    const from = this.data.testimonials.findIndex((t) => t.id === fromId);
    if (from === -1) return;
    this.update((d) => {
      const [item] = d.testimonials.splice(from, 1);
      d.testimonials.splice(Math.max(0, Math.min(toIndex, d.testimonials.length)), 0, item);
      d.testimonials.forEach((t, n) => { t.order = n; });
    });
  }

  // --- media ---------------------------------------------------------------

  async refreshMedia() {
    const res = await fetch('/api/media');
    this.media = (await res.json()).media || [];
    this.emit('media');
  }

  async upload(file) {
    const res = await fetch(`/api/media/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST', body: file,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
    const { src } = await res.json();
    await this.refreshMedia();
    return src;
  }

  // Which project each photo is used by, for the "already used" badge in the
  // media picker.
  usageMap() {
    const map = new Map();
    for (const p of this.data.projects) {
      for (const ph of p.photos) {
        if (!map.has(ph.src)) map.set(ph.src, []);
        map.get(ph.src).push(p.title);
      }
    }
    for (const t of this.data.testimonials) {
      if (!t.image) continue;
      if (!map.has(t.image)) map.set(t.image, []);
      map.get(t.image).push(t.author || 'Testimonial');
    }
    return map;
  }
}
