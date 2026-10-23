/* nue: app-shell behaviour that is not about news or stocks:
   toasts, install prompt, service worker, offline notice, pull to refresh. */
(function () {
  'use strict';

  var V = window.NueViz;
  function $(s) { return document.querySelector(s); }

  // Fill in the icons that the page marks with data-icon, and the icon-only buttons.
  document.querySelectorAll('[data-icon]').forEach(function (n) { n.replaceChildren(V.icon(n.getAttribute('data-icon'))); });
  [['#topicsBtn', 'topics'], ['#refreshBtn', 'refresh'], ['#sideClose', 'close']].forEach(function (p) {
    var b = document.querySelector(p[0]);
    if (b) b.replaceChildren(V.icon(p[1]));
  });

  /* ---------------------------------------------------------------- toast */
  var toastTimer = null;
  function toast(message, opts) {
    opts = opts || {};
    var box = $('#toast');
    if (!box) return;
    box.replaceChildren();
    var msg = document.createElement('span');
    msg.textContent = message;
    box.append(msg);
    if (opts.action) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = opts.action;
      b.addEventListener('click', function () { box.classList.remove('show'); if (opts.onAction) opts.onAction(); });
      box.append(b);
    }
    box.classList.add('show');
    clearTimeout(toastTimer);
    if (!opts.sticky) toastTimer = setTimeout(function () { box.classList.remove('show'); }, opts.ms || 2600);
  }

  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 12); } catch (e) { /* not supported */ } }

  /* -------------------------------------------------------------- install */
  var deferred = null;
  var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var installBtn = $('#installBtn');
  var iosSheet = $('#iosSheet');

  function showInstall(show) { if (installBtn) installBtn.hidden = !show; }
  function openIos(open) {
    if (!iosSheet) return;
    iosSheet.hidden = !open;
    $('#scrim').classList.toggle('on', open || $('#side').classList.contains('open'));
  }

  var installNow = $('#installNow');
  function goGuide() { location.hash = '#install'; }
  async function runInstall() {
    if (deferred) {
      deferred.prompt();
      try { await deferred.userChoice; } catch (e) { /* ignore */ }
      deferred = null;
      if (installNow) installNow.hidden = true;
    } else {
      goGuide();
    }
  }
  if (!standalone) {
    // Always offer the button; when the browser cannot be asked to install, it opens the step by step guide.
    showInstall(true);
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferred = e;
      if (installNow) installNow.hidden = false;
    });
    if (installBtn) installBtn.addEventListener('click', runInstall);
    if (installNow) installNow.addEventListener('click', runInstall);
    window.addEventListener('appinstalled', function () { showInstall(false); if (installNow) installNow.hidden = true; toast('nue is installed'); });
  }
  // Mark the guide card that matches this device.
  var kind = isIOS ? 'ios' : /android/i.test(navigator.userAgent) ? 'android' : 'desktop';
  var card = document.querySelector('.device[data-device="' + kind + '"]');
  if (card) card.classList.add('mine');
  var iosClose = $('#iosClose');
  if (iosClose) iosClose.addEventListener('click', function () { openIos(false); });

  /* ------------------------------------------------------- service worker */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        function offerUpdate(worker) {
          toast('A new version of nue is ready.', {
            action: 'Update', sticky: true,
            onAction: function () { worker.postMessage('SKIP_WAITING'); }
          });
        }
        if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
        reg.addEventListener('updatefound', function () {
          var w = reg.installing;
          if (!w) return;
          w.addEventListener('statechange', function () {
            if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
          });
        });
      }).catch(function () { /* the app works without it */ });
      var reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (reloaded) return;
        reloaded = true;
        location.reload();
      });
    });
  }

  /* -------------------------------------------------------------- offline */
  var net = $('#net');
  function netState() {
    if (!net) return;
    net.hidden = navigator.onLine;
    document.documentElement.classList.toggle('offline', !navigator.onLine);
  }
  window.addEventListener('online', function () { netState(); toast('Back online'); });
  window.addEventListener('offline', netState);
  netState();

  /* ------------------------------------------------------ pull to refresh */
  var pullFn = null;
  var ptr = $('#ptr');
  if (ptr) {
    ptr.append(V.icon('refresh'));
    var startY = 0, dy = 0, pulling = false, busy = false;
    var LIMIT = 84;
    function atTop() { return (window.scrollY || document.documentElement.scrollTop) <= 0; }
    function openOverlay() {
      return !!document.querySelector('#side.open, #iosSheet:not([hidden])');
    }
    window.addEventListener('touchstart', function (e) {
      if (busy || !pullFn || !atTop() || openOverlay() || e.touches.length !== 1) { pulling = false; return; }
      startY = e.touches[0].clientY; dy = 0; pulling = true;
    }, { passive: true });
    window.addEventListener('touchmove', function (e) {
      if (!pulling) return;
      dy = e.touches[0].clientY - startY;
      if (dy <= 0 || !atTop()) { pulling = false; ptr.style.transform = ''; ptr.classList.remove('on'); return; }
      var pull = Math.min(dy * 0.55, LIMIT);
      ptr.classList.add('on');
      ptr.style.transform = 'translate(-50%,' + pull + 'px) rotate(' + (pull * 4) + 'deg)';
      ptr.classList.toggle('ready', pull >= LIMIT * 0.8);
    }, { passive: true });
    window.addEventListener('touchend', async function () {
      if (!pulling) return;
      pulling = false;
      var ready = ptr.classList.contains('ready');
      ptr.classList.remove('ready');
      if (!ready) { ptr.style.transform = ''; ptr.classList.remove('on'); return; }
      busy = true;
      buzz(10);
      ptr.classList.add('spin');
      ptr.style.transform = 'translate(-50%,56px)';
      try { await pullFn(); } catch (e) { /* the page shows its own error */ }
      busy = false;
      ptr.classList.remove('spin', 'on');
      ptr.style.transform = '';
    }, { passive: true });
  }

  window.NueUI = {
    toast: toast,
    buzz: buzz,
    setPull: function (fn) { pullFn = fn; },
    standalone: standalone
  };
})();
