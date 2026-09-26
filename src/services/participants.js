import { one, query } from '../db.js';

export const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

const SORTS = {
  newest: 'p.created_at DESC, p.registration_number DESC',
  oldest: 'p.registration_number ASC',
  reg: 'p.registration_number ASC',
  name: 'p.first_name ASC, p.last_name ASC',
  status: 'p.status ASC, p.registration_number ASC',
  parish: 'p.parish ASC, p.first_name ASC',
  district: 'p.district ASC, p.first_name ASC',
};

const likeValue = (q) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Reads and sanitizes participant filters from a query string. */
export function parseFilters(q = {}) {
  const s = (v, max = 100) => String(v ?? '').trim().slice(0, max);
  const yn = (v) => (v === 'yes' || v === 'no' ? v : '');
  const uuid = (v) => (/^[0-9a-f-]{36}$/i.test(v || '') ? v : '');
  return {
    q: s(q.q),
    status: STATUSES.includes(q.status) ? q.status : (q.status === 'active' ? 'active' : ''),
    activity: uuid(q.activity),
    slot: uuid(q.slot),
    organization: s(q.organization),
    parish: s(q.parish),
    district: s(q.district),
    accommodation: yn(q.accommodation),
    food: yn(q.food),
    checked_in: yn(q.checked_in),
    printed: yn(q.printed),
    from: s(q.from, 20),
    to: s(q.to, 20),
    sort: SORTS[q.sort] ? q.sort : 'newest',
  };
}

/** WHERE clause + params for the filters. Alias `p` = participants. */
export function filterSql(eventId, f) {
  const where = ['p.event_id = ?'];
  const params = [eventId];
  if (f.status === 'active') where.push(`p.status IN ('approved', 'pending')`);
  else if (f.status) { where.push('p.status = ?'); params.push(f.status); }
  if (f.q) {
    const like = likeValue(f.q);
    where.push(`(CONCAT_WS(' ', p.first_name, p.middle_name, p.last_name) LIKE ? OR p.preferred_name LIKE ?
      OR p.registration_number LIKE ? OR p.mobile LIKE ? OR p.email LIKE ? OR p.organization LIKE ?
      OR p.parish LIKE ? OR p.district LIKE ?)`);
    params.push(like, like, like, likeValue(f.q.replace(/[\s\-()]/g, '')), like, like, like, like);
  }
  for (const col of ['organization', 'parish', 'district']) {
    if (f[col]) { where.push(`p.${col} LIKE ?`); params.push(likeValue(f[col])); }
  }
  if (f.slot) {
    where.push(`EXISTS (SELECT 1 FROM participant_slots ps WHERE ps.participant_id = p.id AND ps.slot_id = ? AND ps.status = 'confirmed')`);
    params.push(f.slot);
  } else if (f.activity) {
    where.push(`EXISTS (SELECT 1 FROM participant_slots ps JOIN activity_slots s ON s.id = ps.slot_id
                 WHERE ps.participant_id = p.id AND s.activity_id = ? AND ps.status = 'confirmed')`);
    params.push(f.activity);
  }
  if (f.accommodation) where.push(`p.accommodation_required = ${f.accommodation === 'yes' ? 1 : 0}`);
  if (f.food) where.push(`p.food_required = ${f.food === 'yes' ? 1 : 0}`);
  if (f.checked_in) {
    where.push(`${f.checked_in === 'yes' ? '' : 'NOT '}EXISTS (SELECT 1 FROM checkins c WHERE c.dedupe_key = CONCAT(p.id, ':EVENT'))`);
  }
  if (f.printed) where.push(`p.card_printed_at IS ${f.printed === 'yes' ? 'NOT ' : ''}NULL`);
  const num = (v) => {
    const m = /(\d+)\s*$/.exec(v || '');
    return m ? Number(m[1]) : null;
  };
  if (num(f.from) != null) { where.push('CAST(SUBSTRING_INDEX(p.registration_number, \'-\', -1) AS UNSIGNED) >= ?'); params.push(num(f.from)); }
  if (num(f.to) != null) { where.push('CAST(SUBSTRING_INDEX(p.registration_number, \'-\', -1) AS UNSIGNED) <= ?'); params.push(num(f.to)); }
  return { where: where.join(' AND '), params, order: SORTS[f.sort] || SORTS.newest };
}

