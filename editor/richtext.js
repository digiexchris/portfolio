// The contenteditable rich-text component used by every prose field in the
// form pane: project writeups, testimonial quotes, and the About text.

import { sanitiseHtml } from '../shared/model.js';

const COMMANDS = [
  { cmd: 'bold', label: 'B', title: 'Bold  (Ctrl+B)', style: 'font-weight:700' },
  { cmd: 'italic', label: 'I', title: 'Italic  (Ctrl+I)', style: 'font-style:italic' },
  { cmd: 'formatBlock:H2', label: 'H2', title: 'Heading' },
  { cmd: 'formatBlock:H3', label: 'H3', title: 'Subheading' },
  { cmd: 'insertUnorderedList', label: '•', title: 'Bullet list' },
  { cmd: 'insertOrderedList', label: '1.', title: 'Numbered list' },
  { cmd: 'formatBlock:BLOCKQUOTE', label: '“', title: 'Quote' },
  { cmd: 'createLink', label: '\u{1F517}', title: 'Link  (Ctrl+K)' },
  { cmd: 'removeFormat', label: '✗', title: 'Clear formatting' },
];

export function buildToolbar(onCommand) {
  const bar = document.createElement('div');
  bar.className = 'rt-toolbar';
  for (const c of COMMANDS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rt-btn';
    b.dataset.cmd = c.cmd;
    b.title = c.title;
    b.textContent = c.label;
    if (c.style) b.setAttribute('style', c.style);
    // Keep focus in the editable while the command runs.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => onCommand(c.cmd));
    bar.append(b);
  }
  return bar;
}

export function execCommand(cmd) {
  if (cmd.startsWith('formatBlock:')) {
    const tag = cmd.split(':')[1];
    // Toggle off if the caret is already in that block type.
    const cur = document.queryCommandValue('formatBlock').toUpperCase();
    document.execCommand('formatBlock', false, cur === tag ? 'P' : tag);
    return;
  }
  if (cmd === 'createLink') {
    const sel = String(document.getSelection() || '');
    if (!sel) return alert('Select some text first, then add the link.');
    const url = prompt('Link URL', 'https://');
    if (url) document.execCommand('createLink', false, url);
    return;
  }
  document.execCommand(cmd, false, null);
}

// Attach editing behaviour to an element. Returns a handle with destroy().
export function attachRichText(el, { value = '', onChange, onFocus, onBlur } = {}) {
  el.contentEditable = 'true';
  el.spellcheck = true;
  // Without this, Enter produces <div> or bare <br> runs. Those look right on
  // screen by accident but carry no paragraph structure, so the PDF's
  // orphan/widow and page-break rules -- written against <p> -- do nothing.
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* older engines */ }
  el.classList.add('rt-editable');
  if (value !== null && el.innerHTML !== value) el.innerHTML = value;

  let last = el.innerHTML;
  const emit = () => {
    const html = sanitiseHtml(el.innerHTML);
    if (html === last) return;
    last = html;
    onChange?.(html);
  };

  const onInput = () => emit();

  // Paste as plain-ish text: strip everything the sanitiser would drop anyway,
  // so pasting from a Word document or a website does not smuggle in styling.
  const onPaste = (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    if (html) {
      document.execCommand('insertHTML', false, sanitiseHtml(html));
    } else {
      document.execCommand('insertText', false, text);
    }
  };

  const onKeydown = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); execCommand('createLink'); }
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); execCommand('bold'); }
    if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); execCommand('italic'); }
    // Let Ctrl+S bubble up to the app-level save handler.
    if (e.key === 'Escape') el.blur();
  };

  const onBlurH = () => { emit(); onBlur?.(); };
  const onFocusH = () => onFocus?.(el);

  el.addEventListener('input', onInput);
  el.addEventListener('paste', onPaste);
  el.addEventListener('keydown', onKeydown);
  el.addEventListener('blur', onBlurH);
  el.addEventListener('focus', onFocusH);

  return {
    el,
    get value() { return sanitiseHtml(el.innerHTML); },
    set(html) {
      if (document.activeElement === el) return;   // never yank text out from under the caret
      el.innerHTML = html || '';
      last = el.innerHTML;
    },
    flush: emit,
    destroy() {
      emit();
      el.removeEventListener('input', onInput);
      el.removeEventListener('paste', onPaste);
      el.removeEventListener('keydown', onKeydown);
      el.removeEventListener('blur', onBlurH);
      el.removeEventListener('focus', onFocusH);
      el.contentEditable = 'false';
      el.classList.remove('rt-editable');
    },
  };
}

