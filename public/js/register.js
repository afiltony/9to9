// Registration wizard: one step at a time with validation, photo resize + drag and drop,
// slot conflict checks, live seat counts, a review step, and a local draft of typed data.
(function () {
  var form = document.getElementById('reg-form');
  if (!form) return;

  var steps = Array.prototype.slice.call(form.querySelectorAll('.step'));
  var links = Array.prototype.slice.call(document.querySelectorAll('[data-step-link]'));
  var bar = document.getElementById('progress-bar');
  var btnBack = document.getElementById('btn-back');
  var btnNext = document.getElementById('btn-next');
  var btnSubmit = document.getElementById('btn-submit');
  var navInfo = document.getElementById('nav-info');
  var allowOverlap = form.dataset.allowOverlap === '1';
  var DRAFT_KEY = 'nine2nine-register-draft';
  var current = 0;
  var furthest = 0;

  // ---------------------------------------------------------------- conditional fields
  function isYes(name) {
    var el = form.querySelector('[name="' + name + '"]:checked');
    return !!el && el.value === 'on';
  }
  function syncShowIf() {
    form.querySelectorAll('[data-show-if]').forEach(function (el) {
      el.hidden = !isYes(el.dataset.showIf);
    });
  }
  form.addEventListener('change', function (e) {
    if (e.target.type === 'radio') syncShowIf();
  });
  syncShowIf();

  // ---------------------------------------------------------------- age from date of birth
  var dob = form.querySelector('[name="date_of_birth"]');
  var ageEl = document.getElementById('age-display');
  function showAge() {
    if (!dob || !ageEl) return;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob.value);
    if (!m) { ageEl.textContent = ''; return; }
    var ref = new Date(dob.max || Date.now());
    var age = ref.getFullYear() - Number(m[1]);
    if (ref.getMonth() + 1 < Number(m[2]) || (ref.getMonth() + 1 === Number(m[2]) && ref.getDate() < Number(m[3]))) age--;
    ageEl.textContent = age >= 0 && age < 120 ? 'Age at the event: ' + age : '';
  }
  if (dob) { dob.addEventListener('change', showAge); dob.addEventListener('input', showAge); showAge(); }

  // ---------------------------------------------------------------- photo: drag & drop + resize in the browser
  var photo = form.querySelector('input[name="profile_photo"]');
  var preview = document.getElementById('photo-preview');
  var photoName = document.getElementById('photo-name');
  var dropzone = document.getElementById('dropzone');
  var MAX_SIDE = 900;

  function showPreview(file) {
    preview.style.backgroundImage = 'url(' + URL.createObjectURL(file) + ')';
    preview.innerHTML = '';
    preview.classList.add('has');
    photoName.textContent = 'Photo ready ✓ (' + Math.round(file.size / 1024) + ' KB)';
  }

  function setFile(file) {
    var dt = new DataTransfer();
    dt.items.add(file);
    photo.files = dt.files;
  }

  function handlePhoto(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      photoName.textContent = 'Please choose a JPG or PNG photograph.';
      photo.value = '';
      return;
    }
    photoName.textContent = 'Preparing photo…';
    if (!window.createImageBitmap || !window.DataTransfer) { showPreview(file); return; }
    createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
      var scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) {
        if (!blob) { showPreview(file); return; }
        var resized = new File([blob], 'photo.jpg', { type: 'image/jpeg' });
        setFile(resized);
        showPreview(resized);
      }, 'image/jpeg', 0.86);
    }).catch(function () {
      photoName.textContent = 'This photo format cannot be read. Please choose a JPG or PNG.';
      photo.value = '';
    });
  }

  if (photo) {
    photo.addEventListener('change', function () { handlePhoto(photo.files && photo.files[0]); });
    ['dragenter', 'dragover'].forEach(function (t) {
      dropzone.addEventListener(t, function (e) { e.preventDefault(); dropzone.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      dropzone.addEventListener(t, function (e) { e.preventDefault(); dropzone.classList.remove('drag'); });
    });
    dropzone.addEventListener('drop', function (e) {
      var file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file && window.DataTransfer) { setFile(file); handlePhoto(file); }
    });
  }

  // ---------------------------------------------------------------- slot selection
  var slotBoxes = Array.prototype.slice.call(form.querySelectorAll('input[name="slots"]'));
  var conflictBox = document.getElementById('conflict-message');
  var selectedBar = document.getElementById('selected-bar');

  function overlaps(a, b) {
    return a.dataset.start < b.dataset.end && b.dataset.start < a.dataset.end;
  }
  function chosen() {
    return slotBoxes.filter(function (b) { return b.checked; })
      .sort(function (a, b) { return a.dataset.start < b.dataset.start ? -1 : 1; });
  }
  function renderSelected() {
    var list = chosen();
    selectedBar.innerHTML = '';
    list.forEach(function (b) {
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = '✓ ' + b.dataset.activity + ' · ' + b.dataset.time;
      selectedBar.appendChild(chip);
    });
    updateNav();
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  slotBoxes.forEach(function (box) {
    box.addEventListener('change', function () {
      form.querySelectorAll('.slot.conflict').forEach(function (el) { el.classList.remove('conflict'); });
      conflictBox.hidden = true;
      if (box.checked && !allowOverlap) {
        var clash = slotBoxes.find(function (o) { return o !== box && o.checked && overlaps(o, box); });
        if (clash) {
          box.checked = false;
          box.closest('.slot').classList.add('conflict');
          clash.closest('.slot').classList.add('conflict');
          conflictBox.innerHTML = '<strong>TIME CONFLICT</strong>You have already selected <b>' + escapeHtml(clash.dataset.time) + ' — ' +
            escapeHtml(clash.dataset.activity.toUpperCase()) + '</b>. Please choose another time slot, or untick that one first.';
          conflictBox.hidden = false;
        }
      }
      renderSelected();
      saveDraft();
    });
  });

  // ---------------------------------------------------------------- live seat counts (server is the source of truth)
  function refreshAvailability() {
    fetch('/api/availability', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        slotBoxes.forEach(function (box) {
          var info = data.slots[box.value];
          if (!info) return;
          var label = box.closest('.slot');
          var avail = label.querySelector('[data-avail]');
          var meter = label.querySelector('.meter');
          var full = info.available === 0;
          label.classList.toggle('full', full);
          label.classList.toggle('closed', !info.open);
          if ((full || !info.open) && !box.checked) box.disabled = true;
          if (!full && info.open) box.disabled = false;
          if (!info.open) avail.textContent = 'UNAVAILABLE';
          else if (full) avail.textContent = box.checked ? 'FULL — choose another time' : info.capacity + ' / ' + info.capacity + ' · FULL';
          else if (info.available != null) avail.textContent = info.available + (info.available === 1 ? ' place left' : ' places left');
          if (meter && info.capacity) {
            var pct = Math.min(100, Math.round(100 * (info.capacity - info.available) / info.capacity));
            meter.style.setProperty('--pct', pct + '%');
            meter.classList.toggle('full', pct >= 100);
            meter.classList.toggle('hot', pct >= 85 && pct < 100);
          }
        });
      })
      .catch(function () {});
  }
  setInterval(function () { if (!document.hidden && steps[current] && steps[current].dataset.step === 'activities') refreshAvailability(); }, 15000);

  // ---------------------------------------------------------------- summary (review step)
  function fieldValue(wrapper) {
    var radios = wrapper.querySelectorAll('input[type=radio]');
    if (radios.length) {
      var r = wrapper.querySelector('input[type=radio]:checked');
      return r ? r.nextElementSibling.textContent : '';
    }
    var file = wrapper.querySelector('input[type=file]');
    if (file) return file.files && file.files.length ? 'Photo added ✓' : '';
    var sel = wrapper.querySelector('select:not([name$="_cc"])');
    if (sel) return sel.value ? sel.options[sel.selectedIndex].text : '';
    var input = wrapper.querySelector('input:not([type=hidden]), textarea');
    if (!input || !input.value) return '';
    var cc = wrapper.querySelector('select[name$="_cc"]');
    if (input.type === 'date') {
      var d = new Date(input.value + 'T00:00:00');
      return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    }
    if (input.type === 'datetime-local') return input.value.replace('T', ' ');
    return (cc && cc.value !== '+91' ? cc.value + ' ' : '') + input.value;
  }

  function buildSummary() {
    var out = document.getElementById('summary');
    out.innerHTML = '';
    steps.forEach(function (step, i) {
      var key = step.dataset.step;
      if (key === 'confirm') return;
      var sec = document.createElement('div');
      sec.className = 'summary-section';
      var head = '<header><h3>' + escapeHtml(step.dataset.title) + '</h3><button type="button" class="link-btn" data-goto="' + i + '">Edit</button></header>';
      var body = '<dl class="kv">';
      if (key === 'activities') {
        var list = chosen();
        body = list.length ? '<dl class="kv">' + list.map(function (b) {
          return '<dt>' + escapeHtml(b.dataset.day + ' · ' + b.dataset.time) + '</dt><dd>' + escapeHtml(b.dataset.activity) + (b.dataset.venue ? ' <span class="muted">· ' + escapeHtml(b.dataset.venue) + '</span>' : '') + '</dd>';
        }).join('') : '<p class="muted small" style="margin:0">No activity slots selected — you can still attend all open programmes.';
      } else if (key === 'consent') {
        step.querySelectorAll('input[type=checkbox]').forEach(function (c) {
          body += '<dt>' + (c.checked ? '✓ Yes' : '✗ No') + '</dt><dd>' + escapeHtml(c.parentNode.querySelector('span').textContent.replace(/\s*\*$/, '')) + '</dd>';
        });
      } else {
        step.querySelectorAll('[data-field]').forEach(function (w) {
          if (w.hidden) return;
          var v = fieldValue(w);
          if (!v) return;
          body += '<dt>' + escapeHtml(w.dataset.label) + '</dt><dd>' + escapeHtml(v) + '</dd>';
        });
      }
      sec.innerHTML = head + body + (body.indexOf('<dl') === 0 ? '</dl>' : '</p>');
      out.appendChild(sec);
    });
  }
  document.getElementById('summary').addEventListener('click', function (e) {
    var b = e.target.closest('[data-goto]');
    if (b) go(Number(b.dataset.goto));
  });

  // ---------------------------------------------------------------- wizard navigation
  function validateStep(i) {
    var step = steps[i];
    var controls = Array.prototype.slice.call(step.querySelectorAll('input, select, textarea'))
      .filter(function (el) { return !el.closest('[hidden]') && !el.disabled && el.type !== 'hidden'; });
    for (var k = 0; k < controls.length; k++) {
      var el = controls[k];
      var wrapper = el.closest('.field');
      var old = wrapper && wrapper.querySelector('.error-text.client');
      if (old) old.remove();
      if (!el.checkValidity()) {
        if (wrapper) {
          wrapper.classList.add('has-error');
          var msg = document.createElement('div');
          msg.className = 'error-text client';
          msg.setAttribute('role', 'alert');
          msg.textContent = el.validity.valueMissing ? (el.type === 'file' ? 'Please add a photograph.' : el.type === 'checkbox' ? 'This confirmation is required.' : 'This field is required.')
            : el.validity.patternMismatch ? 'Enter a valid phone number.' : el.validationMessage;
          wrapper.appendChild(msg);
        }
        el.focus({ preventScroll: false });
        return false;
      }
      if (wrapper) wrapper.classList.remove('has-error');
    }
    return true;
  }

  function updateNav() {
    var isLast = current === steps.length - 1;
    btnBack.hidden = current === 0;
    btnNext.hidden = isLast;
    btnSubmit.hidden = !isLast;
    var key = steps[current].dataset.step;
    var n = chosen().length;
    navInfo.textContent = key === 'activities' ? n + (n === 1 ? ' activity selected' : ' activities selected') : 'Step ' + (current + 1) + ' of ' + steps.length;
    bar.style.setProperty('--pct', Math.round(((current + 1) / steps.length) * 100) + '%');
    links.forEach(function (li, i) {
      li.classList.toggle('current', i === current);
      li.classList.toggle('done', i < current || i <= furthest);
      li.querySelector('button').disabled = i > furthest;
      if (i === current) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
  }

  function go(i, focus) {
    if (i < 0 || i >= steps.length) return;
    steps.forEach(function (s, k) { s.classList.toggle('active', k === i); });
    current = i;
    furthest = Math.max(furthest, i);
    if (steps[i].dataset.step === 'confirm') buildSummary();
    if (steps[i].dataset.step === 'activities') refreshAvailability();
    updateNav();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (focus !== false) {
      var h = steps[i].querySelector('h2');
      if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    }
  }

  btnNext.addEventListener('click', function () {
    if (validateStep(current)) { saveDraft(); go(current + 1); }
  });
  btnBack.addEventListener('click', function () { go(current - 1); });
  links.forEach(function (li, i) {
    li.querySelector('button').addEventListener('click', function () {
      if (i <= furthest && (i < current || validateStep(current))) go(i);
    });
  });
  form.addEventListener('submit', function (e) {
    for (var i = 0; i < steps.length; i++) {
      if (!validateStep(i)) { e.preventDefault(); e.stopImmediatePropagation(); go(i, false); validateStep(i); return; }
    }
    saveDraft();
  }, true);
  // Enter in a text field moves to the next step instead of submitting
  form.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && current < steps.length - 1) {
      e.preventDefault();
      btnNext.click();
    }
  });

  // ---------------------------------------------------------------- local draft (never the photo)
  function saveDraft() {
    try {
      var data = { slots: [] };
      Array.prototype.forEach.call(form.elements, function (el) {
        if (!el.name || el.type === 'file' || el.type === 'hidden') return;
        if (el.name === 'slots') { if (el.checked) data.slots.push(el.value); }
        else if (el.type === 'radio') { if (el.checked) data[el.name] = el.value; }
        else if (el.type === 'checkbox') data[el.name] = el.checked;
        else data[el.name] = el.value;
      });
      localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
    } catch (e) { /* storage unavailable */ }
  }
  function restoreDraft() {
    if (document.getElementById('form-message')) return; // server already re-filled the form
    var data;
    try { data = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { data = null; }
    if (!data) return;
    var preselected = slotBoxes.some(function (b) { return b.checked; });
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || el.type === 'file' || el.type === 'hidden') return;
      if (el.name === 'slots') { if (!preselected) el.checked = !el.disabled && (data.slots || []).indexOf(el.value) > -1; }
      else if (el.type === 'radio') { if (el.name in data) el.checked = el.value === data[el.name]; }
      else if (el.type === 'checkbox') { if (el.name in data) el.checked = !!data[el.name]; }
      else if (el.name in data && data[el.name] !== '') el.value = data[el.name];
    });
  }
  form.addEventListener('input', saveDraft);

  // ---------------------------------------------------------------- start
  restoreDraft();
  syncShowIf();
  showAge();
  renderSelected();
  var start = 0;
  var errStep = steps.findIndex(function (s) { return s.querySelector('.has-error, .slot.bad'); });
  if (errStep > -1) start = errStep;
  else if (document.getElementById('form-message')) start = steps.findIndex(function (s) { return s.dataset.step === 'confirm'; });
  furthest = document.getElementById('form-message') ? steps.length - 1 : start;
  go(start, false);
})();
