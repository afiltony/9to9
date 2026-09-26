// /healthz: checks the database, schema, seed data, admin account and photo storage.
// Reports only pass/fail and error codes — never credentials, names or participant data.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { getPool } from './db.js';

const TABLES = ['events', 'participants', 'emergency_contacts', 'activities', 'activity_slots', 'participant_slots',
  'checkins', 'admin_users', 'participant_documents', 'audit_logs', 'sessions', 'schema_migrations'];

/**
 * Safe clues for a failed database login: never the password, and only a short preview of names,
 * so a wrong prefix, a missing password or stray spaces can be spotted from the browser.
 */
function dbDiagnosis(err) {
  const env = process.env;
  const preview = (v) => (v ? `${v.slice(0, 5)}… (${v.length} chars)` : '(empty)');
  const denied = /Access denied for user '([^']*)'@'([^']*)'(?: \(using password: (YES|NO)\))?/.exec(err.message || '');
  const hostingerPrefix = /^u\d+_/;
  return {
    connectingVia: config.db.socketPath ? `socket ${config.db.socketPath}` : `${config.db.host}:${config.db.port}`,
    mysqlSawClientHost: denied ? denied[2] : undefined,
    passwordSent: denied ? denied[3] === 'YES' : undefined,
    user: preview(config.db.user),
    database: preview(config.db.database),
    userHasHostingerPrefix: hostingerPrefix.test(config.db.user),
    databaseHasHostingerPrefix: hostingerPrefix.test(config.db.database),
    variablesSet: ['DB_HOST', 'DB_PORT', 'DB_SOCKET', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].filter((k) => env[k] !== undefined && env[k] !== ''),
    // stray spaces are trimmed automatically, but flag them so the panel value can be fixed
    hadStraySpaces: ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].filter((k) => typeof env[k] === 'string' && env[k] !== env[k].trim()),
  };
}

export async function healthReport() {
  const checks = {};
  const pool = getPool();

  try {
    const [[row]] = await pool.query('SELECT VERSION() AS version, @@session.time_zone AS tz, NOW() AS now');
    checks.database = { ok: true, server: row.version, timeZone: row.tz, now: row.now };
  } catch (err) {
    checks.database = { ok: false, error: err.code || err.name, diagnosis: dbDiagnosis(err) };
    return { ok: false, checks };
  }

  const [tables] = await pool.query('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()');
  const have = new Set(tables.map((r) => String(r.t || r.TABLE_NAME).toLowerCase()));
  const missing = TABLES.filter((t) => !have.has(t));
  checks.tables = { ok: !missing.length, missing };

  if (have.has('schema_migrations')) {
    const [rows] = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
    const files = (await fs.readdir(path.join(ROOT, 'migrations'))).filter((f) => f.endsWith('.sql')).sort();
    const applied = rows.map((r) => r.name);
    checks.migrations = { ok: files.every((f) => applied.includes(f)), applied, pending: files.filter((f) => !applied.includes(f)) };
  }

  if (!missing.length) {
    const [[ev]] = await pool.query('SELECT start_at, status FROM events WHERE event_code = ?', [config.eventCode]);
    const [[slots]] = await pool.query(
      `SELECT COUNT(*) AS n FROM activity_slots s JOIN activities a ON a.id = s.activity_id
         JOIN events e ON e.id = a.event_id WHERE e.event_code = ?`, [config.eventCode]);
    checks.event = ev
      ? { ok: true, code: config.eventCode, starts: ev.start_at, registration: ev.status, slots: Number(slots.n) }
      : { ok: false, error: `Event ${config.eventCode} not loaded (AUTO_SEED)` };
    const [[admins]] = await pool.query('SELECT COUNT(*) AS n FROM admin_users WHERE active = 1');
    checks.admin = { ok: Number(admins.n) > 0, accounts: Number(admins.n) };
    // prove writes and transactions work, without leaving anything behind
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('INSERT INTO sessions (session_id, expires, data) VALUES (?, 0, ?)', [`healthz-${Date.now()}`, '{}']);
      await conn.rollback();
      checks.write = { ok: true };
    } catch (err) {
      await conn.rollback().catch(() => {});
      checks.write = { ok: false, error: err.code || err.name };
    } finally {
      conn.release();
    }
  }

  try {
    const dir = path.join(config.storageDir, 'photos');
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.healthz-${process.pid}`);
    await fs.writeFile(probe, 'ok');
    await fs.unlink(probe);
    checks.storage = { ok: true, outsideApp: !config.storageDir.startsWith(ROOT) };
  } catch (err) {
    checks.storage = { ok: false, error: err.code || err.name };
  }

  checks.baseUrl = { ok: /^https:\/\//.test(config.baseUrl) || !config.isProd, value: config.baseUrl };

  return { ok: Object.values(checks).every((c) => c.ok), checks };
}
