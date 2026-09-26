import { one, query, resetDb, slotFor, validBody } from './helpers.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closePool } from '../src/db.js';
import {
  RegistrationError, changeStatus, findConflicts, registerParticipant, validateRegistration,
} from '../src/services/registration.js';

let event;

async function register(overrides = {}, slotIds = []) {
  const { values, errors } = validateRegistration(event, validBody(overrides), { hasPhoto: true });
  assert.deepEqual(errors, {});
  return registerParticipant(event.id, values, slotIds);
}

async function rejects(promise, code) {
  await assert.rejects(promise, (err) => err instanceof RegistrationError && err.code === code);
}

before(async () => { event = await resetDb(); });
after(closePool);

describe('validation', () => {
  test('accepts a complete form and normalizes values', () => {
    const { values, errors } = validateRegistration(event, validBody({ mobile: '98470 12345', email: 'John@Example.COM' }), { hasPhoto: true });
    assert.deepEqual(errors, {});
    assert.equal(values.mobile, '9847012345');
    assert.equal(values.email, 'john@example.com');
    assert.ok(!('accommodation_required' in values), 'hidden fields are not collected');
  });

  test('reports missing required fields and consents', () => {
    const { errors } = validateRegistration(event, {});
    for (const f of ['first_name', 'mobile', 'date_of_birth', 'emergency_mobile', 'consent_information', 'consent_rules']) {
      assert.ok(errors[f], `expected an error for ${f}`);
    }
    assert.ok(!errors.consent_media, 'media consent is optional');
  });

  test('rejects invalid phone, email, date and non-English names', () => {
    const { errors } = validateRegistration(event, validBody({
      mobile: '12345', email: 'nope', date_of_birth: '2150-01-01', first_name: 'ജോൺ',
    }));
    assert.ok(errors.mobile && errors.email && errors.date_of_birth && errors.first_name);
  });

  test('photo is required unless hidden in form_config', () => {
    assert.ok(validateRegistration(event, validBody()).errors.profile_photo);
    assert.equal(validateRegistration(event, validBody(), { hasPhoto: true }).errors.profile_photo, undefined);
    const noPhoto = { ...event, form_config: JSON.stringify({ profile_photo: 'hidden', parish: 'optional', first_name: 'hidden' }) };
    const { errors } = validateRegistration(noPhoto, validBody({ parish: '' }));
    assert.deepEqual(errors, {});
    assert.ok(validateRegistration(noPhoto, validBody({ first_name: '' })).errors.first_name, 'locked fields cannot be hidden');
  });

  test('accommodation, when switched back on in settings, drops details unless requested', () => {
    const withAccommodation = { ...event, form_config: JSON.stringify({ accommodation_required: 'optional', arrival_at: 'optional' }) };
    const { values } = validateRegistration(withAccommodation, validBody({ arrival_at: '2099-10-10T08:00' }));
    assert.equal(values.arrival_at, null);
    const on = validateRegistration(withAccommodation, validBody({ accommodation_required: 'on', arrival_at: '2099-10-10T08:00' }));
    assert.equal(on.values.arrival_at, '2099-10-10 08:00:00');
  });
});

