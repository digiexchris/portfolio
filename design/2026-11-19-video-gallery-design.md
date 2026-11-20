# Video in project galleries, and zip import — design

Status: proposed, 2026-11-19. Not in `docs/` on purpose: that folder is the
published site and `build:site` wipes it.

## Intent

Let a project's gallery hold a few short videos alongside its photos, for
things a still can't show (a machine running, a part moving). The site must
stay fast: a visitor who never presses play should pay almost nothing for a
video being there.

## Goals

- Up to ~10 videos across the whole site, typically a minute or less (not
  enforced; see Decided).
- Upload from the editor's media drawer, exactly like a photo. The editor
  converts the file and keeps **only** the converted version; the original
  is deleted once conversion succeeds.
- Videos open in the existing lightbox, like photos, so they're big enough
  to see. The lightbox plays them with the native HTML5 player
  (`<video controls>`); no player library.
- Nothing of the video downloads until it's opened.
- Upload a `.zip` of photos and videos in the same drawer; each file inside
  is unpacked and imported as if uploaded on its own.

## Non-goals

- Streaming (HLS/DASH), multiple resolutions, subtitles.
- Archive formats other than `.zip` (no `.7z`, `.rar`, `.tar`).
- Third-party hosting (YouTube, Vimeo).
- Trimming or editing in the editor. Trim before uploading.
- Keeping originals, or re-encoding later at a different quality. Changing
  quality means re-uploading from the source device.
- HDR. HDR phone clips are converted to 8-bit SDR; tone-mapping is not
  attempted (colours may look slightly flat on such clips — accepted).

## Anti-goals (would count as failure even if it "works")

- Any video bytes fetched on page load.
- A video becoming a project's lead photo, card thumbnail or social image.
- Original phone files ending up committed, or any file over GitHub's
  100 MB limit.
- Markup for video written anywhere other than `shared/render.js`.

## Decided

- **Approach:** the gallery shows the video's poster as an ordinary photo
  tile with a ▶ badge; clicking opens the lightbox, which plays it in a native
  `<video>`. The file is committed in-repo. Chosen over YouTube/Vimeo embeds
  (third-party, tracking, off-site) and over a JS player (weight, no benefit
  here). Because the tile is a normal lazy, responsive `<img>`, a video costs
  the page no more than a photo does.
- **No length limit.** Clip length is the author's call; only the converted
  file size is capped (50 MB).
- **Poster:** a photo the author chooses. If none is chosen, the frame from
  about 1 s in, generated at upload.
- **The start scripts refuse to start without `ffmpeg`**, unless a bypass
  argument is given.
- **Conversion happens at upload**, in the editor server, using the system
  `ffmpeg` (not an npm package — `ffmpeg-static` needs install scripts,
  which `.npmrc` blocks). Same pattern as Chromium/Edge for the PDF.
- **Videos are never eligible as the feature (lead) photo.**
- **Quality:** a balance of quality and size. *Builder's note — my call:*
  1080p cap, H.264 CRF 26, which lands around 12–15 MB per minute.
- **Zip import** uses a small zip reader written in the project on top of
  Node's built-in `zlib`. Chosen over an npm package such as `yauzl` (would
  be the first new dependency) and over the system `tar`/`unzip` (a second
  required tool that differs between Windows and Linux).

## Repo-size note

The converted file is stored at `data/uploads/<name>.mp4` (committed) and the
build copies it **byte-for-byte** into `docs/video/`. Git stores identical
content once, so each video costs its size once, not twice. This only holds
if the build copies rather than re-encodes — keep it that way.

## Design

### 1. Conversion (server.js)

New endpoint `POST /api/media/upload-video?name=<file>`.

1. Accept common video extensions (`mp4 mov m4v webm mkv avi`), case
   insensitive. Reject with a clear message if `ffmpeg`/`ffprobe` are not
   found. Locate them via `FFMPEG_PATH` / `FFPROBE_PATH` env vars, else `PATH`
   (mirrors `CHROME_PATH`).
2. **Stream** the request body to `.cache/incoming/<random>` (gitignored).
   Do not use `readBody` — it buffers the whole file in memory. Cap input at
   2 GB.
