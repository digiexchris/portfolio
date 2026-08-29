// Editor entry point: wires the store, sidebar, form pane, preview and
// exports together, and hosts both editing modes.

import { Store } from './store.js';
import { Preview } from './preview.js';
import { MediaPicker } from './media.js';
import { el, textField, checkField, richField, listField, repeatField } from './forms.js';
import { featurePhoto, toPlainText } from '../shared/model.js';

const $ = (id) => document.getElementById(id);

const store = new Store();
const preview = new Preview($('preview-frame'), store);
const media = new MediaPicker(store);

// Selecting this instead of a project id edits the Work page itself rather
// than any one entry on it.
const PAGE_ID = '__work-page__';

const ui = {
  filter: '',
  checked: new Set(),       // multi-select for merge / bulk publish
};

// --- boot -------------------------------------------------------------------

(async function boot() {
  try {
    await store.load();
  } catch (err) {
    setStatus('error', err.message);
    return;
  }
  wireTopbar();
  wireSidebar();
  wireShortcuts();
  wirePreviewNav();

  store.addEventListener('change', () => { renderSidebar(); renderForm(); schedulePreview(); });
  store.addEventListener('preview', schedulePreview);
  store.addEventListener('select', () => {
    if (store.selection.id) preview.page = 'auto';
    syncSiteButtons();
    renderSidebar(); renderForm(); schedulePreview();
  });
  store.addEventListener('status', renderStatus);
  store.addEventListener('media', () => media.refresh());

  renderSidebar();
  renderForm();
  preview.render();
  renderStatus();
})();

// --- status -----------------------------------------------------------------

function setStatus(kind, text) {
  const n = $('status');
  n.className = 'status ' + kind;
  n.textContent = text;
}

function renderStatus() {
  const btn = $('btn-save');
  btn.classList.toggle('primary', store.dirty);
  btn.disabled = store.saving;
  btn.textContent = store.dirty ? 'Save •' : 'Saved';
  document.title = (store.dirty ? '• ' : '') + 'Portfolio Editor';

  if (store.error) return setStatus('error', 'Save failed: ' + store.error);
  if (store.saving) return setStatus('saving', 'Saving…');
  if (store.dirty) return setStatus('dirty', 'Unsaved changes — Ctrl+S to save');
  const n = store.data.projects.length;
  const pub = store.data.projects.filter((p) => p.published).length;
  setStatus('saved', `Saved · ${pub}/${n} published`);
}

// Clicking a link inside the preview navigates it like the real site, and
// selecting a project there selects it in the sidebar too, so the form pane
// always matches what is on screen.
function wirePreviewNav() {
  preview.onNavigate = (kind, arg) => {
    if (kind === 'project') {
      const p = store.data.projects.find((x) => x.slug === arg);
      if (!p) return;
      preview.page = 'auto';
      store.select('projects', p.id);
      return;
    }
    if (kind === 'index') { preview.setPage('index'); store.selection.id = null; renderSidebar(); renderForm(); }
    else if (kind === 'testimonials') preview.setPage('testimonials');
    else if (kind === 'about') preview.setPage('about');
    syncSiteButtons();
  };
}

// The Page control reflects wherever the preview currently is.
function syncSiteButtons() {
  for (const b of document.querySelectorAll('[data-page]')) {
    b.classList.toggle('is-on', b.dataset.page === preview.page);
  }
}

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => preview.render(), 220);
}

function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}

// --- topbar -----------------------------------------------------------------

function wireTopbar() {
  for (const b of document.querySelectorAll('[data-page]')) {
    b.addEventListener('click', () => {
      const page = b.dataset.page;
      preview.setPage(page);
      if (page === 'auto' && !store.selection.id && store.data.projects[0]) {
        store.select('projects', store.data.projects[0].id);
      }
      syncSiteButtons();
    });
  }
  for (const b of document.querySelectorAll('[data-view]')) {
    b.addEventListener('click', () => {
      for (const o of document.querySelectorAll('[data-view]')) o.classList.toggle('is-on', o === b);
      preview.setView(b.dataset.view);
    });
  }
  $('btn-save').addEventListener('click', async () => {
    const ok = await store.save();
    toast(ok ? 'Saved' : 'Save failed: ' + store.error, !ok);
  });
  $('btn-preview-site').addEventListener('click', () => runExport('preview'));
  $('btn-export-site').addEventListener('click', () => runExport('site'));
  $('btn-export-pdf').addEventListener('click', () => runExport('pdf'));
  $('console-close').addEventListener('click', () => { $('console').hidden = true; });
  $('console-open').addEventListener('click', () => {
    fetch(`/api/open?what=${$('console-open').dataset.what || 'site'}`, { method: 'POST' });
  });
}


