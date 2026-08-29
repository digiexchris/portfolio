# Portfolio

A local WYSIWYG editor for a mechanical work portfolio, with two exports:
a **static HTML site** and a **PDF with a table of contents**.

Everything lives in this one folder — the app, the 136 source photos, and your
writing — so the repository can be cloned anywhere and work immediately with
nothing missing. Nothing outside this directory is ever read or written.

---

## Running it

```bash
npm ci               # once
npm start            # then open http://127.0.0.1:4321/editor/
```

For the full command reference, test suites, API and troubleshooting, see
[Development.md](Development.md).

The server binds to loopback only — nothing is exposed to the network.

---

## Writing

Everything you type is stored in `data/portfolio.json`. Every save first
snapshots the previous version into `data/backups/`, then writes atomically,
so an interrupted save can never truncate your work.

**The list on the left** holds your projects. `scripts/seed.js` has already
created one per photo family, with the photos attached — 81 drafts, 136
photos, nothing missing.

**Everything starts as a draft.** Exports skip drafts entirely, so a
half-written entry can never end up in a PDF you send to an employer. Tick
*Published* on a project when its writeup is done.

### The two editing modes

| Mode | What it is | Best for |
|---|---|---|
| **Split** | Fields on the left, the real rendered page on the right | Getting through many entries quickly |
| **Inline** | The preview itself becomes editable — click any heading or paragraph and type in place, drag photos around on the page | Final polish and layout |

Both modes drive the same document, and the rich-text editor is literally the
same component mounted in two places. Toggle with the buttons at the top or
`Ctrl+E`.

**The Page control** decides what the preview shows: *Editing* follows the
selected project, *Gallery* shows the site's front page, *About* the about
page. Links inside the preview work — clicking a project card opens it and
selects it in the sidebar, so you can browse the site the way a reader would
without leaving the editor. (In inline mode clicking text edits it instead,
since that is the point of inline mode.)

The **Screen / Print** toggle switches the preview between the website
rendering and the actual paginated PDF — page boxes, running heads, folios and
all. Inline editing is screen-only, because in print view Paged.js clones
content into page boxes and edits there would have nowhere to map back to.

### Merging projects

The seeder splits deliberately finely: `1cu_crank`, `1cu_piston` and
`1cu_assembled` became three separate drafts, because only you know whether
those were one job or three. To recombine them, tick the checkboxes in the
list and press **Merge** — photos, tags and specs are combined into the first
one. `Ctrl+Z` undoes it.

Running `node scripts/seed.js --dry` prints a list of likely merge candidates
without touching anything.

### Specs

The specs table is what makes a writeup read as trade work rather than a photo
album. It is free-form label/value, so use whatever the job actually turned on:

    Material    12L14 steel
    Tolerance   0.0005 in TIR
    Machines    Denbigh horizontal mill, surface grinder
    Finish      32 Ra

### Testimonials

Each testimonial takes a quote, an attribution, and optionally a **scan or
screenshot of the original note** — a photo of a handwritten card or a
screenshot of an email reads as more genuine than typed text alone. Use the
*Upload…* button in the photo drawer to bring one in. A testimonial can also be
linked to a project, which makes the site and PDF say what it refers to.

### Keyboard

