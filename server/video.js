// Video conversion for uploads. Every video is converted once, here, to a
// web-friendly MP4 and a poster frame; the original is then deleted. Only
// the converted pair is ever stored or committed.
//
// Uses the system ffmpeg/ffprobe (FFMPEG_PATH / FFPROBE_PATH override PATH),
// the same way the PDF build uses the system Chromium/Edge.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { cleanName, uniqueStem } from './uploads.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INCOMING = path.join(ROOT, '.cache', 'incoming');

export const VIDEO_IN_RE = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
// GitHub refuses files over 100 MB; 50 MB keeps well clear of it.
export const MAX_OUTPUT_BYTES = Number(process.env.VIDEO_MAX_BYTES) || 50 * 1024 * 1024;
const TIMEOUT_MS = 10 * 60 * 1000;

export class VideoError extends Error {}

const tool = (name) => process.env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'] || name;

// Run a tool, collecting stdout/stderr. Rejects with the tail of stderr.
function run(bin, args, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return reject(e); }
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; onStdout?.(String(d)); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new VideoError(signal === 'SIGKILL' ? 'Conversion took too long and was stopped'
        : (err.trim().split('\n').pop() || `${path.basename(bin)} exited with ${code}`)));
    });
  });
}

// Only a success is cached: install ffmpeg while the editor is running and
// the next check finds it, no restart needed.
let toolsCache = null;
export async function findTools() {
  if (toolsCache) return toolsCache;
  try {
    await run(tool('ffmpeg'), ['-version']);
    await run(tool('ffprobe'), ['-version']);
    toolsCache = { ffmpeg: tool('ffmpeg'), ffprobe: tool('ffprobe') };
  } catch {
    return null;
  }
  return toolsCache;
}

async function probe(file) {
  let info;
  try {
    info = JSON.parse(await run(tool('ffprobe'),
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]));
  } catch {
    return null;
  }
  const v = (info.streams || []).find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  if (!v) return null;
  // Phones store portrait video as landscape pixels plus a rotation flag.
  const rotation = Number(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0);
  const quarter = Math.abs(rotation) % 180 === 90;
  return {
    width: quarter ? v.height : v.width,
    height: quarter ? v.width : v.height,
    duration: Number(info.format?.duration) || Number(v.duration) || 0,
  };
}

// Conversions run one at a time; a second upload waits its turn.
let queue = Promise.resolve();

export function convertVideo(input, opts) {
  const job = queue.then(() => convert(input, opts));
  queue = job.catch(() => {});
  return job;
}

async function convert(input, { uploadsDir, name, onProgress, incomingDir = INCOMING }) {
  const id = crypto.randomBytes(6).toString('hex');
  const tmpVideo = path.join(incomingDir, `${id}.mp4`);
  const tmpPoster = path.join(incomingDir, `${id}.jpg`);
  try {
    if (!(await findTools())) {
      throw new VideoError('ffmpeg not found — install it (see Development.md) or set FFMPEG_PATH');
    }
    await fs.mkdir(incomingDir, { recursive: true });
    const info = await probe(input);
    if (!info) throw new VideoError(`No video stream in ${name}`);

    // Cap the bounding box, not the width: portrait clips cap at 1080x1920.
    const [bw, bh] = info.width >= info.height ? [1920, 1080] : [1080, 1920];
    const vf = `scale='min(${bw},iw)':'min(${bh},ih)':force_original_aspect_ratio=decrease`
      + ':force_divisible_by=2,format=yuv420p';

    let buf = '';
    await run(tool('ffmpeg'), [
      '-hide_banner', '-nostdin', '-y', '-i', input,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-profile:v', 'high',
      '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
      '-movflags', '+faststart', '-map_metadata', '-1',
      '-progress', 'pipe:1', '-nostats', tmpVideo,
    ], {
      onStdout: (chunk) => {
        if (!onProgress || !info.duration) return;
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const m = /^out_time_us=(\d+)/.exec(line);
          if (m) {
            const f = Math.min(1, Number(m[1]) / 1e6 / info.duration);
            if (f > 0) onProgress(f);
          }
        }
      },
    });

    const { size } = await fs.stat(tmpVideo);
    if (size > MAX_OUTPUT_BYTES) {
      const mb = (size / 1048576).toFixed(0);
      throw new VideoError(`${name} is too large once converted (${mb} MB, limit ${(MAX_OUTPUT_BYTES / 1048576).toFixed(0)} MB) — trim it and re-upload`);
    }

    const at = info.duration >= 1 ? '1' : '0';
    await run(tool('ffmpeg'), ['-hide_banner', '-nostdin', '-y', '-ss', at, '-i', tmpVideo,
      '-frames:v', '1', '-q:v', '3', tmpPoster]);

    const stem = uniqueStem(uploadsDir, path.basename(cleanName(name), path.extname(cleanName(name))) || 'video',
      ['.mp4', '.poster.jpg']);
    await fs.mkdir(uploadsDir, { recursive: true });
    await fs.rename(tmpVideo, path.join(uploadsDir, stem + '.mp4'));
    await fs.rename(tmpPoster, path.join(uploadsDir, stem + '.poster.jpg'));
    return { src: `uploads/${stem}.mp4`, poster: `uploads/${stem}.poster.jpg`, bytes: size };
  } finally {
    for (const f of [input, tmpVideo, tmpPoster]) {
      if (fsSync.existsSync(f)) await fs.rm(f, { force: true });
    }
  }
}
