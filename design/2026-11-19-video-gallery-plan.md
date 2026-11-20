# Video in galleries + zip import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Projects' galleries can hold videos (converted at upload, played in the lightbox), and the media drawer imports `.zip` files of photos and videos.

**Architecture:** Videos are `.mp4` entries in `project.photos[]`, recognised by extension; helpers in `shared/model.js` decide poster and eligibility. Two new server modules — `server/video.js` (ffmpeg conversion) and `server/zip.js` (dependency-free zip reader) — plus `server/importzip.js` glue, exposed through streaming NDJSON endpoints. All markup stays in `shared/render.js`; the site build copies MP4s byte-for-byte into `docs/video/`.

**Tech Stack:** Node ≥ 22.12 ES modules, `node:zlib` (`createInflateRaw`, `crc32`), system `ffmpeg`/`ffprobe`, sharp (posters), puppeteer-core + system Chromium (tests).

**Spec:** `design/2026-11-19-video-gallery-design.md`

## Global Constraints

- No new npm dependencies. `ffmpeg`/`ffprobe` located via `FFMPEG_PATH` / `FFPROBE_PATH`, else `PATH`.
- Encode: 1080p box cap, `libx264 -preset slow -crf 26 -profile:v high`, `yuv420p`, `aac 96k` stereo, `+faststart`, `-map_metadata -1`.
- Converted file over **50 MB** (52428800 bytes) is rejected: "too large — trim it and re-upload". No duration limit.
- Zip: total uncompressed output cap **8 GB**; overridable by `ZIP_MAX_BYTES` (tests). Junk skipped silently: `__MACOSX/…`, `._*`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, any name starting with `.`.
- Temp files only under `.cache/incoming/`. Nothing outside the repo. Originals/zips always deleted.
- Videos: never the feature photo; `pdf` defaults to `false`.
- All markup in `shared/render.js`. `docs/` paths relative. `docs/CNAME` survives builds.
- Commits: **none** — the user asks for commits explicitly in this repo (CLAUDE.md). Each task ends with its tests passing instead.

## Review Focus

1. **Phone `.mov` with rotation / portrait** — converted video is upright and capped at 1080×1920, not 1920×1080 letterboxed. Test: Task 3 fixture with `-metadata:s:v rotate=90` (or `transpose`) is probed upright.
2. **Upload connection dropped mid-way** — temp file removed, nothing left in `data/uploads/`. Test: Task 4 aborts a request halfway and checks `.cache/incoming/` is empty.
3. **Same file name uploaded twice** (`clip.mov` then `clip.mp4`) — second becomes `clip-2.mp4` + `clip-2.poster.jpg`, the pair never split. Test: Task 3.
4. **Chosen poster later deleted from library** — tile, lightbox and build fall back to the auto poster. Test: Task 1 (`posterOf` with `has`) and Task 5 (build).
5. **Zip with nested folders containing same basename** (`a/IMG_1.jpg`, `b/IMG_1.jpg`) — both imported (`IMG_1.jpg`, `IMG_1-2.jpg`). Test: Task 6.

---

### Task 1: Model helpers

**Files:**
- Modify: `shared/model.js` (photo normalisation ~line 104; `featurePhoto` ~392)
- Test: `modelcheck.mjs` (new section `--- video items ---`)

**Interfaces — Produces:**
- `IMAGE_SRC_RE = /\.(jpe?g|png|webp|gif|avif)$/i`
- `isVideo(src: string): boolean` — `/\.mp4$/i`
- `autoPosterOf(src: string): string` — `uploads/x.mp4` → `uploads/x.poster.jpg`
- `posterOf(item: {src, poster?}, has?: (src) => boolean): string` — `item.poster` if set and `has(item.poster)` (default `has` = always true), else `autoPosterOf(item.src)`
- `normalise` photo items gain `poster: string` (kept only when `isVideo(src)` and `IMAGE_SRC_RE.test(poster)`, else `''`); videos forced `feature: false`; videos `pdf: ph.pdf === true`.
- `featurePhoto(project)` ignores videos in both the explicit match and fallback.

- [ ] **Step 1: Write failing tests** in `modelcheck.mjs`:
  - `isVideo('uploads/a.MP4') === true`, `isVideo('a.jpg') === false`
  - `autoPosterOf('uploads/a.mp4') === 'uploads/a.poster.jpg'`
  - `posterOf({src:'uploads/a.mp4', poster:'b.jpg'}) === 'b.jpg'`; with `has = () => false` → `'uploads/a.poster.jpg'`; with `poster:''` → auto
  - normalise a project with `[{src:'uploads/v.mp4', feature:true}, {src:'p.jpg'}]`: video `feature === false`, `pdf === false`; `featurePhoto` → `p.jpg`
  - only-video project: `featurePhoto(...) === null`
  - `poster:'x.txt'` on a video normalises to `''`; `poster` on an image normalises to `''`
