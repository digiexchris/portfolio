// Unit checks for the zip reader (server/zip.js). No browser or server needed.
// Archives are generated here with zipwriter.mjs, under .cache/test-zips/.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeZip } from './zipwriter.mjs';

const DIR = path.join('.cache', 'test-zips');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

let fail = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

let zip;
try { zip = await import('./server/zip.js'); } catch (e) {
  check('server/zip.js loads', false, e.message);
  process.exit(1);
}
const { openZip, ZipError } = zip;

try {
  const photo = crypto.randomBytes(50000);            // incompressible
  const text = Buffer.from('flat to 0.0002 in\n'.repeat(2000));   // compressible

  // --- stored + deflate -----------------------------------------------------
  const f1 = path.join(DIR, 'basic.zip');
  makeZip(f1, [
    { name: 'a/photo.jpg', data: photo, method: 0 },
    { name: 'notes.txt', data: text, method: 8 },
  ]);
  const z1 = await openZip(f1);
  check('lists every entry', z1.entries.map((e) => e.name).join(',') === 'a/photo.jpg,notes.txt',
    z1.entries.map((e) => e.name).join(','));
  const out1 = path.join(DIR, 'photo.out');
  const n1 = await z1.entries[0].extractTo(out1, { maxBytes: 1e9 });
  check('a stored entry extracts byte-identical', fs.readFileSync(out1).equals(photo) && n1 === photo.length);
  const out2 = path.join(DIR, 'notes.out');
  await z1.entries[1].extractTo(out2, { maxBytes: 1e9 });
  check('a deflated entry extracts byte-identical', fs.readFileSync(out2).equals(text));
  check('sizes are reported', z1.entries[1].size === text.length && z1.entries[1].compressedSize < text.length);
  await z1.close();

  // --- ZIP64 ---------------------------------------------------------------
  const f2 = path.join(DIR, 'zip64.zip');
  makeZip(f2, [{ name: 'one.jpg', data: photo, method: 8 }, { name: 'two.txt', data: text }], { zip64: true });
  const z2 = await openZip(f2);
  check('a ZIP64 archive lists', z2.entries.length === 2 && z2.entries[1].size === text.length,
    JSON.stringify(z2.entries.map((e) => [e.name, e.size])));
  const out3 = path.join(DIR, 'z64.out');
  await z2.entries[1].extractTo(out3, { maxBytes: 1e9 });
  check('a ZIP64 entry extracts', fs.readFileSync(out3).equals(text));
  await z2.close();

  // --- names ----------------------------------------------------------------
  const f3 = path.join(DIR, 'names.zip');
  makeZip(f3, [
    { nameBytes: [0x63, 0x61, 0x66, 0x82, 0x2e, 0x6a, 0x70, 0x67], data: 'x' },  // "caf\x82.jpg" in CP437
    { name: 'ü.jpg', data: 'y' },
  ]);
  const z3 = await openZip(f3);
  check('a CP437 name decodes', z3.entries[0].name === 'café.jpg', z3.entries[0].name);
  check('a UTF-8 name decodes', z3.entries[1].name === 'ü.jpg', z3.entries[1].name);
  await z3.close();

  // --- failures -------------------------------------------------------------
  const f4 = path.join(DIR, 'bad.zip');
  makeZip(f4, [
    { name: 'badcrc.jpg', data: photo, badCrc: true },
    { name: 'secret.jpg', data: photo, encrypted: true },
    { name: 'big.txt', data: text },
    { name: 'liar.txt', data: text, declaredSize: 1000 },
  ]);
  const z4 = await openZip(f4);
  const o4 = path.join(DIR, 'crc.out');
  const e4 = await rejects(() => z4.entries[0].extractTo(o4, { maxBytes: 1e9 }));
  check('a bad CRC is rejected', e4 instanceof ZipError, String(e4));
  check('  and leaves no partial file', !fs.existsSync(o4));
  check('an encrypted entry is flagged', z4.entries[1].encrypted === true);
  const o5 = path.join(DIR, 'enc.out');
  const e5 = await rejects(() => z4.entries[1].extractTo(o5, { maxBytes: 1e9 }));
  check('  and refuses to extract', e5 instanceof ZipError && !fs.existsSync(o5), String(e5));
  const o6 = path.join(DIR, 'max.out');
  const e6 = await rejects(() => z4.entries[2].extractTo(o6, { maxBytes: 100 }));
  check('maxBytes stops an oversized entry', e6 instanceof ZipError && !fs.existsSync(o6), String(e6));
  const o8 = path.join(DIR, 'liar.out');
  const e8 = await rejects(() => z4.entries[3].extractTo(o8, { maxBytes: 1e9 }));
  check('an entry larger than declared is stopped', e8 instanceof ZipError && /declared/.test(e8.message) && !fs.existsSync(o8), String(e8));
  await z4.close();

  const f5 = path.join(DIR, 'not-a-zip.zip');
  fs.writeFileSync(f5, 'this is not a zip file at all');
  const e7 = await rejects(() => openZip(f5));
  check('a non-zip is rejected', e7 instanceof ZipError, String(e7));
} finally {
  fs.rmSync(DIR, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILED` : '\nAll checks passed.');
process.exit(fail ? 1 : 0);