3. `ffprobe` the input; reject if it has no video stream. No duration limit.
4. Convert:
   ```
   ffmpeg -i IN -map 0:v:0 -map 0:a:0? \
     -vf "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p" \
     -c:v libx264 -preset slow -crf 26 -profile:v high \
     -c:a aac -b:a 96k -ac 2 \
     -movflags +faststart -map_metadata -1 \
     -progress pipe:1 -nostats -y OUT.tmp.mp4
   ```
   The scale filter caps the *box* at 1920×1080, so portrait clips cap at
   1080×1920. ffmpeg applies rotation metadata automatically.
   `-map_metadata -1` strips location and device metadata from phone clips.
5. Auto poster: `ffmpeg -ss 1 -i OUT.tmp.mp4 -frames:v 1 -q:v 3 POSTER.jpg`
   (use `-ss 0` if the clip is shorter than 1 s). Always generated, even if
   the author later chooses a photo: it's the fallback, and its dimensions
   are the video's own, which the renderer needs.
6. If the output is over **50 MB**, delete it and fail with "too large —
   trim it and re-upload". Otherwise rename into place as
   `data/uploads/<clean-name>.mp4` + `data/uploads/<clean-name>.poster.jpg`,
   using the same clash-avoidance (`-2`, `-3`, …) the photo upload uses, applied
   to the pair.
7. Always delete the incoming original and any temp file, on success or
   failure.
8. Response: streamed NDJSON, one line per update —
   `{"progress":0.42}` … then `{"src":"uploads/x.mp4"}` or `{"error":"…"}`.
   Progress = `out_time_ms` from `-progress` ÷ probed duration.
9. One conversion at a time; a second request waits.

Also in `server.js`:

- `MIME`: add `.mp4 → video/mp4`.
- `serveFile`: support `Range` requests (206 + `Content-Range` +
  `Accept-Ranges: bytes`). Without it Chromium cannot seek in the editor
  preview.
- `listMedia`: return videos with `kind: 'video'` and their poster; hide
  `*.poster.jpg` files from the list.
- `/thumbs/<video>`: serve the thumbnail generated from its poster.

### 1a. Zip import (server.js + a new zip reader module)

New endpoint `POST /api/media/upload-zip?name=<file>.zip`, streaming the same
NDJSON progress format as the video endpoint.

**Zip reader** (e.g. `server/zip.js`, no dependencies):

- Read the End of Central Directory record, then the central directory, from
  the file on disk (a zip's index is at the end, so the whole upload must land
  first; stream it to `.cache/incoming/` like a video).
- Support ZIP64 (zips over 4 GB or 65,535 entries — a few raw phone videos
  get there), stored (method 0) and deflate (method 8) entries, via
  `zlib.createInflateRaw()` streamed straight to a temp file. Verify CRC-32
  and size per entry.
- Refuse encrypted entries (general-purpose flag bit 0) and other
  compression methods; those entries are reported as failed, not fatal.
- File names: UTF-8 when flag bit 11 is set, otherwise CP437 (decode it;
  matters for zips from Windows).
- Expose something like `entries()` → `{name, size, open()}`; no extraction
  to arbitrary paths ever happens.

**Import, per entry, in natural name order** (`IMG_2` before `IMG_10`):

1. Skip directories and junk silently: `__MACOSX/…`, `._*`, `.DS_Store`,
   `Thumbs.db`, `desktop.ini`, and any name starting with `.`.
2. Use only the entry's basename, cleaned the same way as single uploads.
   Folder structure is flattened. Path components are discarded, so
   `../`, absolute paths and drive letters can never escape `data/uploads/`.
3. Photos (`IMAGE_RE`): extract to `data/uploads/` with the usual `-2`, `-3`
   clash handling — the same result as uploading that photo alone.
4. Videos: extract to `.cache/incoming/`, then run the exact same
   conversion pipeline as §1 (50 MB cap, auto poster, original deleted).
   Factor §1 so both endpoints call one function.
5. Anything else: skipped and listed.
6. One entry failing never stops the rest.

**Limits:** stop unpacking (remaining entries reported as not imported) once
total uncompressed output passes **8 GB**, or if any entry's actual size
exceeds what the directory claims. The zip itself and every temp file are
deleted at the end, on success, failure or a dropped connection.

