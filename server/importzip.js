// Zip import for the media drawer: every photo and video inside is imported
// as if it had been uploaded on its own. Folders are flattened, junk from
// Mac/Windows archivers is ignored, and one bad entry never stops the rest.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { IMAGE_SRC_RE } from '../shared/model.js';
import { openZip } from './zip.js';
import { cleanName, uniqueName } from './uploads.js';
import { convertVideo, VIDEO_IN_RE } from './video.js';

const JUNK = (base, full) => full.startsWith('__MACOSX/') || full.includes('/__MACOSX/')
  || base.startsWith('.') || /^(thumbs\.db|desktop\.ini)$/i.test(base);

export async function importZip(zipPath, { uploadsDir, incomingDir, maxBytes, onEvent = () => {} }) {
  const limit = maxBytes ?? (Number(process.env.ZIP_MAX_BYTES) || 8 * 1024 ** 3);
  const result = { imported: [], skipped: [], failed: [] };
  const temps = [];
  let zip;
  try {
    zip = await openZip(zipPath);
    const coll = new Intl.Collator(undefined, { numeric: true });
    const wanted = zip.entries
      .filter((e) => !e.isDirectory)
      .map((e) => {
        const full = e.name.replace(/\\/g, '/');
        return { e, base: full.split('/').pop(), full };
      })
      .filter(({ base, full }) => base && !JUNK(base, full))
      .map((x) => ({ ...x, clean: cleanName(x.base) }))
      .sort((a, b) => coll.compare(a.clean, b.clean));

    // Unsupported files are listed, not counted in the progress.
    const media = [];
    for (const x of wanted) {
      if (x.clean && (IMAGE_SRC_RE.test(x.clean) || VIDEO_IN_RE.test(x.clean))) media.push(x);
      else result.skipped.push(x.base);
    }

    let used = 0;
    for (let i = 0; i < media.length; i++) {
      const { e, base, clean } = media[i];
      const isImage = IMAGE_SRC_RE.test(clean);
      onEvent({ entry: base, index: i + 1, total: media.length });
      if (used + e.size > limit) {
        result.failed.push({ name: base, error: 'not imported — zip expands past the size limit' });
        continue;
      }
      try {
        if (isImage) {
          await fs.mkdir(uploadsDir, { recursive: true });
          const name = uniqueName(uploadsDir, clean);
          used += await e.extractTo(path.join(uploadsDir, name), { maxBytes: limit - used });
          result.imported.push('uploads/' + name);
        } else {
          await fs.mkdir(incomingDir, { recursive: true });
          const tmp = path.join(incomingDir, crypto.randomBytes(6).toString('hex') + path.extname(clean));
          temps.push(tmp);
          used += await e.extractTo(tmp, { maxBytes: limit - used });
          const r = await convertVideo(tmp, { uploadsDir, name: clean, onProgress: (f) => onEvent({ progress: f }) });
          result.imported.push(r.src);
        }
      } catch (err) {
        result.failed.push({ name: base, error: err.message });
      }
    }
    return result;
  } finally {
    await zip?.close();
    for (const f of [zipPath, ...temps]) await fs.rm(f, { force: true });
  }
}
