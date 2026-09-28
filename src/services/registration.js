import crypto from 'node:crypto';
import { config } from '../config.js';
import { one, query, tx } from '../db.js';
import { CONSENTS, LATIN_NAME_PATTERN, formFields } from '../fields.js';
import { nowLocal, timeRange } from '../lib/format.js';
import { audit } from './audit.js';

export class RegistrationError extends Error {
  constructor(message, { code = 'INVALID', fieldErrors = {}, slotIds = [] } = {}) {
    super(message);
    this.code = code;
    this.fieldErrors = fieldErrors;
    this.slotIds = slotIds;
  }
}

export const newId = () => crypto.randomUUID();
export const newToken = () => crypto.randomBytes(32).toString('base64url');

export async function getEvent(code = config.eventCode) {
  return one('SELECT * FROM events WHERE event_code = ?', [code]);
}

export function registrationState(event, now = nowLocal(config.tzOffset)) {
  if (!event || event.status !== 'open') return { open: false, reason: 'Registration is not open.' };
  if (event.registration_open_at && now < event.registration_open_at) {
    return { open: false, reason: 'Registration has not opened yet.' };
  }
  if (event.registration_close_at && now >= event.registration_close_at) {
    return { open: false, reason: 'Registration has closed.' };
  }
  return { open: true };
}

/** Activities with their slots and live availability, in schedule order. */
export async function getSchedule(eventId, { bookableOnly = false } = {}) {
  const rows = await query(
    `SELECT a.id AS activity_id, a.name, a.description, a.venue, a.image_path, a.requires_slot, a.capacity AS activity_capacity,
            s.id AS slot_id, s.label, s.start_at, s.end_at, s.capacity, s.registration_count, s.status
       FROM activities a
       LEFT JOIN activity_slots s ON s.activity_id = a.id
      WHERE a.event_id = ? AND a.active = 1 ${bookableOnly ? 'AND a.requires_slot = 1' : ''}
      ORDER BY a.sort_order, a.name, s.start_at`,
    [eventId],
  );
  const activities = [];
  const byId = new Map();
  for (const r of rows) {
    let a = byId.get(r.activity_id);
    if (!a) {
      a = { id: r.activity_id, name: r.name, description: r.description, venue: r.venue, image: r.image_path,
        requiresSlot: !!r.requires_slot, capacity: r.activity_capacity, slots: [] };
      byId.set(r.activity_id, a);
      activities.push(a);
    }
    if (r.slot_id) {
      const available = r.capacity == null ? null : Math.max(0, r.capacity - r.registration_count);
      a.slots.push({
        id: r.slot_id, label: r.label, start_at: r.start_at, end_at: r.end_at,
        capacity: r.capacity, booked: r.registration_count, available,
        full: available === 0, open: r.status === 'open',
      });
    }
  }
  return activities;
}

// ---------------------------------------------------------------- validation

// 10-digit Indian number, or an international number with its + country code
const MOBILE_RE = /^(\d{10}|\+\d{8,15})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_RE = new RegExp(`^${LATIN_NAME_PATTERN}$`);

export const normalizePhone = (v) => String(v || '').replace(/[\s\-().]/g, '');

/**
 * Validates submitted form values against the event's field configuration.
 * Returns { values, errors } where values are ready for the database.
 */
