// Test helper: writes small zip archives so the zip reader and the zip import
// can be checked against known input. Not used by the app.
//
// makeZip(file, entries, { zip64 })
//   entries: [{ name, data, method = 8, nameBytes?, utf8?, encrypted?, badCrc? }]
//     name       stored name (UTF-8, flag bit 11 set unless utf8 === false)
//     nameBytes  raw name bytes instead (e.g. CP437), no UTF-8 flag
//     method     0 = stored, 8 = deflate
//     declaredSize  lie about the uncompressed size (tests the reader's guard)
//   zip64: force ZIP64 records and extra fields even for tiny data.

import fs from 'node:fs';
import zlib from 'node:zlib';

export function makeZip(file, entries, { zip64 = false } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  const FF32 = 0xffffffff;

  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '');
    const method = e.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    let crc = zlib.crc32(raw);
    if (e.badCrc) crc = (crc ^ 0xdeadbeef) >>> 0;
    const nameBuf = e.nameBytes ? Buffer.from(e.nameBytes) : Buffer.from(e.name, 'utf8');
    let flags = 0;
    if (!e.nameBytes && e.utf8 !== false) flags |= 0x800;
    if (e.encrypted) flags |= 0x1;

    const localExtra = zip64 ? extra64([e.declaredSize ?? raw.length, body.length]) : Buffer.alloc(0);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(zip64 ? 45 : 20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(0, 10);                       // time + date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(zip64 ? FF32 : body.length, 18);
    const usize = e.declaredSize ?? raw.length;
    lh.writeUInt32LE(zip64 ? FF32 : usize, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(localExtra.length, 28);
    parts.push(lh, nameBuf, localExtra, body);

    const cExtra = zip64 ? extra64([usize, body.length, offset]) : Buffer.alloc(0);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(zip64 ? 45 : 20, 4);
    ch.writeUInt16LE(zip64 ? 45 : 20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(zip64 ? FF32 : body.length, 20);
    ch.writeUInt32LE(zip64 ? FF32 : usize, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(cExtra.length, 30);
    ch.writeUInt32LE(zip64 ? FF32 : offset, 42);
    central.push(ch, nameBuf, cExtra);

    offset += lh.length + nameBuf.length + localExtra.length + body.length;
  }

  const cd = Buffer.concat(central);
  const cdOffset = offset;
  const tail = [];
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(entries.length), 24);
    rec.writeBigUInt64LE(BigInt(entries.length), 32);
    rec.writeBigUInt64LE(BigInt(cd.length), 40);
    rec.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cdOffset + cd.length), 8);
    loc.writeUInt32LE(1, 16);
    tail.push(rec, loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(zip64 ? FF32 : cd.length, 12);
  eocd.writeUInt32LE(zip64 ? FF32 : cdOffset, 16);
  fs.writeFileSync(file, Buffer.concat([...parts, cd, ...tail, eocd]));
}

function extra64(values) {
  const b = Buffer.alloc(4 + values.length * 8);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(values.length * 8, 2);
  values.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + i * 8));
  return b;
}
