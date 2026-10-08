// Card printers that want an image at actual size: the ID card PDF is drawn in the browser
// with pdf.js at 300 dpi and each side saved as a JPG — 1299 × 1772 px = 11 × 15 cm
// (the 7 × 11 cm card with a 2 cm gap round it), with 300 dpi written into the file so printing software uses the real size.
// Single cards download as two JPGs; bulk printing downloads a ZIP of JPGs.
(function () {
  var DPI = 300;
  var loaded = {};

  function loadScript(src) {
    if (!loaded[src]) {
      loaded[src] = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = function () { reject(new Error('Could not load ' + src)); };
        document.head.appendChild(s);
      });
    }
    return loaded[src];
  }

  function pdfjs() {
    return loadScript('/static/vendor/pdf.min.js').then(function () {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/vendor/pdf.worker.min.js';
      return window.pdfjsLib;
    });
  }

  // canvas JPEGs carry no resolution; set the JFIF header to 300 dpi
  function withDpi(blob) {
    return blob.arrayBuffer().then(function (buf) {
      var b = new Uint8Array(buf);
      if (b[6] === 0x4a && b[7] === 0x46 && b[8] === 0x49 && b[9] === 0x46 && b[10] === 0) {
        b[13] = 1; // units: dots per inch
        b[14] = DPI >> 8; b[15] = DPI & 255;
        b[16] = DPI >> 8; b[17] = DPI & 255;
      }
      return new Blob([b], { type: 'image/jpeg' });
    });
  }

  /** Every page of the PDF as a 300 dpi JPEG blob, in page order. */
  function pdfToJpegs(bytes) {
    return pdfjs().then(function (lib) {
      return lib.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true }).promise;
    }).then(function (pdf) {
      var out = [];
      var chain = Promise.resolve();
      for (var i = 1; i <= pdf.numPages; i++) {
        (function (n) {
          chain = chain.then(function () { return pdf.getPage(n); }).then(function (page) {
            var vp = page.getViewport({ scale: DPI / 72 });
            var canvas = document.createElement('canvas');
            canvas.width = Math.round(vp.width);
            canvas.height = Math.round(vp.height);
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
              return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.95); });
            });
          }).then(withDpi).then(function (jpg) { out.push(jpg); });
        })(i);
      }
      return chain.then(function () { return out; });
    });
  }

  function save(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  function busy(el, on, text) {
    if (!el) return;
    if (on) { el.dataset.html = el.innerHTML; el.textContent = text; el.classList.add('loading'); el.setAttribute('aria-busy', 'true'); }
    else { if (el.dataset.html) el.innerHTML = el.dataset.html; el.classList.remove('loading'); el.removeAttribute('aria-busy'); }
  }

  function fail(err) {
    window.alert('Could not make the JPG cards: ' + (err && err.message ? err.message : err) + '\nPlease try again, or use the PDF.');
  }

  // single card: <a data-card-jpg="…/id-card.pdf" data-name="9TO9-000123">
  document.addEventListener('click', function (e) {
    var link = e.target.closest('[data-card-jpg]');
    if (!link) return;
    e.preventDefault();
    if (link.getAttribute('aria-busy')) return;
    busy(link, true, 'Making JPG…');
    fetch(link.dataset.cardJpg, { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok || !/pdf/.test(res.headers.get('content-type') || '')) throw new Error('the card could not be generated');
        return res.arrayBuffer();
      })
      .then(pdfToJpegs)
      .then(function (pages) {
        var name = link.dataset.name || 'card';
        save(pages[0], name + '-front.jpg');
        // a short pause so the browser treats them as two separate downloads
        if (pages[1]) setTimeout(function () { save(pages[1], name + '-back.jpg'); }, 400);
      })
      .catch(fail)
      .then(function () { busy(link, false); });
  });

  // bulk: a print form whose layout is "jpg" downloads a ZIP of front/back JPGs
  document.addEventListener('submit', function (e) {
    var form = e.target;
    var layout = form.querySelector('[name="layout"]:checked, select[name="layout"]');
    if (!layout || layout.value !== 'jpg') return;
    var kind = e.submitter && e.submitter.name === 'kind' ? e.submitter.value : (form.querySelector('[name="kind"]:checked') || {}).value;
    if (kind !== 'id') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    var btn = e.submitter || form.querySelector('[type=submit]');
    if (btn && btn.getAttribute('aria-busy')) return;
    var data = new FormData(form);
    data.set('kind', 'id');
    data.set('layout', 'card');
    busy(btn, true, 'Making JPG cards…');
    fetch(form.action, { method: 'POST', body: new URLSearchParams(data), credentials: 'same-origin' })
      .then(function (res) {
        // nothing to print: the server redirects back with a message
        if (!/pdf/.test(res.headers.get('content-type') || '')) { window.location.href = res.url; return null; }
        var numbers = (res.headers.get('X-Registration-Numbers') || '').split(',').filter(Boolean);
        return res.arrayBuffer().then(pdfToJpegs).then(function (pages) {
          return loadScript('/static/vendor/jszip.min.js').then(function () {
            var zip = new window.JSZip();
            for (var i = 0; i < pages.length; i += 2) {
              var name = numbers[i / 2] || 'card-' + String(i / 2 + 1).padStart(3, '0');
              zip.file(name + '-front.jpg', pages[i]);
              if (pages[i + 1]) zip.file(name + '-back.jpg', pages[i + 1]);
            }
            return zip.generateAsync({ type: 'blob' });
          }).then(function (blob) {
            var range = numbers.length ? numbers[0] + '-to-' + numbers[numbers.length - 1] : 'batch';
            save(blob, 'id-cards-jpg-' + range + '.zip');
            // the Print cards page then shows the next batch, as after a PDF
            if (form.querySelector('[name="scope"][value="filter"]') && data.get('mark') !== 'no') setTimeout(function () { window.location.reload(); }, 1500);
          });
        });
      })
      .catch(fail)
      .then(function () { busy(btn, false); });
  }, true);
})();