// --- sidebar ----------------------------------------------------------------

function wireSidebar() {
  for (const t of document.querySelectorAll('.side-tab')) {
    t.addEventListener('click', () => {
      const section = t.dataset.section;
      const first = section === 'projects' ? store.data.projects[0]
                  : section === 'testimonials' ? store.data.testimonials[0] : null;
      ui.checked.clear();
      store.select(section, first ? first.id : null);
    });
  }
  $('side-search').addEventListener('input', (e) => { ui.filter = e.target.value.toLowerCase(); renderSidebar(); });
  $('btn-add').addEventListener('click', () => {
    const s = store.selection.section;
    if (s === 'testimonials') store.addTestimonial();
    else store.addProject();
  });
  $('btn-merge').addEventListener('click', doMerge);
  $('btn-bulk-publish').addEventListener('click', () => {
    const ids = [...ui.checked];
    store.update((d) => {
      for (const p of d.projects) if (ids.includes(p.id)) p.published = true;
    });
    ui.checked.clear();
    toast(`Published ${ids.length}`);
  });
  $('btn-bulk-clear').addEventListener('click', () => { ui.checked.clear(); renderSidebar(); });
}

function doMerge() {
  const ids = store.data.projects.filter((p) => ui.checked.has(p.id)).map((p) => p.id);
  if (ids.length < 2) return toast('Select at least two projects to merge', true);
  const keep = store.data.projects.find((p) => p.id === ids[0]);
  const names = store.data.projects.filter((p) => ui.checked.has(p.id)).map((p) => p.title);
  if (!confirm(`Merge ${ids.length} projects into "${keep.title}"?\n\n${names.join('\n')}\n\nPhotos, tags and specs are combined. This can be undone with Ctrl+Z.`)) return;
  store.mergeProjects(ids);
  ui.checked.clear();
  toast(`Merged ${ids.length} projects`);
}

function renderSidebar() {
  const section = store.selection.section;
  for (const t of document.querySelectorAll('.side-tab')) t.classList.toggle('is-on', t.dataset.section === section);

  const list = $('side-list');
  const tools = $('side-tools');
  const bulk = $('side-bulk');
  list.textContent = '';

  const isList = section === 'projects' || section === 'testimonials';
  tools.hidden = !isList;
  bulk.hidden = !(section === 'projects' && ui.checked.size);
  if (!bulk.hidden) $('bulk-count').textContent = `${ui.checked.size} selected`;

  if (section === 'projects') renderProjectList(list);
  else if (section === 'testimonials') renderTestimonialList(list);

  const foot = $('side-foot');
  if (section === 'projects') {
    const n = store.data.projects.length;
    const pub = store.data.projects.filter((p) => p.published).length;
    const photos = store.data.projects.reduce((a, p) => a + p.photos.length, 0);
    foot.textContent = `${n} projects · ${pub} published · ${photos} photos`;
  } else if (section === 'testimonials') {
    foot.textContent = `${store.data.testimonials.length} testimonials`;
  } else foot.textContent = '';
}

