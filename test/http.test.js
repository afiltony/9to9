import { one, query, resetDb, slotFor, validBody } from './helpers.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { createApp } from '../src/app.js';
import { closePool } from '../src/db.js';

let server;
let base;
let photo;

/** Minimal cookie-keeping client. */
function client() {
  const jar = new Map();
  async function request(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + path, { redirect: 'manual', ...opts, headers });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  }
  async function csrfFrom(path) {
    const html = await (await request(path)).text();
    return /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
  }
  async function postForm(path, fields) {
    return request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  }
  return { request, csrfFrom, postForm };
}

async function createStaff(role, email = `${role.toLowerCase()}@test.local`) {
  await query('INSERT INTO admin_users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [crypto.randomUUID(), role, email, await bcrypt.hash('Password#12345', 4), role]);
  const c = client();
  const csrf = await c.csrfFrom('/admin/login');
  const res = await c.postForm('/admin/login', { _csrf: csrf, email, password: 'Password#12345' });
  assert.equal(res.status, 303);
  return c;
}

async function registerViaHttp(c, overrides = {}, slotIds = [], withPhoto = true) {
  const csrf = await c.csrfFrom('/register');
  const fd = new FormData();
  fd.append('_csrf', csrf);
  for (const [k, v] of Object.entries(validBody(overrides))) fd.append(k, v);
  for (const id of slotIds) fd.append('slots', id);
  if (withPhoto) fd.append('profile_photo', new Blob([photo], { type: 'image/png' }), 'me.png');
  return c.request('/register', { method: 'POST', body: fd });
}

before(async () => {
  await resetDb();
  photo = await QRCode.toBuffer('photo', { width: 200 }); // any valid PNG
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await closePool();
});

describe('public registration over HTTP', () => {
  test('registration page lists bookable slots with availability', async () => {
    const html = await (await client().request('/register')).text();
    assert.match(html, /Adoration/);
    assert.match(html, /30 places left/);
    assert.ok(!html.includes('Holy Qurbana'), 'open-to-all items are not bookable');
  });

  test('POST without a CSRF token is refused', async () => {
    const res = await client().postForm('/register', validBody());
    assert.equal(res.status, 403);
  });

  test('full registration with photo redirects to the private documents page', async () => {
    const c = client();
    const slot = await slotFor('Theatre', '10:00:00');
    const res = await registerViaHttp(c, { mobile: '9111111111' }, [slot.id]);
    assert.equal(res.status, 303);
    const loc = res.headers.get('location');
    assert.match(loc, /^\/r\/[A-Za-z0-9_-]{43}$/);

    const page = await (await c.request(loc)).text();
    assert.match(page, /9TO9-000001/);
    assert.match(page, /Theatre/);

    const pdf = await c.request(`${loc}/id-card.pdf`);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    const card = await c.request(`${loc}/activity-card.pdf`);
    assert.equal(card.status, 200);

    const p = await one('SELECT profile_photo_path FROM participants WHERE mobile = ?', ['9111111111']);
    assert.match(p.profile_photo_path, /^photos\/[0-9a-f-]{36}\.png$/);
  });

  test('missing photo and invalid fields re-render the form with values kept', async () => {
    const res = await registerViaHttp(client(), { mobile: '123', last_name: 'Keepme' }, [], false);
    assert.equal(res.status, 422);
    const html = await res.text();
    assert.match(html, /Please add a photograph/);
    assert.match(html, /valid phone number/);
    assert.match(html, /value="Keepme"/);
  });

  test('a photo over the 1 MB limit is refused with a clear message', async () => {
    const c = client();
    const csrf = await c.csrfFrom('/register');
    const fd = new FormData();
    fd.append('_csrf', csrf);
    for (const [k, v] of Object.entries(validBody({ last_name: 'Bigphoto' }))) fd.append(k, v);
    const big = Buffer.alloc(1024 * 1024 + 10, 0);
    photo.copy(big); // valid PNG header, padded past 1 MB
    fd.append('profile_photo', new Blob([big], { type: 'image/png' }), 'big.png');
    const res = await c.request('/register', { method: 'POST', body: fd });
    assert.equal(res.status, 422);
    const html = await res.text();
    assert.match(html, /too large \(max 1 MB\)/);
    assert.match(html, /value="Bigphoto"/);
    assert.match(html, /max 1 MB/);
  });

  test('a non-image upload is rejected', async () => {
    const c = client();
    const csrf = await c.csrfFrom('/register');
    const fd = new FormData();
    fd.append('_csrf', csrf);
    for (const [k, v] of Object.entries(validBody())) fd.append(k, v);
    fd.append('profile_photo', new Blob(['<?php echo 1; ?>'], { type: 'image/png' }), 'x.png');
    const res = await c.request('/register', { method: 'POST', body: fd });
    assert.equal(res.status, 422);
    assert.match(await res.text(), /must be a JPG or PNG/);
  });

  test('a full slot shows a clear message and keeps the rest of the form', async () => {
    const slot = await slotFor('Meet with Bishop', '10:00:00');
    await query('UPDATE activity_slots SET capacity = 0 WHERE id = ?', [slot.id]);
    const res = await registerViaHttp(client(), { last_name: 'Fullslot' }, [slot.id]);
    assert.equal(res.status, 409);
    const html = await res.text();
    assert.match(html, /just filled up/);
    assert.match(html, /value="Fullslot"/);
  });

  test('unknown document links return 404', async () => {
    assert.equal((await client().request(`/r/${'x'.repeat(43)}`)).status, 404);
  });

  test('availability endpoint returns seat counts', async () => {
    const data = await (await client().request('/api/availability')).json();
    const slot = await slotFor('Theatre', '10:00:00');
    assert.equal(data.slots[slot.id].available, 249);
  });
});

describe('staff access', () => {
  test('wrong password is refused', async () => {
    const c = client();
    const csrf = await c.csrfFrom('/admin/login');
    const res = await c.postForm('/admin/login', { _csrf: csrf, email: 'nobody@test.local', password: 'wrong-password' });
    assert.equal(res.status, 401);
  });

  test('check-in URLs require login', async () => {
    const p = await one('SELECT qr_token FROM participants LIMIT 1');
    const res = await client().request(`/checkin/${p.qr_token}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/admin/login');
  });

  test('login returns staff to the QR link they opened', async () => {
    const p = await one('SELECT qr_token FROM participants LIMIT 1');
    await query('INSERT INTO admin_users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
      [crypto.randomUUID(), 'Door', 'door@test.local', await bcrypt.hash('Password#12345', 4), 'CHECKIN_STAFF']);
    const c = client();
    await c.request(`/checkin/${p.qr_token}`);
    const csrf = await c.csrfFrom('/admin/login');
    const res = await c.postForm('/admin/login', { _csrf: csrf, email: 'door@test.local', password: 'Password#12345' });
    assert.equal(res.headers.get('location'), `/checkin/${p.qr_token}`);
  });

  test('check-in staff can scan and check in but cannot browse participants', async () => {
    const c = await createStaff('CHECKIN_STAFF');
    assert.equal((await c.request('/admin/checkin')).status, 200);
    assert.equal((await c.request('/admin/participants')).status, 403);

    const p = await one(`SELECT id, qr_token FROM participants WHERE status = 'approved' LIMIT 1`);
    const page = await c.request(`/checkin/${p.qr_token}?station=EVENT`);
    const html = await page.text();
    assert.match(html, /VALID REGISTRATION/);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(html)[1];

    const res = await c.postForm(`/checkin/${p.qr_token}`, { _csrf: csrf, station: 'EVENT', slot_id: '' });
    assert.equal(res.status, 303);
    assert.match(await (await c.request(res.headers.get('location'))).text(), /CHECK-IN SUCCESSFUL/);
    assert.equal((await one('SELECT COUNT(*) AS n FROM checkins WHERE participant_id = ?', [p.id])).n, 1);

    await c.postForm(`/checkin/${p.qr_token}`, { _csrf: csrf, station: 'EVENT', slot_id: '' });
    assert.match(await (await c.request(`/checkin/${p.qr_token}?station=EVENT`)).text(), /Already checked in/);
    assert.equal((await one('SELECT COUNT(*) AS n FROM checkins WHERE participant_id = ?', [p.id])).n, 1);
  });

  test('station verdict warns when the participant has not booked the slot', async () => {
    const c = await createStaff('CHECKIN_STAFF', 'door2@test.local');
    const p = await one('SELECT qr_token FROM participants LIMIT 1');
    const vr = await slotFor('VR Experience Show', '17:00:00');
    assert.match(await (await c.request(`/checkin/${p.qr_token}?station=${vr.id}`)).text(), /NOT BOOKED/);
  });

  test('manual lookup by short registration number', async () => {
    const c = await createStaff('CHECKIN_STAFF', 'door3@test.local');
    const csrf = await c.csrfFrom('/admin/checkin');
    const res = await c.postForm('/admin/checkin/lookup', { _csrf: csrf, registration_number: '1', station: 'EVENT' });
    const p = await one(`SELECT qr_token FROM participants WHERE registration_number = '9TO9-000001'`);
    assert.equal(res.headers.get('location'), `/checkin/${p.qr_token}?station=EVENT`);
  });

  test('report manager can view but not change registrations', async () => {
    const c = await createStaff('REPORT_MANAGER');
    const p = await one('SELECT id FROM participants LIMIT 1');
    assert.equal((await c.request('/admin/participants?q=9111111111')).status, 200);
    const html = await (await c.request(`/admin/participants/${p.id}`)).text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(html)[1];
    const res = await c.postForm(`/admin/participants/${p.id}/status`, { _csrf: csrf, action: 'cancel' });
    assert.equal(res.status, 403);
    assert.equal((await c.request(`/admin/participants/${p.id}/id-card.pdf`)).status, 403);
  });

  test('admin can search, cancel and print cards', async () => {
    const c = await createStaff('ADMIN');
    const list = await (await c.request('/admin/participants?q=9111111111')).text();
    assert.match(list, /9TO9-000001/);
    const p = await one(`SELECT id FROM participants WHERE mobile = '9111111111'`);
    const html = await (await c.request(`/admin/participants/${p.id}`)).text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(html)[1];
    await c.postForm(`/admin/participants/${p.id}/status`, { _csrf: csrf, action: 'cancel' });
    assert.equal((await one('SELECT status FROM participants WHERE id = ?', [p.id])).status, 'cancelled');
    const pdf = await c.request(`/admin/participants/${p.id}/activity-card.pdf`);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal((await one('SELECT COUNT(*) AS n FROM participant_documents WHERE participant_id = ?', [p.id])).n, 1);
    assert.equal((await c.request(`/admin/participants/${p.id}/photo`)).status, 200);
    assert.equal((await c.request('/admin')).status, 200);
  });

  test('participant photos are not publicly reachable', async () => {
    const p = await one('SELECT id, profile_photo_path FROM participants WHERE profile_photo_path IS NOT NULL LIMIT 1');
    assert.equal((await client().request(`/admin/participants/${p.id}/photo`)).status, 302);
    assert.equal((await client().request(`/static/../storage/${p.profile_photo_path}`)).status, 404);
  });
});
