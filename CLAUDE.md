# CLAUDE.md

Personal portfolio site for mechanical/trade work. Live at **https://digiex.ca** (GitHub Pages, custom domain).

Full reference: [Development.md](Development.md) (commands, tests, API, troubleshooting). [README.md](README.md) covers writing content — note it still says `dist/` in places; the real publish folder is `docs/`.

## Workflow

1. `npm ci` then `npm start` → local WYSIWYG editor at http://127.0.0.1:4321/editor/ (loopback only). Shortcut: `start-editor.ps1` (Windows) / `start-editor.sh` (Linux) starts the server and opens Firefox.
2. Edit content in the editor; it saves to `data/portfolio.json` (manual save, Ctrl+S; snapshots to `data/backups/`).
3. `npm run build` (PDF first, then site — order matters, the site embeds the PDF) → regenerates `docs/`.
4. Commit and push to `main`. GitHub Pages serves `main` → `/docs`.

Node ≥ 20, plain ES modules, no bundler. Dev machine is Windows; PDF export uses Microsoft Edge on Windows, Chromium on Linux (`CHROME_PATH=...` overrides).

## Hard rules

- **`docs/CNAME` (`digiex.ca`) must survive every build.** `build:site` wipes `docs/` but preserves host control files (CNAME, robots.txt, _headers, _redirects, .well-known/, verification files) and rewrites `.nojekyll`. If touching `export/build-site.js`, keep that behaviour — losing CNAME silently unpoints the domain. Deliberately added host files belong in `public/` (copied verbatim into `docs/`).
- **`shared/render.js` is the only place markup is written.** Editor preview, site builder and PDF builder all share it; don't duplicate templates.
- **Drafts never ship.** Only published projects reach `docs/` and the PDF. `preview/` (built with `--drafts`) is gitignored and must never be committed.
- `docs/` paths must stay relative (site works from `file://` and any subpath).
- Use `npm ci`, not `npm install`; `.npmrc` sets `ignore-scripts` and `save-exact`. Don't add dependencies casually.
- `media/` (source photos) is committed and never modified.
- Nothing reads or writes outside this repo directory.

## Tests

`npm start` in one terminal, `npm run check` in another. Suites drive headless Chromium against the real server and restore `data/portfolio.json` afterwards. `SKIP` for empty sections is expected.
