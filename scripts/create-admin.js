// Creates or updates a staff account.
//   npm run create-admin -- --email you@example.com --name "Your Name" --role SUPER_ADMIN [--password secret]
// Without --password a random one is generated and printed once.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { closePool, one, query } from '../src/db.js';
import { ROLES } from '../src/lib/security.js';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const email = String(arg('email') || '').trim().toLowerCase();
const name = arg('name') || email;
const role = (arg('role') || 'SUPER_ADMIN').toUpperCase();
let password = arg('password');

if (!email.includes('@')) throw new Error('Pass --email');
if (!ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(', ')}`);
const generated = !password;
if (generated) password = crypto.randomBytes(9).toString('base64url');
if (password.length < 10) throw new Error('Password must be at least 10 characters');

const hash = await bcrypt.hash(password, 12);
const existing = await one('SELECT id FROM admin_users WHERE email = ?', [email]);
if (existing) {
  await query('UPDATE admin_users SET name = ?, role = ?, password_hash = ?, active = 1 WHERE id = ?', [name, role, hash, existing.id]);
  console.log(`Updated ${email} (${role}).`);
} else {
  await query('INSERT INTO admin_users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [crypto.randomUUID(), name, email, hash, role]);
  console.log(`Created ${email} (${role}).`);
}
if (generated) console.log(`Password: ${password}   <- store it now; it is not shown again.`);
await closePool();