describe('registration', () => {
  beforeEach(async () => { event = await resetDb(); });

  test('creates a participant with a sequential registration number and books slots', async () => {
    const adoration = await slotFor('Adoration', '10:00:00');
    const theatre = await slotFor('Theatre', '13:00:00');
    const p1 = await register({}, [adoration.id, theatre.id]);
    const p2 = await register();
    assert.equal(p1.registration_number, '9TO9-000001');
    assert.equal(p2.registration_number, '9TO9-000002');
    assert.equal(p1.status, 'approved');
    assert.match(p1.qr_token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(p1.qr_token, p1.access_token);
    assert.equal((await one('SELECT registration_count FROM activity_slots WHERE id = ?', [adoration.id])).registration_count, 1);
    assert.equal((await query('SELECT * FROM participant_slots WHERE participant_id = ?', [p1.id])).length, 2);
    assert.ok(await one('SELECT * FROM emergency_contacts WHERE participant_id = ?', [p1.id]));
  });

  test('registration numbers are never reused after a cancellation', async () => {
    const p1 = await register();
    await changeStatus(p1.id, 'cancel');
    const p2 = await register();
    assert.equal(p2.registration_number, '9TO9-000002');
  });

  test('pending status when auto-approve is off', async () => {
    await query('UPDATE events SET auto_approve = 0 WHERE id = ?', [event.id]);
    const p = await register();
    assert.equal(p.status, 'pending');
  });

  test('duplicate rule mobile_name blocks the same person but allows a sibling on the same phone', async () => {
    await register({ mobile: '9000000001', first_name: 'Anna' });
    await rejects(register({ mobile: '9000000001', first_name: 'anna' }), 'DUPLICATE');
    const sibling = await register({ mobile: '9000000001', first_name: 'Tom' });
    assert.ok(sibling.id);
  });

  test('duplicate rule mobile blocks any second registration on the phone', async () => {
    await query(`UPDATE events SET duplicate_rule = 'mobile' WHERE id = ?`, [event.id]);
    await register({ mobile: '9000000002', first_name: 'Anna' });
    await rejects(register({ mobile: '9000000002', first_name: 'Tom' }), 'DUPLICATE');
  });

  test('a cancelled registration does not count as a duplicate', async () => {
    const p = await register({ mobile: '9000000003' });
    await changeStatus(p.id, 'cancel');
    assert.ok((await register({ mobile: '9000000003' })).id);
  });

  test('rejects overlapping slots unless the event allows overlaps', async () => {
    const adoration = await slotFor('Adoration', '10:00:00');
    const vr = await slotFor('VR Experience Show', '10:00:00');
    await rejects(register({}, [adoration.id, vr.id]), 'CONFLICT');
    assert.equal((await one('SELECT registration_count FROM activity_slots WHERE id = ?', [adoration.id])).registration_count, 0);

    await query('UPDATE events SET allow_overlapping_bookings = 1 WHERE id = ?', [event.id]);
    assert.ok((await register({}, [adoration.id, vr.id])).id);
  });

  test('back-to-back slots do not conflict', () => {
    const a = { start_at: '2099-10-10 10:00:00', end_at: '2099-10-10 11:00:00' };
    const b = { start_at: '2099-10-10 11:00:00', end_at: '2099-10-10 12:00:00' };
    const c = { start_at: '2099-10-10 10:30:00', end_at: '2099-10-10 12:00:00' };
    assert.equal(findConflicts([a, b]).length, 0);
    assert.equal(findConflicts([a, b, c]).length, 2);
  });

  test('refuses a full slot', async () => {
    const rosary = await slotFor('Rosary Making Workshop', '10:00:00');
    await query('UPDATE activity_slots SET capacity = 2 WHERE id = ?', [rosary.id]);
    await register({}, [rosary.id]);
    await register({}, [rosary.id]);
    await rejects(register({}, [rosary.id]), 'FULL');
    assert.equal((await one('SELECT registration_count FROM activity_slots WHERE id = ?', [rosary.id])).registration_count, 2);
  });

  test('a failed booking rolls back the whole registration', async () => {
    const rosary = await slotFor('Rosary Making Workshop', '11:00:00');
    const theatre = await slotFor('Theatre', '13:00:00');
    await query('UPDATE activity_slots SET capacity = 0 WHERE id = ?', [rosary.id]);
    await rejects(register({}, [theatre.id, rosary.id]), 'FULL');
    assert.equal((await one('SELECT COUNT(*) AS n FROM participants')).n, 0);
    assert.equal((await one('SELECT registration_count FROM activity_slots WHERE id = ?', [theatre.id])).registration_count, 0);
    assert.equal((await one('SELECT registration_seq FROM events WHERE id = ?', [event.id])).registration_seq, 0);
  });

  test('concurrent registrations never overbook a slot', async () => {
    const rosary = await slotFor('Rosary Making Workshop', '12:00:00'); // capacity 20
    const attempts = 45;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, (_, i) => register({ mobile: `97${String(i).padStart(8, '0')}` }, [rosary.id])),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 20);
    assert.ok(failed.every((r) => r.reason.code === 'FULL'), failed.map((r) => r.reason.message).join('\n'));
    assert.equal((await one('SELECT registration_count FROM activity_slots WHERE id = ?', [rosary.id])).registration_count, 20);
    assert.equal((await one(`SELECT COUNT(*) AS n FROM participant_slots WHERE slot_id = ? AND status = 'confirmed'`, [rosary.id])).n, 20);
    const numbers = ok.map((r) => r.value.registration_number).sort();
    assert.equal(new Set(numbers).size, 20);
    assert.deepEqual(numbers, Array.from({ length: 20 }, (_, i) => `9TO9-${String(i + 1).padStart(6, '0')}`));
  });

  test('rejects slots from inactive or open-to-all activities', async () => {
    const qurbana = await slotFor('Holy Qurbana', '07:00:00');
    await rejects(register({}, [qurbana.id]), 'SLOT_UNAVAILABLE');
    const closed = await slotFor('Theatre', '10:00:00');
    await query(`UPDATE activity_slots SET status = 'closed' WHERE id = ?`, [closed.id]);
    await rejects(register({}, [closed.id]), 'SLOT_UNAVAILABLE');
  });

  test('refuses registration when the event is closed or outside the window', async () => {
    await query(`UPDATE events SET status = 'closed' WHERE id = ?`, [event.id]);
    await rejects(register(), 'CLOSED');
    await query(`UPDATE events SET status = 'open', registration_close_at = '2000-01-01 00:00:00' WHERE id = ?`, [event.id]);
    await rejects(register(), 'CLOSED');
  });

  test('cancel releases places, reinstate re-books them, and reinstate is refused when full', async () => {
    const vr = await slotFor('VR Experience Show', '14:00:00');
    await query('UPDATE activity_slots SET capacity = 1 WHERE id = ?', [vr.id]);
    const p = await register({}, [vr.id]);
    await changeStatus(p.id, 'cancel');
    assert.equal((await one('SELECT registration_count FROM activity_slots WHERE id = ?', [vr.id])).registration_count, 0);

    await changeStatus(p.id, 'reinstate');
    assert.equal((await one('SELECT registration_count FROM activity_slots WHERE id = ?', [vr.id])).registration_count, 1);

    await changeStatus(p.id, 'cancel');
    await register({}, [vr.id]); // someone else takes the place
    await rejects(changeStatus(p.id, 'reinstate'), 'FULL');
    assert.equal((await one('SELECT status FROM participants WHERE id = ?', [p.id])).status, 'cancelled');
  });

  test('status changes are audited', async () => {
    const p = await register();
    await changeStatus(p.id, 'cancel');
    const actions = (await query('SELECT action FROM audit_logs WHERE participant_id = ? ORDER BY created_at', [p.id])).map((r) => r.action);
    assert.ok(actions.includes('REGISTRATION_CREATED') && actions.includes('STATUS_CANCELLED'));
  });
});
