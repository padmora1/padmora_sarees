// Custom desktop cursor companion — a small line-art lotus that softly
// trails the real pointer. Purely decorative and additive: it never touches
// click/scroll/selection/drag behavior (pointer-events:none throughout,
// nothing here ever calls preventDefault or intercepts an event), and the
// OS pointer itself is never hidden or replaced — this only ever adds two
// small, inert elements on top of the page.
//
// Gated to real mouse/trackpad input only (never phones/tablets — a touch
// device has no persistent pointer for this to follow) and to
// prefers-reduced-motion: reduce (skipped entirely there). Both checks run
// once at load; a device's input capability doesn't change from a browser
// window resize, so nothing here needs to react to resizing.
(function () {
  'use strict';
  if (!window.matchMedia) return;
  var canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!canHover || reducedMotion) return;

  // Minimal line-art lotus — a symmetric five-petal bloom with a small
  // calyx base beneath it (the classic minimal-lotus silhouette, not the
  // flatter watermark shape used for the large decorative backgrounds
  // elsewhere on the site) — designed specifically to read clearly at
  // cursor size. Built from one petal shape rotated around a shared base
  // point, so every petal stays perfectly symmetric.
  var LOTUS_SVG =
    '<svg viewBox="0 0 64 56" width="30" height="26" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M16 47 Q32 53 48 47" opacity="0.6"/>' +
    '<path d="M32 48 C22.5 40 21 24 32 21 C43 24 41.5 40 32 48 Z" transform="rotate(50 32 48)"/>' +
    '<path d="M32 48 C22.5 40 21 24 32 21 C43 24 41.5 40 32 48 Z" transform="rotate(-50 32 48)"/>' +
    '<path d="M32 48 C24.5 40 23.5 24 32 13 C40.5 24 39.5 40 32 48 Z" transform="rotate(24 32 48)"/>' +
    '<path d="M32 48 C24.5 40 23.5 24 32 13 C40.5 24 39.5 40 32 48 Z" transform="rotate(-24 32 48)"/>' +
    '<path d="M32 48 C25 39 24 22 32 8 C40 22 39 39 32 48 Z"/>' +
    '</svg>';

  var el = document.createElement('div');
  el.id = 'padmora-cursor-lotus';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = LOTUS_SVG;

  // A second, independent lotus used only for the click-bloom: it has its
  // own element so the bloom's CSS keyframe animation (scale + fade) never
  // fights the main lotus's per-frame JS-driven position/hover transform —
  // two separate `transform` writers on one element would stomp on each
  // other; two separate elements can't.
  var bloom = document.createElement('div');
  bloom.id = 'padmora-cursor-bloom';
  bloom.setAttribute('aria-hidden', 'true');
  bloom.innerHTML = LOTUS_SVG;

  var style = document.createElement('style');
  style.textContent =
    '#padmora-cursor-lotus,#padmora-cursor-bloom{' +
    'position:fixed;top:0;left:0;width:30px;height:26px;' +
    'pointer-events:none;z-index:2147483000;' +
    'color:#B87F55;' +
    '}' +
    '#padmora-cursor-lotus{' +
    'filter:drop-shadow(0 1px 2px rgba(61,34,41,0.35));' +
    'opacity:0;transition:opacity .35s ease;' +
    'transform:translate3d(-100px,-100px,0) scale(0.8);' +
    '}' +
    '#padmora-cursor-lotus.is-visible{opacity:.85;}' +
    '#padmora-cursor-lotus svg,#padmora-cursor-bloom svg{display:block;}' +
    '#padmora-cursor-bloom{opacity:0;}' +
    '#padmora-cursor-bloom.is-blooming{animation:padmoraLotusBloom .65s cubic-bezier(.22,.68,.35,1);}' +
    '@keyframes padmoraLotusBloom{' +
    '0%{opacity:.7;transform:translate3d(var(--bloom-x,-100px),var(--bloom-y,-100px),0) scale(0.5) rotate(0deg);}' +
    '100%{opacity:0;transform:translate3d(var(--bloom-x,-100px),var(--bloom-y,-100px),0) scale(2.2) rotate(8deg);}' +
    '}';
  document.head.appendChild(style);

  function mount() {
    document.body.appendChild(el);
    document.body.appendChild(bloom);
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  // Target = real pointer position; current = eased position the lotus is
  // actually drawn at. Easing `current` toward `target` a fraction per frame
  // (rather than snapping straight to it) is what produces the "slight
  // delay / soft movement" the design calls for, without any extra library.
  var targetX = -100, targetY = -100;
  var curX = -100, curY = -100;
  var scale = 0.8, targetScale = 0.8;
  var hasMoved = false;

  window.addEventListener('mousemove', function (e) {
    targetX = e.clientX;
    targetY = e.clientY;
    if (!hasMoved) {
      hasMoved = true;
      curX = targetX;
      curY = targetY;
      el.classList.add('is-visible');
    }
  }, { passive: true });

  document.addEventListener('mouseleave', function () { el.classList.remove('is-visible'); });
  document.addEventListener('mouseenter', function () { if (hasMoved) el.classList.add('is-visible'); });

  // Bloom on hover: anything actually clickable gets a slightly larger,
  // more "open" lotus — checked by tag/role first (cheap) and falling back
  // to a shallow walk for computed cursor:pointer, so custom clickable
  // widgets across the site are covered without hardcoding every class name.
  var NATIVE_INTERACTIVE = 'a,button,input,select,textarea,[role="button"],label';
  function isInteractive(target) {
    var node = target, depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      if (node.matches && node.matches(NATIVE_INTERACTIVE)) return true;
      if (getComputedStyle(node).cursor === 'pointer') return true;
      node = node.parentElement;
      depth++;
    }
    return false;
  }
  document.addEventListener('mouseover', function (e) {
    if (isInteractive(e.target)) targetScale = 1.5;
  }, true);
  document.addEventListener('mouseout', function (e) {
    if (isInteractive(e.target)) targetScale = 1;
  }, true);

  // Click: the lotus itself gives a quick, immediate pop (eased back down by
  // the tick loop below), AND a second lotus blooms outward from the click
  // point — scaling up while fading out, like a flower opening — then
  // disappears completely. Restarting the animation on a rapid second click
  // needs the class removed, a reflow forced, then re-added, or the browser
  // just no-ops re-adding a class that's already there.
  window.addEventListener('mousedown', function (e) {
    scale = targetScale + 0.55;
    var bx = e.clientX - 15, by = e.clientY - 13;
    bloom.style.setProperty('--bloom-x', bx + 'px');
    bloom.style.setProperty('--bloom-y', by + 'px');
    bloom.classList.remove('is-blooming');
    void bloom.offsetWidth; // force reflow so the animation restarts every click
    bloom.classList.add('is-blooming');
  }, { passive: true });

  function tick() {
    curX += (targetX - curX) * 0.18;
    curY += (targetY - curY) * 0.18;
    scale += (targetScale - scale) * 0.22;
    el.style.transform = 'translate3d(' + (curX - 15) + 'px,' + (curY - 13) + 'px,0) scale(' + scale.toFixed(3) + ')';
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
