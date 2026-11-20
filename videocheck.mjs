// Video + zip import checks: conversion, server endpoints, the built site's
// lightbox, the editor, and the start script.
//
// Needs the editor server running (npm start) for every section after
// "conversion". Sections that need ffmpeg SKIP when it is missing.
// Restores data/portfolio.json and removes every file it uploads.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import httpMod from 'node:http';
import { docsSnapshot, docsChanges, TEST_PREVIEW, previewUrl, BUILD_ROOT } from './testbuild.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.EDITOR_URL || 'http://127.0.0.1:4321';
const DATA = path.join(ROOT, 'data', 'portfolio.json');
const UPLOADS = path.join(ROOT, 'data', 'uploads');
const INCOMING = path.join(ROOT, '.cache', 'incoming');
const WORK = path.join(ROOT, '.cache', 'videocheck');
const ONLY = process.argv[2] || '';          // run one section: node videocheck.mjs server

const backup = fs.readFileSync(DATA, 'utf8');
const docsBefore = docsSnapshot();
const uploadsBefore = new Set(fs.existsSync(UPLOADS) ? fs.readdirSync(UPLOADS) : []);
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const skip = (name, why) => console.log(`SKIP  ${name} — ${why}`);
const section = (name) => !ONLY || ONLY === name;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bin = (name, env) => process.env[env] || name;
const hasTools = spawnSync(bin('ffmpeg', 'FFMPEG_PATH'), ['-version']).status === 0
  && spawnSync(bin('ffprobe', 'FFPROBE_PATH'), ['-version']).status === 0;

