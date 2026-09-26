// Staff accounts.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { one, query } from '../db.js';
import { ROLES } from '../lib/security.js';
import { audit } from './audit.js';
import { ValidationError } from './catalog.js';

export async function listUsers() {
  return query('SELECT id, name, email, role, active, last_login_at, created_at FROM admin_users ORDER BY active DESC, role, name');
}

export async function getUser(id) {
  return one('SELECT id, name, email, role, active, last_login_at FROM admin_users WHERE id = ?', [id]);
}

/** Creates or updates a staff account. A password is required for new accounts. */
export async function saveUser(id, body, { actor, ip } = {}) {
  const errors = {};
  const name = String(body.name || '').trim().slice(0, 200);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 255);
  const role = String(body.role || '');
  const password = String(body.password || '');
  const active = body.active === 'on' ? 1 : 0;

  if (!name) errors.name = 'Name is required.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email.';
  if (!ROLES.includes(role)) errors.role = 'Choose a role.';
  if ((!id || password) && password.length < 10) errors.password = 'Use at least 10 characters.';
  // only a super admin can create or edit super admins
  if (role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') errors.role = 'Only a super admin can grant this role.';
  if (id === actor.id && (!active || role !== actor.role)) errors.role = 'You cannot change your own role or deactivate yourself.';
  const clash = await one('SELECT id FROM admin_users WHERE email = ? AND id <> ?', [email, id || '']);
  if (clash) errors.email = 'Another account uses this email.';
  if (id) {
    const target = await getUser(id);
    if (!target) errors.name = 'User not found.';
    else if (target.role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') errors.role = 'Only a super admin can edit a super admin.';
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const v = { name, email, role, active };
  if (password) v.password_hash = await bcrypt.hash(password, 12);
  if (id) {
    await query('UPDATE admin_users SET ? WHERE id = ?', [v, id]);
    if (!active || password) await query(`DELETE FROM sessions WHERE data LIKE ?`, [`%"id":"${id}"%`]); // sign them out everywhere
    await audit(null, { adminId: actor.id, action: password ? 'USER_UPDATED_PASSWORD_RESET' : 'USER_UPDATED', newValue: { email, role, active }, ip });
    return id;
  }
  const newIdValue = crypto.randomUUID();
  await query('INSERT INTO admin_users SET ?', [{ id: newIdValue, ...v }]);
  await audit(null, { adminId: actor.id, action: 'USER_CREATED', newValue: { email, role }, ip });
  return newIdValue;
}
