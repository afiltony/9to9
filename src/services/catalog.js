// Activities and time slots, as managed from the admin panel.
import { one, query, tx } from '../db.js';
import { audit } from './audit.js';
import { newId, RegistrationError } from './registration.js';

export class ValidationError extends Error {
  constructor(errors) {
    super('Please correct the highlighted fields.');
    this.errors = errors;
  }
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const intOrNull = (v) => {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? n : NaN;
};

export async function listActivities(eventId) {
  return query(
    `SELECT a.*, COUNT(s.id) AS slot_count, COALESCE(SUM(s.registration_count), 0) AS booked
       FROM activities a LEFT JOIN activity_slots s ON s.activity_id = a.id
      WHERE a.event_id = ? GROUP BY a.id ORDER BY a.sort_order, a.name`, [eventId]);
}

export async function getActivity(eventId, id) {
  return one('SELECT * FROM activities WHERE id = ? AND event_id = ?', [id, eventId]);
}

function activityValues(body) {
  const errors = {};
  const v = {
    name: str(body.name, 255),
    venue: str(body.venue, 255) || null,
    description: str(body.description, 2000) || null,
    capacity: intOrNull(body.capacity),
    requires_slot: body.requires_slot === 'on' ? 1 : 0,
    active: body.active === 'on' ? 1 : 0,
    sort_order: intOrNull(body.sort_order) ?? 0,
  };
  if (!v.name) errors.name = 'Name is required.';
  if (Number.isNaN(v.capacity)) errors.capacity = 'Capacity must be a whole number, or empty for no limit.';
  if (Number.isNaN(v.sort_order)) errors.sort_order = 'Order must be a whole number.';
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return v;
}

export async function saveActivity(eventId, id, body, { imagePath, adminId, ip } = {}) {
  const v = activityValues(body);
  if (imagePath) v.image_path = imagePath;
  if (body.remove_image === 'on' && !imagePath) v.image_path = null;
  if (id) {
    const before = await getActivity(eventId, id);
    if (!before) throw new RegistrationError('Activity not found.', { code: 'NOT_FOUND' });
    await query('UPDATE activities SET ? WHERE id = ?', [v, id]);
    await audit(null, { adminId, action: 'ACTIVITY_UPDATED', oldValue: pick(before, v), newValue: v, ip });
    if (body.apply_capacity === 'on') {
      // push the new default capacity to slots that can still hold their current bookings
      await query('UPDATE activity_slots SET capacity = ? WHERE activity_id = ? AND (? IS NULL OR registration_count <= ?)',
        [v.capacity, id, v.capacity, v.capacity]);
    }
    return id;
  }
  const newIdValue = newId();
  await query('INSERT INTO activities SET ?', [{ id: newIdValue, event_id: eventId, ...v }]);
  await audit(null, { adminId, action: 'ACTIVITY_CREATED', newValue: v, ip });
  return newIdValue;
}

/** Deletes an activity only when nobody has booked it; otherwise it must be deactivated. */
export async function deleteActivity(eventId, id, { adminId, ip } = {}) {
  const a = await one(
    `SELECT a.name, COALESCE(SUM(s.registration_count), 0) AS booked, COUNT(ps.id) AS history
       FROM activities a LEFT JOIN activity_slots s ON s.activity_id = a.id
       LEFT JOIN participant_slots ps ON ps.slot_id = s.id
      WHERE a.id = ? AND a.event_id = ? GROUP BY a.id`, [id, eventId]);
  if (!a) throw new RegistrationError('Activity not found.');
  if (Number(a.history) > 0) throw new RegistrationError('This activity has bookings. Deactivate it instead of deleting it.');
  await query('DELETE FROM activities WHERE id = ?', [id]);
  await audit(null, { adminId, action: 'ACTIVITY_DELETED', oldValue: { name: a.name }, ip });
}

// ---------------------------------------------------------------- slots

export async function listSlots(eventId, activityId = null) {
  return query(
    `SELECT s.*, a.name AS activity_name, a.venue,
            (SELECT COUNT(*) FROM checkins c WHERE c.slot_id = s.id) AS checked_in
       FROM activity_slots s JOIN activities a ON a.id = s.activity_id
      WHERE a.event_id = ? ${activityId ? 'AND a.id = ?' : ''}
      ORDER BY s.start_at, a.sort_order`, activityId ? [eventId, activityId] : [eventId]);
}

function slotValues(body) {
  const errors = {};
  const date = str(body.date, 10);
  const endDate = str(body.end_date, 10) || date;
  const start = str(body.start_time, 5);
  const end = str(body.end_time, 5);
  const v = {
    label: str(body.label, 255) || null,
    capacity: intOrNull(body.capacity),
    status: ['open', 'closed'].includes(body.status) ? body.status : 'open',
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.date = 'Choose a date.';
  if (!/^\d{2}:\d{2}$/.test(start)) errors.start_time = 'Choose a start time.';
  if (!/^\d{2}:\d{2}$/.test(end)) errors.end_time = 'Choose an end time.';
  if (Number.isNaN(v.capacity)) errors.capacity = 'Capacity must be a whole number, or empty for no limit.';
  if (!Object.keys(errors).length) {
    v.start_at = `${date} ${start}:00`;
    // an end time earlier than the start means the slot runs past midnight
    v.end_at = `${end <= start && endDate === date ? nextDay(date) : endDate} ${end}:00`;
    if (v.end_at <= v.start_at) errors.end_time = 'The end must be after the start.';
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return v;
}

function nextDay(date) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

export async function saveSlot(eventId, activityId, slotId, body, { adminId, ip } = {}) {
  const activity = await getActivity(eventId, activityId);
  if (!activity) throw new RegistrationError('Activity not found.');
  const v = slotValues(body);
  if (!slotId) {
    const id = newId();
    await query('INSERT INTO activity_slots SET ?', [{ id, activity_id: activityId, ...v }]);
    await audit(null, { adminId, action: 'SLOT_CREATED', newValue: { activity: activity.name, ...v }, ip });
    return id;
  }
  return tx(async (conn) => {
    const [[before]] = await conn.query('SELECT * FROM activity_slots WHERE id = ? AND activity_id = ? FOR UPDATE', [slotId, activityId]);
    if (!before) throw new RegistrationError('Slot not found.');
    if (v.capacity != null && v.capacity < before.registration_count) {
      throw new ValidationError({ capacity: `${before.registration_count} people are already booked; capacity cannot be lower than that.` });
    }
    await conn.query('UPDATE activity_slots SET ? WHERE id = ?', [v, slotId]);
    await audit(conn, {
      adminId,
      action: before.capacity !== v.capacity ? 'SLOT_CAPACITY_CHANGED' : 'SLOT_UPDATED',
      oldValue: { activity: activity.name, ...pick(before, v) }, newValue: { activity: activity.name, ...v }, ip,
    });
    return slotId;
  });
}

export async function deleteSlot(eventId, slotId, { adminId, ip } = {}) {
  const s = await one(
    `SELECT s.*, a.name AS activity_name, (SELECT COUNT(*) FROM participant_slots ps WHERE ps.slot_id = s.id) AS history
       FROM activity_slots s JOIN activities a ON a.id = s.activity_id WHERE s.id = ? AND a.event_id = ?`, [slotId, eventId]);
  if (!s) throw new RegistrationError('Slot not found.');
  if (Number(s.history) > 0) throw new RegistrationError('This slot has bookings. Close it instead of deleting it.');
  await query('DELETE FROM activity_slots WHERE id = ?', [slotId]);
  await audit(null, { adminId, action: 'SLOT_DELETED', oldValue: { activity: s.activity_name, start_at: s.start_at }, ip });
}

function pick(obj, keys) {
  return Object.fromEntries(Object.keys(keys).map((k) => [k, obj[k]]));
}
