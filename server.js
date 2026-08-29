// Local-only editing server. Serves the editor, the media library, and a
// small JSON API over the portfolio file. Binds to loopback only.

import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

import { normalise, emptyPortfolio } from './shared/model.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// The photo library lives inside the project so the whole thing can be cloned
// with nothing missing. Nothing here ever reads or writes outside ROOT.
const MEDIA_ROOT = path.join(ROOT, 'media');
const UPLOADS = path.join(ROOT, 'data', 'uploads');
const DATA_FILE = path.join(ROOT, 'data', 'portfolio.json');
const BACKUPS = path.join(ROOT, 'data', 'backups');
const THUMBS = path.join(ROOT, '.cache', 'thumbs');

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

async function serveFile(res, file, { download = false } = {}) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return send(res, 404, 'Not found');
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Last-Modified': stat.mtime.toUTCString(),
    };
    if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`;
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
      if (!IMAGE_RE.test(e.name)) continue;
      const stat = await fs.stat(path.join(dir, e.name));
      out.push({ src: prefix + e.name, size: stat.size, mtime: stat.mtimeMs });
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
  const source = resolveMedia(rel);
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
      return json(res, 200, { media: await listMedia() });
    }

    if (p === '/api/media/upload' && req.method === 'POST') {
      const name = url.searchParams.get('name') || '';
      const clean = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!clean || !IMAGE_RE.test(clean)) return json(res, 400, { error: 'Unsupported file type' });
      await fs.mkdir(UPLOADS, { recursive: true });
      let target = path.join(UPLOADS, clean);
      let n = 2;
      while (fsSync.existsSync(target)) {
        const ext = path.extname(clean);
        target = path.join(UPLOADS, `${path.basename(clean, ext)}-${n++}${ext}`);
      }
      await fs.writeFile(target, await readBody(req));
      return json(res, 200, { src: 'uploads/' + path.basename(target) });
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
      return serveFile(res, file);
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
