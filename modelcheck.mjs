// Unit checks for the data model: the HTML sanitiser, paragraph normalisation,
// slugs, and the published/draft split. No browser or server needed.

import {
  sanitiseHtml, slugify, ensureSlugs, toPlainText, normalise,
  publishedProjects, allTags, featurePhoto,
} from './shared/model.js';
import * as M from './shared/model.js';
import { buildStemMap } from './export/images.js';
import { testimonialCard, projectCard, previewCtx } from './shared/render.js';
import * as R from './shared/render.js';

let fail = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)}${JSON.stringify(got)}`
    + (ok ? '' : `\n      want ${JSON.stringify(want)}`));
};

console.log('--- sanitiser: safety ---');
eq('strips event handlers', sanitiseHtml('<p onclick="evil()">hi <b>there</b></p>'), '<p>hi <b>there</b></p>');
eq('drops script and its contents', sanitiseHtml('<script>alert(1)</script><p>ok</p>'), '<p>ok</p>');
eq('drops style and its contents', sanitiseHtml('<style>p{x}</style><p>ok</p>'), '<p>ok</p>');
eq('unclosed script eats the rest', sanitiseHtml('<script>alert(1)'), '');
eq('removes comments', sanitiseHtml('<!-- <script>x</script> --><p>y</p>'), '<p>y</p>');
eq('blocks javascript: urls', sanitiseHtml('<a href="javascript:alert(1)">x</a>'), '<p><a>x</a></p>');
eq('blocks obfuscated js urls', sanitiseHtml('<a href="java\nscript:alert(1)">x</a>'), '<p><a>x</a></p>');
eq('blocks data: urls', sanitiseHtml('<a href="data:text/html,x">x</a>'), '<p><a>x</a></p>');
eq('keeps http urls', sanitiseHtml('<a href="https://a.co" target="_blank">x</a>'),
  '<p><a href="https://a.co">x</a></p>');
eq('keeps mailto urls', sanitiseHtml('<a href="mailto:a@b.c">x</a>'), '<p><a href="mailto:a@b.c">x</a></p>');
eq('img is not allowed', sanitiseHtml('<img src=x onerror=alert(1)>'), '');
eq('closes unclosed tags', sanitiseHtml('<p>unclosed <b>bold'), '<p>unclosed <b>bold</b></p>');
eq('ignores stray close tags', sanitiseHtml('</p></b>stray'), '<p>stray</p>');

console.log('\n--- sanitiser: machining text ---');
// Writeups are full of tolerances. A bare '<' must survive as text.
eq('bare angle brackets escape', sanitiseHtml('a < b and 5 > 3'), '<p>a &lt; b and 5 &gt; 3</p>');
eq('tolerance survives', sanitiseHtml('held < 0.001" over 14 in'), '<p>held &lt; 0.001" over 14 in</p>');
eq('both bounds survive', sanitiseHtml('flatness <0.0002 and >0.5'), '<p>flatness &lt;0.0002 and &gt;0.5</p>');
eq('real markup still parses', sanitiseHtml('held <b>0.0005</b> TIR'), '<p>held <b>0.0005</b> TIR</p>');

console.log('\n--- entities and non-breaking spaces ---');
// contenteditable serialises a typed space as `&nbsp;` in innerHTML. Escaping
// that as if it were plain text produced a literal `&amp;nbsp;` on screen, and
// every save added another `amp;`.
eq('browser nbsp becomes a space', sanitiseHtml('<p>held flat&nbsp;</p>'), '<p>held flat</p>');
eq('a real U+00A0 too', sanitiseHtml('<p>4\u00A0cams</p>'), '<p>4 cams</p>');
eq('nbsp mid-sentence', sanitiseHtml('<p>4&nbsp;very nice cams</p>'), '<p>4 very nice cams</p>');

let repeated = '<p>held flat&nbsp;</p>';
for (let i = 0; i < 6; i++) repeated = sanitiseHtml(repeated);
eq('does not compound over saves', repeated, '<p>held flat</p>');

// Existing damage reverses exactly, however deep.
eq('repairs 1-deep damage', sanitiseHtml('<p>a&amp;nbsp;b</p>'), '<p>a b</p>');
eq('repairs 5-deep damage',
  sanitiseHtml('<p>using 4&amp;amp;amp;amp;amp;nbsp; very nice cams</p>'),
  '<p>using 4 very nice cams</p>');

// ...but a real ampersand is not an escaping artefact and must survive.
eq('a typed ampersand survives', sanitiseHtml('<p>Smith &amp; Sons</p>'), '<p>Smith &amp; Sons</p>');
eq('  and stays stable', sanitiseHtml(sanitiseHtml('<p>Smith &amp; Sons</p>')), '<p>Smith &amp; Sons</p>');
eq('a bare ampersand escapes once', sanitiseHtml('<p>Smith & Sons</p>'), '<p>Smith &amp; Sons</p>');
eq('  and does not double', sanitiseHtml(sanitiseHtml('<p>Smith & Sons</p>')), '<p>Smith &amp; Sons</p>');

eq('quote entity preserved', sanitiseHtml('<p>0.001&quot; flat</p>'), '<p>0.001&quot; flat</p>');
eq('numeric entity preserved', sanitiseHtml('<p>90&#176; corner</p>'), '<p>90&#176; corner</p>');
eq('entity-obfuscated js url still blocked',
  sanitiseHtml('<a href="&#106;avascript:x">t</a>'), '<p><a>t</a></p>');
eq('escaped tolerance does not double',
  sanitiseHtml(sanitiseHtml('held < 0.001 flat')), '<p>held &lt; 0.001 flat</p>');

console.log('\n--- paragraph structure ---');
// A contenteditable left alone yields <br><br> runs or <div> wrappers. Neither
// carries block structure, so `.prose p` and the PDF's orphan/widow and
// page-break rules would silently do nothing.
eq('br runs become paragraphs', sanitiseHtml('One.<br><br>Two.<br><br>Three.'),
  '<p>One.</p><p>Two.</p><p>Three.</p>');
eq('a single br stays a line break', sanitiseHtml('Line one<br>line two'), '<p>Line one<br>line two</p>');
eq('div becomes p', sanitiseHtml('<div>One</div><div>Two</div>'), '<p>One</p><p>Two</p>');
eq('bare text is wrapped', sanitiseHtml('Just text'), '<p>Just text</p>');
eq('existing paragraphs untouched', sanitiseHtml('<p>One</p><p>Two</p>'), '<p>One</p><p>Two</p>');
eq('headings stay blocks', sanitiseHtml('<h2>Head</h2>Body text'), '<h2>Head</h2><p>Body text</p>');
eq('lists stay intact', sanitiseHtml('<ul><li>a</li><li>b</li></ul>'), '<ul><li>a</li><li>b</li></ul>');
eq('blockquote stays a block', sanitiseHtml('<blockquote>Q</blockquote>Then'),
  '<blockquote>Q</blockquote><p>Then</p>');
eq('mixed blocks and loose text', sanitiseHtml('Intro<br><br><h2>H</h2>After<br><br>End'),
  '<p>Intro</p><h2>H</h2><p>After</p><p>End</p>');
eq('inline formatting survives', sanitiseHtml('Held <b>0.0005</b> TIR<br><br>Next'),
  '<p>Held <b>0.0005</b> TIR</p><p>Next</p>');
eq('empty stays empty', sanitiseHtml(''), '');
eq('breaks alone yield nothing', sanitiseHtml('<br><br>'), '');
eq('trailing breaks trimmed', sanitiseHtml('Text<br><br>'), '<p>Text</p>');
eq('running it twice is stable', sanitiseHtml(sanitiseHtml('One.<br><br>Two.')),
  '<p>One.</p><p>Two.</p>');

const real = 'Engine of my design.<br><br>An oil filled crank case.<br><br>About 60% complete.';
eq('no text is lost', toPlainText(sanitiseHtml(real)), toPlainText(real));

console.log('\n--- slugs and lists ---');
eq('slugify', slugify('Beaver Head — 12" Shaper!'), 'beaver-head-12-shaper');
eq('slugs are unique',
  ensureSlugs([{ title: 'Face Mill' }, { title: 'Face Mill' }, { title: 'Face Mill' }])
    .map((p) => p.slug).join(','),
  'face-mill,face-mill-2,face-mill-3');
eq('plain text extraction', toPlainText('<p>Scraped <b>flat</b> to 0.0002&quot;</p>'),
  'Scraped flat to 0.0002"');
eq('plain text truncation', toPlainText('<p>one two three four five</p>', 12), 'one two…');

console.log('\n--- normalise ---');
const n = normalise({
  projects: [
    { title: 'A', photos: ['a.jpg', { src: 'b.jpg' }], published: true, tags: ['x'] },
    { title: 'B', published: false },
  ],
});
eq('photo strings are coerced', JSON.stringify(n.projects[0].photos.map((p) => p.src)), '["a.jpg","b.jpg"]');
eq('drafts are excluded from exports', publishedProjects(n).length, 1);
eq('a feature photo is chosen', featurePhoto(n.projects[0]).src, 'a.jpg');
eq('tags are collected', JSON.stringify(allTags(n.projects)), '[["x",1]]');
eq('junk input does not throw', normalise(null).projects.length, 0);
eq('missing fields are filled', normalise({}).settings.pdf.paper, 'Letter');

console.log('\n--- rendering edge cases ---');
// A testimonial not tied to a project is the common case, and used to crash
// the whole site build by dereferencing the missing project.
const ctx = previewCtx();
const loose = { id: 't1', quote: '<p>Good work.</p>', author: 'A Client', role: '', company: '',
  date: '', projectId: null, image: null, featured: false, published: true, order: 0 };
let rendered = null;
try { rendered = testimonialCard(loose, ctx, new Map()); } catch (e) { rendered = 'THREW: ' + e.message; }
eq('an unlinked testimonial renders', /Good work/.test(rendered) && !/THREW/.test(rendered), true);
eq('  and names no project', !/re:/.test(rendered), true);

// Linked, but pointing at a project that no longer exists (after a delete).
const dangling = { ...loose, projectId: 'gone' };
let d2 = null;
try { d2 = testimonialCard(dangling, ctx, new Map()); } catch (e) { d2 = 'THREW: ' + e.message; }
eq('a dangling project link renders', !/THREW/.test(d2), true);

// Linked to a real project.
const linked = { ...loose, projectId: 'p1' };
const withProj = testimonialCard(linked, ctx, new Map([['p1', { id: 'p1', title: 'Beaver Head' }]]));
eq('a linked testimonial names the project', /re: Beaver Head/.test(withProj), true);

// A project with no photos at all must not break the index card.
const bare = { id: 'x', slug: 'x', title: 'No Photos', summary: '', tags: [], photos: [], published: true };
let card = null;
try { card = projectCard(bare, ctx); } catch (e) { card = 'THREW: ' + e.message; }
eq('a photoless project still makes a card', /No Photos/.test(card) && !/THREW/.test(card), true);

console.log('\n--- video items ---');
const call = (fn, ...args) => { try { return M[fn](...args); } catch (e) { return 'THREW: ' + e.message; } };
eq('isVideo spots an mp4', call('isVideo', 'uploads/a.MP4'), true);
eq('isVideo ignores a photo', call('isVideo', 'a.jpg'), false);
eq('auto poster sits beside the video', call('autoPosterOf', 'uploads/a.mp4'), 'uploads/a.poster.jpg');
eq('a chosen poster wins', call('posterOf', { src: 'uploads/a.mp4', poster: 'b.jpg' }), 'b.jpg');
eq('a missing chosen poster falls back',
  call('posterOf', { src: 'uploads/a.mp4', poster: 'b.jpg' }, () => false), 'uploads/a.poster.jpg');
eq('no chosen poster uses the frame', call('posterOf', { src: 'uploads/a.mp4', poster: '' }), 'uploads/a.poster.jpg');

const vidProj = normalise({ projects: [{ title: 'V', photos: [
  { src: 'uploads/v.mp4', feature: true, poster: 'x.txt' }, { src: 'p.jpg', poster: 'q.jpg' }] }] }).projects[0];
eq('a video is never the lead', vidProj.photos[0].feature, false);
eq('a video stays out of the PDF by default', vidProj.photos[0].pdf, false);
eq('a non-image poster is dropped', vidProj.photos[0].poster, '');
eq('a photo carries no poster field', 'poster' in vidProj.photos[1], false);
eq('the lead skips the video', (featurePhoto(vidProj) || {}).src, 'p.jpg');
const optIn = normalise({ projects: [{ title: 'O', photos: [{ src: 'uploads/v.mp4', pdf: true, poster: 'q.jpg' }] }] }).projects[0];
eq('a video can opt into the PDF', optIn.photos[0].pdf, true);
eq('an image poster is kept', optIn.photos[0].poster, 'q.jpg');
eq('a video-only project has no lead', featurePhoto(optIn), null);

console.log('\n--- video rendering ---');
const rcall = (fn, ...args) => { try { return R[fn](...args); } catch (e) { return 'THREW: ' + e.message; } };
const vctx = previewCtx({ video: (s) => '/media/' + s });
const vitem = { src: 'uploads/v.mp4', poster: 'p.jpg', caption: 'Running', alt: '', feature: false, pdf: false };
const tile = String(rcall('photoFigure', vitem, vctx));
eq('a video tile opens the lightbox', /data-lightbox/.test(tile) && /data-video/.test(tile), true);
eq('  links to the mp4', tile.includes('href="/media/uploads/v.mp4"'), true);
eq('  shows the chosen poster', tile.includes('src="/media/p.jpg"'), true);
eq('  carries a play badge', /class="play-badge"/.test(tile), true);
eq('  and no inline player', /<video/.test(tile), false);
const auto = String(rcall('photoFigure', { ...vitem, poster: '' }, vctx));
eq('no chosen poster shows the frame', auto.includes('src="/media/uploads/v.poster.jpg"'), true);
const gone = String(rcall('photoFigure', vitem, { ...vctx, has: () => false }));
eq('a deleted poster falls back to the frame', gone.includes('src="/media/uploads/v.poster.jpg"'), true);
const ptile = String(rcall('photoFigure', vitem, { ...vctx, photoLinks: false, lazy: false }));
eq('in print a video is its poster and a note', /video-note/.test(ptile) && !/data-lightbox/.test(ptile), true);
eq('more-note: photos and a video', rcall('morePhotosNote', 2, 1, ''),
  '<p class="more-photos">2 more photos and 1 video of this project are online.</p>');
eq('more-note: one video', rcall('morePhotosNote', 0, 1, ''),
  '<p class="more-photos">One video of this project is online.</p>');
eq('more-note: one photo unchanged', rcall('morePhotosNote', 1, 0, ''),
  '<p class="more-photos">One more photo of this project is online.</p>');
const vdata = normalise({ settings: { siteUrl: 'https://x.ca' }, projects: [{ title: 'V', slug: 'v', published: true,
  photos: [{ src: 'a.jpg' }, { src: 'uploads/v.mp4' }] }] });
const pdfDefault = String(rcall('printBody', vdata, { ...vctx, photoLinks: false, lazy: false }));
eq('the PDF leaves videos out by default', /video-note/.test(pdfDefault), false);
eq('  and counts them online', /One video of this project is online/.test(pdfDefault), true);
vdata.projects[0].photos[1].pdf = true;
const pdfIn = String(rcall('printBody', vdata, { ...vctx, photoLinks: false, lazy: false }));
eq('an opted-in video prints as poster + note', /video-note/.test(pdfIn), true);
eq('  linked to the project page', /<a href="https:\/\/x.ca\/projects\/v.html"[^>]*>[^<]*<p class="video-note"|class="video-note"><a href="https:\/\/x.ca\/projects\/v.html"/.test(pdfIn), true);

console.log('\n--- export filenames ---');
// Export names drop the extension for readability, so two sources could
// otherwise claim the same file and one would silently overwrite the other.
const uniq = (m) => new Set(m.values()).size === m.size;

const plain = buildStemMap(['beaver_head.jpg', 'face_mill.jpg']);
eq('unique names stay clean', plain.get('beaver_head.jpg'), 'beaver_head');

const extClash = buildStemMap(['note.jpg', 'note.png']);
eq('jpg/png clash is split', [...extClash.values()].sort().join(','), 'note-jpg,note-png');
eq('  and the names are unique', uniq(extClash), true);

const dirClash = buildStemMap(['note.jpg', 'uploads/note.jpg']);
eq('upload shadowing an original is split', uniq(dirClash), true);
eq('  neither keeps the bare name',
  [...dirClash.values()].every((v) => v !== 'note'), true);

const three = buildStemMap(['note.jpg', 'note.png', 'uploads/note.jpg', 'uploads/note.webp']);
eq('a four-way clash still resolves', uniq(three), true);
eq('  all four are mapped', three.size, 4);

// Order must not affect the result, or export filenames would churn whenever
// projects are reordered.
const a = buildStemMap(['b.jpg', 'a.png', 'a.jpg']);
const b = buildStemMap(['a.jpg', 'a.png', 'b.jpg']);
eq('order does not change the mapping',
  JSON.stringify([...a].sort()), JSON.stringify([...b].sort()));

const library = buildStemMap(['1cu_assembled.jpg', 'cardo_trace_repair.png', 'tw200_hub_1.jpg']);
eq('the real library keeps readable names',
  library.get('cardo_trace_repair.png'), 'cardo_trace_repair');

console.log(fail ? `\n${fail} FAILED` : '\nAll checks passed.');
process.exit(fail ? 1 : 0);
