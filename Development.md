# Development

How to run the editor, build the outputs, and check nothing is broken.

For what the portfolio *is* and how to write in it, see [README.md](README.md).

---

## Requirements

| | |
|---|---|
| **Node** | 20 or newer (`node --version`) |
| **Chromium** | only for PDF export — `sudo apt install chromium` |
| **Everything else** | three npm packages, no build step, no framework |

There is no bundler, transpiler or watch process. The editor is plain ES modules
served straight off disk, so a change to a file under `editor/` or `shared/` is
live on the next browser reload.

---

## First run

```bash
npm ci          # NOT npm install — see "Dependencies" below
npm start
```

Then open **http://127.0.0.1:4321/editor/**

`npm start` prints the URL, the media library path and the data file path. The
server binds to loopback only; nothing is exposed to the network. To use a
different port:

```bash
PORT=8080 npm start
```

The server has no watch mode — it serves files as they are on disk. Editing
server-side code (`server.js`, `shared/`, `export/`) needs a restart; editing
browser-side code (`editor/`, `shared/styles/`) just needs a page reload.

---

## Commands

| Command | What it does |
|---|---|
| `npm start` | Run the editor at http://127.0.0.1:4321/editor/ |
| `npm run build` | PDF then site — the order matters, the site embeds the PDF |
| `npm run build:site` | Publish `docs/` (published projects only) |
| `npm run build:pdf` | Build `out/portfolio.pdf` |
| `npm run preview:site` | Build `preview/` **including drafts**, for local review |
| `npm run seed` | Create projects from the photo library (first-time bootstrap) |
| `npm run check` | Run all six test suites |
| `npm run vendor` | Refresh `vendor/paged.polyfill.js` from node_modules |

### Flags worth knowing

```bash
node scripts/seed.js --dry          # report the grouping, write nothing
node scripts/seed.js --force        # overwrite an existing portfolio.json (backs it up first)
node export/build-site.js --drafts  # same as npm run preview:site
node export/build-pdf.js --html-only # write the paginated HTML, skip Chromium
```

---

## The editor

Three panes: the section list on the left, the form in the middle, the live
preview on the right. The preview is rendered by the same `shared/render.js`
templates the exporters use, so it cannot drift from what ships.

**Sections** are the four tabs at the top of the sidebar:

| Tab | Edits | Appears as |
|---|---|---|
| **Work** | the page's own **intro text** (pinned at the top of the list), then projects — title, summary, specs, writeup, photos | the site's index + one page each, and the PDF body |
| **Testimonials** | quote, attribution, optional scan of the note | `testimonials.html` and the PDF's testimonials section |
| **Profile** | name, tagline, contact, About text, **photo**, links, skills | `about.html` and the PDF's About page |
| **Settings** | site title, accent colour, paper size, cover photo | everywhere |

**Toolbar toggles**

- **Screen / Print** — website rendering, or the real paginated PDF via Paged.js
- **Editing / Gallery / About** — which page the preview shows

Links inside the preview navigate, and clicking a project card selects it in
the sidebar.

**Saving is manual.** Nothing is written until **Save** or `Ctrl+S`, including
with the preview focused (the shortcut is forwarded out of the iframe). Pending
edits show an orange Save button and a dot in the tab title, and leaving the
page raises a confirmation.

| Shortcut | |
|---|---|
| `Ctrl+S` | Save |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo (80 steps) |
| `Ctrl+B` `Ctrl+I` `Ctrl+K` | Bold, italic, link |

---

## Outputs

| Folder | Built by | Committed | Contains |
|---|---|---|---|
| `docs/` | `build:site` | **yes** | the published site + `portfolio.pdf`, served by GitHub Pages |
| `preview/` | `preview:site` | no | the same site **including drafts**, banner-marked "not for sending" |
| `out/` | `build:pdf` | no | `portfolio.pdf` plus the intermediate print document |
| `.cache/` | both | no | resized image derivatives |

`docs/` is the Pages source: set **Settings → Pages → Deploy from a branch →
main → /docs**. It carries a `.nojekyll` so Pages serves the files verbatim.

**Host control files survive the build.** `build:site` wipes the output folder,
which would otherwise delete files it did not generate — most importantly
`CNAME`, which GitHub writes into `docs/` when you set a custom domain in its
UI, and whose loss silently unpoints the domain. These are moved aside and put
back on every build:

    CNAME   robots.txt   _headers   _redirects   .well-known/
    google<token>.html   BingSiteAuth.xml

Anything in an optional **`public/`** directory is also copied verbatim into the
published folder, and takes precedence. That is the better home for files you
add deliberately, since it is version-controlled and independent of whatever
happens to survive in `docs/`.

Only **published** projects reach `docs/` and the PDF. Drafts are skipped
everywhere except `preview/`, so a half-written entry cannot end up in
something you send.

### Serving a build locally

The dev server exposes the build folders, so you can check them without a
separate static server:

- http://127.0.0.1:4321/docs/index.html
- http://127.0.0.1:4321/preview/index.html
- http://127.0.0.1:4321/out/portfolio.pdf

`docs/` also works opened straight from `file://` — every path in it is
relative, so the folder can be handed over on a USB stick.

---

## Tests

```bash
npm start        # in one terminal — four of the six suites drive the real editor
npm run check    # in another
```

