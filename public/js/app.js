(function () {
  /* Attach the browser's timezone offset to every form that asks for it,
     so due dates are stored correctly regardless of server timezone. */
  document.addEventListener('submit', function (e) {
    var form = e.target;
    var offset = form.querySelector('input.tz-offset');
    if (offset) {
      offset.value = String(new Date().getTimezoneOffset());
    }
    /* Theme toggle returns to the exact page (including query string). */
    var back = form.querySelector('input.redirect-url');
    if (back) {
      back.value = window.location.pathname + window.location.search;
    }
    var message = form.getAttribute('data-confirm');
    if (message && !window.confirm(message)) {
      e.preventDefault();
    }
  });

  /* Checkboxes submit their form immediately (no extra button needed). */
  document.querySelectorAll('form.auto-submit input[type="checkbox"]').forEach(function (box) {
    box.addEventListener('change', function () {
      box.form.submit();
    });
  });

  /* Copy-to-clipboard buttons. */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-copy]') : null;
    if (!btn) return;
    var text = btn.getAttribute('data-copy') || '';
    var done = function () {
      var old = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(function () { btn.textContent = old; }, 1500);
    };
    var fallback = function () {
      var area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); done(); } catch (err) {}
      document.body.removeChild(area);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  });

  /* ---- Drag & drop: tabs onto tabs to group them. ---- */
  var highlight = ['ring-2', 'ring-indigo-400', 'bg-indigo-50', 'dark:bg-indigo-950'];
  var dragKind = null;

  function clearHighlights() {
    document.querySelectorAll('.tab-drop-zone').forEach(function (z) {
      z.classList.remove.apply(z.classList, highlight);
    });
  }

  function closestZone(el) {
    if (!el || !el.closest) return null;
    if (dragKind === 'tab') return el.closest('.tab-drop-zone');
    return null;
  }

  document.addEventListener('dragstart', function (e) {
    var tabLink = e.target.closest ? e.target.closest('[data-tab-id][draggable="true"]') : null;
    if (tabLink) {
      dragKind = 'tab';
      e.dataTransfer.setData('text/plain', 'tab:' + tabLink.getAttribute('data-tab-id'));
      e.dataTransfer.effectAllowed = 'move';
      tabLink.classList.add('opacity-40');
    }
  });

  document.addEventListener('dragend', function () {
    if (dragKind === 'tab') {
      document.querySelectorAll('[data-tab-id][draggable="true"]').forEach(function (el) { el.classList.remove('opacity-40'); });
    }
    dragKind = null;
    clearHighlights();
  });

  document.addEventListener('dragover', function (e) {
    var zone = closestZone(e.target);
    if (zone) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  });

  document.addEventListener('dragenter', function (e) {
    var zone = closestZone(e.target);
    if (zone) {
      e.preventDefault();
      clearHighlights();
      zone.classList.add.apply(zone.classList, highlight);
    }
  });

  document.addEventListener('dragleave', function (e) {
    var zone = closestZone(e.target);
    if (zone && !zone.contains(e.relatedTarget)) {
      zone.classList.remove.apply(zone.classList, highlight);
    }
  });

  document.addEventListener('drop', function (e) {
    var zone = closestZone(e.target);
    if (!zone) return;
    e.preventDefault();
    var payload = e.dataTransfer.getData('text/plain');
    if (dragKind === 'tab' && payload.indexOf('tab:') === 0) {
      var tabForm = document.getElementById('tab-parent-form');
      if (tabForm) {
        var tabId = payload.slice(4);
        var target = zone.getAttribute('data-tab-id');
        if (tabId === target) return; // dropping on itself: ignore
        tabForm.querySelector('input[name="tab_id"]').value = tabId;
        tabForm.querySelector('input[name="parent_id"]').value = target || '';
        tabForm.submit();
      }
    }
  });
})();