export function validateRegistration(event, body, { hasPhoto = false, adminEdit = false } = {}) {
  const fields = formFields(event);
  const values = {};
  const errors = {};

  for (const f of fields) {
    if (f.type === 'photo') {
      if (f.required && !hasPhoto && !adminEdit) errors[f.name] = 'Please add a photograph.';
      continue;
    }
    if (f.type === 'checkbox') {
      values[f.name] = body[f.name] === 'on' || body[f.name] === '1' || body[f.name] === true;
      continue;
    }
    // fields that only apply when a parent checkbox is ticked
    if (f.showIf && !(body[f.showIf] === 'on' || body[f.showIf] === '1' || body[f.showIf] === true)) {
      values[f.name] = null;
      continue;
    }

    let v = typeof body[f.name] === 'string' ? body[f.name].trim() : '';
    if (!v) {
      values[f.name] = null;
      if (f.required) errors[f.name] = `${f.label} is required.`;
      continue;
    }
    if (f.max && v.length > f.max) errors[f.name] = `${f.label} is too long (max ${f.max} characters).`;

    if (f.type === 'tel') {
      v = normalizePhone(v);
      // numbers outside India are stored with their country code; Indian numbers as 10 digits
      const cc = f.countryCode && typeof body[`${f.name}_cc`] === 'string' ? body[`${f.name}_cc`].trim() : '';
      if (cc && cc !== '+91' && /^\+\d{1,4}$/.test(cc) && !v.startsWith('+')) v = cc + v;
      if (/^\+91\d{10}$/.test(v)) v = v.slice(3);
      // Indian numbers are often typed with a trunk 0 or the 91 prefix: 09496935651, 919496935651
      else if (/^0\d{10}$/.test(v)) v = v.slice(1);
      else if (/^91\d{10}$/.test(v)) v = v.slice(2);
      if (!MOBILE_RE.test(v)) errors[f.name] = 'Enter a valid phone number.';
    } else if (f.type === 'email') {
      v = v.toLowerCase();
      if (!EMAIL_RE.test(v)) errors[f.name] = 'Enter a valid email address.';
    } else if (f.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) errors[f.name] = 'Enter a valid date.';
      else if (v < '1900-01-01' || v >= event.start_at.slice(0, 10)) errors[f.name] = 'Enter a valid date of birth.';
    } else if (f.type === 'datetime-local') {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) errors[f.name] = 'Enter a valid date and time.';
      else v = `${v.replace('T', ' ')}:00`;
    } else if (f.type === 'select') {
      if (!f.options.includes(v)) errors[f.name] = `Choose a valid ${f.label.toLowerCase()}.`;
    } else if (f.latin) {
      // cards are printed with Latin fonts, so names must be typed in English letters
      if (!NAME_RE.test(v)) errors[f.name] = 'Please type the name in English letters.';
    }
    values[f.name] = v;
  }

  if (values.arrival_at && values.departure_at && values.departure_at <= values.arrival_at) {
    errors.departure_at = 'Departure must be after arrival.';
  }

  for (const c of adminEdit ? [] : CONSENTS) {
    values[c.name] = body[c.name] === 'on' || body[c.name] === '1' || body[c.name] === true;
    if (c.required && !values[c.name]) errors[c.name] = 'This confirmation is required.';
  }

  return { values, errors };
}

export function parseSlotIds(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const ids = [...new Set(list.map(String))];
  return ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
}

