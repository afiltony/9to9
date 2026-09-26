import crypto from 'node:crypto';
import { getPool } from '../db.js';

/** Writes an audit row. Pass a transaction connection to make it part of that transaction. */
export async function audit(conn, { adminId = null, participantId = null, action, oldValue = null, newValue = null, ip = null }) {
  const db = conn || getPool();
  await db.query(
    `INSERT INTO audit_logs (id, admin_user_id, participant_id, action, old_value, new_value, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), adminId, participantId, action,
      oldValue == null ? null : JSON.stringify(oldValue),
      newValue == null ? null : JSON.stringify(newValue), ip],
  );
}
