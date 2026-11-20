// File naming shared by every upload path (photo, video, zip import), so the
// same file uploaded any of those ways lands under the same name.

import fsSync from 'node:fs';
import path from 'node:path';

// Basename only, anything unusual replaced. Path components never survive,
// so a name can never point outside the uploads folder.
export function cleanName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
}

// First of stem, stem-2, stem-3, ... for which none of stem+ext exists, so a
// set of files that belong together (a video and its poster) is never split
// across two numbers.
export function uniqueStem(dir, stem, exts) {
  for (let n = 1; ; n++) {
    const s = n === 1 ? stem : `${stem}-${n}`;
    if (!exts.some((ext) => fsSync.existsSync(path.join(dir, s + ext)))) return s;
  }
}

// A free file name in `dir` for an already-cleaned name.
export function uniqueName(dir, clean) {
  const ext = path.extname(clean);
  return uniqueStem(dir, path.basename(clean, ext), [ext]) + ext;
}
