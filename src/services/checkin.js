import { getPool, one } from '../db.js';
import { audit } from './audit.js';
import { newId } from './registration.js';

export class CheckinError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * Records an event-entry check-in (slotId = null) or an activity check-in for one of the
 * participant's confirmed bookings. The unique dedupe_key makes a second check-in for the
 * same participant + slot fail at the database, even if two volunteers scan at once.
 */
export async function checkIn(participantId, slotId, { adminId = null, ip = null, userAgent = null } = {}) {
  const p = await one('SELECT id, status FROM participants WHERE id = ?', [participantId]);
  if (!p) throw new CheckinError('Participant not found.', 'NOT_FOUND');
  if (p.status !== 'approved') throw new CheckinError(`Registration is ${p.status.toUpperCase()} — send the participant to the help desk.`, 'NOT_APPROVED');

  if (slotId) {
    const booking = await one(
      `SELECT ps.id FROM participant_slots ps WHERE ps.participant_id = ? AND ps.slot_id = ? AND ps.status = 'confirmed'`,
      [participantId, slotId],
    );
    if (!booking) throw new CheckinError('This participant has not booked that slot.', 'NOT_BOOKED');
  }

  const dedupeKey = `${participantId}:${slotId || 'EVENT'}`;
  try {
    await getPool().query(
      `INSERT INTO checkins (id, participant_id, slot_id, checkin_type, dedupe_key, scanned_by, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), participantId, slotId || null, slotId ? 'ACTIVITY_ENTRY' : 'EVENT_ENTRY', dedupeKey,
        adminId, ip, userAgent ? userAgent.slice(0, 255) : null],
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      const prev = await one('SELECT checked_in_at FROM checkins WHERE dedupe_key = ?', [dedupeKey]);
      throw new CheckinError(`Already checked in at ${prev?.checked_in_at?.slice(11, 16) ?? 'an earlier time'}.`, 'DUPLICATE');
    }
    throw err;
  }
  await audit(null, { adminId, participantId, action: slotId ? 'CHECKIN_ACTIVITY' : 'CHECKIN_EVENT', newValue: { slotId }, ip });
}

export async function eventCheckin(participantId) {
  return one('SELECT checked_in_at FROM checkins WHERE dedupe_key = ?', [`${participantId}:EVENT`]);
}