function ff(args) {
  const r = spawnSync(bin('ffmpeg', 'FFMPEG_PATH'), ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error('ffmpeg fixture failed: ' + r.stderr);
}
function probe(file) {
  const r = spawnSync(bin('ffprobe', 'FFPROBE_PATH'),
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  return JSON.parse(r.stdout || '{}');
}
const incomingEmpty = () => !fs.existsSync(INCOMING) || fs.readdirSync(INCOMING).length === 0;

// Fixtures: a 3 s landscape clip with sound, and the same clip flagged as
// rotated 90° the way a phone records portrait video.
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const FIX = path.join(WORK, 'clip.mov');
const FIX_ROT = path.join(WORK, 'portrait.mov');
if (hasTools) {
  // A phone-style location tag, so stripping metadata can be checked.
  ff(['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-metadata', 'location=+49.8951-097.1384/', FIX]);
  // Full-size 1920x1080 flagged as rotated: comes out 1080x1920 only if the
  // portrait size cap is applied (a landscape cap would shrink it to 608x1080).
  const big = path.join(WORK, 'big-landscape.mov');
  ff(['-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', big]);
  ff(['-display_rotation:v:0', '90', '-i', big, '-c', 'copy', FIX_ROT]);
}
const copyFixture = (to) => { fs.copyFileSync(FIX, to); return to; };

try {
  // --- conversion ------------------------------------------------------------
  if (section('conversion')) {
    console.log('--- conversion ---');
    if (!hasTools) skip('conversion', 'ffmpeg/ffprobe not found');
    else {
      const { convertVideo, VideoError } = await import('./server/video.js');
      const out = path.join(WORK, 'uploads');
      fs.mkdirSync(out, { recursive: true });

      const seen = [];
      const input = copyFixture(path.join(WORK, 'in1.mov'));
      const r = await convertVideo(input, { uploadsDir: out, name: 'clip.mov', onProgress: (f) => seen.push(f) });
      check('returns the converted pair', r.src === 'uploads/clip.mp4' && r.poster === 'uploads/clip.poster.jpg',
        JSON.stringify(r));
      const mp4 = path.join(out, 'clip.mp4');
      const info = probe(mp4);
      const v = (info.streams || []).find((s) => s.codec_type === 'video') || {};
      const a = (info.streams || []).find((s) => s.codec_type === 'audio') || {};
      check('video is H.264 yuv420p', v.codec_name === 'h264' && v.pix_fmt === 'yuv420p', `${v.codec_name} ${v.pix_fmt}`);
      check('audio is AAC', a.codec_name === 'aac', a.codec_name);
      check('size stays within 1920x1080', v.width <= 1920 && v.height <= 1080, `${v.width}x${v.height}`);
      const buf = fs.readFileSync(mp4);
      check('faststart: index before data', buf.indexOf('moov') > -1 && buf.indexOf('moov') < buf.indexOf('mdat'));
      const tagged = JSON.stringify(probe(FIX).format?.tags || {});
      check('metadata is stripped', /49\.8951/.test(tagged) && !/49\.8951/.test(JSON.stringify(info.format?.tags || {})),
        `fixture ${tagged.slice(0, 60)} → ${JSON.stringify(info.format?.tags || {}).slice(0, 60)}`);
      const poster = fs.readFileSync(path.join(out, 'clip.poster.jpg'));
      check('a poster frame is written', poster[0] === 0xff && poster[1] === 0xd8);
      check('the original is deleted', !fs.existsSync(input));
      check('no temp files are left', incomingEmpty());
      check('progress is reported', seen.length > 0 && seen.every((f) => f > 0 && f <= 1), seen.slice(-3).join(','));

      const again = await convertVideo(copyFixture(path.join(WORK, 'in2.mov')), { uploadsDir: out, name: 'clip.mp4' });
      check('a second upload of the same name gets -2 for both files',
        again.src === 'uploads/clip-2.mp4' && again.poster === 'uploads/clip-2.poster.jpg'
        && fs.existsSync(path.join(out, 'clip-2.poster.jpg')), JSON.stringify(again));

      const rotIn = path.join(WORK, 'in3.mov');
      fs.copyFileSync(FIX_ROT, rotIn);
      const rot = await convertVideo(rotIn, { uploadsDir: out, name: 'portrait.mov' });
      const rv = (probe(path.join(out, 'portrait.mp4')).streams || []).find((s) => s.codec_type === 'video') || {};
      check('a rotated phone clip comes out upright at full size', rv.width === 1080 && rv.height === 1920, `${rv.width}x${rv.height} (${rot.src})`);

      const junk = path.join(WORK, 'notes.mov');
      fs.writeFileSync(junk, 'not a video');
      let err = null;
      try { await convertVideo(junk, { uploadsDir: out, name: 'notes.mov' }); } catch (e) { err = e; }
      check('a non-video is rejected', err instanceof VideoError, String(err));
      check('  and is deleted', !fs.existsSync(junk));

      // The cap is read at import, so check it in a child process.
      const capIn = copyFixture(path.join(WORK, 'in4.mov'));
      const child = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { convertVideo } from './server/video.js';
         convertVideo(${JSON.stringify(capIn)}, { uploadsDir: ${JSON.stringify(out)}, name: 'big.mov' })
           .then(() => console.log('NO ERROR'), (e) => console.log('ERR ' + e.message));`],
      { cwd: ROOT, env: { ...process.env, VIDEO_MAX_BYTES: '1000' }, encoding: 'utf8' });
      check('a converted file over the cap is rejected', /ERR .*too large/i.test(child.stdout), child.stdout.trim() || child.stderr.trim());
      check('  and nothing is kept', !fs.existsSync(path.join(out, 'big.mp4')) && !fs.existsSync(capIn) && incomingEmpty());
    }
  }
  // --- server ----------------------------------------------------------------
  if (section('server')) {
    console.log('--- server ---');
    const lib = fs.readdirSync(path.join(ROOT, 'media')).find((f) => /\.jpg$/i.test(f));
    const head = fs.readFileSync(path.join(ROOT, 'media', lib)).subarray(0, 10);
    let r = await fetch(`${BASE}/media/${encodeURIComponent(lib)}`, { headers: { Range: 'bytes=0-9' } });
    const body = Buffer.from(await r.arrayBuffer());
    check('a range request gets 206 and those bytes', r.status === 206 && body.equals(head)
      && /^bytes 0-9\//.test(r.headers.get('content-range') || ''), `${r.status} ${r.headers.get('content-range')}`);
    r = await fetch(`${BASE}/media/${encodeURIComponent(lib)}`);
    await r.arrayBuffer();
    check('full responses advertise ranges', r.headers.get('accept-ranges') === 'bytes');
    r = await fetch(`${BASE}/media/${encodeURIComponent(lib)}`, { headers: { Range: 'bytes=999999999-' } });
    await r.arrayBuffer();
    check('an unsatisfiable range gets 416', r.status === 416, String(r.status));

    // Listing: a stand-in video pair dropped straight into uploads/.
    fs.mkdirSync(UPLOADS, { recursive: true });
    fs.writeFileSync(path.join(UPLOADS, 'vc-standin.mp4'), 'x');
    fs.copyFileSync(path.join(ROOT, 'media', lib), path.join(UPLOADS, 'vc-standin.poster.jpg'));
    const list = (await (await fetch(`${BASE}/api/media`)).json()).media;
    const item = list.find((m) => m.src === 'uploads/vc-standin.mp4');
    check('videos are listed as videos', item?.kind === 'video' && item?.poster === 'uploads/vc-standin.poster.jpg',
      JSON.stringify(item));
    check('photos are listed as images', list.find((m) => m.src === lib)?.kind === 'image');
    check('poster files are not listed', !list.some((m) => /\.poster\.jpg$/.test(m.src)));
    r = await fetch(`${BASE}/thumbs/uploads/vc-standin.mp4`);
    check('a video thumbnail comes from its poster', r.status === 200 && r.headers.get('content-type') === 'image/jpeg',
      `${r.status} ${r.headers.get('content-type')}`);
    await r.arrayBuffer();
    r = await fetch(`${BASE}/media/uploads/vc-standin.mp4`);
    await r.arrayBuffer();
    check('mp4 is served as video/mp4', r.headers.get('content-type') === 'video/mp4', r.headers.get('content-type'));

    const ndjson = async (res) => (await res.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    if (!hasTools) skip('video upload endpoint', 'ffmpeg/ffprobe not found');
    else {
      r = await fetch(`${BASE}/api/media/upload-video?name=vc%20clip.mov`, { method: 'POST', body: fs.readFileSync(FIX) });
      const events = await ndjson(r);
      const last = events[events.length - 1] || {};
      check('upload-video streams progress then the result',
        events.some((e) => typeof e.progress === 'number') && last.src === 'uploads/vc_clip.mp4'
        && fs.existsSync(path.join(UPLOADS, 'vc_clip.mp4')), JSON.stringify(last));

      // Drop the connection halfway through sending.
      await new Promise((resolve) => {
        const http = httpMod;
        const req = http.request(`${BASE}/api/media/upload-video?name=vc-aborted.mov`, { method: 'POST' });
        req.on('error', () => resolve());
        const data = fs.readFileSync(FIX);
        req.write(data.subarray(0, data.length >> 1), () => { setTimeout(() => { req.destroy(); resolve(); }, 300); });
      });
      await sleep(1000);
      check('an aborted upload leaves nothing behind', incomingEmpty()
        && !fs.readdirSync(UPLOADS).some((f) => f.startsWith('vc-aborted')));
    }
    r = await fetch(`${BASE}/api/media/upload-video?name=notes.txt`, { method: 'POST', body: 'hello' });
    const bad = await ndjson(r);
    check('a non-video name is refused', !!bad[bad.length - 1]?.error, JSON.stringify(bad));

    const photoBytes = fs.readFileSync(path.join(ROOT, 'media', lib));
    const up = async () => (await (await fetch(`${BASE}/api/media/upload?name=vc%20photo.jpg`,
      { method: 'POST', body: photoBytes })).json()).src;
    const p1 = await up();
    const p2 = await up();
    check('photo uploads still avoid name clashes', p1 === 'uploads/vc_photo.jpg' && p2 === 'uploads/vc_photo-2.jpg', `${p1} ${p2}`);
  }

  // --- site ------------------------------------------------------------------
  if (section('site')) {
    console.log('--- site ---');
    const lib = fs.readdirSync(path.join(ROOT, 'media')).filter((f) => /\.jpg$/i.test(f)).sort()[0];
    // A real converted clip when ffmpeg is here; otherwise a stand-in pair
    // (enough for everything except actual playback).
    let vsrc;
    fs.mkdirSync(UPLOADS, { recursive: true });
    if (hasTools) {
      const r = await fetch(`${BASE}/api/media/upload-video?name=vc-site.mov`, { method: 'POST', body: fs.readFileSync(FIX) });
      vsrc = JSON.parse((await r.text()).trim().split('\n').pop()).src;
    } else {
      fs.writeFileSync(path.join(UPLOADS, 'vc-site.mp4'), 'stand-in video bytes');
      fs.copyFileSync(path.join(ROOT, 'media', lib), path.join(UPLOADS, 'vc-site.poster.jpg'));
      vsrc = 'uploads/vc-site.mp4';
    }

    // Two copies of the video in one gallery: one with a chosen poster, one
    // whose chosen poster has since been deleted.
    const data = JSON.parse(backup);
    const proj = data.projects.slice().sort((a, b) => a.order - b.order).find((p) => (p.photos || []).length >= 1);
    proj.photos.push({ src: vsrc, caption: 'VC chosen', poster: lib }, { src: vsrc, caption: 'VC gone', poster: 'vc-deleted.jpg' });
    fs.writeFileSync(DATA, JSON.stringify(data, null, 2));
    const build = spawnSync(process.execPath, ['export/build-site.js', '--drafts'],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PORTFOLIO_BUILD_ROOT: BUILD_ROOT } });
    fs.writeFileSync(DATA, backup);                  // restore at once: the file is shared with a running editor
    check('the drafts build succeeds', build.status === 0, (build.stderr || '').trim().split('\n').pop());

    const slug = proj.slug;
    const html = fs.readFileSync(path.join(TEST_PREVIEW, 'projects', `${slug}.html`), 'utf8');
    const hrefs = [...html.matchAll(/href="([^"]+\.mp4\?v=[0-9a-f]+)"[^>]*data-video/g)].map((m) => m[1]);
    check('video tiles link to a versioned relative mp4', hrefs.length === 2 && hrefs[0].startsWith('../video/'), hrefs.join(' '));
    const shipped = path.join(TEST_PREVIEW, hrefs[0]?.replace(/^\.\.\//, '').replace(/\?.*/, '') || 'x');
    check('the mp4 is copied byte-for-byte', fs.existsSync(shipped)
      && fs.readFileSync(shipped).equals(fs.readFileSync(path.join(UPLOADS, path.basename(vsrc)))));
    const tiles = [...html.matchAll(/<figure class="photo video"[\s\S]*?<\/figure>/g)].map((m) => m[0]);
    const libStem = lib.replace(/\.[^.]+$/, '');
    check('a chosen poster is used', tiles[0]?.includes(`img/${libStem}-`), (tiles[0] || '').slice(0, 160));
    check('a deleted poster falls back to the frame', /img\/[^"]*poster[^"]*-\d+\.jpg/.test(tiles[1] || ''), (tiles[1] || '').slice(0, 160));

    const puppeteer = (await import('puppeteer-core')).default;
    const b = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
    try {
      const page = await b.newPage();
      const asked = [];
      page.on('request', (rq) => asked.push(rq.url()));
      await page.goto(previewUrl(`projects/${slug}.html`), { waitUntil: 'networkidle0' });
      await page.evaluate(async () => {           // pull every lazy poster in
        for (let y = 0; y < document.body.scrollHeight; y += 500) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
      });
      await sleep(500);
      check('no video bytes load with the page', !asked.some((u) => /\.mp4/.test(u)), asked.filter((u) => /\.mp4/.test(u)).join(' '));

      await page.click('a[data-video]');
      await sleep(400);
      const open = await page.evaluate(() => {
        const v = document.getElementById('lb-video');
        return { shown: !!v && !v.hidden, src: v?.getAttribute('src') || '', img: !document.getElementById('lb-img').hidden };
      });
      check('clicking a video tile opens it in the lightbox', open.shown && /\.mp4/.test(open.src) && !open.img, JSON.stringify(open));
      if (hasTools) {
        await page.waitForFunction(() => !document.getElementById('lb-video').paused, { timeout: 5000 }).catch(() => {});
        check('  and it plays', await page.evaluate(() => !document.getElementById('lb-video').paused));
      } else skip('playback', 'stand-in video (ffmpeg not found)');

      await page.keyboard.press('Escape');
      await sleep(200);
      check('closing stops the video download', await page.evaluate(() => !document.getElementById('lb-video').hasAttribute('src')));

      // Arrow from the photo just before the first video lands on it.
      const idx = await page.evaluate(() => {
        const links = [...document.querySelectorAll('a[data-lightbox]')];
        return links.findIndex((a) => a.hasAttribute('data-video')) - 1;
      });
      if (idx < 0) skip('arrow navigation into a video', 'no photo before the video');
      else {
        await page.evaluate((i) => document.querySelectorAll('a[data-lightbox]')[i].click(), idx);
        await sleep(200);
        await page.keyboard.press('ArrowRight');
        await sleep(300);
        check('arrow keys move from a photo to a video', await page.evaluate(() =>
          !document.getElementById('lb-video').hidden && document.getElementById('lb-img').hidden));
        await page.keyboard.press('ArrowLeft');
        await sleep(200);
        check('  and back, stopping it', await page.evaluate(() =>
          document.getElementById('lb-video').hidden && !document.getElementById('lb-video').hasAttribute('src')));
      }
    } finally {
      await b.close();
    }
  }
  // --- zip import ------------------------------------------------------------
  if (section('zip')) {
    console.log('--- zip import ---');
    const { makeZip } = await import('./zipwriter.mjs');
    const libs = fs.readdirSync(path.join(ROOT, 'media')).filter((f) => /\.jpg$/i.test(f)).sort();
    const jpg = (i) => fs.readFileSync(path.join(ROOT, 'media', libs[i]));
    const entries = [
      { name: 'b/VZ_IMG_10.jpg', data: jpg(0), method: 0 },
      { name: 'a/VZ_IMG_2.jpg', data: jpg(1) },
      { name: 'a/VZ_IMG_1.jpg', data: jpg(2) },
      { name: 'b/VZ_IMG_1.jpg', data: jpg(3) },
      { name: 'notes.txt', data: 'not media' },
      { name: '__MACOSX/a/._VZ_IMG_2.jpg', data: 'junk' },
      { name: '.DS_Store', data: 'junk' },
      { name: 'Thumbs.db', data: 'junk' },
      { name: '../vz_evil.jpg', data: jpg(4) },
      { name: '/abs/vz_evil2.jpg', data: jpg(5) },
      { name: 'vz_secret.jpg', data: jpg(6), encrypted: true },
      { name: 'a/', data: '' },
    ];
    if (hasTools) entries.push({ name: 'clips/vz_clip.mov', data: fs.readFileSync(FIX), method: 0 });
    const zipFile = path.join(WORK, 'import.zip');
    makeZip(zipFile, entries);

    const post = async (base, file) => {
      const r = await fetch(`${base}/api/media/upload-zip?name=import.zip`, { method: 'POST', body: fs.readFileSync(file) });
      return (await r.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    };
    const events = await post(BASE, zipFile);
    const result = events[events.length - 1] || {};
    const coll = new Intl.Collator(undefined, { numeric: true });
    const names = ['VZ_IMG_10.jpg', 'VZ_IMG_2.jpg', 'VZ_IMG_1.jpg', 'VZ_IMG_1.jpg', 'vz_evil.jpg', 'vz_evil2.jpg',
      ...(hasTools ? ['vz_clip.mov'] : [])].sort(coll.compare);
    let dup = 0;
    const want = names.map((n) => {
      if (n === 'VZ_IMG_1.jpg' && dup++) return 'uploads/VZ_IMG_1-2.jpg';
      return 'uploads/' + n.replace(/\.mov$/, '.mp4');
    });
    check('imports every photo and video in name order', JSON.stringify(result.imported) === JSON.stringify(want),
      JSON.stringify(result.imported));
    check('lists unsupported files as skipped', JSON.stringify(result.skipped) === '["notes.txt"]', JSON.stringify(result.skipped));
    check('ignores junk files silently', !JSON.stringify(result).match(/MACOSX|DS_Store|Thumbs\.db/));
    check('an encrypted entry fails on its own', (result.failed || []).length === 1
      && result.failed[0].name === 'vz_secret.jpg', JSON.stringify(result.failed));
    const steps = events.filter((e) => e.entry);
    const media = result.imported.length + result.failed.length;
    check('reports progress per entry, counting only media', steps.length === media && steps[0].index === 1
      && steps.every((e) => e.total === media), JSON.stringify(steps[0]));
    check('paths inside the zip cannot escape uploads', !fs.existsSync(path.join(ROOT, 'data', 'vz_evil.jpg'))
      && !fs.existsSync(path.join(ROOT, 'vz_evil.jpg')) && fs.existsSync(path.join(UPLOADS, 'vz_evil.jpg'))
      && fs.existsSync(path.join(UPLOADS, 'vz_evil2.jpg')));
    check('imported photos are byte-identical', fs.readFileSync(path.join(UPLOADS, 'VZ_IMG_10.jpg')).equals(jpg(0)));
    if (hasTools) check('a video in the zip is converted', fs.existsSync(path.join(UPLOADS, 'vz_clip.mp4'))
      && fs.existsSync(path.join(UPLOADS, 'vz_clip.poster.jpg')) && !fs.existsSync(path.join(UPLOADS, 'vz_clip.mov')));
    else skip('video inside a zip', 'ffmpeg/ffprobe not found');
    check('the zip and temp files are gone', incomingEmpty());

    // The size limit, on a second server started with a tiny cap.
    const cap = jpg(0).length + 10;
    const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: '4398', ZIP_MAX_BYTES: String(cap) }, stdio: 'ignore' });
    try {
      for (let i = 0; i < 40; i++) { try { await fetch('http://127.0.0.1:4398/editor/'); break; } catch { await sleep(150); } }
      const small = path.join(WORK, 'limit.zip');
      makeZip(small, [{ name: 'vz_lim_1.jpg', data: jpg(0) }, { name: 'vz_lim_2.jpg', data: jpg(1) }, { name: 'vz_lim_3.jpg', data: jpg(2) }]);
      const ev = await post('http://127.0.0.1:4398', small);
      const res = ev[ev.length - 1] || {};
      check('the size limit stops unpacking cleanly', JSON.stringify(res.imported) === '["uploads/vz_lim_1.jpg"]'
        && (res.failed || []).length === 2 && res.failed.every((f) => /size limit/.test(f.error)), JSON.stringify(res));
      check('  and leaves no temp files', incomingEmpty());
    } finally {
      srv.kill();
    }

    const notZip = path.join(WORK, 'bad.zip');
    fs.writeFileSync(notZip, 'not a zip');
    const bad = await post(BASE, notZip);
    check('a damaged zip reports an error', !!bad[bad.length - 1]?.error, JSON.stringify(bad[bad.length - 1]));
  }
  // --- editor ----------------------------------------------------------------
  if (section('editor')) {
    console.log('--- editor ---');
    const { makeZip } = await import('./zipwriter.mjs');
    const libs = fs.readdirSync(path.join(ROOT, 'media')).filter((f) => /\.jpg$/i.test(f)).sort();
    fs.mkdirSync(UPLOADS, { recursive: true });
    // A stand-in video pair, so the UI can be checked without ffmpeg.
    fs.writeFileSync(path.join(UPLOADS, 'vc-ed.mp4'), 'stand-in');
    fs.copyFileSync(path.join(ROOT, 'media', libs[0]), path.join(UPLOADS, 'vc-ed.poster.jpg'));
    const zipFile = path.join(WORK, 'ed.zip');
    makeZip(zipFile, [{ name: 'vc_ed_photo.jpg', data: fs.readFileSync(path.join(ROOT, 'media', libs[1])) },
      { name: 'notes.txt', data: 'x' }]);

    const puppeteer = (await import('puppeteer-core')).default;
    const b = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const errs = [];
    try {
      const page = await b.newPage();
      await page.setViewport({ width: 1500, height: 1000 });
      page.on('pageerror', (e) => errs.push(e.message));
      page.on('dialog', (d) => { errs.push('dialog: ' + d.message()); d.dismiss(); });
      await page.goto(`${BASE}/editor/`, { waitUntil: 'networkidle0' });
      await sleep(1200);
      const strip = () => page.$$eval('.form-pane .photo-strip .strip-item', (els) => els.length);
      const before = await strip();

      // Add the video from the drawer.
      await page.click('.form-pane .strip-add');
      await sleep(400);
      const tile = await page.$eval('.media-item[title^="uploads/vc-ed.mp4"]', (n) => ({
        video: n.classList.contains('is-video'), badge: !!n.querySelector('.play-badge'),
      })).catch(() => null);
      check('the drawer shows a video with a play badge', tile?.video && tile?.badge, JSON.stringify(tile));
      await page.click('.media-item[title^="uploads/vc-ed.mp4"]').catch(() => {});
      await page.click('#drawer-close');
      await sleep(400);
      const vitem = await page.evaluate(() => {
        const it = [...document.querySelectorAll('.form-pane .strip-item.is-video')].pop();
        if (!it) return null;
        return { badge: !!it.querySelector('.play-badge'), thumb: it.querySelector('img').getAttribute('src'),
          buttons: [...it.querySelectorAll('.strip-tools button')].map((x) => x.textContent) };
      });
      check('the video joins the gallery', (await strip()) === before + 1 && !!vitem, JSON.stringify(vitem));
      check('  with a play badge and its frame as thumbnail', vitem?.badge && /vc-ed\.mp4|vc-ed\.poster/.test(vitem?.thumb || ''), vitem?.thumb);
      check('  and no Lead button', vitem && !vitem.buttons.some((t) => /Lead/.test(t)), vitem?.buttons.join('|'));

      // Choose a poster.
      const clickStripButton = (label) => page.evaluate((label) => {
        const it = [...document.querySelectorAll('.form-pane .strip-item.is-video')].pop();
        [...it.querySelectorAll('.strip-tools button')].find((x) => x.textContent.startsWith(label))?.click();
      }, label);
      await clickStripButton('Poster');
      await sleep(400);
      const pick = await page.evaluate(() => ({
        open: !document.getElementById('drawer').hidden,
        videos: document.querySelectorAll('.media-item.is-video').length,
      }));
      check('the poster picker lists images only', pick.open && pick.videos === 0, JSON.stringify(pick));
      await page.click(`.media-item[title^="${libs[2]}"]`).catch(() => {});
      await sleep(400);
      const chosen = await page.evaluate(() =>
        [...document.querySelectorAll('.form-pane .strip-item.is-video')].pop()?.querySelector('img').getAttribute('src'));
      check('choosing a poster updates the gallery', (chosen || '').includes(encodeURI(libs[2])), chosen);
      await clickStripButton('Use frame');
      await sleep(400);
      const reset = await page.evaluate(() =>
        [...document.querySelectorAll('.form-pane .strip-item.is-video')].pop()?.querySelector('img').getAttribute('src'));
      check('"Use frame from video" goes back to the frame', !(reset || '').includes(encodeURI(libs[2])), reset);

      // Zip upload from the gallery drawer.
      const n0 = await strip();
      await page.click('.form-pane .strip-add');
      await sleep(400);
      const input = await page.$('#media-upload');
      await input.uploadFile(zipFile);
      await page.waitForFunction(() => !document.getElementById('media-report').hidden, { timeout: 15000 }).catch(() => {});
      const report = await page.$eval('#media-report', (n) => ({ hidden: n.hidden, text: n.textContent }));
      check('a zip upload shows a summary', !report.hidden && /notes\.txt/.test(report.text) && /1 imported|Imported/i.test(report.text),
        report.text.slice(0, 120));
      await page.click('#drawer-close');
      await sleep(400);
      check('  and adds what it imported to the gallery', (await strip()) === n0 + 1, `${n0} -> ${await strip()}`);

      // Single-pick pickers never offer videos.
      await page.evaluate(() => document.querySelector('.side-tab[data-section="profile"]').click());
      await sleep(600);
      await page.evaluate(() => [...document.querySelectorAll('.form-pane .strip-add')]
        .find((x) => /photo/i.test(x.textContent))?.click());
      await sleep(400);
      check('the profile photo picker hides videos', await page.evaluate(() =>
        !document.getElementById('drawer').hidden && document.querySelectorAll('.media-item.is-video').length === 0));
      check('no page errors or alerts', errs.length === 0, errs.join(' / '));

      // The Upload button warns when the server has no ffmpeg. Checked on two
      // extra servers: one pointed at a missing ffmpeg, one at a stub that
      // only answers -version, so both cases run on any machine.
      const stub = path.join(WORK, 'fake-ff.sh');
      fs.writeFileSync(stub, '#!/bin/sh\necho "ffmpeg version stub"\n');
      fs.chmodSync(stub, 0o755);
      const uploadButton = async (port, env) => {
        const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), ...env }, stdio: 'ignore' });
        try {
          for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/editor/`); break; } catch { await sleep(150); } }
          const pg = await b.newPage();
          await pg.goto(`http://127.0.0.1:${port}/editor/`, { waitUntil: 'networkidle0' });
          await sleep(800);
          await pg.click('.form-pane .strip-add');
          await sleep(300);
          const out = await pg.$eval('label[for="media-upload"]', (n) => ({ title: n.title, warn: n.classList.contains('warn') }));
          await pg.close();
          return out;
        } finally {
          srv.kill();
        }
      };
      const missing = await uploadButton(4396, { FFMPEG_PATH: '/nonexistent/ffmpeg', FFPROBE_PATH: '/nonexistent/ffprobe' });
      check('the Upload button warns when ffmpeg is missing', missing.warn && /ffmpeg/i.test(missing.title)
        && /video/i.test(missing.title), JSON.stringify(missing));
      const present = await uploadButton(4395, { FFMPEG_PATH: stub, FFPROBE_PATH: stub });
      check('  and not when it is there', !present.warn && !/ffmpeg/i.test(present.title), JSON.stringify(present));
    } finally {
      await b.close();
    }
  }
  // --- start script ----------------------------------------------------------
  if (section('start')) {
    console.log('--- start script ---');
    const runScript = (args, env, ms) => new Promise((resolve) => {
      const child = spawn('bash', ['start-editor.sh', ...args], { cwd: ROOT, env: { ...process.env, PORT: '4397', ...env }, detached: true });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const timer = setTimeout(() => resolve({ code: null, out, child }), ms);
      child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, child }); });
    });
    // A fake firefox first on PATH leaves a marker if the script ever runs it.
    const fakeBin = path.join(WORK, 'bin');
    const marker = path.join(WORK, 'firefox-was-run');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'firefox'), `#!/bin/sh\ntouch "${marker}"\n`);
    fs.chmodSync(path.join(fakeBin, 'firefox'), 0o755);
    const PATHX = `${fakeBin}${path.delimiter}${process.env.PATH}`;

    const missing = await runScript([], { FFMPEG_PATH: '/nonexistent/ffmpeg', PATH: PATHX }, 8000);
    check('refuses to start without ffmpeg', missing.code === 1, `exit ${missing.code}`);
    check('  and says how to install it', /apt install ffmpeg/.test(missing.out) && /winget install Gyan\.FFmpeg/.test(missing.out)
      && /--no-ffmpeg/.test(missing.out), missing.out.trim().split('\n').slice(0, 3).join(' | '));
    if (missing.code === null) try { process.kill(-missing.child.pid); } catch {}

    // Started by hand (not runScript) so its process group can be stopped.
    const child = spawn('bash', ['start-editor.sh', '--no-ffmpeg'],
      { cwd: ROOT, env: { ...process.env, PORT: '4397', FFMPEG_PATH: '/nonexistent/ffmpeg', PATH: PATHX }, detached: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(250);
      try { up = (await fetch('http://127.0.0.1:4397/editor/')).ok; } catch {}
    }
    await sleep(700);
    check('--no-ffmpeg starts the editor anyway', up);
    check('prints the editor address to open', /Open http:\/\/127\.0\.0\.1:4397\/editor\/ in your browser/.test(out),
      out.trim().split('\n').pop());
    check('never launches a browser', !fs.existsSync(marker));
    const again = await runScript(['--no-ffmpeg'], { FFMPEG_PATH: '/nonexistent/ffmpeg', PATH: PATHX }, 8000);
    check('when already running, says so and prints the address', again.code === 0
      && /already running/.test(again.out) && /http:\/\/127\.0\.0\.1:4397\/editor\//.test(again.out) && !fs.existsSync(marker),
      again.out.trim().split('\n').pop());
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await sleep(800);
    let down = true;
    try { down = !(await fetch('http://127.0.0.1:4397/editor/')).ok; } catch {}
    const pid = child.pid;
    check('  (test cleanup: stopped)', down, String(pid || ''));
  }
} finally {
  fs.writeFileSync(DATA, backup);
  if (fs.existsSync(UPLOADS)) {
    for (const f of fs.readdirSync(UPLOADS)) if (!uploadsBefore.has(f)) fs.rmSync(path.join(UPLOADS, f), { force: true });
  }
  fs.rmSync(WORK, { recursive: true, force: true });
}

{ const ch = docsChanges(docsBefore, docsSnapshot());
  check('docs/ is left untouched', ch.length === 0, ch.slice(0, 4).join(' | ')); }
console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