| Suite | Checks | Needs the server | Covers |
|---|---|---|---|
| `modelcheck.mjs` | 70 | no | sanitiser, paragraph handling, slugs, export filenames, render edge cases |
| `verify.mjs` | 17 | yes | editing, merge, undo, both exports, TOC page numbers |
| `navcheck.mjs` | 12 | yes | preview navigation, the draft preview |
| `savecheck.mjs` | 10 | yes | manual saving, the unsaved-changes guard |
| `widthcheck.mjs` | 10 | yes | text and photo columns stay aligned, mobile |
| `pagescheck.mjs` | 20 | no | `docs/` served as a Pages root: links resolve, no 404s, PDF fetchable |
| `nbspcheck.mjs` | 8 | yes | typing in the real editor produces clean markup, stable across saves |
| `aboutcheck.mjs` | 25 | yes | the About photo through preview/save/export; picker thumbnail geometry |
| `workcheck.mjs` | 13 | yes | the Work intro is separate from the About text, and lands above the gallery |

**185 checks in total.** They drive a real headless Chromium against the real
server, and each restores `data/portfolio.json` when it finishes — safe to run
on real work. `verify.mjs` rebuilds `docs/` from the restored data rather than
leaving a test build behind.

Run one on its own with `node widthcheck.mjs`.

A suite may report `SKIP` for a page that has nothing to show yet — with no
testimonials written, there is no `testimonials.html` to lay out. That is
expected, not a failure.

---

## Dependencies

Use **`npm ci`**, not `npm install`. It installs strictly from
`package-lock.json` and fails if the lockfile and `package.json` disagree.

`.npmrc` sets:

```ini
ignore-scripts=true    # never run package lifecycle scripts on install
save-exact=true        # record exact versions, not caret ranges
```

Lifecycle scripts are the main way a compromised dependency runs code on your
machine, before you have run anything yourself. None of the three dependencies
declares one — `sharp` ships prebuilt binaries as optional dependencies, and
`puppeteer-core` deliberately downloads no browser — so blocking them costs
nothing. All three are pinned to exact versions and the lockfile pins all 78
packages.

`vendor/paged.polyfill.js` is committed, so a clone needs no post-install step
and PDF export works without a network.

---

## Layout

```
media/               the 136 source photos — committed, never modified
data/portfolio.json  everything you write
data/uploads/        testimonial scans and the profile photo
data/backups/        a snapshot per save (last 60), gitignored

shared/render.js     the templates — ONE source of markup for all three outputs
shared/model.js      data shape, normalisation, HTML sanitiser
shared/styles/       tokens.css + site.css (screen) + print.css (paged)

server.js            local API, media library, cached thumbnails
editor/              the WYSIWYG — plain ES modules, no build step
export/              build-site.js, build-pdf.js, images.js
scripts/seed.js      one-time photo-to-drafts bootstrap
vendor/              paged.polyfill.js, committed for offline PDF export
```

The structural rule: **`shared/render.js` is the only place markup is written.**
The editor preview, the site builder and the PDF builder all import the same
functions and differ only in a small `ctx` that resolves URLs for their target.
Change markup there and all three follow.

Nothing reads or writes outside this directory.

---

## API

The editor talks to the server over a small JSON API. Useful for scripting.

| Route | |
|---|---|
| `GET/PUT /api/portfolio` | load / save the whole document |
| `GET /api/media` | list the photo library |
| `POST /api/media/upload?name=…` | upload a scan or photo (raw body) |
| `POST /api/export/site` \| `/api/export/pdf` \| `/api/preview/site` | run a builder, streaming its output |
| `GET /media/…` `/thumbs/…` | originals, and 400px cached thumbnails |
| `GET /docs/…` `/preview/…` `/out/…` | the build folders |

```bash
curl -s localhost:4321/api/portfolio | node -e "…"     # inspect
curl -X POST localhost:4321/api/export/pdf             # build, streaming
```

---

## Troubleshooting

**PDF export says no Chromium found.**
`sudo apt install chromium`, or point at one you have:
`CHROME_PATH=/path/to/chrome npm run build:pdf`. Until then,
`node export/build-pdf.js --html-only` writes the fully paginated document to
`out/print/index.html` — open it in any browser and use Print → Save as PDF.
The table of contents already has its real page numbers.

**Port 4321 in use.** `PORT=8080 npm start`.

**The editor shows stale styling or behaviour.** Browser-side files are served
with `Cache-Control: no-cache`, so an ordinary reload picks up changes to
anything under `editor/` or `shared/`. If something still looks stale, a hard
reload (`Ctrl+Shift+R`) forces it. Server-side changes need `npm start` again.

**Photos look wrong or a new one is missing.** Drop it in `media/` — the picker
lists the folder on load, so reopen the editor. To force every derivative to be
rebuilt: `rm -rf .cache` (it is only a cache; the next build regenerates it).

**Exports look out of date.** The builders read `data/portfolio.json` from disk,
not the editor's in-memory state. Save first — the export buttons prompt if
there are unsaved changes.

The PDF is built separately from the site, so it can lag behind your writing;
`build:site` warns when the `portfolio.pdf` it is copying into `docs/` is older
than the data file. `npm run build` does both in the right order.

**Something went wrong in the data file.** `data/backups/` holds a snapshot from
before every save, newest last. Copy one over `data/portfolio.json` and restart
the server.

**Starting the content over.** `node scripts/seed.js --force` rebuilds the draft
list from `media/`, backing up the existing file first. This discards writeups,
so check `data/backups/` afterwards if that was not the intent.

**A PDF build hangs.** Paged.js pagination stalls if an image cannot settle —
historically `loading="lazy"`, which is why the print path never emits it. If it
recurs, `node export/build-pdf.js --html-only` and open the result in a browser;
the layout problem is visible there.
