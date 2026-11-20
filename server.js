// Local-only editing server. Serves the editor, the media library, and a
// small JSON API over the portfolio file. Binds to loopback only.

import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import sharp from 'sharp';

import { normalise, emptyPortfolio, isVideo, autoPosterOf } from './shared/model.js';
import { cleanName, uniqueName } from './server/uploads.js';
import { convertVideo, findTools, VIDEO_IN_RE } from './server/video.js';
import { importZip } from './server/importzip.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// The photo library lives inside the project so the whole thing can be cloned
// with nothing missing. Nothing here ever reads or writes outside ROOT.
const MEDIA_ROOT = path.join(ROOT, 'media');
const UPLOADS = path.join(ROOT, 'data', 'uploads');
const DATA_FILE = path.join(ROOT, 'data', 'portfolio.json');
const BACKUPS = path.join(ROOT, 'data', 'backups');
const THUMBS = path.join(ROOT, '.cache', 'thumbs');
// Uploads land here first; videos and zips are processed from here, and the
// originals are always deleted afterwards.
const INCOMING = path.join(ROOT, '.cache', 'incoming');

const PORT = Number(process.env.PORT) || 4321;
const HOST = '127.0.0.1';
const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif)$/i;
const THUMB_W = 400;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json',
  '.mp4': 'video/mp4',
};

// --- helpers ----------------------------------------------------------------

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Cache-Control': 'no-cache', ...headers });
  res.end(body);
};
const json = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': MIME['.json'] });

// Resolve a request path inside a base directory, refusing anything that
// escapes it. Every filesystem-touching route goes through this.
function safeJoin(base, rel) {
  const decoded = decodeURIComponent(rel).replace(/^\/+/, '');
  const full = path.resolve(base, decoded);
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (full !== base && !full.startsWith(withSep)) return null;
  return full;
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function serveFile(res, file, { download = false, req = null } = {}) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return send(res, 404, 'Not found');
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Last-Modified': stat.mtime.toUTCString(),
      // Revalidate every time. Without this the browser heuristically caches
      // editor CSS and JS, so a change only appears after a hard refresh --
      // and a stale stylesheet looks exactly like a styling bug.
      'Cache-Control': 'no-cache',
    };
    if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`;
    headers['Accept-Ranges'] = 'bytes';

    // Byte ranges: browsers need them to seek in a video.
    const range = req?.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      let start = m && m[1] !== '' ? Number(m[1]) : null;
      let end = m && m[2] !== '' ? Number(m[2]) : null;
      if (m && start === null && end !== null) { start = Math.max(0, stat.size - end); end = stat.size - 1; }
      if (m && end === null) end = stat.size - 1;
      if (!m || start === null || start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Cache-Control': 'no-cache' });
        return res.end();
      }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, { ...headers, 'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}` });
      return fsSync.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, headers);
    fsSync.createReadStream(file).pipe(res);
  } catch {
    send(res, 404, 'Not found');
  }
}

// --- portfolio file ---------------------------------------------------------

async function loadPortfolio() {
  try {
    return normalise(JSON.parse(await fs.readFile(DATA_FILE, 'utf8')));
  } catch (err) {
    if (err.code === 'ENOENT') return normalise(emptyPortfolio());
    throw err;
  }
}

// Save = snapshot the previous version, then write atomically via a temp file
// and rename, so an interrupted write can never truncate the real file.
async function savePortfolio(raw) {
  const data = normalise(raw);
  const text = JSON.stringify(data, null, 2);

  await fs.mkdir(BACKUPS, { recursive: true });
  try {
    const prev = await fs.readFile(DATA_FILE, 'utf8');
    if (prev !== text) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      await fs.writeFile(path.join(BACKUPS, `portfolio-${stamp}.json`), prev);
      await pruneBackups();
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const tmp = DATA_FILE + '.tmp';
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, DATA_FILE);
  return data;
}

async function pruneBackups(keep = 60) {
  const files = (await fs.readdir(BACKUPS)).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    await fs.rm(path.join(BACKUPS, f), { force: true });
  }
}

// --- media ------------------------------------------------------------------

// Both source roots look the same to the client: originals are bare names,
// uploads are prefixed "uploads/".
function resolveMedia(rel) {
  if (rel.startsWith('uploads/')) return safeJoin(UPLOADS, rel.slice('uploads/'.length));
  return safeJoin(MEDIA_ROOT, rel);
}

