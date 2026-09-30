import { one, query, resetDb, slotFor, validBody } from './helpers.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { closePool } from '../src/db.js';
import { addBooking, registerParticipant, removeBooking, RegistrationError, validateRegistration } from '../src/services/registration.js';

let server;
let base;
let event;

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
  const csrfFrom = async (path) => /name="_csrf" value="([^"]+)"/.exec(await (await request(path)).text())?.[1];
  const post = (path, fields) => request(path, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields),
  });
  return { request, csrfFrom, post };
}

async function staff(role) {
  const email = `${role.toLowerCase()}-${crypto.randomUUID().slice(0, 6)}@test.local`;
  await query('INSERT INTO admin_users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [crypto.randomUUID(), `${role} user`, email, await bcrypt.hash('Password#12345', 4), role]);
  const c = client();
  const csrf = await c.csrfFrom('/admin/login');
  const res = await c.post('/admin/login', { _csrf: csrf, email, password: 'Password#12345', remember: 'on' });
  assert.equal(res.status, 303);
  c.csrf = await c.csrfFrom('/admin/checkin');
  return c;
}

async function register(overrides = {}, slots = []) {
  const { values } = validateRegistration(event, validBody(overrides), { hasPhoto: true });
  return registerParticipant(event.id, values, slots);
}

before(async () => {
  event = await resetDb();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await closePool(); });

describe('public pages', () => {
  test('every public page renders', async () => {
    const c = client();
    for (const path of ['/', '/about', '/schedule', '/activities', '/register', '/contact', '/privacy', '/terms']) {
      const res = await c.request(path);
      assert.equal(res.status, 200, path);
      const html = await res.text();
      assert.match(html, /<title>[^<]*9 TO 9 Meet/, path);
      assert.match(html, /og:title/, path);
      assert.match(html, /<meta property="og:image" content="[^"]*\/static\/img\/poster-popup\.jpg\?v=/, `${path} shares the new poster`);
      assert.match(html, /<img src="\/static\/img\/organizers\.jpg[^>]*alt="Organized by/, `${path} shows the organizers' logos`);
    }
  });

  test('schedule comes from the database, including overnight and next-day items', async () => {
    const html = await (await client().request('/schedule')).text();
    assert.match(html, /Holy Qurbana/);
    assert.match(html, /11:00 PM – 5:00 AM/);
    assert.match(html, /Sun 11 Oct/);
  });

  test('registration wizard has five steps with one name field', async () => {
    const html = await (await client().request('/register')).text();
    assert.ok(!/<span class="t">Requirements<\/span>/.test(html), 'requirements step is off');
    assert.match(html, /Full name \(as printed on your card\)/);
    assert.ok(!html.includes('name="last_name"') && !html.includes('name="accommodation_required"'));
    assert.match(html, /<select name="forane"[^>]*required/);
    assert.match(html, /name="outside_archdiocese"/);
    assert.match(html, /data-outside-only hidden>[\s\S]*?<input type="text" name="diocese"[^>]*disabled/, 'diocese box waits for "outside"');
    assert.match(html, /<optgroup label="Kottayam"><option >Assumption Church, Eravinalloor<\/option>/);
    for (const step of ['Personal', 'Contact', 'Parish', 'Activities', 'Confirm']) {
      assert.match(html, new RegExp(`<span class="t">${step}</span>`));
    }
    assert.ok(!html.includes('<span class="t">Emergency</span>') && !html.includes('name="emergency_mobile"'), 'emergency step is off');
    assert.ok(!html.includes('<span class="t">Consent</span>'), 'consent is part of the confirm step');
    assert.match(html, /name="consent_rules"/);
  });

  test('"book this slot" preselects the slot on the registration form', async () => {
    const slot = await slotFor('Adoration', '12:00:00');
    const html = await (await client().request(`/register?slot=${slot.id}`)).text();
    assert.match(html, new RegExp(`value="${slot.id}"[\\s\\S]{0,400}checked`));
  });

  test('success page shows the QR code image', async () => {
    const p = await register();
    const html = await (await client().request(`/r/${p.access_token}`)).text();
    assert.match(html, /src="data:image\/png;base64,/);
    assert.match(html, /Collect your card at reception/);
  });

  test('international mobile numbers keep their country code', () => {
    const { values, errors } = validateRegistration(event, validBody({ mobile: '501234567', mobile_cc: '+971' }), { hasPhoto: true });
    assert.deepEqual(errors, {});
    assert.equal(values.mobile, '+971501234567');
    const india = validateRegistration(event, validBody({ mobile: '+91 98470 12345' }), { hasPhoto: true });
    assert.equal(india.values.mobile, '9847012345');
  });
});

describe('bulk card printing', () => {
  test('prints unprinted approved cards as one PDF and marks them printed', async () => {
    await query('DELETE FROM participants WHERE event_id = ?', [event.id]).catch(() => {});
    const c = await staff('REGISTRATION_MANAGER');
    const ps = [];
    for (let i = 0; i < 11; i++) ps.push(await register({ mobile: `93000000${String(i).padStart(2, '0')}` }));
    const page = await (await c.request('/admin/documents')).text();
    assert.match(page, /Generate 11 cards/);

    const res = await c.post('/admin/documents', { _csrf: c.csrf, scope: 'filter', printed: 'no', status: 'approved', kind: 'id', layout: 'a4' });
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    const pdf = Buffer.from(await res.arrayBuffer()).toString('latin1');
    // 11 cards at 4 per sheet (10 × 12.5 cm) = 3 sheets, each a front page and a back page
    assert.equal(pdf.match(/\/Type \/Page\b/g).length, 6);
    assert.equal((await one('SELECT COUNT(*) AS n FROM participants WHERE card_printed_at IS NOT NULL AND event_id = ?', [event.id])).n, 11);
    assert.match(await (await c.request('/admin/documents')).text(), /Generate 0 cards/);
  });

  test('card-printer layout gives a front and back page per participant; test prints are not marked', async () => {
    const c = await staff('ADMIN');
    const a = await register({ mobile: '9310000001' });
    const b = await register({ mobile: '9310000002' });
    const res = await c.post('/admin/documents', { _csrf: c.csrf, ids: a.id, kind: 'id', layout: 'card', mark: 'no' });
    const pdf = Buffer.from(await res.arrayBuffer()).toString('latin1');
    assert.equal(pdf.match(/\/Type \/Page\b/g).length, 2);
    assert.equal((await one('SELECT card_printed_at FROM participants WHERE id = ?', [a.id])).card_printed_at, null);
    const act = await c.post('/admin/documents', [['_csrf', c.csrf], ['ids', a.id], ['ids', b.id], ['kind', 'activity']]);
    assert.equal(act.status, 200);
  });

  test('printing from the list without a selection prints nothing', async () => {
    const c = await staff('ADMIN');
    const res = await c.post('/admin/documents', { _csrf: c.csrf, kind: 'id', layout: 'card' });
    assert.equal(res.status, 303);
  });

  test('check-in staff cannot print cards', async () => {
    const c = await staff('CHECKIN_STAFF');
    assert.equal((await c.request('/admin/documents')).status, 403);
  });

  test('reception check-in shows whether the card is printed', async () => {
    const c = await staff('CHECKIN_STAFF');
    const p = await register({ mobile: '9320000001' });
    const html = await (await c.request(`/checkin/${p.qr_token}?station=EVENT`)).text();
    assert.match(html, /Not printed yet/);
    assert.match(html, /CARD HANDED OVER · CHECK IN/);
  });

  test('reception lookup by name lists matches', async () => {
    const c = await staff('CHECKIN_STAFF');
    await register({ mobile: '9330000001', first_name: 'Zacharias Kurian' });
    await register({ mobile: '9330000002', first_name: 'Zacharias Thomas' });
    const html = await (await c.post('/admin/checkin/lookup', { _csrf: c.csrf, registration_number: 'Zacharias', station: 'EVENT' })).text();
    assert.match(html, /2 matches/);
    const one1 = await c.post('/admin/checkin/lookup', { _csrf: c.csrf, registration_number: 'Zacharias Kurian', station: 'EVENT' });
    assert.equal(one1.status, 303);
  });
});

describe('reports', () => {
  test('every report renders and exports', async () => {
    const c = await staff('REPORT_MANAGER');
    const slot = await slotFor('Life of St. Carlo & Eucharistic Miracles', '10:00:00');
    for (const key of ['participants', 'activities', 'slots', 'checkins', 'accommodation', 'food', 'organizations', 'foranes', 'parishes', 'districts']) {
      assert.equal((await c.request(`/admin/reports/${key}`)).status, 200, key);
    }
    assert.equal((await c.request(`/admin/reports/roster?slot=${slot.id}`)).status, 200);
    const csv = await c.request('/admin/reports/participants?format=csv');
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(await csv.text(), /^﻿?Reg\. no,Name/);
    const xlsx = await c.request('/admin/reports/slots?format=xlsx');
    assert.equal(Buffer.from(await xlsx.arrayBuffer()).subarray(0, 2).toString(), 'PK');
    const pdf = await c.request('/admin/reports/parishes?format=pdf');
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  });

  test('CSV export neutralizes spreadsheet formulas', async () => {
    const c = await staff('REPORT_MANAGER');
    await register({ mobile: '9340000001', district: '=HYPERLINK("http://x")' });
    const csv = await (await c.request('/admin/reports/participants?format=csv')).text();
    assert.match(csv, /"'=HYPERLINK\(""http:\/\/x""\)"/);
  });
});

describe('activity and slot management', () => {
  test('admin creates an activity and a slot; it appears for booking', async () => {
    const c = await staff('ADMIN');
    const res = await c.request('/admin/activities/new', {
      method: 'POST', body: (() => { const f = new FormData(); for (const [k, v] of Object.entries({ _csrf: c.csrf, name: 'Bible Quiz', venue: 'Hall B', capacity: '25', requires_slot: 'on', active: 'on', sort_order: '200' })) f.append(k, v); return f; })(),
    });
    assert.equal(res.status, 303);
    const activityId = res.headers.get('location').split('/').pop();
    const slotRes = await c.post('/admin/slots', { _csrf: c.csrf, activity_id: activityId, date: '2099-10-10', start_time: '14:00', end_time: '15:00', capacity: '25', status: 'open', back: 'activity' });
    assert.equal(slotRes.status, 303);
    const list = await c.request('/admin/activities');
    assert.equal(list.status, 200);
    assert.match(await list.text(), /Bible Quiz/);
    assert.equal((await c.request(`/admin/activities/${activityId}`)).status, 200);
    assert.equal((await c.request('/admin/slots')).status, 200);
    const html = await (await client().request('/register')).text();
    assert.match(html, /Bible Quiz/);
    assert.match(html, /25 places left/);
  });

  test('capacity cannot be lowered below existing bookings', async () => {
    const c = await staff('ADMIN');
    const slot = await slotFor('VR Experience Show', '11:00:00');
    await register({ mobile: '9350000001' }, [slot.id]);
    await register({ mobile: '9350000002' }, [slot.id]);
    await c.post('/admin/slots', { _csrf: c.csrf, activity_id: slot.activity_id, slot_id: slot.id, date: '2099-10-10', start_time: '11:00', end_time: '12:00', capacity: '1', status: 'open' });
    assert.equal((await one('SELECT capacity FROM activity_slots WHERE id = ?', [slot.id])).capacity, 40);
    await c.post('/admin/slots', { _csrf: c.csrf, activity_id: slot.activity_id, slot_id: slot.id, date: '2099-10-10', start_time: '11:00', end_time: '12:00', capacity: '2', status: 'open' });
    assert.equal((await one('SELECT capacity FROM activity_slots WHERE id = ?', [slot.id])).capacity, 2);
    assert.ok(await one(`SELECT id FROM audit_logs WHERE action = 'SLOT_CAPACITY_CHANGED'`));
  });

  test('a slot ending before it starts runs past midnight', async () => {
    const c = await staff('ADMIN');
    const vigil = await slotFor('Night Vigil', '19:00:00');
    await c.post('/admin/slots', { _csrf: c.csrf, activity_id: vigil.activity_id, date: '2099-10-10', start_time: '23:30', end_time: '01:00', capacity: '', status: 'open' });
    const s = await one(`SELECT * FROM activity_slots WHERE activity_id = ? AND start_at = '2099-10-10 23:30:00'`, [vigil.activity_id]);
    assert.equal(s.end_at, '2099-10-11 01:00:00');
    assert.equal(s.capacity, null);
  });

  test('booked slots and activities cannot be deleted', async () => {
    const c = await staff('ADMIN');
    const slot = await slotFor('VR Experience Show', '11:00:00');
    await c.post(`/admin/slots/${slot.id}/delete`, { _csrf: c.csrf });
    assert.ok(await one('SELECT id FROM activity_slots WHERE id = ?', [slot.id]));
  });

  test('changing the event date moves every slot with it', async () => {
    const c = await staff('SUPER_ADMIN');
    const before = await slotFor('Holy Qurbana', '07:00:00');
    const res = await c.request('/admin/settings', {
      method: 'POST',
      body: (() => { const f = new FormData(); for (const [k, v] of Object.entries({
        _csrf: c.csrf, name: event.name, start_at: '2099-10-17T09:00', end_at: '2099-10-18T09:00', status: 'open', duplicate_rule: 'mobile_name',
        auto_approve: 'on', shift_slots: 'on', contact_phone: '+91 94969 35651', theme_primary: '#223366', theme_secondary: '#ffaa00',
        field_diocese: 'hidden', field_food_required: 'optional', field_food_preference: 'optional', food_options: 'Veg\nNon-veg',
      })) f.append(k, v); return f; })(),
    });
    assert.equal(res.status, 303);
    const after2 = await one('SELECT start_at FROM activity_slots WHERE id = ?', [before.id]);
    assert.equal(after2.start_at, '2099-10-18 07:00:00');
    const html = await (await client().request('/register')).text();
    assert.ok(!html.includes('name="diocese"'), 'hidden field is not on the form');
    assert.match(html, /<option >Non-veg<\/option>|<option>Non-veg<\/option>/);
    assert.match(html, /--primary: #223366/);
    // put it back for the other tests
    await query(`UPDATE events SET start_at = '2099-10-10 09:00:00', end_at = '2099-10-11 09:00:00', form_config = NULL, content = NULL WHERE id = ?`, [event.id]);
    await query(`UPDATE activity_slots s JOIN activities a ON a.id = s.activity_id SET s.start_at = s.start_at - INTERVAL 7 DAY, s.end_at = s.end_at - INTERVAL 7 DAY WHERE a.event_id = ?`, [event.id]);
  });

  test('only admins manage the event', async () => {
    const c = await staff('REGISTRATION_MANAGER');
    for (const path of ['/admin/activities', '/admin/slots', '/admin/settings', '/admin/users', '/admin/audit']) {
      assert.equal((await c.request(path)).status, 403, path);
    }
  });
});

describe('participant management', () => {
  test('admin edits details; the change is audited', async () => {
    const c = await staff('ADMIN');
    const p = await register({ mobile: '9360000001', locality: 'Old Locality' });
    const form = await (await c.request(`/admin/participants/${p.id}/edit`)).text();
    assert.match(form, /value="Old Locality"/);
    const fd = new FormData();
    for (const [k, v] of Object.entries({ ...validBody({ mobile: '9360000001', locality: 'New Locality' }), _csrf: c.csrf })) fd.append(k, v);
    const res = await c.request(`/admin/participants/${p.id}/edit`, { method: 'POST', body: fd });
    assert.equal(res.status, 303);
    assert.equal((await one('SELECT locality FROM participants WHERE id = ?', [p.id])).locality, 'New Locality');
    const log = await one(`SELECT old_value, new_value FROM audit_logs WHERE participant_id = ? AND action = 'PARTICIPANT_EDITED'`, [p.id]);
    assert.match(JSON.stringify(log), /Old Locality/);
    for (const tab of ['overview', 'contact', 'emergency', 'activities', 'documents', 'checkins', 'history']) {
      assert.equal((await c.request(`/admin/participants/${p.id}?tab=${tab}`)).status, 200, tab);
    }
  });

  test('admin adds and cancels bookings with capacity and conflict rules', async () => {
    const p = await register({ mobile: '9370000001' });
    const slot = await slotFor('Rosary Making Workshop', '15:00:00');
    const clash = await slotFor('VR Experience Show', '15:00:00');
    await query('UPDATE activity_slots SET capacity = 1 WHERE id = ?', [slot.id]);
    await addBooking(p.id, slot.id);
    await assert.rejects(addBooking(p.id, clash.id), (e) => e instanceof RegistrationError && e.code === 'CONFLICT');
    const other = await register({ mobile: '9370000002' });
    await assert.rejects(addBooking(other.id, slot.id), (e) => e.code === 'FULL');
    await addBooking(other.id, slot.id, { force: true });
    assert.equal((await one('SELECT registration_count FROM activity_slots WHERE id = ?', [slot.id])).registration_count, 2);
    await removeBooking(p.id, slot.id);
    assert.equal((await one('SELECT registration_count FROM activity_slots WHERE id = ?', [slot.id])).registration_count, 1);
  });

  test('admin deletes a test registration; its places are released and the delete is audited', async () => {
    const slot = await slotFor('Life of St. Carlo & Eucharistic Miracles', '15:00:00');
    const p = await register({ mobile: '9390000001', first_name: 'Dummy Entry' }, [slot.id]);
    const before = (await one('SELECT registration_count FROM activity_slots WHERE id = ?', [slot.id])).registration_count;

    const manager = await staff('REGISTRATION_MANAGER');
    assert.doesNotMatch(await (await manager.request(`/admin/participants/${p.id}`)).text(), /\/delete"/);
    assert.equal((await manager.post(`/admin/participants/${p.id}/delete`, { _csrf: manager.csrf })).status, 403);

    const c = await staff('ADMIN');
    assert.match(await (await c.request(`/admin/participants/${p.id}`)).text(), new RegExp(`/admin/participants/${p.id}/delete`));
    const res = await c.post(`/admin/participants/${p.id}/delete`, { _csrf: c.csrf });
    assert.equal(res.status, 303);
    assert.equal(await one('SELECT id FROM participants WHERE id = ?', [p.id]), null);
    assert.equal(await one('SELECT id FROM participant_slots WHERE participant_id = ?', [p.id]), null);
    assert.equal((await one('SELECT registration_count FROM activity_slots WHERE id = ?', [slot.id])).registration_count, before - 1);
    const log = await one(`SELECT old_value FROM audit_logs WHERE action = 'PARTICIPANT_DELETED' ORDER BY created_at DESC LIMIT 1`);
    assert.match(JSON.stringify(log), /Dummy Entry/);
    assert.equal((await c.request(`/admin/participants/${p.id}`)).status, 404);
  });

  test('participant list filters by activity, card status and sorts', async () => {
    const c = await staff('ADMIN');
    const slot = await slotFor('Life of St. Carlo & Eucharistic Miracles', '15:00:00');
    await register({ mobile: '9380000001', first_name: 'Filtered' }, [slot.id]);
    const html = await (await c.request(`/admin/participants?slot=${slot.id}&printed=no&sort=name`)).text();
    assert.match(html, /Filtered/);
    assert.match(html, /1 found/);
  });
});

describe('users', () => {
  test('admin creates a check-in volunteer who can then sign in', async () => {
    const c = await staff('ADMIN');
    const res = await c.post('/admin/users/new', { _csrf: c.csrf, name: 'Door Volunteer', email: 'door.vol@test.local', role: 'CHECKIN_STAFF', password: 'Volunteer#2026', active: 'on' });
    assert.equal(res.status, 303);
    const v = client();
    const csrf = await v.csrfFrom('/admin/login');
    const login = await v.post('/admin/login', { _csrf: csrf, email: 'door.vol@test.local', password: 'Volunteer#2026' });
    assert.equal(login.headers.get('location'), '/admin/checkin');
  });

  test('an admin cannot create a super admin', async () => {
    const c = await staff('ADMIN');
    const res = await c.post('/admin/users/new', { _csrf: c.csrf, name: 'X', email: 'x.super@test.local', role: 'SUPER_ADMIN', password: 'Password#99999', active: 'on' });
    assert.equal(res.status, 422);
    assert.equal(await one(`SELECT id FROM admin_users WHERE email = 'x.super@test.local'`), null);
  });
});
