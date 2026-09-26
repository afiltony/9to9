// Shared page behaviour: back links, confirmation prompts, and preventing double submits.
(function () {
  // the registration page keeps a local draft; drop it once registration has succeeded
  if (document.querySelector('[data-clear-draft]')) {
    try { localStorage.removeItem('nine2nine-register-draft'); } catch (e) { /* ignore */ }
  }

  document.addEventListener('click', function (e) {
    var back = e.target.closest('[data-back]');
    var print = e.target.closest('[data-print]');
    if (print) { e.preventDefault(); window.print(); return; }
    if (back && history.length > 1) {
      e.preventDefault();
      history.back();
    }
  });

  document.addEventListener('submit', function (e) {
    var form = e.target;
    var msg = form.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) {
      e.preventDefault();
      return;
    }
    if (form.dataset.submitting) {
      e.preventDefault();
      return;
    }
    form.dataset.submitting = '1';
    var btn = e.submitter || form.querySelector('[type=submit]');
    if (btn) {
      btn.classList.add('loading');
      if (btn.dataset.loadingText) btn.textContent = btn.dataset.loadingText;
    }
    // file downloads don't leave the page, so re-enable the button after a moment
    if (form.hasAttribute('data-download')) {
      setTimeout(function () { delete form.dataset.submitting; if (btn) btn.classList.remove('loading'); }, 6000);
    }
    // re-enable if the user comes back to this page via the back button
    window.addEventListener('pageshow', function () {
      delete form.dataset.submitting;
      if (btn) btn.classList.remove('loading');
    }, { once: true });
  });
})();

// Mobile menus: public header navigation and the admin sidebar.
(function () {
  var toggle = document.querySelector('[data-menu-toggle]');
  var nav = document.getElementById('site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  var sideToggle = document.querySelector('[data-sidebar-toggle]');
  var sidebar = document.getElementById('sidebar');
  if (sideToggle && sidebar) {
    var scrim;
    function close() {
      sidebar.classList.remove('open');
      sideToggle.setAttribute('aria-expanded', 'false');
      if (scrim) { scrim.remove(); scrim = null; }
    }
    sideToggle.addEventListener('click', function () {
      if (sidebar.classList.contains('open')) return close();
      sidebar.classList.add('open');
      sideToggle.setAttribute('aria-expanded', 'true');
      scrim = document.createElement('div');
      scrim.className = 'scrim';
      scrim.addEventListener('click', close);
      document.body.appendChild(scrim);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  // "select all" checkbox for tables with selectable rows
  document.querySelectorAll('[data-select-all]').forEach(function (all) {
    var name = all.getAttribute('data-select-all');
    var counter = document.querySelector('[data-selected-count]');
    function update() {
      var n = document.querySelectorAll('input[name="' + name + '"]:checked').length;
      if (counter) counter.textContent = n;
    }
    all.addEventListener('change', function () {
      document.querySelectorAll('input[name="' + name + '"]').forEach(function (b) { b.checked = all.checked; });
      update();
    });
    document.addEventListener('change', function (e) { if (e.target.name === name) update(); });
  });
})();

// panels that are folded on phones start open on wider screens
document.querySelectorAll('[data-open-desktop]').forEach(function (d) {
  if (window.matchMedia('(min-width: 721px)').matches) d.open = true;
});
