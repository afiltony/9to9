// QR scanner for volunteers. Remembers the chosen station on this device and jumps
// straight to the participant's check-in screen when a card is scanned.
(function () {
  var STATION_KEY = 'nine2nine-station';
  var stationSelect = document.getElementById('station');
  var lookupStation = document.getElementById('lookup-station');
  var statusEl = document.getElementById('scan-status');
  var errorEl = document.getElementById('scan-error');
  var startBtn = document.getElementById('start-camera');

  var params = new URLSearchParams(location.search);
  var saved = params.get('station');
  try { saved = saved || localStorage.getItem(STATION_KEY); } catch (e) { /* ignore */ }
  if (saved && stationSelect.querySelector('option[value="' + saved + '"]')) stationSelect.value = saved;

  function syncStation() {
    lookupStation.value = stationSelect.value;
    try { localStorage.setItem(STATION_KEY, stationSelect.value); } catch (e) { /* ignore */ }
  }
  stationSelect.addEventListener('change', syncStation);
  syncStation();

  if (!window.Html5Qrcode) {
    statusEl.textContent = 'Scanner could not load. Use the registration number box below.';
    return;
  }

  var scanner = new Html5Qrcode('reader');
  var handled = false;

  function onScan(text) {
    if (handled) return;
    var m = /\/checkin\/([A-Za-z0-9_-]{43})(?:[?#].*)?$/.exec(text);
    if (!m) {
      errorEl.textContent = 'This is not a 9 TO 9 MEET participant QR code.';
      errorEl.hidden = false;
      return;
    }
    handled = true;
    if (navigator.vibrate) navigator.vibrate(80);
    statusEl.textContent = 'Found — opening…';
    scanner.stop().catch(function () {}).finally(function () {
      location.href = '/checkin/' + m[1] + '?station=' + encodeURIComponent(stationSelect.value);
    });
  }

  function start() {
    errorEl.hidden = true;
    startBtn.hidden = true;
    statusEl.textContent = 'Point the camera at the QR code on the card.';
    scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: function (w, h) { var s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; } },
      onScan,
      function () { /* no code in this frame */ }
    ).catch(function (err) {
      statusEl.textContent = '';
      errorEl.textContent = (window.isSecureContext ? 'Camera unavailable: ' + err : 'The camera only works over HTTPS.') +
        ' You can type the registration number below instead.';
      errorEl.hidden = false;
      startBtn.hidden = false;
    });
  }

  startBtn.addEventListener('click', start);
  start();
})();