| | |
|---|---|
| `Ctrl+S` | Save (nothing saves on its own) |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+E` | Toggle split / inline |
| `Ctrl+B` `Ctrl+I` `Ctrl+K` | Bold, italic, link |

---

## Exporting

Both buttons are in the top right of the editor, and both are also plain
scripts:

```bash
npm run build:site     # -> dist/
npm run build:pdf      # -> out/portfolio.pdf
npm run build          # both
```

### Previewing before you publish

Exports only ever contain published work, which is not much help while 60-odd
entries are still drafts. **Preview site** builds a local copy that includes
everything and opens it in a new tab:

```bash
npm run preview:site     # -> dist-preview/
```

It lands in `dist-preview/`, not `dist/`, on purpose — every page carries a
"not for sending" banner and every unpublished entry is flagged, so a review
copy full of half-written entries can never be mistaken for the real export.

### The site (`dist/`)

An index with search and tag filtering, one page per project, a testimonials
page and an about page. Photos are resized to 480 / 1200 / 2000 px with
`srcset`, so the exported folder is a fraction of the 120 MB of originals.

**Every path is relative**, so `dist/` works three ways: uploaded to any host,
served from a subdirectory, or opened straight off a USB stick by
double-clicking `dist/index.html`. That last one matters — it is a plausible
way an employer ends up looking at this.

### The PDF (`out/portfolio.pdf`)

Cover, about page, **table of contents with real page numbers**, one section
per project, then testimonials. Running head carries the project title, footer
carries the folio.

The page numbers are the interesting part. Chromium's print engine does not
implement CSS cross-references, so `target-counter()` cannot work from Chrome
alone. [Paged.js](https://pagedjs.org) paginates the document in the DOM first
and resolves every TOC entry to the page its project actually lands on;
Chromium then prints the already-paginated result.

It needs a system Chromium:

```bash
sudo apt install chromium
```

Point at a different browser with `CHROME_PATH=/path/to/chrome`. If none is
found, the builder still writes the fully paginated document and tells you
where it is — open `out/print/index.html` in any browser and use
**Print → Save as PDF**. Same output, one extra click:

```bash
node export/build-pdf.js --html-only
```

Paper size (Letter/A4), whether testimonials are included, and the cover photo
are all under **Settings**.

---

## Checking it still works

```bash
npm start          # in one terminal
npm run check      # in another — runs all five suites
```

`verify.mjs` drives the real editor in a headless Chromium: it types into the
form and checks the preview updates, merges projects and undoes the merge,
switches to inline mode and confirms an on-page edit reaches the saved model,
paginates the print preview, then exports both targets. For the PDF it reads
the generated file back with Ghostscript and confirms **every contents entry's
page number actually lands on that section** — the one thing worth never
trusting a builder's own report about. It restores `data/portfolio.json` and
removes `dist/` and `out/` when it finishes, so it is safe to run on real work.

---

## How it fits together

The one structural idea worth knowing: **`shared/render.js` is the only place
markup is written.** The editor preview, the static site builder and the PDF
builder all import the same template functions and differ only in a small
`ctx` object that resolves URLs for their target. There is no second copy of
the markup anywhere, so the preview cannot drift from what you ship.

```
media/               the 136 source photos — committed, never modified
shared/render.js     the templates — one source of markup for all three outputs
shared/model.js      data shape, normalisation, HTML sanitiser
shared/styles/       tokens.css + site.css (screen) + print.css (paged)
server.js            local API, media library, cached thumbnails
editor/              the WYSIWYG (no build step, plain ES modules)
export/build-site.js -> dist/
export/build-pdf.js  -> out/portfolio.pdf
scripts/seed.js      the one-time photo-to-drafts bootstrap
modelcheck.mjs       unit checks: sanitiser, paragraphs, slugs, drafts
verify.mjs           end-to-end check of the editor and both exports
navcheck.mjs         checks preview navigation and the draft preview
savecheck.mjs        checks manual saving and the unsaved-changes guard
widthcheck.mjs       checks the text and photo columns stay aligned
data/portfolio.json  everything you write
data/backups/        a snapshot per save
.cache/              resized images, reused across builds
```

Anything the rich-text editor produces is run through an allow-list sanitiser
in the browser *and* again on the server before it is stored, because that HTML
gets inlined directly into the exported pages.

`.cache/`, `dist/`, `dist-preview/`, `out/` and `data/backups/` are all
disposable and gitignored — delete any of them and the next build rebuilds what
it needs from `media/` and `data/portfolio.json`, which are the only two things
that actually hold your work.

### Export filenames

Photos are emitted as `img/<name>-<width>.jpg`, keeping the source name so
`dist/` stays readable. Because the extension is dropped, `note.jpg` and
`note.png` would both want `note-1200.jpg`. `buildStemMap` in
`export/images.js` assigns names from the complete source set up front, so a
clash becomes `note-jpg` / `note-png` (and gains a short hash if even the
extension matches, as when an upload shadows an original). Sources are sorted
first, so filenames depend only on which files exist — never on project order —
and stay stable across builds and re-clones.
