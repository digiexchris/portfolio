// One-time bootstrap: group the photo library by filename family and create a
// draft project for each, with its photos already attached in order.
//
//   node scripts/seed.js            create data/portfolio.json
//   node scripts/seed.js --force    overwrite an existing file
//   node scripts/seed.js --dry      report the grouping, write nothing

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyPortfolio, emptyProject, normalise, slugify } from '../shared/model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA_ROOT = path.join(ROOT, 'media');
const DATA_FILE = path.join(ROOT, 'data', 'portfolio.json');
const IMAGE_RE = /\.(jpe?g|png|webp)$/i;

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');
const FORCE = args.has('--force');

// Words that title-casing would otherwise mangle. Model numbers and marques
// carry meaning to anyone reading a mechanical portfolio, so they keep their
// real casing.
const NAME_OVERRIDES = {
  '1cu': '1cu', '2_cyl_rc': '2-Cylinder RC', '2in': '2in', '2_stroke': 'Two-Stroke',
  '3rd_scale': 'Third-Scale', '66_triumph': "'66 Triumph",
  at: 'AT', cb: 'CB', cb450x: 'CB450X', cb650: 'CB650', cr450: 'CR450', cr650: 'CR650',
  klr: 'KLR', klr650: 'KLR650', tw200: 'TW200', t7: 'T7', iltis: 'Iltis',
  rc: 'RC', nasa: 'NASA', yak54: 'Yak 54', mc: 'MC', tir: 'TIR',
};

const titleCase = (stem) =>
  stem
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => NAME_OVERRIDES[w.toLowerCase()] ?? (w[0].toUpperCase() + w.slice(1)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

// Strip the extension, then a trailing sequence number, to get the family key.
// beaver_head_12.jpg -> beaver_head ; tw200_hub_tank_rack.jpg -> tw200_hub_tank_rack
function familyOf(file) {
  const stem = file.replace(IMAGE_RE, '');
  return stem.replace(/[_-]?\d+$/, '') || stem;
}

// Sort within a family: the bare name first, then _2, _3, ... numerically.
function seqOf(file) {
  const stem = file.replace(IMAGE_RE, '');
  const m = stem.match(/[_-](\d+)$/);
  return m ? Number(m[1]) : 0;
}

async function main() {
  const all = (await fs.readdir(MEDIA_ROOT, { withFileTypes: true }))
    .filter((e) => e.isFile() && IMAGE_RE.test(e.name) && !e.name.startsWith('.'))
    .map((e) => e.name);

  if (!all.length) {
    console.error(`No images found in ${MEDIA_ROOT}`);
    process.exit(1);
  }

  const families = new Map();
  for (const file of all) {
    const key = familyOf(file);
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(file);
  }

  const keys = [...families.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const projects = keys.map((key, i) => {
    const files = families.get(key).sort((a, b) => seqOf(a) - seqOf(b) || a.localeCompare(b));
    return emptyProject({
      title: titleCase(key),
      slug: slugify(titleCase(key)),
      order: i,
      published: false,
      photos: files.map((f, j) => ({ src: f, caption: '', alt: '', feature: j === 0 })),
    });
  });

  // Every source photo must land in exactly one project, or the grouping rule
  // has a hole in it and photos would silently go missing from the portfolio.
  const assigned = projects.flatMap((p) => p.photos.map((ph) => ph.src));
  const orphans = all.filter((f) => !assigned.includes(f));
  const dupes = assigned.filter((f, i) => assigned.indexOf(f) !== i);

  console.log(`Photos found:     ${all.length}`);
  console.log(`Projects created: ${projects.length}`);
  console.log(`Photos assigned:  ${assigned.length}`);
  console.log(`Orphans:          ${orphans.length}${orphans.length ? ' -> ' + orphans.join(', ') : ''}`);
  console.log(`Duplicates:       ${dupes.length}${dupes.length ? ' -> ' + dupes.join(', ') : ''}`);

  const multi = projects.filter((p) => p.photos.length > 1).length;
  console.log(`Multi-photo:      ${multi}   Single-photo: ${projects.length - multi}\n`);

  if (DRY) {
    for (const p of projects) console.log(`  ${String(p.photos.length).padStart(2)}  ${p.title}`);
    reportMergeCandidates(keys);
    console.log('\nDry run: nothing written.');
    return;
  }
  if (orphans.length || dupes.length) {
    console.error('Refusing to write: grouping did not account for every photo exactly once.');
    process.exit(1);
  }

  let existing = null;
  try { existing = JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); } catch { /* none yet */ }
  if (existing && !FORCE) {
    console.error(`${DATA_FILE} already exists. Re-run with --force to overwrite (a backup is kept).`);
    process.exit(1);
  }
  if (existing) {
    const backup = DATA_FILE.replace(/\.json$/, `.pre-seed-${Date.now()}.json`);
    await fs.writeFile(backup, JSON.stringify(existing, null, 2));
    console.log(`Existing data backed up to ${path.basename(backup)}`);
  }

  const data = normalise({
    ...emptyPortfolio(),
    profile: {
      name: '', tagline: 'Machinist and mechanic', location: '', email: '', phone: '',
      links: [], summary: '', photo: '',
    },
    settings: { siteTitle: 'Portfolio', accent: '#b4531f',
                pdf: { paper: 'Letter', includeTestimonials: true, coverPhoto: '' } },
    projects,
  });

  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
  console.log(`Wrote ${DATA_FILE}`);
  console.log('All projects start as drafts. Publish each one as you finish its writeup.');
}

// Families sharing a leading token are often one job photographed in stages
// (1cu_crank, 1cu_piston, 1cu_assembled). The seeder will not merge them
// automatically -- only the person who did the work knows which were separate
// jobs -- but it points them out so they can be merged in the editor.
function reportMergeCandidates(keys) {
  const byPrefix = new Map();
  for (const k of keys) {
    const first = k.split(/[_-]/)[0];
    if (!byPrefix.has(first)) byPrefix.set(first, []);
    byPrefix.get(first).push(k);
  }
  const candidates = [...byPrefix.entries()].filter(([, v]) => v.length > 1);
  if (!candidates.length) return;
  console.log(`\nPossible merges (${candidates.length} groups) -- combine these in the editor if they were one job:`);
  for (const [prefix, group] of candidates) {
    console.log(`  ${prefix}: ${group.join(', ')}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