function renderProjectList(list) {
  // The Work page's own intro text, pinned above the entries that appear on it.
  const pageRow = el('li', {
    class: 'side-item is-page' + (store.selection.id === PAGE_ID ? ' is-on' : ''),
    title: 'Text shown above the gallery on the Work page',
    onclick: () => store.select('projects', PAGE_ID),
  },
    el('span', { class: 'page-icon', 'aria-hidden': 'true' }, '¶'),
    el('span', { class: 'label' }, 'Work page intro'),
    el('span', { class: 'dot' + (store.data.home.intro ? ' live' : '') }));
  list.append(pageRow);

  const items = store.data.projects.filter((p) =>
    !ui.filter || p.title.toLowerCase().includes(ui.filter) || p.tags.join(' ').toLowerCase().includes(ui.filter));

  items.forEach((p) => {
    const photo = featurePhoto(p);
    const check = el('input', { type: 'checkbox', class: 'check', title: 'Select for merge / bulk publish' });
    check.checked = ui.checked.has(p.id);
    check.addEventListener('click', (e) => e.stopPropagation());
    check.addEventListener('change', () => {
      if (check.checked) ui.checked.add(p.id); else ui.checked.delete(p.id);
      renderSidebar();
    });

    const item = el('li', {
      class: 'side-item' + (p.id === store.selection.id ? ' is-on' : '')
        + (ui.checked.has(p.id) ? ' is-checked' : '') + (p.published ? '' : ' is-draft'),
      draggable: 'true',
      onclick: () => store.select('projects', p.id),
    },
      check,
      photo ? el('img', { class: 'thumb', src: '/thumbs/' + encodeURI(photo.src), alt: '', loading: 'lazy' })
            : el('span', { class: 'thumb' }),
      el('span', { class: 'label', title: p.title }, p.title),
      el('span', { class: 'n' }, String(p.photos.length)),
      el('span', { class: 'dot' + (p.published ? ' live' : ''), title: p.published ? 'Published' : 'Draft' }));

    wireDrag(item, p.id, items, (fromId, toIndex) => store.reorderProjects(fromId, toIndex));
    list.append(item);
  });

  if (!items.length) list.append(el('li', { class: 'side-foot' }, ui.filter ? 'No matches' : 'No projects yet'));
}

function renderTestimonialList(list) {
  const items = store.data.testimonials.filter((t) =>
    !ui.filter || (t.author + ' ' + t.company + ' ' + toPlainText(t.quote)).toLowerCase().includes(ui.filter));

  items.forEach((t) => {
    const item = el('li', {
      class: 'side-item' + (t.id === store.selection.id ? ' is-on' : '') + (t.published ? '' : ' is-draft'),
      draggable: 'true',
      onclick: () => store.select('testimonials', t.id),
    },
      el('span', { class: 'label' }, t.author || toPlainText(t.quote, 30) || 'New testimonial'),
      el('span', { class: 'dot' + (t.published ? ' live' : '') }));
    wireDrag(item, t.id, items, (fromId, toIndex) => store.reorderTestimonials(fromId, toIndex));
    list.append(item);
  });

  if (!items.length) list.append(el('li', { class: 'side-foot' }, 'No testimonials yet'));
}

// Drag-to-reorder. Reordering is only meaningful on the unfiltered list, so
// the drop index is resolved against the full array.
function wireDrag(item, id, items, apply) {
  item.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
  });
  item.addEventListener('dragover', (e) => { e.preventDefault(); item.classList.add('drag-over'); });
  item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
  item.addEventListener('drop', (e) => {
    e.preventDefault();
    item.classList.remove('drag-over');
    const fromId = e.dataTransfer.getData('text/plain');
    if (!fromId || fromId === id) return;
    const target = items.findIndex((x) => x.id === id);
    apply(fromId, target);
  });
}

// --- form pane --------------------------------------------------------------

function renderForm() {
  const pane = $('form-pane');
  pane.textContent = '';
  const s = store.selection.section;
  if (s === 'projects' && store.selection.id === PAGE_ID) pane.append(workPageForm());
  else if (s === 'projects') pane.append(projectForm());
  else if (s === 'testimonials') pane.append(testimonialForm());
  else if (s === 'profile') pane.append(profileForm());
  else pane.append(settingsForm());
}

function workPageForm() {
  const frag = document.createDocumentFragment();
  frag.append(el('h2', {}, 'Work page'));
  frag.append(el('p', { class: 'hint', style: 'margin:-.6rem 0 1rem' },
    'The front page of the site. This text sits above the gallery.'));
  frag.append(richField('Intro', store.data.home, 'intro', store,
    'A short introduction to the work — what you make, what you fix, what you want to be judged on.'));
  frag.append(el('p', { class: 'hint' },
    'Separate from the About text, which is on the Profile tab and appears on the About page.'));
  return frag;
}