async function listMedia() {
  const out = [];
  const walk = async (dir, prefix) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) continue;                     // the library is flat
      // A video's poster frame travels with the video, not as a photo.
      if (/\.poster\.jpg$/i.test(e.name)) continue;
      const video = isVideo(e.name);
      if (!video && !IMAGE_RE.test(e.name)) continue;
      const stat = await fs.stat(path.join(dir, e.name));
      const src = prefix + e.name;
      out.push({ src, size: stat.size, mtime: stat.mtimeMs, kind: video ? 'video' : 'image',
        ...(video ? { poster: autoPosterOf(src) } : {}) });
    }
  };
  await walk(MEDIA_ROOT, '');
  await walk(UPLOADS, 'uploads/');
  out.sort((a, b) => a.src.localeCompare(b.src, undefined, { numeric: true }));
  return out;
}

// On-demand thumbnails, cached to disk. Without this the media picker would
// pull 120 MB of full-resolution photos and be unusable.
async function serveThumb(res, rel) {
  // A video's thumbnail is made from its poster frame.
  const decoded = decodeURIComponent(rel);
  const source = resolveMedia(isVideo(decoded) ? autoPosterOf(decoded) : decoded);
  if (!source) return send(res, 400, 'Bad path');
  let stat;
  try { stat = await fs.stat(source); } catch { return send(res, 404, 'Not found'); }

  const key = rel.replace(/[^a-zA-Z0-9._-]/g, '_') + '-' + Math.round(stat.mtimeMs) + '.jpg';
  const cached = path.join(THUMBS, key);
  if (fsSync.existsSync(cached)) return serveFile(res, cached);

  try {
    await fs.mkdir(THUMBS, { recursive: true });
    const buf = await sharp(source)
      .rotate()
      .resize({ width: THUMB_W, withoutEnlargement: true })
      .jpeg({ quality: 72, progressive: true })
      .toBuffer();
    await fs.writeFile(cached, buf);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length });
    res.end(buf);
  } catch (err) {
    send(res, 500, 'Thumbnail failed: ' + err.message);
  }
}

// --- streaming uploads ------------------------------------------------------

// Write a request body straight to disk. Videos and zips can be gigabytes, so
// they never pass through memory. A dropped connection removes the file.
function streamToFile(req, dest, limit = 2 * 1024 ** 3) {
  return new Promise((resolve, reject) => {
    const out = fsSync.createWriteStream(dest);
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      out.destroy();
      fs.rm(dest, { force: true }).finally(() => reject(err));
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); fail(new Error('Upload too large')); }
    });
    req.on('aborted', () => fail(new Error('Upload interrupted')));
    req.on('close', () => { if (!req.complete) fail(new Error('Upload interrupted')); });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => { if (!done) { done = true; resolve(size); } });
    req.pipe(out);
  });
}

// Long-running uploads answer with one JSON object per line, so the editor
// can show progress as it happens.
function ndjson(res) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  return (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };
}

async function handleVideoUpload(req, res, name) {
  const send = ndjson(res);
  const clean = cleanName(name);
  if (!clean || !VIDEO_IN_RE.test(clean)) {
    req.resume();
    send({ error: 'Unsupported video type' });
    return res.end();
  }
  await fs.mkdir(INCOMING, { recursive: true });
  const tmp = path.join(INCOMING, crypto.randomBytes(6).toString('hex') + path.extname(clean));
  try {
    await streamToFile(req, tmp);
    const r = await convertVideo(tmp, { uploadsDir: UPLOADS, name: clean, onProgress: (f) => send({ progress: f }) });
    send({ src: r.src, poster: r.poster });
  } catch (err) {
    await fs.rm(tmp, { force: true });
    send({ error: err.message });
  }
  res.end();
}

async function handleZipUpload(req, res) {
  const send = ndjson(res);
  await fs.mkdir(INCOMING, { recursive: true });
  const tmp = path.join(INCOMING, crypto.randomBytes(6).toString('hex') + '.zip');
  try {
    // A zip's index is at its end, so the whole upload has to land first.
    await streamToFile(req, tmp, 16 * 1024 ** 3);
    send(await importZip(tmp, { uploadsDir: UPLOADS, incomingDir: INCOMING, onEvent: send }));
  } catch (err) {
    send({ error: err.message });
  } finally {
    await fs.rm(tmp, { force: true });
  }
  res.end();
}

// --- exporters --------------------------------------------------------------

