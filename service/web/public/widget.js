/* Tribune widget: one line on any site.
 *   <script src="https://HOST/widget.js" data-site="SLUG" async></script>
 * Options (data-*): position=bottom-right|bottom-left|none, label="Vos idées", lang=fr|en|es, token=<signed JWT>
 * JS API: Tribune.identify(jwt) · Tribune.open("roadmap"|"changelog"|"p/12"|"") · Tribune.close() · Tribune.logout()
 * The panel is an iframe on the Tribune origin: no CSS leaks either way, and the session is a
 * bearer token inside the frame, so third-party cookie blocking does not matter. */
(function () {
  var s = document.currentScript || document.querySelector('script[data-site][src*="widget.js"]');
  if (!s || window.Tribune && window.Tribune._ready) return;
  var site = s.getAttribute('data-site');
  var src = s.src.replace(/\/widget\.js.*$/, '');
  var origin = new URL(src).origin;
  var lang = s.getAttribute('data-lang') || (document.documentElement.lang || 'fr').slice(0, 2);
  var position = s.getAttribute('data-position') || 'bottom-right';
  if (['fr', 'en', 'es'].indexOf(lang) < 0) lang = 'en';
  var label = s.getAttribute('data-label') || ({ en: 'Feedback', es: 'Tus ideas' }[lang] || 'Vos idées');
  var pending = s.getAttribute('data-token') || null, ready = false, frame, panel, btn, lastFocus;
  var queued = (window.Tribune && window.Tribune.q) || [];

  var css = '.trb-btn{position:fixed;bottom:20px;z-index:2147483000;border:0;border-radius:999px;padding:10px 16px;font:600 14px/1 system-ui,sans-serif;background:#111827;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.2);cursor:pointer}' +
    '.trb-btn:focus-visible{outline:2px solid #2563eb;outline-offset:2px}' +
    '.trb-panel{position:fixed;top:0;bottom:0;width:440px;max-width:100vw;z-index:2147483001;background:#fff;box-shadow:0 0 30px rgba(0,0,0,.25);transform:translateX(110%);transition:transform .2s ease;display:flex}' +
    '.trb-panel.trb-left{left:0;transform:translateX(-110%)}.trb-panel.trb-right{right:0}.trb-panel.trb-open{transform:none}' +
    '.trb-panel iframe{border:0;width:100%;height:100%}' +
    '@media (prefers-reduced-motion:reduce){.trb-panel{transition:none}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function build() {
    if (panel) return;
    panel = document.createElement('div');
    panel.className = 'trb-panel ' + (position === 'bottom-left' ? 'trb-left' : 'trb-right');
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', label); panel.setAttribute('aria-hidden', 'true');
    frame = document.createElement('iframe');
    frame.title = label;
    frame.src = src + '/s/' + encodeURIComponent(site) + '/?embed=1&lang=' + encodeURIComponent(lang);
    panel.appendChild(frame);
    document.body.appendChild(panel);
  }
  function post(msg) { if (frame && frame.contentWindow) frame.contentWindow.postMessage(msg, origin); }
  // Fit the panel to the visible area, not the layout viewport: on a page wider than the
  // phone screen (an overflowing table), right:0 would put half the panel and its close
  // button off-screen.
  function fit() {
    var vv = window.visualViewport; if (!panel || !vv) return;
    var w = Math.min(440, Math.floor(vv.width));
    panel.style.width = w + 'px'; panel.style.maxWidth = 'none'; panel.style.right = 'auto';
    panel.style.left = Math.round(vv.offsetLeft + (position === 'bottom-left' ? 0 : vv.width - w)) + 'px';
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fit);
    window.visualViewport.addEventListener('scroll', fit);
  }
  function open(view) {
    build(); fit(); lastFocus = document.activeElement;
    panel.classList.add('trb-open'); panel.setAttribute('aria-hidden', 'false');
    if (view !== undefined) { if (ready) post({ type: 'tribune:open', view: view }); else panel._view = view; }
    setTimeout(function () { frame.focus(); }, 50);
  }
  function close() {
    if (!panel) return;
    panel.classList.remove('trb-open'); panel.setAttribute('aria-hidden', 'true');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== origin || !frame || e.source !== frame.contentWindow) return;
    var d = e.data || {};
    if (d.type === 'tribune:ready') {
      ready = true;
      if (pending) post({ type: 'tribune:identify', token: pending });
      if (panel._view !== undefined) { post({ type: 'tribune:open', view: panel._view }); panel._view = undefined; }
    }
    if (d.type === 'tribune:close') close();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && panel && panel.classList.contains('trb-open')) close(); });

  if (position !== 'none') {
    btn = document.createElement('button');
    btn.className = 'trb-btn'; btn.type = 'button'; btn.textContent = label;
    btn.style[position === 'bottom-left' ? 'left' : 'right'] = '20px';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.addEventListener('click', function () { panel && panel.classList.contains('trb-open') ? close() : open(); });
    (document.body ? Promise.resolve() : new Promise(function (r) { document.addEventListener('DOMContentLoaded', r); })).then(function () { document.body.appendChild(btn); });
  }

  window.Tribune = {
    _ready: true,
    identify: function (jwt) { pending = jwt; build(); if (ready) post({ type: 'tribune:identify', token: jwt }); },
    logout: function () { pending = null; post({ type: 'tribune:logout' }); },
    open: open, close: close,
  };
  for (var i = 0; i < queued.length; i++) { var c = queued[i]; window.Tribune[c[0]] && window.Tribune[c[0]].apply(null, c.slice(1)); }
})();
