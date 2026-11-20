(function () {
  'use strict';

  // --- index filtering ---
  var grid = document.getElementById('grid');
  if (grid) {
    var cards = [].slice.call(grid.querySelectorAll('.card'));
    var q = document.getElementById('q');
    var empty = document.getElementById('empty');
    var tag = '';

    function apply() {
      var term = (q && q.value || '').trim().toLowerCase();
      var shown = 0;
      cards.forEach(function (c) {
        var tags = (c.dataset.tags || '').split('|');
        var okTag = !tag || tags.indexOf(tag) > -1;
        var okTerm = !term || c.textContent.toLowerCase().indexOf(term) > -1;
        var on = okTag && okTerm;
        c.hidden = !on;
        if (on) shown++;
      });
      if (empty) empty.hidden = shown > 0;
    }

    if (q) q.addEventListener('input', apply);
    [].forEach.call(document.querySelectorAll('.tag-btn'), function (b) {
      b.addEventListener('click', function () {
        tag = b.dataset.tag || '';
        [].forEach.call(document.querySelectorAll('.tag-btn'), function (o) {
          o.classList.toggle('is-on', o === b);
        });
        apply();
      });
    });

    // Deep link from a tag on a project page: index.html?tag=turning
    var param = new URLSearchParams(location.search).get('tag');
    if (param) {
      var btn = document.querySelector('.tag-btn[data-tag="' + param.replace(/"/g, '') + '"]');
      if (btn) btn.click();
    }
  }

  // --- lightbox ---
  // Photos and videos share one viewer and one prev/next order. A video gets
  // its src only while it is showing, so nothing of it downloads until then.
  var lb = document.getElementById('lb');
  if (!lb) return;
  var img = document.getElementById('lb-img');
  var vid = document.getElementById('lb-video');
  var cap = document.getElementById('lb-cap');
  var links = [].slice.call(document.querySelectorAll('a[data-lightbox]'));
  var at = 0;

  function stopVideo() {
    if (!vid || !vid.hasAttribute('src')) return;
    vid.pause();
    vid.removeAttribute('src');
    vid.load();                                 // drops the buffered download
  }

  function show(i) {
    at = (i + links.length) % links.length;
    var a = links[at];
    stopVideo();
    if (a.hasAttribute('data-video') && vid) {
      img.hidden = true;
      img.src = '';
      var poster = a.querySelector('img');
      vid.poster = poster ? (poster.currentSrc || poster.src) : '';
      vid.src = a.getAttribute('href');
      vid.hidden = false;
      var p = vid.play();
      if (p && p.catch) p.catch(function () {});  // refused: the controls are there
    } else {
      if (vid) vid.hidden = true;
      img.hidden = false;
      img.src = a.getAttribute('href');
    }
    var fig = a.closest('figure');
    var c = fig && fig.querySelector('figcaption');
    cap.textContent = c ? c.textContent : '';
    lb.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }
  function hide() {
    stopVideo();
    if (vid) vid.hidden = true;
    lb.classList.remove('is-open');
    img.src = '';
    document.body.style.overflow = '';
  }

  links.forEach(function (a, i) {
    a.addEventListener('click', function (e) { e.preventDefault(); show(i); });
  });
  lb.addEventListener('click', function (e) {
    if (e.target === lb || e.target.classList.contains('lb-close')) hide();
  });
  lb.querySelector('.lb-prev').addEventListener('click', function (e) { e.stopPropagation(); show(at - 1); });
  lb.querySelector('.lb-next').addEventListener('click', function (e) { e.stopPropagation(); show(at + 1); });
  // Arrow keys navigate even while the player has focus; space and the
  // player's other keys stay with the player.
  document.addEventListener('keydown', function (e) {
    if (!lb.classList.contains('is-open')) return;
    if (e.key === 'Escape') hide();
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(at - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); show(at + 1); }
  }, true);
})();
