import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = process.env;

function required(name, fallback) {
  const v = env[name] ?? fallback;
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
    host: env.DB_HOST || (isProd ? 'localhost' : '127.0.0.1'),
    port: Number(env.DB_PORT || 3306),
    user: required('DB_USER', isProd ? undefined : 'root'),
    password: isProd ? required('DB_PASSWORD') : env.DB_PASSWORD || '',
    database: required('DB_NAME', isProd ? undefined : 'nine_to_nine'),
    connectionLimit: Number(env.DB_POOL_SIZE || 10),
  },
  storageDir: path.resolve(ROOT, env.STORAGE_DIR || 'storage'),
  maxPhotoBytes: Number(env.MAX_PHOTO_KB || 3072) * 1024,
};