**Progress and result:** a line per entry as it starts
(`{"entry":"clip3.mov","index":4,"total":17}`), video conversion progress as
in §1, and a final summary:
`{"imported":[…srcs],"skipped":[…names],"failed":[{"name":…,"error":…}]}`.

### 2. Data model (shared/model.js)

- Videos live in `project.photos[]` like any photo:
  `{ src: 'uploads/x.mp4', caption, alt, feature, pdf, poster }`.
- `poster` is optional: the `src` of any image in the media library (it
  need not be in this project's gallery). Empty means use the auto poster.
  `normalise` keeps it only on videos, and only if it names an image.
- Add `isVideo(src)` (extension `.mp4`), `autoPosterOf(src)` (swap to
  `.poster.jpg`) and `posterOf(item)` → `item.poster || autoPosterOf(src)`.
- `normalise`: force `feature: false` for videos; default `pdf: false`
  for videos (explicit `true` keeps it).
- `featurePhoto`: skip videos in both the explicit match and the
  `photos[0]` fallback. A project with only videos has no feature photo,
  a case the renderer already handles.

### 3. Rendering (shared/render.js)

`photoFigure` branches on `isVideo`. A video renders as its poster, built
exactly like a photo's `<img>` (srcset, lazy loading, dimensions), wrapped
in a lightbox link that points at the MP4:

```html
<figure class="photo video" data-index="…">
  <a class="photo-link" href="…/x.mp4" data-lightbox data-video
     aria-label="Play video: alt or caption">
    <img src="…poster…" srcset="…" loading="lazy" …>
    <span class="play-badge" aria-hidden="true">▶</span>
  </a>
  <figcaption>…</figcaption>
</figure>
```

- Without JavaScript the link opens the MP4 directly and the browser plays
  it, so nothing breaks.
- `ctx` gains `video(src)` → URL of the MP4; the poster goes through the
  existing `ctx.img` / `ctx.imgSet` using `posterOf(item)`.
- A chosen poster can have a different shape from the video. The tile uses
  the poster's own dimensions, as any photo would; in the lightbox the
  `<video>` is sized by the video itself.

### 3a. Lightbox (site.js, generated in export/build-site.js)

- The lightbox gains a `<video id="lb-video" controls playsinline>`
  alongside `#lb-img`; one of the two is shown at a time.
- `show(i)`: for a `data-video` link, hide the image, set the video's `src`
  to the link's `href` and `poster` to the tile's image, and `play()`. The
  click is a user gesture, so playback with sound is allowed; if `play()` is
  refused anyway, the controls are there.
- Leaving a video (close, prev/next, Escape) pauses it, removes its `src`
  and calls `load()`, so it stops downloading.
- Prev/next and arrow keys cycle through photos and videos together, in
  gallery order. Arrow keys still navigate while the video has focus; space
  and the other player keys stay with the player.
- `site.css`: `.play-badge` centred over the tile; `#lb-video` sized like
  `#lb-img` (fits the viewport, keeps aspect ratio).
- Print (`ctx.photoLinks === false`): render the poster `<img>` (the chosen
  one if set) plus a
  `<p class="video-note">▶ Video — watch online</p>`, linked to
  `projectUrl` when a site URL is known.
- `morePhotosNote` counts videos too ("2 more photos and 1 video of this
  project are online").
- `print.css`: style `.video-note`.

### 4. Site build (export/build-site.js)

- Collect video sources separately from photos. Copy each MP4 unchanged to
  `docs/video/<stem>.mp4` (use `buildStemMap` over the video set), referenced
  with the usual `?v=<hash>` cache-buster.
- Add each video's poster (`posterOf(item)`) to the photo `wanted` set, so
  it gets normal derivatives in `docs/img/`. An auto poster that isn't used
  doesn't ship.
- The editor preview context maps `video(src)` to `/media/<src>`.

### 5. PDF (export/build-pdf.js)

No special handling beyond the render branch: videos default to
`pdf: false`, and an opted-in one prints as poster + note. The PDF context
already turns lazy loading off.

### 6. Editor UI

- Media drawer: the upload input accepts `image/*,video/*,.zip`; video files
  and zips go to their endpoints, with a progress bar on a placeholder tile
  until done (for a zip: "4 of 17 — clip3.mov", then that video's
  conversion). Error messages from the server are shown in place.
- Zip results follow the existing upload rule (`editor/media.js`): when the
  drawer was opened for a project's gallery, every imported item is added to
  that gallery, in zip order. In single-pick modes (poster, profile photo,
  testimonial image) items go into the library only and nothing is picked.
- After a zip finishes, show its summary (imported / skipped / failed with
  reasons) in the drawer until dismissed, not in an `alert()`.
- Video tiles show the poster thumbnail with a ▶ badge.
- Photo strip: no "feature" star for videos; the "in PDF" toggle works as
  for photos. Video items show their current poster with a ▶ badge.
- Each video item in the strip gets a "Poster…" control. It opens the media
  drawer in a pick mode that lists images only; picking one sets `poster`.
  A "Use frame from video" option clears it back to the auto poster.
- Profile photo and testimonial image pickers exclude videos.

### 7. Docs and setup

- `Development.md` + `CLAUDE.md`: `ffmpeg` is required for video uploads
  (Windows: `winget install Gyan.FFmpeg`; Debian: `apt install ffmpeg`), and
  `FFMPEG_PATH`/`FFPROBE_PATH` overrides.
- `start-editor.sh` / `.ps1`: **fail** with install instructions if
  `ffmpeg` or `ffprobe` is missing (respecting `FFMPEG_PATH` /
  `FFPROBE_PATH`), unless started with `--no-ffmpeg` (sh) / `-NoFfmpeg`
  (ps1). With the bypass the editor runs normally and only video uploads
  fail, with the server's own message. `npm start` itself does not check.

### 8. Tests — new `videocheck.mjs`, added to `npm run check`

- **Fixture:** if `ffmpeg` exists, generate a 3 s clip with
  `-f lavfi -i testsrc=size=1280x720:rate=30` plus a sine tone; otherwise
  `SKIP` the upload tests (the pattern used elsewhere for empty sections).
- Upload converts to MP4 + poster, deletes the incoming file, rejects a
  non-video, and reports progress.
- Range request on `/media/` returns 206 with the right bytes.
- Model: a video is never `featurePhoto`, even as `photos[0]` or with
  `feature: true` in the data.
- Built site: loading a page with a video in headless Chromium makes **no**
  `.mp4` request. Clicking the tile opens the lightbox and plays the video;
  closing it stops the download. Prev/next moves between a photo and a
  video. A chosen poster appears on the tile; with none chosen, the auto poster does.
- No-JS fallback: the tile's link `href` is the MP4.
- Zip reader unit tests (in `modelcheck.mjs` style, no browser), on zips
  generated in the test: stored and deflate entries; a ZIP64 archive; CP437
  and UTF-8 names; a bad CRC; an encrypted entry (rejected); `../evil.jpg`
  and absolute names (land as `evil.jpg` in `data/uploads/`); junk entries
  skipped.
- Zip import end to end: a zip with 2 photos, the generated test clip, a
  `.txt` and a `__MACOSX/` entry imports 2 photos + 1 converted video, lists
  the `.txt` as skipped, ignores `__MACOSX/` silently, adds the items to the open
  project's gallery in name order, and leaves no zip or temp files behind.
- Size limit: a zip whose entries expand past the limit stops cleanly (test
  with the limit lowered via an env var, e.g. `ZIP_MAX_BYTES`).
- Start scripts: exit non-zero when `ffmpeg` is missing, and start with
  `--no-ffmpeg` (test by pointing `FFMPEG_PATH` at a missing file).
- PDF: a video is absent by default; when opted in, it prints the poster and note.
- Restore `data/portfolio.json` and delete test uploads afterwards.

## Left to the builder

- Exact UI styling of the progress tile, zip summary and ▶ badge.
- How test zips are generated (a tiny writer in the test, using `zlib`, is
  fine).
- Internal module layout (e.g. a `server/video.js` helper).
- Whether a hung `ffmpeg` gets a timeout (suggested: 10 min).

## Risks

- Encoding a 1080p minute at `-preset slow` can take a minute or two on a
  modest machine. Progress reporting covers it; `medium` is the fallback if
  it's painful.
- Deleting a photo from the media library that a video uses as its poster
  would leave a dangling `poster`. `posterOf` should fall back to the auto
  poster when the chosen file no longer exists (build and editor both).
