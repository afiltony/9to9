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
  var incomplete = document.getElementById('incomplete-message');
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

  // ---------------------------------------------------------------- forane → parish
  // The parish list arrives grouped by forane. Choosing a forane narrows it to that forane's
  // parishes; "Other" swaps it for a text box; picking a parish first fills in its forane.
  var foraneSel = form.querySelector('select[name="forane"]');
  var parishSel = form.querySelector('[data-parish-select]');
  var parishOther = form.querySelector('[data-parish-other]');
  var parishGroups = {};
  var allParishes = parishSel ? parishSel.innerHTML : '';
  if (parishSel) {
    parishSel.querySelectorAll('optgroup').forEach(function (g) {
      parishGroups[g.label] = Array.prototype.map.call(g.children, function (o) { return o.value; });
    });
  }
  function syncParish() {
    if (!foraneSel || !parishSel) return;
    var list = parishGroups[foraneSel.value];
    var other = !!foraneSel.value && !list;
    var keep = parishSel.value;
    parishSel.innerHTML = list
      ? '<option value="">Choose…</option>' + list.map(function (p) { return '<option>' + escapeHtml(p) + '</option>'; }).join('')
      : allParishes;
    parishSel.value = keep;
    if (parishSel.value !== keep) parishSel.value = '';
    parishSel.hidden = parishSel.disabled = other;
    parishOther.hidden = parishOther.disabled = !other;
  }
  if (foraneSel && parishSel) {
    foraneSel.addEventListener('change', syncParish);
    parishSel.addEventListener('change', function () {
      if (foraneSel.value || !parishSel.value) return;
      var group = parishSel.options[parishSel.selectedIndex].parentNode;
      if (group.tagName === 'OPTGROUP') { foraneSel.value = group.label; syncParish(); }
    });
  }

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
  var maxBytes = photo ? Number(photo.dataset.maxBytes) || 1048576 : 1048576;
  var maxUploadBytes = photo ? (Number(photo.dataset.maxUploadMb) || 15) * 1048576 : 15728640;
  // tried in order until the photo fits under maxBytes; the server shrinks anything that still doesn't
  var STEPS = [[900, 0.86], [900, 0.72], [720, 0.7], [600, 0.62], [480, 0.55]];

  function clearPhoto(message) {
    photoName.textContent = message;
    photo.value = '';
    // a photo saved on an earlier attempt is still there: keep showing it
    if (photo.dataset.kept) { preview.style.backgroundImage = 'url(/register/photo)'; return; }
    preview.style.backgroundImage = '';
    preview.classList.remove('has');
  }

  function showPreview(file, note) {
    preview.style.backgroundImage = 'url(' + URL.createObjectURL(file) + ')';
    preview.innerHTML = '';
    preview.classList.add('has');
    photoName.textContent = 'Photo ready ✓ (' + Math.round(file.size / 1024) + ' KB)' + (note || '');
  }

  function setFile(file) {
    var dt = new DataTransfer();
    dt.items.add(file);
    photo.files = dt.files;
  }

  // browser can't resize: send the original and let the server reduce it, if it isn't huge
  function useOriginal(file) {
    if (file.size > maxUploadBytes) {
      clearPhoto('This photo is very large (' + (file.size / 1048576).toFixed(1) + ' MB). Please choose one under ' + Math.round(maxUploadBytes / 1048576) + ' MB.');
      return;
    }
    showPreview(file, file.size > maxBytes ? ' — it will be reduced to ' + Math.round(maxBytes / 1048576) + ' MB when you register' : '');
  }

  function encode(bmp, side, quality) {
    return new Promise(function (resolve) {
      var scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(resolve, 'image/jpeg', quality);
    });
  }

  function handlePhoto(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      clearPhoto('Please choose a JPG or PNG photograph.');
      return;
    }
    photoName.textContent = 'Preparing photo…';
    if (!window.createImageBitmap || !window.DataTransfer) { useOriginal(file); return; }
    createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
      var i = 0;
      var best = null;
      (function next() {
        var step = STEPS[i];
        encode(bmp, step[0], step[1]).then(function (blob) {
          if (blob && (!best || blob.size < best.size)) best = blob;
          if (blob && blob.size <= maxBytes) return done(blob);
          i++;
          if (i < STEPS.length) return next();
          if (best) return done(best);
          useOriginal(file);
        });
      })();
      function done(blob) {
        var resized = new File([blob], 'photo.jpg', { type: 'image/jpeg' });
        setFile(resized);
        showPreview(resized, file.size > maxBytes ? ' — reduced from ' + (file.size / 1048576).toFixed(1) + ' MB' : '');
      }
    }).catch(function () {
      // cannot decode here (unusual format or old browser): JPG/PNG can still be reduced on the server
      if (/^image\/(jpeg|png)$/.test(file.type)) useOriginal(file);
      else clearPhoto('This photo format cannot be read. Please choose a JPG or PNG.');
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

  // ---------------------------------------------------------------- phone numbers (same rules as the server)
  function phoneProblem(input) {
    var v = input.value.replace(/[\s\-().]/g, '');
    if (!v) return '';
    if (!/^\+?\d+$/.test(v)) return 'Use digits only.';
    var ccSel = input.closest('.phone-input') && input.closest('.phone-input').querySelector('select');
    var cc = ccSel ? ccSel.value : '+91';
    if (v.charAt(0) === '+') return /^\+\d{8,15}$/.test(v) ? '' : 'Enter the full number with its country code.';
    if (cc !== '+91') return /^\d{8,15}$/.test(cc.slice(1) + v) ? '' : 'Enter a valid phone number.';
    // India: 10 digits, also accepted with a leading 0 or 91
    return /^(0|91)?\d{10}$/.test(v) ? '' : 'Enter a 10-digit mobile number.';
  }
  var phones = Array.prototype.slice.call(form.querySelectorAll('input[type=tel]'));
  function checkPhone(input) { input.setCustomValidity(phoneProblem(input)); }
  phones.forEach(function (input) {
    input.addEventListener('input', function () { checkPhone(input); });
    var cc = input.closest('.phone-input') && input.closest('.phone-input').querySelector('select');
    if (cc) cc.addEventListener('change', function () { checkPhone(input); });
  });

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
      // one time slot per activity: choosing another time moves the booking
      // (activities marked data-multi, such as the Night Vigil, allow several)
      if (box.checked && !box.dataset.multi) {
        slotBoxes.forEach(function (o) {
          if (o !== box && o.checked && o.dataset.activityId === box.dataset.activityId) o.checked = false;
        });
      }
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
    if (file) return (file.files && file.files.length) || file.dataset.kept ? 'Photo added ✓' : '';
    var sel = wrapper.querySelector('select:not([name$="_cc"]):not(:disabled)');
    if (sel) return sel.value ? sel.options[sel.selectedIndex].text : '';
    var input = wrapper.querySelector('input:not([type=hidden]):not(:disabled), textarea');
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
  function stepControls(i) {
    return Array.prototype.slice.call(steps[i].querySelectorAll('input, select, textarea'))
      .filter(function (el) { return !el.closest('[hidden]') && !el.disabled && el.type !== 'hidden'; });
  }
  // index of the first step with a missing or invalid answer (no messages shown), or -1
  function firstIncomplete() {
    for (var i = 0; i < steps.length; i++) {
      if (!stepControls(i).every(function (el) { return el.checkValidity(); })) return i;
    }
    return -1;
  }

  function validateStep(i) {
    var controls = stepControls(i);
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
            : el.validity.customError ? el.validationMessage
            : el.validity.patternMismatch ? (el.dataset.patternMsg || 'Enter a valid phone number.') : el.validationMessage;
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
    // the submit button appears only on the review step, once every earlier step is complete
    // (the consent ticks on the review step itself are checked when it is pressed)
    var missing = isLast ? firstIncomplete() : -1;
    if (missing === current) missing = -1;
    btnSubmit.hidden = !isLast || missing !== -1;
    incomplete.hidden = missing === -1;
    if (missing !== -1) {
      incomplete.innerHTML = '<strong>NOT COMPLETE YET</strong>Please finish the <b>' + escapeHtml(steps[missing].dataset.title || 'earlier') +
        '</b> step before confirming. <button type="button" class="link-btn" data-goto="' + missing + '">Go to that step</button>';
    }
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
      if (i > furthest || (i > current && !validateStep(current))) return;
      // jumping ahead stops at the first unfinished step
      var missing = firstIncomplete();
      if (i > current && missing !== -1 && missing < i) { go(missing, false); validateStep(missing); return; }
      go(i);
    });
  });
  incomplete.addEventListener('click', function (e) {
    var b = e.target.closest('[data-goto]');
    if (b) { var i = Number(b.dataset.goto); go(i, false); validateStep(i); }
  });
  // re-check completeness as answers change (e.g. after fixing an earlier step)
  form.addEventListener('input', updateNav);
  form.addEventListener('change', updateNav);
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
        if (!el.name || el.disabled || el.type === 'file' || el.type === 'hidden') return;
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
  syncParish();
  phones.forEach(checkPhone);
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