/** Pairs of selected slots whose times overlap. Slots touching end-to-start do not overlap. */
export function findConflicts(slots) {
  const sorted = [...slots].sort((a, b) => (a.start_at < b.start_at ? -1 : 1));
  const conflicts = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].start_at < sorted[i].end_at; j++) {
      conflicts.push([sorted[i], sorted[j]]);
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------- registration

const PARTICIPANT_COLUMNS = [
  'first_name', 'middle_name', 'last_name', 'preferred_name', 'date_of_birth', 'gender',
  'mobile', 'whatsapp', 'email', 'address', 'locality', 'district', 'state', 'pin_code', 'country',
  'parish', 'diocese', 'organization', 'institution', 'youth_group', 'coordinator_name', 'coordinator_mobile',
  'accommodation_required', 'arrival_at', 'departure_at', 'accommodation_notes',
  'food_required', 'food_preference', 'dietary_notes',
  'consent_information', 'consent_rules', 'consent_media',
];

async function findDuplicate(conn, event, v) {
  const rule = event.duplicate_rule;
  let sql;
  let params;
  if (rule === 'mobile') {
    sql = 'mobile = ?'; params = [v.mobile];
  } else if (rule === 'email') {
    if (!v.email) return null;
    sql = 'email = ?'; params = [v.email];
  } else if (rule === 'mobile_name') {
    // same phone + same first name + same date of birth: lets siblings share a parent's phone
    sql = 'mobile = ? AND first_name = ? AND (date_of_birth <=> ?)';
    params = [v.mobile, v.first_name, v.date_of_birth];
  } else {
    return null;
  }
  const [rows] = await conn.query(
    `SELECT registration_number FROM participants
      WHERE event_id = ? AND status <> 'cancelled' AND ${sql} LIMIT 1`,
    [event.id, ...params],
  );
  return rows[0] || null;
}

/**
 * Creates a participant and books the chosen slots atomically.
 *
 * Concurrency: the event row is locked FOR UPDATE first, which serializes registrations
 * for the event (sequence number + duplicate check). The chosen slot rows are then locked
 * FOR UPDATE and their counts checked and incremented in the same transaction, so two
 * people can never both take the last place in a slot.
 */
export async function registerParticipant(eventId, values, slotIds, { photoPath = null, ip = null } = {}) {
  return tx(async (conn) => {
    const [[event]] = await conn.query('SELECT * FROM events WHERE id = ? FOR UPDATE', [eventId]);
    const state = registrationState(event);
    if (!state.open) throw new RegistrationError(state.reason, { code: 'CLOSED' });

    const dup = await findDuplicate(conn, event, values);
    if (dup) {
      throw new RegistrationError(
        `You are already registered (registration number ${dup.registration_number}). Please contact the help desk if you need to change your registration.`,
        { code: 'DUPLICATE' },
      );
    }

    let slots = [];
    if (slotIds.length) {
      // lock in a fixed order so concurrent transactions cannot deadlock each other
      const ordered = [...slotIds].sort();
      const [rows] = await conn.query(
        `SELECT s.*, a.name AS activity_name
           FROM activity_slots s JOIN activities a ON a.id = s.activity_id
          WHERE s.id IN (?) AND a.event_id = ? AND a.active = 1 AND a.requires_slot = 1
          ORDER BY s.id FOR UPDATE`,
        [ordered, event.id],
      );
      slots = rows;
      const missing = slotIds.filter((id) => !rows.some((r) => r.id === id));
      const closed = rows.filter((r) => r.status !== 'open').map((r) => r.id);
      if (missing.length || closed.length) {
        throw new RegistrationError('One or more selected time slots are no longer available. Please review your selection.', {
          code: 'SLOT_UNAVAILABLE', slotIds: [...missing, ...closed],
        });
      }

      // one time slot per activity
      const repeated = slots.filter((s) => slots.some((o) => o !== s && o.activity_id === s.activity_id));
      if (repeated.length) {
        throw new RegistrationError(
          `You can book only one time slot for ${repeated[0].activity_name}. Please keep one and untick the others.`,
          { code: 'SAME_ACTIVITY', slotIds: repeated.map((s) => s.id) },
        );
      }

      if (!event.allow_overlapping_bookings) {
        const conflicts = findConflicts(slots);
        if (conflicts.length) {
          const [a, b] = conflicts[0];
          throw new RegistrationError(
            `Time conflict: ${a.activity_name} (${timeRange(a.start_at, a.end_at)}) overlaps ${b.activity_name} (${timeRange(b.start_at, b.end_at)}). Please choose only one.`,
            { code: 'CONFLICT', slotIds: conflicts.flat().map((s) => s.id) },
          );
        }
      }

      const full = slots.filter((s) => s.capacity != null && s.registration_count >= s.capacity);
      if (full.length) {
        throw new RegistrationError(
          `Sorry, these slots just filled up: ${full.map((s) => `${s.activity_name} ${timeRange(s.start_at, s.end_at)}`).join('; ')}. Please choose another time.`,
          { code: 'FULL', slotIds: full.map((s) => s.id) },
        );
      }
    }

    const seq = event.registration_seq + 1;
    await conn.query('UPDATE events SET registration_seq = ? WHERE id = ?', [seq, event.id]);
    const registrationNumber = `${event.event_code}-${String(seq).padStart(6, '0')}`;

    const id = newId();
    const participant = {
      id,
      event_id: event.id,
      registration_number: registrationNumber,
      status: event.auto_approve ? 'approved' : 'pending',
      qr_token: newToken(),
      access_token: newToken(),
      profile_photo_path: photoPath,
    };
    for (const col of PARTICIPANT_COLUMNS) {
      // fields hidden on the form are not collected: leave them to the column defaults
      if (!(col in values)) continue;
      const v = values[col];
      participant[col] = typeof v === 'boolean' ? (v ? 1 : 0) : v ?? null;
    }
    await conn.query('INSERT INTO participants SET ?', [participant]);

    if (values.emergency_name || values.emergency_mobile) {
      await conn.query('INSERT INTO emergency_contacts SET ?', [{
        id: newId(),
        participant_id: id,
        name: values.emergency_name || '',
        relationship: values.emergency_relationship ?? null,
        mobile: values.emergency_mobile || '',
        alternate_mobile: values.emergency_alternate_mobile ?? null,
        email: values.emergency_email ?? null,
        address: values.emergency_address ?? null,
      }]);
    }

    for (const s of slots) {
      await conn.query('INSERT INTO participant_slots (id, participant_id, slot_id) VALUES (?, ?, ?)', [newId(), id, s.id]);
      await conn.query('UPDATE activity_slots SET registration_count = registration_count + 1 WHERE id = ?', [s.id]);
    }

    await audit(conn, { participantId: id, action: 'REGISTRATION_CREATED', newValue: { registrationNumber, slots: slotIds }, ip });
    return participant;
  });
}

// ---------------------------------------------------------------- lookups

export async function getParticipantBy(column, value) {
  if (!['id', 'qr_token', 'access_token', 'registration_number'].includes(column)) throw new Error('bad column');
  const p = await one(
    `SELECT p.*, e.name AS emergency_name, e.relationship AS emergency_relationship, e.mobile AS emergency_mobile,
            e.alternate_mobile AS emergency_alternate_mobile, e.email AS emergency_email, e.address AS emergency_address
       FROM participants p LEFT JOIN emergency_contacts e ON e.participant_id = p.id
      WHERE p.${column} = ?`,
    [value],
  );
  return p;
}

export async function getParticipantSlots(participantId) {
  return query(
    `SELECT ps.id AS booking_id, ps.status AS booking_status, s.id AS slot_id, s.label, s.start_at, s.end_at,
            a.name AS activity_name, a.venue,
            c.checked_in_at
       FROM participant_slots ps
       JOIN activity_slots s ON s.id = ps.slot_id
       JOIN activities a ON a.id = s.activity_id
       LEFT JOIN checkins c ON c.dedupe_key = CONCAT(ps.participant_id, ':', s.id)
      WHERE ps.participant_id = ? AND ps.status = 'confirmed'
      ORDER BY s.start_at`,
    [participantId],
  );
}

// ---------------------------------------------------------------- admin status changes

const STATUS_ACTIONS = { approve: 'approved', reject: 'rejected', cancel: 'cancelled', reinstate: 'approved' };

/**
 * Changes a participant's status. Rejecting or cancelling releases their slot places;
 * reinstating re-books them only if every slot still has room.
 */
export async function changeStatus(participantId, action, { adminId = null, ip = null } = {}) {
  const next = STATUS_ACTIONS[action];
  if (!next) throw new RegistrationError('Unknown action.');
  return tx(async (conn) => {
    const [[p]] = await conn.query('SELECT id, status FROM participants WHERE id = ? FOR UPDATE', [participantId]);
    if (!p) throw new RegistrationError('Participant not found.', { code: 'NOT_FOUND' });
    const releasing = ['rejected', 'cancelled'];
    const wasReleased = releasing.includes(p.status);
    const willRelease = releasing.includes(next);

    const [bookings] = await conn.query(
      `SELECT ps.id, ps.slot_id FROM participant_slots ps WHERE ps.participant_id = ? AND ps.status = ?`,
      [participantId, wasReleased ? 'cancelled' : 'confirmed'],
    );
    const slotIds = bookings.map((b) => b.slot_id).sort();
    if (!wasReleased && willRelease && slotIds.length) {
      await conn.query('SELECT id FROM activity_slots WHERE id IN (?) ORDER BY id FOR UPDATE', [slotIds]);
      await conn.query(
        'UPDATE activity_slots SET registration_count = GREATEST(registration_count, 1) - 1 WHERE id IN (?)', [slotIds]);
      await conn.query(`UPDATE participant_slots SET status = 'cancelled' WHERE participant_id = ? AND status = 'confirmed'`, [participantId]);
    } else if (wasReleased && !willRelease && slotIds.length) {
      const [slots] = await conn.query('SELECT * FROM activity_slots WHERE id IN (?) ORDER BY id FOR UPDATE', [slotIds]);
      const full = slots.filter((s) => s.capacity != null && s.registration_count >= s.capacity);
      if (full.length) {
        throw new RegistrationError('Cannot reinstate: some of this participant\'s slots are now full. Remove those bookings first.', { code: 'FULL' });
      }
      await conn.query('UPDATE activity_slots SET registration_count = registration_count + 1 WHERE id IN (?)', [slotIds]);
      await conn.query(`UPDATE participant_slots SET status = 'confirmed' WHERE participant_id = ? AND status = 'cancelled'`, [participantId]);
    }

    await conn.query('UPDATE participants SET status = ? WHERE id = ?', [next, participantId]);
    await audit(conn, { adminId, participantId, action: `STATUS_${next.toUpperCase()}`, oldValue: { status: p.status }, newValue: { status: next }, ip });
    return next;
  });
}

// ---------------------------------------------------------------- admin booking changes

/**
 * Adds a booking for an existing participant, with the same capacity and conflict rules as
 * registration. `force` lets an admin book past capacity or over a conflict (recorded in the audit).
 */
export async function addBooking(participantId, slotId, { adminId = null, ip = null, force = false } = {}) {
  return tx(async (conn) => {
    const [[p]] = await conn.query('SELECT id, event_id, status FROM participants WHERE id = ? FOR UPDATE', [participantId]);
    if (!p) throw new RegistrationError('Participant not found.', { code: 'NOT_FOUND' });
    if (['cancelled', 'rejected'].includes(p.status)) throw new RegistrationError('Reinstate the registration before adding bookings.');
    const [[event]] = await conn.query('SELECT * FROM events WHERE id = ?', [p.event_id]);
    const [[slot]] = await conn.query(
      `SELECT s.*, a.name AS activity_name FROM activity_slots s JOIN activities a ON a.id = s.activity_id
        WHERE s.id = ? AND a.event_id = ? AND a.requires_slot = 1 FOR UPDATE`, [slotId, p.event_id]);
    if (!slot) throw new RegistrationError('That slot does not exist.', { code: 'SLOT_UNAVAILABLE' });

    const [[existing]] = await conn.query('SELECT id, status FROM participant_slots WHERE participant_id = ? AND slot_id = ?', [participantId, slotId]);
    if (existing?.status === 'confirmed') throw new RegistrationError('Already booked for this slot.');

    if (!force) {
      if (slot.capacity != null && slot.registration_count >= slot.capacity) {
        throw new RegistrationError(`${slot.activity_name} ${timeRange(slot.start_at, slot.end_at)} is full.`, { code: 'FULL' });
      }
      const [[sibling]] = await conn.query(
        `SELECT s.start_at, s.end_at FROM participant_slots ps JOIN activity_slots s ON s.id = ps.slot_id
          WHERE ps.participant_id = ? AND ps.status = 'confirmed' AND s.activity_id = ? LIMIT 1`,
        [participantId, slot.activity_id]);
      if (sibling) {
        throw new RegistrationError(`Already booked for ${slot.activity_name} (${timeRange(sibling.start_at, sibling.end_at)}). Only one time slot per activity — remove that booking first.`, { code: 'SAME_ACTIVITY' });
      }
      if (!event.allow_overlapping_bookings) {
        const [clash] = await conn.query(
          `SELECT a.name, s.start_at, s.end_at FROM participant_slots ps
             JOIN activity_slots s ON s.id = ps.slot_id JOIN activities a ON a.id = s.activity_id
            WHERE ps.participant_id = ? AND ps.status = 'confirmed' AND s.start_at < ? AND s.end_at > ? LIMIT 1`,
          [participantId, slot.end_at, slot.start_at]);
        if (clash.length) {
          throw new RegistrationError(`Time conflict with ${clash[0].name} (${timeRange(clash[0].start_at, clash[0].end_at)}).`, { code: 'CONFLICT' });
        }
      }
    }

    if (existing) await conn.query(`UPDATE participant_slots SET status = 'confirmed' WHERE id = ?`, [existing.id]);
    else await conn.query('INSERT INTO participant_slots (id, participant_id, slot_id) VALUES (?, ?, ?)', [newId(), participantId, slotId]);
    await conn.query('UPDATE activity_slots SET registration_count = registration_count + 1 WHERE id = ?', [slotId]);
    await audit(conn, { adminId, participantId, action: 'BOOKING_ADDED', newValue: { slot: `${slot.activity_name} ${slot.start_at}`, forced: force }, ip });
  });
}

export async function removeBooking(participantId, slotId, { adminId = null, ip = null } = {}) {
  return tx(async (conn) => {
    const [[slot]] = await conn.query(
      `SELECT s.*, a.name AS activity_name FROM activity_slots s JOIN activities a ON a.id = s.activity_id WHERE s.id = ? FOR UPDATE`, [slotId]);
    const [res] = await conn.query(
      `UPDATE participant_slots SET status = 'cancelled' WHERE participant_id = ? AND slot_id = ? AND status = 'confirmed'`, [participantId, slotId]);
    if (!slot || !res.affectedRows) throw new RegistrationError('No such booking.');
    await conn.query('UPDATE activity_slots SET registration_count = GREATEST(registration_count, 1) - 1 WHERE id = ?', [slotId]);
    await audit(conn, { adminId, participantId, action: 'BOOKING_CANCELLED', oldValue: { slot: `${slot.activity_name} ${slot.start_at}` }, ip });
  });
}

/**
 * Permanently deletes a registration (e.g. a test entry). Confirmed bookings give their places
 * back; bookings, check-ins, documents and emergency contacts go with it (ON DELETE CASCADE).
 * Returns the photo path so the caller can remove the file.
 */
export async function deleteParticipant(participantId, { adminId = null, ip = null } = {}) {
  return tx(async (conn) => {
    const [[p]] = await conn.query(
      'SELECT id, registration_number, first_name, mobile, status, profile_photo_path FROM participants WHERE id = ? FOR UPDATE', [participantId]);
    if (!p) throw new RegistrationError('Participant not found.', { code: 'NOT_FOUND' });
    const [bookings] = await conn.query(
      `SELECT slot_id FROM participant_slots WHERE participant_id = ? AND status = 'confirmed'`, [participantId]);
    const slotIds = bookings.map((b) => b.slot_id).sort();
    if (slotIds.length) {
      await conn.query('SELECT id FROM activity_slots WHERE id IN (?) ORDER BY id FOR UPDATE', [slotIds]);
      await conn.query(
        'UPDATE activity_slots SET registration_count = GREATEST(registration_count, 1) - 1 WHERE id IN (?)', [slotIds]);
    }
    await conn.query('DELETE FROM participants WHERE id = ?', [participantId]);
    await audit(conn, {
      adminId, action: 'PARTICIPANT_DELETED', ip,
      oldValue: { registration_number: p.registration_number, name: p.first_name, mobile: p.mobile, status: p.status },
    });
    return { registrationNumber: p.registration_number, photoPath: p.profile_photo_path };
  });
}

/** Admin edit of a participant's details; records changed fields in the audit log. */
export async function updateParticipant(participantId, values, { photoPath, adminId = null, ip = null } = {}) {
  return tx(async (conn) => {
    const [[before]] = await conn.query('SELECT * FROM participants WHERE id = ? FOR UPDATE', [participantId]);
    if (!before) throw new RegistrationError('Participant not found.', { code: 'NOT_FOUND' });
    const [[em]] = await conn.query('SELECT * FROM emergency_contacts WHERE participant_id = ?', [participantId]);

    const changes = {};
    const oldValues = {};
    for (const col of PARTICIPANT_COLUMNS) {
      if (!(col in values) || col.startsWith('consent_')) continue;
      const v = typeof values[col] === 'boolean' ? (values[col] ? 1 : 0) : values[col] ?? null;
      if (String(v ?? '') !== String(before[col] ?? '')) { changes[col] = v; oldValues[col] = before[col]; }
    }
    if (photoPath) { changes.profile_photo_path = photoPath; oldValues.profile_photo_path = before.profile_photo_path; }
    if (Object.keys(changes).length) await conn.query('UPDATE participants SET ? WHERE id = ?', [changes, participantId]);

    const emergency = {
      name: values.emergency_name || '', relationship: values.emergency_relationship ?? null, mobile: values.emergency_mobile || '',
      alternate_mobile: values.emergency_alternate_mobile ?? null, email: values.emergency_email ?? null, address: values.emergency_address ?? null,
    };
    const emChanged = !em || Object.entries(emergency).some(([k, v]) => String(v ?? '') !== String(em[k] ?? ''));
    if (emChanged && (emergency.name || emergency.mobile)) {
      if (em) await conn.query('UPDATE emergency_contacts SET ? WHERE id = ?', [emergency, em.id]);
      else await conn.query('INSERT INTO emergency_contacts SET ?', [{ id: newId(), participant_id: participantId, ...emergency }]);
      changes.emergency_contact = emergency;
      oldValues.emergency_contact = em ? { name: em.name, mobile: em.mobile } : null;
    }
    if (Object.keys(changes).length) {
      await audit(conn, { adminId, participantId, action: 'PARTICIPANT_EDITED', oldValue: oldValues, newValue: changes, ip });
    }
    return { changed: Object.keys(changes), oldPhoto: photoPath ? before.profile_photo_path : null };
  });
}