// Run a builder as a child process and stream its output back, so the editor
// can show real progress instead of hanging on a long request.
function runBuilder(res, script, args = []) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  const child = spawn(process.execPath, [path.join(ROOT, 'export', script), ...args], { cwd: ROOT });
  child.stdout.on('data', (d) => res.write(d));
  child.stderr.on('data', (d) => res.write(d));
  child.on('close', (code) => {
    res.write(`\n[exit ${code}]\n`);
    res.end();
  });
  child.on('error', (err) => { res.write('\n' + err.message + '\n[exit 1]\n'); res.end(); });
}

// --- routing ----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  try {
    if (p === '/') return send(res, 302, '', { Location: '/editor/' });

    // --- API ---
    if (p === '/api/portfolio') {
      if (req.method === 'GET') return json(res, 200, await loadPortfolio());
      if (req.method === 'PUT') {
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        return json(res, 200, await savePortfolio(body));
      }
      return json(res, 405, { error: 'Method not allowed' });
    }

    if (p === '/api/media' && req.method === 'GET') {
      // `video`: can this server convert video uploads (is ffmpeg here)?
      return json(res, 200, { media: await listMedia(), video: !!(await findTools()) });
    }

    if (p === '/api/media/upload' && req.method === 'POST') {
      const clean = cleanName(url.searchParams.get('name') || '');
      if (!clean || !IMAGE_RE.test(clean)) return json(res, 400, { error: 'Unsupported file type' });
      await fs.mkdir(UPLOADS, { recursive: true });
      const target = path.join(UPLOADS, uniqueName(UPLOADS, clean));
      await fs.writeFile(target, await readBody(req));
      return json(res, 200, { src: 'uploads/' + path.basename(target) });
    }

    if (p === '/api/media/upload-zip' && req.method === 'POST') return handleZipUpload(req, res);
    if (p === '/api/media/upload-video' && req.method === 'POST') {
      return handleVideoUpload(req, res, url.searchParams.get('name') || '');
    }

    if (p === '/api/export/site' && req.method === 'POST') return runBuilder(res, 'build-site.js');
    if (p === '/api/preview/site' && req.method === 'POST') return runBuilder(res, 'build-site.js', ['--drafts']);
    if (p === '/api/export/pdf' && req.method === 'POST') return runBuilder(res, 'build-pdf.js');

    if (p === '/api/open' && req.method === 'POST') {
      // Best-effort "reveal in file manager" for the export buttons.
      const what = url.searchParams.get('what');
      const which = what === 'pdf' ? path.join(ROOT, 'out')
        : what === 'preview' ? path.join(ROOT, 'preview')
        : path.join(ROOT, 'docs');
      spawn('xdg-open', [which], { detached: true, stdio: 'ignore' }).unref();
      return json(res, 200, { ok: true, path: which });
    }

    // --- media ---
    if (p.startsWith('/thumbs/')) return serveThumb(res, p.slice('/thumbs/'.length));
    if (p.startsWith('/media/')) {
      const file = resolveMedia(p.slice('/media/'.length));
      if (!file) return send(res, 400, 'Bad path');
      return serveFile(res, file, { req });
    }

    // --- generated output, browsable from the editor ---
    if (p.startsWith('/docs/')) {
      const file = safeJoin(path.join(ROOT, 'docs'), p.slice('/docs/'.length));
      return file ? serveFile(res, file) : send(res, 400, 'Bad path');
    }
    if (p.startsWith('/preview/')) {
      const file = safeJoin(path.join(ROOT, 'preview'), p.slice('/preview/'.length));
      return file ? serveFile(res, file) : send(res, 400, 'Bad path');
    }
    if (p.startsWith('/out/')) {
      const file = safeJoin(path.join(ROOT, 'out'), p.slice('/out/'.length));
      return file ? serveFile(res, file) : send(res, 400, 'Bad path');
    }

    // --- static app files ---
    for (const [prefix, dir] of [
      ['/editor/', path.join(ROOT, 'editor')],
      ['/shared/', path.join(ROOT, 'shared')],
      ['/vendor/', path.join(ROOT, 'vendor')],
      ['/export/', path.join(ROOT, 'export')],
    ]) {
      if (p.startsWith(prefix)) {
        let rel = p.slice(prefix.length) || 'index.html';
        if (rel.endsWith('/')) rel += 'index.html';
        const file = safeJoin(dir, rel);
        return file ? serveFile(res, file) : send(res, 400, 'Bad path');
      }
    }
    if (p === '/editor') return send(res, 302, '', { Location: '/editor/' });

    send(res, 404, 'Not found');
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Portfolio editor  ->  http://${HOST}:${PORT}/editor/`);
  console.log(`  Media library     ->  ${MEDIA_ROOT}`);
  console.log(`  Data file         ->  ${DATA_FILE}\n`);
});