- [ ] **Step 2:** `node modelcheck.mjs` → new checks FAIL (import errors count).
- [ ] **Step 3:** Implement in `shared/model.js`.
- [ ] **Step 4:** `node modelcheck.mjs` → `All checks passed.`

### Task 2: Zip reader

**Files:**
- Create: `server/zip.js`
- Create: `zipcheck.mjs` (unit, no server); add to `npm run check` after `modelcheck.mjs`

**Interfaces — Produces:**
- `class ZipError extends Error`
- `openZip(file: string): Promise<{ entries: ZipEntry[], close(): Promise<void> }>`
- `ZipEntry = { name: string, size: number, compressedSize: number, method: number, encrypted: boolean, isDirectory: boolean, extractTo(dest: string, { maxBytes: number }): Promise<number> }` — `extractTo` streams (stored → copy, deflate → `zlib.createInflateRaw()`), verifies `zlib.crc32` and byte count, throws `ZipError` on encrypted / unsupported method / CRC mismatch / output exceeding `min(maxBytes, size)`; deletes partial `dest` on failure. Returns bytes written.
- Names: UTF-8 when flag bit 11, else CP437 (full 128-entry high table). `name` is the raw path as stored (sanitising is the importer's job).
- ZIP64: honour EOCD64 locator/record and the `0x0001` extra field for sizes/offsets.

- [ ] **Step 1: Write failing tests** in `zipcheck.mjs`. The test contains a tiny zip *writer* (`makeZip(entries, {zip64, encryptedIndex})`, using `zlib.deflateRawSync` + `zlib.crc32`) writing to `.cache/test-zips/`. Assertions:
  - stored + deflate entries extract byte-identical
  - ZIP64-format archive (forced records, small data) lists and extracts
  - CP437 name `caf\x82.jpg` → `café.jpg`; UTF-8-flagged name `ü.jpg` → `ü.jpg`
  - corrupted CRC → `extractTo` rejects with `ZipError`, dest absent
  - encrypted flag → `encrypted === true`, `extractTo` rejects
  - `maxBytes` smaller than entry → rejects, dest absent
  - not-a-zip file → `openZip` rejects with `ZipError`
- [ ] **Step 2:** `node zipcheck.mjs` → FAIL (module missing).
- [ ] **Step 3:** Implement `server/zip.js` (read last 64 KiB + EOCD search; central directory parse; local header skip at `offset + 30 + nameLen + extraLen`).
- [ ] **Step 4:** `node zipcheck.mjs` → all PASS; cleanup removes `.cache/test-zips/`.

### Task 3: Video conversion module

**Files:**
- Create: `server/uploads.js` — naming shared by every upload path
- Create: `server/video.js`
- Test: `videocheck.mjs` section `--- conversion ---` (SKIP whole section when tools missing)

**Interfaces — Produces:**
- `server/uploads.js`: `cleanName(name: string): string` (existing rule from `server.js:231`: basename, `[^a-zA-Z0-9._-]` → `_`); `uniqueStem(dir: string, stem: string, exts: string[]): Promise<string>` — first of `stem`, `stem-2`, … for which **none** of `stem+ext` exists; `uniqueName(dir, cleanName)` built on it (used by photo upload too).
- `server/video.js`:
  - `findTools(env = process.env): Promise<{ffmpeg: string, ffprobe: string} | null>` — runs `<bin> -version`; caches result.
  - `VIDEO_IN_RE = /\.(mp4|mov|m4v|webm|mkv|avi)$/i`
  - `MAX_OUTPUT_BYTES` = `Number(env.VIDEO_MAX_BYTES) || 52428800`
  - `class VideoError extends Error`
  - `convertVideo(input: string, { uploadsDir: string, name: string, onProgress?: (fraction: number) => void }): Promise<{ src: string, poster: string, bytes: number }>` — serialised through a module-level promise queue; probes (`ffprobe -v error -print_format json -show_streams -show_format`), rejects no-video with `VideoError('No video stream in <name>')`; converts with the Global Constraints settings, `-vf "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p"` for landscape and the 1080×1920 box for portrait (decide orientation from probed display size incl. rotation side data); writes temp outputs in `.cache/incoming/`; auto poster `-ss 1` (or `0` if duration < 1); size check; renames pair into `uploadsDir` via `uniqueStem(dir, stem, ['.mp4', '.poster.jpg'])`; **always** deletes `input` and temps. Progress from `-progress pipe:1` `out_time_us` ÷ duration. 10-minute kill timeout.
  - Returned `src` / `poster` are `uploads/<stem>.mp4` / `uploads/<stem>.poster.jpg`.

- [ ] **Step 1: Write failing tests** (`videocheck.mjs`, conversion section, direct module import, `uploadsDir` = `.cache/test-uploads/`): fixture made with `ffmpeg -f lavfi -i testsrc=size=1280x720:rate=30 -f lavfi -i sine -t 3`; plus a portrait/rotated fixture; plus a 5 MB `-f lavfi -i nullsrc` cases as needed.
  - result `.mp4` probes as h264 + aac, `yuv420p`, ≤ 1920×1080; `moov` atom before `mdat` (faststart: `buf.indexOf('moov') < buf.indexOf('mdat')`)
  - poster exists and is a JPEG
  - input file deleted; `.cache/incoming/` empty
  - rotated portrait fixture → width < height, height ≤ 1920
  - same name twice → second is `-2` for both files
  - `VIDEO_MAX_BYTES=1000` (set before import in a child process) → rejects with `/too large/`, nothing left
  - a `.txt` renamed `.mov` → rejects with `VideoError`
  - `onProgress` called with values in (0, 1]
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS (or SKIP when tools missing).

### Task 4: Server endpoints, range requests, media listing

**Files:**
- Modify: `server.js` (MIME, `serveFile`, `listMedia`, `serveThumb`, upload routes)
- Test: `videocheck.mjs` section `--- server ---` (HTTP against the running server)

**Interfaces:**
- Consumes: Task 1 `isVideo`, `autoPosterOf`; Task 3 `convertVideo`, `findTools`, `uniqueName`, `cleanName`.
- Produces:
  - `streamToFile(req, dest, limit = 2 * 1024 ** 3): Promise<number>` — removes `dest` on error or `req` `'aborted'`/`'close'` before end.
  - `POST /api/media/upload-video?name=` → `200 application/x-ndjson`: `{"progress":f}`… then `{"src","poster"}` or `{"error"}`. Tools missing → single `{"error":"ffmpeg not found — install it (see Development.md) or set FFMPEG_PATH"}`.
  - `POST /api/media/upload-zip?name=` → NDJSON, events defined in Task 6.
  - `GET /api/media` items: `{ src, size, mtime, kind: 'image'|'video', poster? }` (`poster` = auto poster src for videos); `*.poster.jpg` not listed.
  - `/thumbs/<video src>` → thumbnail of its auto poster.
  - `serveFile` honours `Range: bytes=a-b` / `a-` / `-n` → 206 + `Content-Range`; invalid → 416; always `Accept-Ranges: bytes`.
  - MIME `.mp4: video/mp4`, `.ndjson` not needed.

- [ ] **Step 1: Write failing tests:** `Range: bytes=0-9` on a known `/media/*.jpg` → 206, 10 bytes equal to file head; `bytes=999999999-` → 416; upload-video of the fixture → final `{src}` and file exists under `data/uploads/`; `/api/media` lists it with `kind:'video'` and no `.poster.jpg` entry; `/thumbs/<src>` → 200 `image/jpeg`; aborted upload (send half, destroy socket) → `.cache/incoming/` empty after 1 s. Test deletes its uploads afterwards.
- [ ] **Step 2:** run (server restarted) → FAIL. **Step 3:** implement; photo upload switches to `uniqueName`. **Step 4:** run → PASS.

### Task 5: Rendering, lightbox, site build, PDF note

**Files:**
- Modify: `shared/render.js` (`photoFigure`, `morePhotosNote`, `printBody` call site, header comment for `ctx.video` / `ctx.has`)
- Modify: `export/build-site.js` (video copy, posters into `wanted`, `ctxFor`, `lightboxMarkup`, `siteScript`)
- Modify: `editor/preview.js` (`ctx()` adds `video`, `has`)
- Modify: `shared/styles/site.css` (`.play-badge`, `#lb-video`), `shared/styles/print.css` (`.video-note`)
- Test: `modelcheck.mjs` (render unit), `videocheck.mjs` section `--- site ---`

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces (ctx contract):
  - `ctx.video(src) → url` (site: `../video/<stem>.mp4?v=<hash>`; preview: `/media/<src>`)
  - `ctx.has(src) → boolean` optional; passed to `posterOf`
  - `photoFigure` for a video, screen: `<figure class="photo video" data-index><a class="photo-link" href="{video}" data-lightbox data-video aria-label="Play video: {alt||caption||'video'}">{poster img exactly as photos build it}<span class="play-badge" aria-hidden="true">▶</span></a>{figcaption}</figure>`
  - print (`ctx.photoLinks === false`): `<figure class="photo video">{poster img}<p class="video-note">▶ Video — watch online</p>{figcaption}</figure>`; note wrapped in `<a href="{projectUrl}">` when a site URL is known (pass via `photoFigure` option `videoHref`).
  - `morePhotosNote(hiddenPhotos, hiddenVideos, url)` wording: "One more photo", "2 more photos", "1 video", joined with " and ", + " of this project are/is online."
  - Lightbox markup adds `<video id="lb-video" controls playsinline preload="none" hidden></video>`; `siteScript` per design §3a (stop = `pause(); removeAttribute('src'); load()`).

- [ ] **Step 1: Write failing tests.**
  - `modelcheck.mjs`: `photoFigure({src:'uploads/v.mp4', poster:'p.jpg', caption:'Run'}, previewCtx({video: s => '/media/'+s}))` contains `data-video`, `href="/media/uploads/v.mp4"`, `src="/media/p.jpg"`, `play-badge`, and no `<video`; print ctx (`photoLinks:false`) contains `video-note` and no `data-lightbox`; `morePhotosNote` cases: (2,1) → "2 more photos and 1 video of this project are online."; (0,1) → "One video of this project is online."
  - `videocheck.mjs` site section (needs a converted fixture from Task 4 flow): put the video into the first draft-including project via `PUT /api/portfolio` (restore after), run `node export/build-site.js --drafts`, then in Chromium open that project page in `preview/`:
    - no request URL containing `.mp4` after `networkidle0`
    - `docs`-style relative `href` ends `.mp4?v=` and the file exists in `preview/video/`, byte-identical to the upload
    - click tile → `#lb-video` visible, `src` set, `paused === false` within 3 s
    - press Escape → `#lb-video` has no `src`
    - ArrowRight from a photo in the same gallery reaches the video
    - with `poster:'<a library photo>'` the tile `img` derives from that photo; after setting `poster` to a missing file and rebuilding, it derives from the auto poster
  - PDF: `printBody` on that data contains no `video-note` by default; with `pdf:true` on the video it does.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS; `node verify.mjs` still passes (then `git checkout -- docs/`).

### Task 6: Zip import

**Files:**
- Create: `server/importzip.js`
- Modify: `server.js` (route)
- Test: `videocheck.mjs` section `--- zip import ---` (photo-only parts run even without ffmpeg)

**Interfaces:**
- Consumes: Task 2 `openZip`, Task 3 `convertVideo`, `uniqueName`, `cleanName`, `VIDEO_IN_RE`; model `IMAGE_SRC_RE`.
- Produces: `importZip(zipPath, { uploadsDir, incomingDir, maxBytes, onEvent }): Promise<{ imported: string[], skipped: string[], failed: {name, error}[] }>`
  - Order: entries sorted by `cleanName(basename)` with `Intl.Collator(undefined, {numeric: true})`.
  - Events: `{entry, index, total}` per non-junk entry; `{progress}` during conversion; final `{imported, skipped, failed}` (also the return value). `imported` holds srcs in order (videos as their `.mp4` src).
  - `maxBytes` = `Number(process.env.ZIP_MAX_BYTES) || 8 * 1024 ** 3`; once exceeded, remaining entries go to `failed` with "not imported — zip expands past the size limit".
  - Deletes `zipPath` and temps in `finally`.

- [ ] **Step 1: Write failing tests** (zip built with the Task 2 test writer, uploaded via HTTP):
  - zip of `b/IMG_10.jpg`, `a/IMG_2.jpg`, `a/IMG_1.jpg`, `b/IMG_1.jpg`, `clip.mov` (fixture), `notes.txt`, `__MACOSX/._x`, `.DS_Store` → `imported` has 5 `uploads/` srcs whose order matches the cleaned basenames sorted by the numeric collator (so `IMG_2` before `IMG_10`, the two `IMG_1.jpg` as `IMG_1.jpg` then `IMG_1-2.jpg`, the video as `clip.mp4`); `skipped` = `['notes.txt']`; junk absent from all lists
  - `../evil.jpg` and `/abs/evil2.jpg` entries land as `uploads/evil.jpg`, `uploads/evil2.jpg`; nothing written outside `data/uploads/`
  - encrypted entry → in `failed`, others still imported
  - `ZIP_MAX_BYTES` small (server started with it in a child for this case, port 4399) → later entries in `failed` with the limit message
  - after each: zip and `.cache/incoming/` contents gone
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS. Test removes its uploads.

### Task 7: Editor UI

**Files:**
- Modify: `editor/index.html` (`accept="image/*,video/*,.zip"`, `<div id="media-report" hidden>` in the drawer)
- Modify: `editor/store.js` (`uploadStreaming`)
- Modify: `editor/media.js` (routing by type, progress tile, report, video badge, `imagesOnly` filter)
- Modify: `editor/editor.js` (`photoStrip`: no Lead button on videos, ▶ badge, "Poster…" control; single-pick callers pass `imagesOnly: true`)
- Modify: `editor/editor.css`
- Test: `videocheck.mjs` section `--- editor ---`

**Interfaces:**
- Produces:
  - `store.uploadStreaming(file: File, endpoint: 'video'|'zip', onEvent: (obj) => void): Promise<object>` — reads the NDJSON body line by line; resolves with the final object; rejects on `{error}` (video) — zip finals always resolve.
  - `media.open({ ..., imagesOnly?: boolean })` — hides videos from the grid; uploads in this mode still import everything but select nothing.
  - Upload routing: `IMAGE_SRC_RE` → existing photo endpoint; `VIDEO_IN_RE` → video; `/\.zip$/i` → zip; else report "unsupported".
  - Gallery mode: every imported src from a zip passed to `opts.onToggle(src, true)` in order; single-pick mode: none.
  - `#media-report`: lists imported / skipped / failed (with reasons); a "Dismiss" button hides it. Replaces `alert()` for zip results.
  - Strip video item: thumbnail `/thumbs/<posterOf(ph, inLibrary)>`, `▶` badge, buttons `Poster…` (opens `media.open({single:true, imagesOnly:true, title:'Poster for …'})`, sets `ph.poster`) and, when `ph.poster` set, `Use frame from video` (sets `''`); no Lead button.
  - The existing "+ Add photos" `onToggle` must not set `feature: true` on a video (use `!isVideo(src) && no feature yet`); likewise the Remove fallback picks the first non-video.

- [ ] **Step 1: Write failing tests** (Chromium on the editor): after uploading the fixture through `#media-upload` with the drawer opened from the first project's "+ Add photos", the strip gains an item with `.play-badge` and no "Lead" button; `Poster…` → pick a library photo → data's `poster` equals it and the strip thumb URL changes; `Use frame from video` clears it; a zip upload shows `#media-report` listing `notes.txt` as skipped; profile photo picker (single mode) shows no video tiles. Never saves; restores data.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS; `node verify.mjs` still passes.

### Task 8: Start scripts and docs

**Files:**
- Modify: `start-editor.sh`, `start-editor.ps1`
- Modify: `Development.md`, `CLAUDE.md`, `README.md` (one line under adding photos: videos + zips)
- Modify: `package.json` (`check` adds `node zipcheck.mjs` after modelcheck and `node videocheck.mjs` at the end)
- Test: `videocheck.mjs` section `--- start script ---`

**Interfaces:**
- `start-editor.sh [--no-ffmpeg] [--no-browser]`; `start-editor.ps1 [-NoFfmpeg] [-NoBrowser]`. Check = `"${FFMPEG_PATH:-ffmpeg}" -version` and same for ffprobe; failure prints install lines for Debian (`sudo apt install ffmpeg`) and Windows (`winget install Gyan.FFmpeg`) and the bypass flag, exit 1. `--no-browser` (added so the test doesn't launch Firefox) skips `open_firefox`. Also fix the stale "need 20+" to "22.12+".

- [ ] **Step 1: Write failing tests:** `FFMPEG_PATH=/nonexistent PORT=4398 bash start-editor.sh --no-browser` exits 1 within 5 s with output containing `apt install ffmpeg`; with `--no-ffmpeg --no-browser` it serves `http://127.0.0.1:4398/editor/` (then kill it). The ps1 is reviewed by reading only (no pwsh here) — note in the summary.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement + docs. **Step 4:** run every suite individually (the `&&` chain stops at the first failure; preview built first) → only the 4 known pre-existing failures; `git checkout -- docs/` afterwards.
