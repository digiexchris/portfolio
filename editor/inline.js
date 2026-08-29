// Inline editing: makes the live preview itself editable.
//
// The preview is rendered by the same shared/render.js templates as the
// exports. When ctx.editable is on, those templates emit data-edit="<path>"
// hooks on the fields that can be edited. This module walks those hooks and
// mounts the SAME rich-text component the form pane uses, writing back through
// the same store. There is no second editor and no second code path.

import { attachRichText, attachPlainText, buildToolbar, execCommand } from './richtext.js';

let mounted = [];
let toolbar = null;
let activeDoc = null;

export function disableInline() {
  for (const h of mounted) { try { h.destroy(); } catch { /* node already gone */ } }
  mounted = [];
  toolbar?.remove();
  toolbar = null;
  activeDoc = null;
}

export function enableInline(preview, store) {
  preview.onMounted = (doc) => mount(doc, preview, store);
  const doc = preview.frame.contentDocument;
  if (doc && doc.body && doc.body.querySelector('[data-edit]')) mount(doc, preview, store);
}

function mount(doc, preview, store) {
  if (!preview.inline || preview.view !== 'screen') return;
  disableInline();
  activeDoc = doc;

  // Floating toolbar inside the iframe, shown while a rich field has focus.
  toolbar = doc.createElement('div');
  toolbar.className = 'rt-toolbar inline-toolbar';
  toolbar.setAttribute('style',
    'position:fixed;top:0;left:0;right:0;z-index:99;display:none;gap:1px;'
    + 'padding:4px 6px;background:#fff;border-bottom:1px solid #ddd6cc;'
    + 'box-shadow:0 2px 8px rgba(0,0,0,.08)');
  toolbar.append(buildToolbar((cmd) => execCommand(cmd)));
  doc.body.append(toolbar);

  const style = doc.createElement('style');
  style.textContent =
    '.inline-toolbar .rt-btn{min-width:28px;height:24px;border:1px solid transparent;'
    + 'border-radius:4px;background:none;cursor:pointer;font:13px system-ui;color:#4a453e}'
    + '.inline-toolbar .rt-btn:hover{background:#f4f0ea;border-color:#ddd6cc}';
  doc.head.append(style);

  for (const node of doc.querySelectorAll('[data-edit]')) {
    const path = node.dataset.edit;
    const kind = node.dataset.editKind || 'text';
    const owner = resolveOwner(node, path, store);
    if (!owner) continue;
    const { obj, key } = owner;

    if (kind === 'rich') {
      const h = attachRichText(node, {
        value: null,                       // keep what the renderer produced
        onChange: (html) => {
          store.update(() => { obj[key] = html; }, { label: `inline:${path}`, silent: true });
        },
        onFocus: () => { toolbar.style.display = 'flex'; },
        onBlur: () => { toolbar.style.display = 'none'; store.emit('change'); },
      });
      node.dataset.empty = 'Click to write…';
      mounted.push(h);
    } else {
      const h = attachPlainText(node, {
        value: node.textContent,
        onChange: (text) => {
          store.update(() => { obj[key] = text; }, { label: `inline:${path}`, silent: true });
          store.emit('change');
        },
      });
      node.dataset.empty = 'Click to add…';
      mounted.push(h);
    }
  }

  wirePhotoDrag(doc, store);
}

// Resolve a data-edit path to the object and key it names.
//
// The owning entity comes from the DOM rather than the sidebar selection, so
// this works on any view -- a single project page, the testimonials list, or
// the full print document where dozens of entities are on screen at once.
//
//   "title"            -> project.title
//   "specs.2.value"    -> project.specs[2].value
//   "photos.0.caption" -> project.photos[0].caption
//   "quote"            -> testimonial.quote
function resolveOwner(node, path, store) {
  const projectEl = node.closest('[data-project-id]');
  const testimonialEl = node.closest('[data-testimonial-id]');

  let root = null;
  if (testimonialEl) {
    root = store.data.testimonials.find((t) => t.id === testimonialEl.dataset.testimonialId);
  } else if (projectEl) {
    root = store.data.projects.find((p) => p.id === projectEl.dataset.projectId);
  }
  if (!root) return null;

  const parts = path.split('.');
  let obj = root;
  for (let i = 0; i < parts.length - 1; i++) {
    obj = obj?.[parts[i]];
    if (obj == null) return null;
  }
  const key = parts[parts.length - 1];
  return obj && typeof obj === 'object' ? { obj, key } : null;
}

function wirePhotoDrag(doc, store) {
  for (const fig of doc.querySelectorAll('.photo[data-photo]')) {
    const owner = fig.closest('[data-project-id]');
    const project = owner && store.data.projects.find((p) => p.id === owner.dataset.projectId);
    if (!project) continue;
    fig.draggable = true;
    const index = () => Number(fig.dataset.photo.split('.')[1]);

    fig.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(index()));
      e.dataTransfer.effectAllowed = 'move';
      fig.classList.add('dragging');
    });
    fig.addEventListener('dragend', () => fig.classList.remove('dragging'));
    fig.addEventListener('dragover', (e) => { e.preventDefault(); fig.classList.add('drop-target'); });
    fig.addEventListener('dragleave', () => fig.classList.remove('drop-target'));
    fig.addEventListener('drop', (e) => {
      e.preventDefault();
      fig.classList.remove('drop-target');
      const from = Number(e.dataTransfer.getData('text/plain'));
      const to = index();
      if (Number.isNaN(from) || from === to) return;
      store.update(() => {
        const [moved] = project.photos.splice(from, 1);
        project.photos.splice(to, 0, moved);
      });
    });
  }
}