function projectForm() {
  const p = store.currentProject;
  const frag = document.createDocumentFragment();
  if (!p) {
    frag.append(el('h2', {}, 'No project selected'),
      el('p', { class: 'hint' }, 'Pick one from the list, or press + New.'));
    return frag;
  }

  frag.append(el('h2', {}, 'Project'));
  frag.append(checkField('Published — include in the exported site and PDF', p, 'published', store));
  frag.append(textField('Title', p, 'title', store, {
    onInput: () => { /* slug is regenerated server-side when blank */ },
  }));
  frag.append(el('div', { class: 'row' },
    textField('Subtitle', p, 'subtitle', store, { placeholder: 'Client, machine, context' }),
    textField('Date', p, 'date', store, { placeholder: 'March 2024' })));
  frag.append(textField('Summary', p, 'summary', store, {
    multiline: true, rows: 2,
    placeholder: 'One or two lines. Shown on the index cards and in the PDF contents.',
  }));
  frag.append(listField('Tags', p, 'tags', store, 'Comma separated. Used for filtering on the site.'));
  frag.append(repeatField('Specs', p.specs, store, [
    { key: 'label', placeholder: 'Material' },
    { key: 'value', placeholder: '12L14 steel' },
  ], { addLabel: '+ Add spec' }));
  frag.append(richField('Writeup', p, 'body', store, 'What the job was, how you approached it, what it took…'));
  frag.append(photoStrip(p));

  frag.append(el('div', { class: 'rep-row', style: 'margin-top:1.2rem' },
    el('button', { class: 'btn small', onclick: () => store.duplicateProject(p.id) }, 'Duplicate'),
    el('button', {
      class: 'btn small danger',
      onclick: () => { if (confirm(`Delete "${p.title}"? Ctrl+Z undoes this.`)) store.removeProject(p.id); },
    }, 'Delete')));
  return frag;
}

function photoStrip(p) {
  const grid = el('div', { class: 'photo-strip' });
  p.photos.forEach((ph, i) => {
    const cap = el('input', { class: 'strip-cap', type: 'text', placeholder: 'Caption…' });
    cap.value = ph.caption || '';
    cap.addEventListener('input', () => {
      const v = cap.value;
      store.update(() => { ph.caption = v; }, { label: `cap:${p.id}:${i}`, silent: true });
      store.emit('preview');
    });
    cap.addEventListener('blur', () => store.emit('change'));

    const item = el('div', {
      class: 'strip-item' + (ph.feature ? ' is-feature' : ''), draggable: 'true',
    },
      el('img', { src: '/thumbs/' + encodeURI(ph.src), alt: ph.alt || '', loading: 'lazy', title: ph.src }),
      cap,
      el('div', { class: 'strip-tools' },
        el('button', {
          class: ph.feature ? 'on' : '', title: 'Use as the lead photo',
          onclick: () => store.update(() => { p.photos.forEach((x) => { x.feature = false; }); ph.feature = true; }),
        }, ph.feature ? '★ Lead' : '☆ Lead'),
        el('button', {
          title: 'Remove from this project',
          onclick: () => store.update(() => {
            p.photos.splice(i, 1);
            if (!p.photos.some((x) => x.feature) && p.photos[0]) p.photos[0].feature = true;
          }),
        }, 'Remove')));

    item.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); });
    item.addEventListener('dragover', (e) => { e.preventDefault(); item.classList.add('drag-over'); });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      const from = Number(e.dataTransfer.getData('text/plain'));
      if (Number.isNaN(from) || from === i) return;
      store.update(() => {
        const [moved] = p.photos.splice(from, 1);
        p.photos.splice(i, 0, moved);
      });
    });
    grid.append(item);
  });

  grid.append(el('button', {
    class: 'strip-add', type: 'button',
    onclick: () => media.open({
      title: `Photos for “${p.title}”`,
      selected: p.photos.map((x) => x.src),
      onToggle: (src, on) => {
        store.update(() => {
          if (on) {
            if (!p.photos.some((x) => x.src === src)) {
              p.photos.push({ src, caption: '', alt: '', feature: p.photos.length === 0 });
            }
          } else {
            const idx = p.photos.findIndex((x) => x.src === src);
            if (idx > -1) p.photos.splice(idx, 1);
            if (!p.photos.some((x) => x.feature) && p.photos[0]) p.photos[0].feature = true;
          }
        });
      },
    }),
  }, '+ Add photos'));

  return el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Photos'), grid);
}

