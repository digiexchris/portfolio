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
  var lb = document.getElementById('lb');
  if (!lb) return;
  var img = document.getElementById('lb-img');
  var cap = document.getElementById('lb-cap');
  var links = [].slice.call(document.querySelectorAll('a[data-lightbox]'));
  var at = 0;

  function show(i) {
    at = (i + links.length) % links.length;
    var a = links[at];
    img.src = a.getAttribute('href');
    var fig = a.closest('figure');
    var c = fig && fig.querySelector('figcaption');
    cap.textContent = c ? c.textContent : '';
    lb.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }
  function hide() {
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
  document.addEventListener('keydown', function (e) {
    if (!lb.classList.contains('is-open')) return;
    if (e.key === 'Escape') hide();
    if (e.key === 'ArrowLeft') show(at - 1);
    if (e.key === 'ArrowRight') show(at + 1);
  });
})();
