// Image derivatives for the exports.
//
// The originals are up to 4160px and 120 MB in total. Shipping those to a
// static site or embedding them in a PDF would be unusable, so every photo is
// resized once per target width and cached by (source mtime + size + quality).
// Re-exports then cost nothing for photos that have not changed.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

export const SITE_WIDTHS = [480, 1200, 2000];
export const PRINT_WIDTH = 1800;          // ~150dpi across a Letter text column
export const COVER_WIDTH = 2200;

export class ImagePipeline {
  constructor({ mediaRoot, uploadsRoot, cacheDir, quality = 82 }) {
    this.mediaRoot = mediaRoot;
    this.uploadsRoot = uploadsRoot;
    this.cacheDir = cacheDir;
    this.quality = quality;
    this.stats = { built: 0, cached: 0, failed: 0, bytes: 0 };
    this._meta = new Map();
  }

  // Source paths are stored either bare ("beaver_head.jpg") or prefixed
  // ("uploads/note.png"); both resolve here.
  resolve(src) {
    return src.startsWith('uploads/')
      ? path.join(this.uploadsRoot, src.slice('uploads/'.length))
      : path.join(this.mediaRoot, src);
  }

  async dimensions(src) {
    if (this._meta.has(src)) return this._meta.get(src);
    try {
      const m = await sharp(this.resolve(src)).metadata();
      // EXIF orientation 5-8 means the stored pixels are rotated.
      const swap = m.orientation >= 5;
      const out = { width: swap ? m.height : m.width, height: swap ? m.width : m.height };
      this._meta.set(src, out);
      return out;
    } catch {
      return null;
    }
  }

  cacheKey(src, width, format) {
    const file = this.resolve(src);
    let sig = src + '|' + width + '|' + format + '|' + this.quality;
    try {
      const st = fsSync.statSync(file);
      sig += '|' + st.size + '|' + Math.round(st.mtimeMs);
    } catch { /* missing file is its own signature */ }
    return crypto.createHash('sha1').update(sig).digest('hex').slice(0, 16);
  }

  // Produce one derivative and return its absolute path, or null if the source
  // is unreadable. Never throws: a missing photo should not abort a build.
  async derivative(src, width, format = 'jpeg') {
    const key = this.cacheKey(src, width, format);
    const ext = format === 'webp' ? '.webp' : '.jpg';
    const out = path.join(this.cacheDir, key + ext);

    if (fsSync.existsSync(out)) {
      this.stats.cached++;
      return out;
    }
    const file = this.resolve(src);
    if (!fsSync.existsSync(file)) {
      this.stats.failed++;
      console.warn(`  ! missing photo: ${src}`);
      return null;
    }
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      const pipe = sharp(file)
        .rotate()                                     // honour EXIF orientation
        .resize({ width, withoutEnlargement: true });
      const buf = format === 'webp'
        ? await pipe.webp({ quality: this.quality }).toBuffer()
        : await pipe.jpeg({ quality: this.quality, progressive: true, mozjpeg: true }).toBuffer();
      await fs.writeFile(out, buf);
      this.stats.built++;
      this.stats.bytes += buf.length;
      return out;
    } catch (err) {
      this.stats.failed++;
      console.warn(`  ! could not process ${src}: ${err.message}`);
      return null;
    }
  }

  // Copy a derivative into the export tree under a stable, readable name.
  async emit(src, width, destDir, destName, format = 'jpeg') {
    const built = await this.derivative(src, width, format);
    if (!built) return null;
    await fs.mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, destName);
    await fs.copyFile(built, dest);
    return dest;
  }

  report(label = 'Images') {
    const mb = (this.stats.bytes / 1048576).toFixed(1);
    console.log(`${label}: ${this.stats.built} built (${mb} MB), ${this.stats.cached} from cache`
      + (this.stats.failed ? `, ${this.stats.failed} failed` : ''));
  }
}

// A filesystem-safe stem for a photo, used for the exported filenames.
export const stemOf = (src) =>
  (src ? path.basename(src, path.extname(src)) : 'missing').replace(/[^a-zA-Z0-9._-]/g, '-');

const shortHash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 6);

// Map every source path to a unique export filename stem.
//
// Export names drop the extension so `dist/img/` stays readable, which means
// `note.png` and `note.jpg` would both want `note-1200.jpg` and one would
// silently overwrite the other. The same goes for an upload named like an
// original (`uploads/note.jpg` vs `note.jpg`). So names are assigned from the
// complete source set up front: unique basenames keep their clean name, and
// only genuine clashes get a suffix.
//
// Sources are sorted first, so the mapping depends solely on which files
// exist -- never on project order -- and export filenames stay stable across
// builds and across re-clones.
export function buildStemMap(sources) {
  const byBase = new Map();
  for (const src of [...sources].sort()) {
    const base = stemOf(src);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(src);
  }

  const out = new Map();
  for (const [base, list] of byBase) {
    if (list.length === 1) { out.set(list[0], base); continue; }

    // Same basename, different files. Disambiguate by extension first, since
    // that reads better than a hash, and fall back to a hash of the full path
    // when even the extension matches (an upload shadowing an original).
    const extCount = new Map();
    for (const src of list) {
      const ext = (path.extname(src).slice(1) || 'img').toLowerCase();
      extCount.set(ext, (extCount.get(ext) || 0) + 1);
    }
    for (const src of list) {
      const ext = (path.extname(src).slice(1) || 'img').toLowerCase();
      out.set(src, extCount.get(ext) > 1
        ? `${base}-${ext}-${shortHash(src)}`
        : `${base}-${ext}`);
    }
  }
  return out;
}