function testimonialForm() {
  const t = store.currentTestimonial;
  const frag = document.createDocumentFragment();
  if (!t) {
    frag.append(el('h2', {}, 'No testimonial selected'),
      el('p', { class: 'hint' }, 'Press + New to add a note from a client.'));
    return frag;
  }
  frag.append(el('h2', {}, 'Testimonial'));
  frag.append(checkField('Published', t, 'published', store));
  frag.append(checkField('Feature this one', t, 'featured', store));
  frag.append(richField('Quote', t, 'quote', store, 'What the client said…'));
  frag.append(el('div', { class: 'row' },
    textField('Name', t, 'author', store, { placeholder: 'Jane Doe' }),
    textField('Date', t, 'date', store, { placeholder: 'June 2024' })));
  frag.append(el('div', { class: 'row' },
    textField('Role', t, 'role', store, { placeholder: 'Shop foreman' }),
    textField('Company', t, 'company', store, { placeholder: 'Acme Fabrication' })));

  // Link to a project, so the PDF and site can say what the note refers to.
  const sel = el('select');
  sel.append(el('option', { value: '' }, '— not linked —'));
  for (const p of store.data.projects) {
    const o = el('option', { value: p.id }, p.title);
    if (p.id === t.projectId) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', () => store.update(() => { t.projectId = sel.value || null; }));
  frag.append(el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'About which project'), sel));

  // Optional scan or screenshot of the original note.
  const scan = el('div', { class: 'photo-strip' });
  if (t.image) {
    scan.append(el('div', { class: 'strip-item' },
      el('img', { src: '/thumbs/' + encodeURI(t.image), alt: '' }),
      el('div', { class: 'strip-tools' },
        el('button', { onclick: () => store.update(() => { t.image = null; }) }, 'Remove'))));
  }
  scan.append(el('button', {
    class: 'strip-add', type: 'button',
    onclick: () => media.open({
      title: 'Scan or screenshot of the note',
      selected: t.image ? [t.image] : [],
      single: true,
      onToggle: (src, on) => store.update(() => { t.image = on ? src : null; }),
    }),
  }, t.image ? 'Replace image' : '+ Add scan'));
  frag.append(el('div', { class: 'field' },
    el('span', { class: 'field-label' }, 'Scan of the note (optional)'), scan,
    el('p', { class: 'hint' }, 'A photo of a handwritten note or a screenshot of an email reads as more genuine than typed text alone.')));

  frag.append(el('div', { class: 'rep-row', style: 'margin-top:1.2rem' },
    el('button', {
      class: 'btn small danger',
      onclick: () => { if (confirm('Delete this testimonial?')) store.removeTestimonial(t.id); },
    }, 'Delete')));
  return frag;
}

