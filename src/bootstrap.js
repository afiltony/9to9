// Optional first-start setup driven by environment variables, for hosting where you cannot
// run scripts over SSH. Both steps are idempotent, so they are safe to leave switched on.
//   AUTO_SEED=true                 load the event programme if the event does not exist yet
//   INITIAL_ADMIN_EMAIL / _PASSWORD create a SUPER_ADMIN, only while no staff accounts exist
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { one, query } from './db.js';

export async function bootstrap({ env = process.env, log = console.log } = {}) {
  // production loads the programme on start unless AUTO_SEED=false; seeding skips an existing event
  const autoSeed = env.AUTO_SEED ? env.AUTO_SEED === 'true' : env.NODE_ENV === 'production';
  if (autoSeed) {
    const { seed } = await import('../scripts/seed.js');
    await seed({ log });
  }

  const email = String(env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(env.INITIAL_ADMIN_PASSWORD || '');
  if (!email) return;
  const existing = await one('SELECT COUNT(*) AS n FROM admin_users');
  if (Number(existing.n) > 0) return;
  if (!email.includes('@') || password.length < 10) {
    log('INITIAL_ADMIN_EMAIL/INITIAL_ADMIN_PASSWORD ignored: need a valid email and a password of at least 10 characters.');
    return;
  }
  await query('INSERT INTO admin_users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [crypto.randomUUID(), 'Administrator', email, await bcrypt.hash(password, 12), 'SUPER_ADMIN']);
  log(`Created first admin ${email}. Remove INITIAL_ADMIN_PASSWORD from the environment now.`);
}
