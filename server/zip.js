// Minimal zip reader for the media drawer's zip import. No dependencies:
// Node's zlib does the decompression; this only reads the archive's index.
//
// Supports stored (0) and deflate (8) entries, ZIP64 archives (over 4 GB or
// 65,535 entries -- a few raw phone videos get there), UTF-8 and CP437 names,
// and verifies every entry's CRC-32 and size. Encrypted entries and other
// methods are listed but refuse to extract.
//
// It never decides where anything lands: extractTo() writes to the path it is
// given, and callers choose that path from a sanitised basename.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export class ZipError extends Error {}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const FF16 = 0xffff;
const FF32 = 0xffffffff;

const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeName(buf, utf8) {
  if (utf8) return buf.toString('utf8');
  let s = '';
  for (const b of buf) s += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return s;
}

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

export async function openZip(file) {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    // The End Of Central Directory record is the last 22 bytes plus an
    // optional comment of up to 65,535 bytes.
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { at = i; break; }
    }
    if (at < 0) throw new ZipError('Not a zip file (no end-of-archive record)');
    const eocdPos = size - tailLen + at;

    let count = tail.readUInt16LE(at + 10);
    let cdSize = tail.readUInt32LE(at + 12);
    let cdOffset = tail.readUInt32LE(at + 16);

    // ZIP64: a locator sits immediately before the classic record.
    if (eocdPos >= 20) {
      const loc = await readAt(fh, eocdPos - 20, 20);
      if (loc.readUInt32LE(0) === SIG_LOC64) {
        const recPos = Number(loc.readBigUInt64LE(8));
        const rec = await readAt(fh, recPos, 56);
        if (rec.length < 56 || rec.readUInt32LE(0) !== SIG_EOCD64) throw new ZipError('Broken ZIP64 record');
        count = Number(rec.readBigUInt64LE(32));
        cdSize = Number(rec.readBigUInt64LE(40));
        cdOffset = Number(rec.readBigUInt64LE(48));
      }
    }
    if (cdOffset + cdSize > size) throw new ZipError('Zip index points past the end of the file');

    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('Broken zip index');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let size32 = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = decodeName(cd.subarray(p + 46, p + 46 + nameLen), !!(flags & 0x800));

      // ZIP64 extra field: only the values that overflowed are present, in
      // this fixed order.
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      for (let e = 0; e + 4 <= extra.length;) {
        const id = extra.readUInt16LE(e);
        const len = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          const next = () => { const v = Number(extra.readBigUInt64LE(q)); q += 8; return v; };
          if (size32 === FF32) size32 = next();
          if (compressedSize === FF32) compressedSize = next();
          if (offset === FF32) offset = next();
        }
        e += 4 + len;
      }

      entries.push(makeEntry(file, {
        name, method, crc, flags, size: size32, compressedSize, offset,
      }));
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries, close: async () => {} };
  } finally {
    await fh.close();
  }
}

function makeEntry(file, { name, method, crc, flags, size, compressedSize, offset }) {
  return {
    name,
    size,
    compressedSize,
    method,
    encrypted: !!(flags & 0x1),
    isDirectory: name.endsWith('/'),

    // Stream this entry to `dest`. Verifies CRC and size; never writes more
    // than min(maxBytes, declared size). Removes `dest` on any failure.
    async extractTo(dest, { maxBytes = Infinity } = {}) {
      if (this.encrypted) throw new ZipError(`${name}: password-protected entries are not supported`);
      if (method !== 0 && method !== 8) throw new ZipError(`${name}: unsupported compression method ${method}`);
      const limit = Math.min(maxBytes, size);
      if (size > maxBytes) throw new ZipError(`${name}: larger than the size limit`);

      // The local header's own name/extra lengths can differ from the
      // central directory's, so read them here.
      const fh = await fs.open(file, 'r');
      let start;
      try {
        const lh = await readAt(fh, offset, 30);
        if (lh.length < 30 || lh.readUInt32LE(0) !== SIG_LOCAL) throw new ZipError(`${name}: broken local header`);
        start = offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      } finally {
        await fh.close();
      }

      let written = 0;
      let sum = 0;
      const guard = new Transform({
        transform(chunk, _enc, cb) {
          written += chunk.length;
          if (written > limit) return cb(new ZipError(`${name}: expands past its declared size`));
          sum = zlib.crc32(chunk, sum);
          cb(null, chunk);
        },
      });
      const stages = [
        compressedSize
          ? fsSync.createReadStream(file, { start, end: start + compressedSize - 1 })
          : (async function* () {})(),
      ];
      if (method === 8) stages.push(zlib.createInflateRaw());
      stages.push(guard, fsSync.createWriteStream(dest));
      try {
        await pipeline(...stages);
        if (written !== size) throw new ZipError(`${name}: size mismatch (${written} of ${size} bytes)`);
        if ((sum >>> 0) !== crc) throw new ZipError(`${name}: CRC check failed — the zip is damaged`);
        return written;
      } catch (err) {
        await fs.rm(dest, { force: true });
        if (err instanceof ZipError) throw err;
        throw new ZipError(`${name}: ${err.message}`);
      }
    },
  };
}