function profileForm() {
  const p = store.data.profile;
  const frag = document.createDocumentFragment();
  frag.append(el('h2', {}, 'Profile'));
  frag.append(textField('Name', p, 'name', store, { placeholder: 'Your name' }));
  frag.append(textField('Tagline', p, 'tagline', store, { placeholder: 'Machinist · engine builder · fabricator' }));
  frag.append(el('div', { class: 'row' },
    textField('Location', p, 'location', store, { placeholder: 'City, Province' }),
    textField('Phone', p, 'phone', store, { type: 'tel' })));
  frag.append(textField('Email', p, 'email', store, { type: 'email' }));
  frag.append(richField('About', p, 'summary', store, 'A short paragraph about your background and what you do.'));

  // A photo for the About page. Images cannot go inside the prose -- the
  // sanitiser allows no <img> in stored HTML -- so this renders beneath it.
  const portrait = el('div', { class: 'photo-strip' });
  const drawPortrait = () => {
    portrait.textContent = '';
    if (p.photo) {
      portrait.append(el('div', { class: 'strip-item' },
        el('img', { src: '/thumbs/' + encodeURI(p.photo), alt: '' }),
        el('div', { class: 'strip-tools' },
          el('button', {
            onclick: () => { store.update(() => { p.photo = ''; }); drawPortrait(); },
          }, 'Remove'))));
    }
    portrait.append(el('button', {
      class: 'strip-add', type: 'button',
      onclick: () => media.open({
        title: 'Photo for the About page',
        selected: p.photo ? [p.photo] : [],
        single: true,
        onToggle: (src, on) => { store.update(() => { p.photo = on ? src : ''; }); drawPortrait(); },
      }),
    }, p.photo ? 'Replace photo' : '+ Choose photo'));
  };
  drawPortrait();
  frag.append(el('div', { class: 'field' },
    el('span', { class: 'field-label' }, 'Photo'), portrait,
    el('p', { class: 'hint' }, 'Shown under the About text on the site, and in the PDF. '
      + 'Pick anything from the library — a shot of you at the machine works well.')));
  frag.append(repeatField('Links', p.links, store, [
    { key: 'label', placeholder: 'Label' },
    { key: 'url', placeholder: 'https://' },
  ], { addLabel: '+ Add link' }));

  // Skills: a group name plus a comma-separated list per group.
  const skills = el('div');
  const drawSkills = () => {
    skills.textContent = '';
    store.data.skills.forEach((g, i) => {
      const name = el('input', { type: 'text', placeholder: 'Machining' });
      name.value = g.group;
      name.addEventListener('input', () => {
        const v = name.value;
        store.update(() => { g.group = v; }, { label: `skillg:${i}`, silent: true });
        store.emit('preview');
      });
      const items = el('input', { type: 'text', placeholder: 'Manual lathe, surface grinding, hand scraping' });
      items.value = g.items.join(', ');
      items.addEventListener('input', () => {
        const parts = items.value.split(',').map((s) => s.trim()).filter(Boolean);
        store.update(() => { g.items = parts; }, { label: `skilli:${i}`, silent: true });
        store.emit('preview');
      });
      const del = el('button', {
        class: 'rep-del', type: 'button',
        onclick: () => { store.update(() => store.data.skills.splice(i, 1)); drawSkills(); },
      }, '×');
      skills.append(el('div', { class: 'rep-row' }, name, items, del));
    });
    skills.append(el('button', {
      class: 'btn small', type: 'button',
      onclick: () => { store.update(() => store.data.skills.push({ group: '', items: [] })); drawSkills(); },
    }, '+ Add skill group'));
  };
  drawSkills();
  frag.append(el('fieldset', {}, el('legend', {}, 'Skills'), skills));
  return frag;
}

function settingsForm() {
  const s = store.data.settings;
  const frag = document.createDocumentFragment();
  frag.append(el('h2', {}, 'Settings'));
  frag.append(textField('Site title', s, 'siteTitle', store, { hint: 'Used when no name is set.' }));
  frag.append(textField('Accent colour', s, 'accent', store, { type: 'color' }));

  const paper = el('select');
  for (const opt of ['Letter', 'A4']) {
    const o = el('option', { value: opt }, opt);
    if (s.pdf.paper === opt) o.selected = true;
    paper.append(o);
  }
  paper.addEventListener('change', () => {
    store.update(() => { s.pdf.paper = paper.value; });
    schedulePreview();
  });
  frag.append(el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'PDF paper size'), paper));
  frag.append(checkField('Include testimonials in the PDF', s.pdf, 'includeTestimonials', store));

  const cover = el('div', { class: 'photo-strip' });
  if (s.pdf.coverPhoto) {
    cover.append(el('div', { class: 'strip-item' },
      el('img', { src: '/thumbs/' + encodeURI(s.pdf.coverPhoto), alt: '' }),
      el('div', { class: 'strip-tools' },
        el('button', { onclick: () => store.update(() => { s.pdf.coverPhoto = ''; }) }, 'Remove'))));
  }
  cover.append(el('button', {
    class: 'strip-add', type: 'button',
    onclick: () => media.open({
      title: 'PDF cover photo', selected: s.pdf.coverPhoto ? [s.pdf.coverPhoto] : [], single: true,
      onToggle: (src, on) => store.update(() => { s.pdf.coverPhoto = on ? src : ''; }),
    }),
  }, s.pdf.coverPhoto ? 'Replace' : '+ Choose cover'));
  frag.append(el('div', { class: 'field' },
    el('span', { class: 'field-label' }, 'PDF cover photo'), cover,
    el('p', { class: 'hint' }, 'Defaults to the lead photo of the first published project.')));

  frag.append(el('div', { class: 'rep-row', style: 'margin-top:1.4rem' },
    el('button', { class: 'btn small', onclick: () => window.open('/docs/index.html', '_blank') }, 'Open exported site'),
    el('button', { class: 'btn small', onclick: () => window.open('/out/portfolio.pdf', '_blank') }, 'Open exported PDF')));
  return frag;
}

