import { one, query, resetDb, slotFor, validBody } from './helpers.js';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closePool } from '../src/db.js';
import { CheckinError, checkIn } from '../src/services/checkin.js';
import { activityCardPdf, checkinUrl, idCardPdf } from '../src/services/pdf.js';
import { changeStatus, getParticipantBy, getParticipantSlots, registerParticipant, validateRegistration } from '../src/services/registration.js';

let event;
let adoration;
let participant;

async function register(overrides = {}, slotIds = []) {
  const { values } = validateRegistration(event, validBody(overrides), { hasPhoto: true });
  return registerParticipant(event.id, values, slotIds);
}

async function rejects(promise, code) {
  await assert.rejects(promise, (err) => err instanceof CheckinError && err.code === code);
}

before(async () => {
  event = await resetDb();
  adoration = await slotFor('Adoration', '10:00:00');
  participant = await register({}, [adoration.id]);
});
after(closePool);

describe('check-in', () => {
  test('event entry check-in is recorded once', async () => {
    await checkIn(participant.id, null, { ip: '127.0.0.1', userAgent: 'test' });
    const rows = await query('SELECT * FROM checkins WHERE participant_id = ?', [participant.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].checkin_type, 'EVENT_ENTRY');
    await rejects(checkIn(participant.id, null), 'DUPLICATE');
  });

  test('simultaneous scans of the same card record a single check-in', async () => {
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => checkIn(participant.id, adoration.id)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'DUPLICATE'));
    assert.equal((await one('SELECT COUNT(*) AS n FROM checkins WHERE slot_id = ?', [adoration.id])).n, 1);
  });

  test('activity check-in requires a booking for that slot', async () => {
    const vr = await slotFor('VR Experience Show', '15:00:00');
    await rejects(checkIn(participant.id, vr.id), 'NOT_BOOKED');
  });

  test('pending or cancelled registrations cannot check in', async () => {
    const p = await register();
    await changeStatus(p.id, 'cancel');
    await rejects(checkIn(p.id, null), 'NOT_APPROVED');
  });

  test('check-in status shows on the participant bookings', async () => {
    const bookings = await getParticipantSlots(participant.id);
    assert.equal(bookings.length, 1);
    assert.ok(bookings[0].checked_in_at);
  });
});

describe('QR code and PDFs', () => {
  test('QR payload is a check-in URL with the random token and no personal data', () => {
    const url = checkinUrl(participant);
    assert.equal(url, `http://localhost:3999/checkin/${participant.qr_token}`);
    assert.ok(!url.includes(participant.mobile) && !url.includes(participant.registration_number));
  });

  test('ID card PDF has front and back pages', async () => {
    const p = await getParticipantBy('id', participant.id);
    const pdf = await idCardPdf(event, p);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.equal(pdf.toString('latin1').match(/\/Type \/Page\b/g).length, 2);
  });

  test('activity card PDF renders bookings and open programme items, and is repeatable', async () => {
    const p = await getParticipantBy('id', participant.id);
    const bookings = await getParticipantSlots(p.id);
    const open = [{ activity_name: 'Holy Qurbana', venue: 'Central Stage', start_at: '2099-10-11 07:00:00', end_at: '2099-10-11 09:00:00' }];
    const a = await activityCardPdf(event, p, bookings, open);
    const b = await activityCardPdf(event, p, bookings, open);
    assert.equal(a.subarray(0, 5).toString(), '%PDF-');
    assert.ok(Math.abs(a.length - b.length) < 64, 'same input gives the same document');
  });

  test('activity card paginates a long booking list', async () => {
    const p = await getParticipantBy('id', participant.id);
    const many = Array.from({ length: 40 }, (_, i) => ({
      activity_name: `Activity ${i}`, venue: 'Hall', label: null,
      start_at: `2099-10-10 ${String(10 + (i % 9)).padStart(2, '0')}:00:00`, end_at: `2099-10-10 ${String(11 + (i % 9)).padStart(2, '0')}:00:00`,
    }));
    const pdf = await activityCardPdf(event, p, many, []);
    assert.ok(pdf.toString('latin1').match(/\/Type \/Page\b/g).length >= 2);
  });
});
