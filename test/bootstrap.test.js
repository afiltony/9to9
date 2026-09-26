import { one, query, resetDb } from './helpers.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bootstrap } from '../src/bootstrap.js';
import { closePool } from '../src/db.js';

before(resetDb);
after(closePool);

test('creates the first admin once, and never while staff accounts exist', async () => {
  const env = { INITIAL_ADMIN_EMAIL: 'Owner@Example.com', INITIAL_ADMIN_PASSWORD: 'Start#Password1' };
  await bootstrap({ env, log: () => {} });
  const admin = await one('SELECT email, role FROM admin_users');
  assert.deepEqual({ ...admin }, { email: 'owner@example.com', role: 'SUPER_ADMIN' });

  await bootstrap({ env: { INITIAL_ADMIN_EMAIL: 'second@example.com', INITIAL_ADMIN_PASSWORD: 'Another#Password1' }, log: () => {} });
  assert.equal((await one('SELECT COUNT(*) AS n FROM admin_users')).n, 1);
});

test('rejects a short initial password', async () => {
  await query('DELETE FROM admin_users');
  const logs = [];
  await bootstrap({ env: { INITIAL_ADMIN_EMAIL: 'a@b.co', INITIAL_ADMIN_PASSWORD: 'short' }, log: (m) => logs.push(m) });
  assert.equal((await one('SELECT COUNT(*) AS n FROM admin_users')).n, 0);
  assert.match(logs[0], /ignored/);
});

test('AUTO_SEED leaves an existing event untouched', async () => {
  await bootstrap({ env: { AUTO_SEED: 'true' }, log: () => {} });
  assert.equal((await one('SELECT COUNT(*) AS n FROM events')).n, 1);
});

test('health report passes on a migrated, seeded database with an admin', async () => {
  const { healthReport } = await import('../src/health.js');
  await query(`INSERT INTO admin_users (id, name, email, password_hash, role) VALUES (UUID(), 'A', 'health@test.local', 'x', 'ADMIN')`);
  const report = await healthReport();
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.deepEqual(report.checks.tables.missing, []);
  assert.deepEqual(report.checks.migrations.pending, []);
  assert.ok(report.checks.event.slots >= 48);
  assert.ok(!JSON.stringify(report).includes(process.env.DB_PASSWORD || '\u0000'), 'never exposes the password');
});
