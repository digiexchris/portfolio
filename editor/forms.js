// Form-pane builders. Each returns a DocumentFragment for one section.
// Kept apart from editor.js so the wiring and the fields stay legible.

import { attachRichText, buildToolbar, execCommand } from './richtext.js';

export const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
};

// A labelled text input bound to obj[key]. `label` groups undo steps.
export function textField(labelText, obj, key, store, opts = {}) {
  const id = 'f-' + Math.random().toString(36).slice(2, 8);
  const input = el(opts.multiline ? 'textarea' : 'input', {
    id, type: opts.type || 'text', placeholder: opts.placeholder || '',
    rows: opts.rows || 3,
  });
  input.value = obj[key] ?? '';
  input.addEventListener('input', () => {
    const v = input.value;
    store.update(() => { obj[key] = v; }, { label: `${key}:${obj.id || ''}`, silent: true });
    opts.onInput?.(v);
    store.emit('preview');
  });
  input.addEventListener('blur', () => store.emit('change'));
  return el('div', { class: 'field' },
    el('label', { for: id }, opts.label ?? labelText),
    input,
    opts.hint ? el('p', { class: 'hint' }, opts.hint) : null);
}

export function checkField(labelText, obj, key, store, onChange) {
  const id = 'c-' + Math.random().toString(36).slice(2, 8);
  const input = el('input', { id, type: 'checkbox' });
  input.checked = !!obj[key];
  input.addEventListener('change', () => {
    store.update(() => { obj[key] = input.checked; });
    onChange?.(input.checked);
  });
  return el('div', { class: 'check-row' }, input, el('label', { for: id }, labelText));
}

// Rich-text field. Uses the shared component, so this is the identical editor
// that inline mode mounts onto the preview.
export function richField(labelText, obj, key, store, placeholder = '') {
  const area = el('div', { class: 'rt-editable', 'data-placeholder': placeholder });
  const bar = buildToolbar((cmd) => { area.focus(); execCommand(cmd); handle.flush(); });
  const wrap = el('div', { class: 'rt-wrap' }, bar, area);
  const handle = attachRichText(area, {
    value: obj[key] || '',
    onChange: (html) => {
      store.update(() => { obj[key] = html; }, { label: `${key}:${obj.id || ''}`, silent: true });
      store.emit('preview');
    },
    onBlur: () => store.emit('change'),
  });
  const field = el('div', { class: 'field' }, el('span', { class: 'field-label' }, labelText), wrap);
  field._rt = handle;
  return field;
}

// Comma-separated list bound to a string array (tags).
export function listField(labelText, obj, key, store, hint = '') {
  const input = el('input', { type: 'text', placeholder: 'turning, welding, fabrication' });
  input.value = (obj[key] || []).join(', ');
  input.addEventListener('input', () => {
    const parts = input.value.split(',').map((s) => s.trim()).filter(Boolean);
    store.update(() => { obj[key] = parts; }, { label: `${key}:${obj.id || ''}`, silent: true });
    store.emit('preview');
  });
  input.addEventListener('blur', () => store.emit('change'));
  return el('div', { class: 'field' },
    el('span', { class: 'field-label' }, labelText), input,
    hint ? el('p', { class: 'hint' }, hint) : null);
}

// Repeating label/value rows: specs, profile links, skill groups.
export function repeatField(labelText, arr, store, cols, opts = {}) {
  const body = el('div');
  const draw = () => {
    body.textContent = '';
    arr.forEach((row, i) => {
      const inputs = cols.map((c) => {
        const inp = el('input', { type: 'text', placeholder: c.placeholder || c.key });
        inp.value = row[c.key] ?? '';
        inp.addEventListener('input', () => {
          const v = inp.value;
          store.update(() => { row[c.key] = v; }, { label: `rep:${labelText}:${i}:${c.key}`, silent: true });
          store.emit('preview');
        });
        inp.addEventListener('blur', () => store.emit('change'));
        return inp;
      });
      const del = el('button', {
        class: 'rep-del', type: 'button', title: 'Remove row',
        onclick: () => { store.update(() => arr.splice(i, 1)); draw(); },
      }, '×');
      body.append(el('div', { class: 'rep-row' }, ...inputs, del));
    });
    body.append(el('button', {
      class: 'btn small', type: 'button',
      onclick: () => {
        store.update(() => arr.push(Object.fromEntries(cols.map((c) => [c.key, '']))));
        draw();
      },
    }, opts.addLabel || '+ Add row'));
  };
  draw();
  return el('fieldset', {}, el('legend', {}, labelText), body);
}
