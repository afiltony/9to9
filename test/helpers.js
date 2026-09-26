// Must be imported first in every test file: points the app at the test database.
process.env.DB_NAME = process.env.TEST_DB_NAME || 'nine_to_nine_test';
process.env.SESSION_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
process.env.BASE_URL = 'http://localhost:3999';
process.env.STORAGE_DIR = (await import('node:path')).join((await import('node:os')).tmpdir(), 'nine2nine-test-storage');

const { getPool, query, one } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { seed } = await import('../scripts/seed.js');

const TABLES = ['checkins', 'participant_documents', 'audit_logs', 'participant_slots', 'emergency_contacts',
  'participants', 'activity_slots', 'activities', 'events', 'admin_users', 'sessions', 'schema_migrations'];

/** Drops every table, re-applies migrations and seeds the event (year 2099, registration open). */
export async function resetDb() {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of TABLES) await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
  await migrate({ log: () => {} });
  await seed({ year: 2099, code: '9TO9', log: () => {} });
  return one('SELECT * FROM events WHERE event_code = ?', ['9TO9']);
}

let counter = 0;

/** A complete, valid registration form body. Each call gets a unique mobile number. */
export function validBody(overrides = {}) {
  counter++;
  return {
    first_name: 'John',
    last_name: 'Mathew',
    date_of_birth: '2005-05-20',
    gender: 'Male',
    mobile: `9${String(100000000 + counter)}`,
    district: 'Ernakulam',
    parish: 'St. Mary\'s Church',
    emergency_name: 'Mary Mathew',
    emergency_relationship: 'Mother',
    emergency_mobile: '9847000000',
    consent_information: 'on',
    consent_rules: 'on',
    ...overrides,
  };
}

export async function slotFor(activityName, startTime) {
  return one(
    `SELECT s.* FROM activity_slots s JOIN activities a ON a.id = s.activity_id
      WHERE a.name = ? AND TIME(s.start_at) = ? ORDER BY s.start_at LIMIT 1`,
    [activityName, startTime],
  );
}

export { getPool, query, one };
