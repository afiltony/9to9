import mysql from 'mysql2/promise';
import { config } from './config.js';

let pool;

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...config.db,
      waitForConnections: true,
      // keep DATETIME as 'YYYY-MM-DD HH:MM:SS' strings: they are event-local wall-clock
      // times and must not be shifted by the Node process time zone
      dateStrings: true,
      timezone: config.tzOffset,
      charset: 'utf8mb4_unicode_ci',
      supportBigNumbers: true,
    });
    pool.on('connection', (conn) => {
      conn.query(`SET time_zone = '${config.tzOffset}'`);
    });
  }
  return pool;
}

export async function query(sql, params = []) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

export async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

/** Runs fn(conn) inside a transaction; retries on deadlock. */
export async function tx(fn, { retries = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback().catch(() => {});
      const retryable = err.code === 'ER_LOCK_DEADLOCK' || err.code === 'ER_LOCK_WAIT_TIMEOUT';
      if (retryable && attempt < retries) continue;
      throw err;
    } finally {
      conn.release();
    }
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