const LIST_COLUMNS = `p.id, p.registration_number, p.first_name, p.middle_name, p.last_name, p.preferred_name, p.mobile, p.email,
  p.organization, p.institution, p.parish, p.district, p.status, p.created_at, p.profile_photo_path, p.card_printed_at,
  p.accommodation_required, p.food_required, p.food_preference,
  (SELECT COUNT(*) FROM participant_slots ps WHERE ps.participant_id = p.id AND ps.status = 'confirmed') AS bookings,
  (SELECT c.checked_in_at FROM checkins c WHERE c.dedupe_key = CONCAT(p.id, ':EVENT')) AS checked_in_at`;

export async function listParticipants(eventId, filters, { page = 1, pageSize = 50 } = {}) {
  const { where, params, order } = filterSql(eventId, filters);
  const total = Number((await one(`SELECT COUNT(*) AS n FROM participants p WHERE ${where}`, params)).n);
  const rows = await query(
    `SELECT ${LIST_COLUMNS} FROM participants p WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return { rows, total, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Full participant rows (with emergency contact) for printing cards, in registration order. */
export async function participantsForPrint(eventId, filters, { ids = null, limit = 200 } = {}) {
  let where;
  let params;
  if (ids?.length) {
    where = 'p.event_id = ? AND p.id IN (?)';
    params = [eventId, ids];
  } else {
    ({ where, params } = filterSql(eventId, filters));
  }
  return query(
    `SELECT p.*, e.name AS emergency_name, e.relationship AS emergency_relationship, e.mobile AS emergency_mobile,
            e.alternate_mobile AS emergency_alternate_mobile
       FROM participants p LEFT JOIN emergency_contacts e ON e.participant_id = p.id
      WHERE ${where} ORDER BY p.registration_number LIMIT ?`,
    [...params, limit],
  );
}

export async function countForPrint(eventId, filters) {
  const { where, params } = filterSql(eventId, filters);
  return Number((await one(`SELECT COUNT(*) AS n FROM participants p WHERE ${where}`, params)).n);
}

export async function markCardsPrinted(ids) {
  if (!ids.length) return;
  await query('UPDATE participants SET card_printed_at = NOW(), card_print_count = card_print_count + 1 WHERE id IN (?)', [ids]);
}

/** Confirmed bookings for many participants at once: Map(participantId → bookings[]). */
export async function bookingsFor(ids) {
  const map = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return map;
  const rows = await query(
    `SELECT ps.participant_id, s.id AS slot_id, s.label, s.start_at, s.end_at, a.name AS activity_name, a.venue, c.checked_in_at
       FROM participant_slots ps
       JOIN activity_slots s ON s.id = ps.slot_id
       JOIN activities a ON a.id = s.activity_id
       LEFT JOIN checkins c ON c.dedupe_key = CONCAT(ps.participant_id, ':', s.id)
      WHERE ps.participant_id IN (?) AND ps.status = 'confirmed'
      ORDER BY s.start_at`,
    [ids],
  );
  for (const r of rows) map.get(r.participant_id).push(r);
  return map;
}

/** Distinct values for filter dropdowns. */
export async function filterOptions(eventId) {
  const distinct = async (col) => (await query(
    `SELECT DISTINCT ${col} AS v FROM participants WHERE event_id = ? AND ${col} IS NOT NULL AND ${col} <> '' ORDER BY v LIMIT 300`, [eventId],
  )).map((r) => r.v);
  const [parishes, districts, organizations] = await Promise.all([distinct('parish'), distinct('district'), distinct('organization')]);
  return { parishes, districts, organizations };
}
