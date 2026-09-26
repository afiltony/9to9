import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './config.js';
import { getPool } from './db.js';

/** Applies every migrations/*.sql file not yet recorded in schema_migrations, in name order. */
export async function migrate({ log = console.log } = {}) {
  const pool = getPool();
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(255) NOT NULL PRIMARY KEY,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);

  const [done] = await pool.query('SELECT name FROM schema_migrations');
  const applied = new Set(done.map((r) => r.name));
  const dir = path.join(ROOT, 'migrations');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    const statements = sql
      .split(/;\s*(?:\r?\n|$)/)
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean);
    const conn = await pool.getConnection();
    try {
      // DDL auto-commits in MySQL, so a failed migration must be fixed by hand
      for (const stmt of statements) await conn.query(stmt);
      await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
      log(`Applied migration ${file}`);
    } finally {
      conn.release();
    }
  }
}
