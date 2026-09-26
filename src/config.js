import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = process.env;

// values pasted into hosting panels often carry stray spaces or newlines
const clean = (v) => (typeof v === 'string' ? v.trim() : v);

function required(name, fallback) {
  const v = clean(env[name]) || fallback;
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${name}`);
  return v;
}

const isProd = env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: Number(env.PORT || 3000),
  // printed inside every QR code, so production must say where the site really lives
  baseUrl: required('BASE_URL', isProd ? undefined : `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  sessionSecret: required('SESSION_SECRET', isProd ? undefined : 'dev-only-secret-change-me'),
  trustProxy: env.TRUST_PROXY ? Number(env.TRUST_PROXY) : (isProd ? 1 : 0),
  // production creates/updates tables on start unless AUTO_MIGRATE=false; both steps are idempotent
  autoMigrate: env.AUTO_MIGRATE ? env.AUTO_MIGRATE === 'true' : isProd,
  eventCode: env.EVENT_CODE || '9TO9',
  // event-local offset, used for the DB session time zone so NOW() matches the schedule
  tzOffset: env.TZ_OFFSET || '+05:30',
  db: {
    // 127.0.0.1, not localhost: Node may resolve localhost to ::1, which MySQL grants usually don't cover
    host: clean(env.DB_HOST) || '127.0.0.1',
    // some shared hosts only accept local logins over the MySQL socket, e.g. /var/lib/mysql/mysql.sock
    ...(clean(env.DB_SOCKET) ? { socketPath: clean(env.DB_SOCKET) } : {}),
    port: Number(env.DB_PORT || 3306),
    user: required('DB_USER', isProd ? undefined : 'root'),
    password: isProd ? required('DB_PASSWORD') : clean(env.DB_PASSWORD) || '',
    database: required('DB_NAME', isProd ? undefined : 'nine_to_nine'),
    connectionLimit: Number(env.DB_POOL_SIZE || 10),
  },
  storageDir: path.resolve(ROOT, env.STORAGE_DIR || 'storage'),
  // stored photos are shrunk to fit this; uploads up to maxUploadBytes are accepted and shrunk
  maxPhotoBytes: Number(env.MAX_PHOTO_KB || 1024) * 1024,
  maxUploadBytes: Number(env.MAX_UPLOAD_MB || 15) * 1024 * 1024,
};