// --- exports ----------------------------------------------------------------

async function runExport(what) {
  // The builders read data/portfolio.json, so unsaved edits would silently be
  // left out of whatever gets exported.
  if (store.dirty) {
    if (!confirm('You have unsaved changes.\n\nSave them before building? '
      + 'Otherwise the build will use the last saved version.')) return;
    if (!await store.save()) { toast('Save failed: ' + store.error, true); return; }
  }
  const box = $('console');
  const out = $('console-out');
  const openBtn = $('console-open');
  box.hidden = false;
  openBtn.hidden = true;
  openBtn.dataset.what = what;
  $('console-title').textContent = what === 'pdf' ? 'Building PDF…'
    : what === 'preview' ? 'Building draft preview…' : 'Building site…';
  out.textContent = '';

  const endpoint = what === 'preview' ? '/api/preview/site' : `/api/export/${what}`;
  try {
    const res = await fetch(endpoint, { method: 'POST' });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      out.textContent = text;
      out.scrollTop = out.scrollHeight;
    }
    const ok = /\[exit 0\]/.test(text);
    $('console-title').textContent = ok
      ? (what === 'pdf' ? 'PDF built' : what === 'preview' ? 'Draft preview built' : 'Site built')
      : 'Build failed';
    openBtn.hidden = !ok;
    if (ok && what === 'preview') window.open('/preview/index.html', 'portfolio-preview');
    if (ok && what === 'site') window.open('/docs/index.html', 'portfolio-site');
    toast(ok ? (what === 'pdf' ? 'PDF exported'
              : what === 'preview' ? 'Draft preview opened in a new tab' : 'Site exported')
             : 'Build failed — see the log', !ok);
  } catch (err) {
    out.textContent += '\n' + err.message;
    toast('Build failed', true);
  }
}

// --- shortcuts --------------------------------------------------------------

// Keyboard shortcuts. Split out from the listener so the preview iframe can
// share the same handler -- key events inside that document never reach this
// window on their own.
function handleShortcut(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();

  if (k === 's') {
    e.preventDefault();
    // No flush needed, and none wanted: every field commits to the store on
    // each keystroke, whereas forcing a blur here would re-render the form
    // pane out from under the caret and drop whatever was being typed.
    store.save().then((ok) => toast(ok ? 'Saved' : 'Save failed: ' + store.error, !ok));
    return;
  }
  if (k === 'z' && !e.shiftKey) {
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName))) return;
    e.preventDefault();
    if (!store.undo()) toast('Nothing to undo');
    return;
  }
  if ((k === 'z' && e.shiftKey) || k === 'y') {
    e.preventDefault();
    if (!store.redo()) toast('Nothing to redo');
    return;
  }
}

function wireShortcuts() {
  window.addEventListener('keydown', handleShortcut);
  preview.onShortcut = handleShortcut;

  // Nothing is saved automatically, so leaving with pending edits would lose
  // them. The browser shows its own confirmation dialog for this.
  window.addEventListener('beforeunload', (e) => {
    if (!store.dirty) return;
    e.preventDefault();
    e.returnValue = 'You have unsaved changes.';
    return e.returnValue;
  });
}
