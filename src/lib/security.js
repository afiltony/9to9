import crypto from 'node:crypto';
import session from 'express-session';
import { getPool } from '../db.js';

/** express-session store backed by the `sessions` table. */
export class MySqlSessionStore extends session.Store {
  constructor({ ttlMs = 12 * 3600 * 1000 } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.lastPrune = 0;
  }

  expiry(sess) {
    const exp = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + this.ttlMs;
    return Math.floor(exp / 1000);
  }

  get(sid, cb) {
    getPool().query('SELECT data, expires FROM sessions WHERE session_id = ?', [sid])
      .then(([rows]) => {
        const row = rows[0];
        if (!row || Number(row.expires) * 1000 < Date.now()) return cb(null, null);
        cb(null, JSON.parse(row.data));
      })
      .catch(cb);
  }

  set(sid, sess, cb = () => {}) {
    getPool().query(
      'INSERT INTO sessions (session_id, expires, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE expires = VALUES(expires), data = VALUES(data)',
      [sid, this.expiry(sess), JSON.stringify(sess)],
    ).then(() => { this.prune(); cb(null); }).catch(cb);
  }

  touch(sid, sess, cb = () => {}) {
    getPool().query('UPDATE sessions SET expires = ? WHERE session_id = ?', [this.expiry(sess), sid])
      .then(() => cb(null)).catch(cb);
  }

  destroy(sid, cb = () => {}) {
    getPool().query('DELETE FROM sessions WHERE session_id = ?', [sid]).then(() => cb(null)).catch(cb);
  }

  prune() {
    if (Date.now() - this.lastPrune < 15 * 60 * 1000) return;
    this.lastPrune = Date.now();
    getPool().query('DELETE FROM sessions WHERE expires < ?', [Math.floor(Date.now() / 1000)]).catch(() => {});
  }
}

// ---------------------------------------------------------------- CSRF (synchronizer token)

export function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('base64url');
  return req.session.csrf;
}

export function verifyCsrf(req, res, next) {
  const sent = req.body?._csrf || req.get('x-csrf-token');
  const expected = req.session?.csrf;
  const ok = sent && expected && sent.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
  if (ok) return next();
  res.status(403).render('error', { title: 'Session expired', message: 'Your session expired or the form was submitted twice. Please go back, refresh the page and try again.' });
}

// ---------------------------------------------------------------- roles

export const ROLES = ['SUPER_ADMIN', 'ADMIN', 'REGISTRATION_MANAGER', 'CHECKIN_STAFF', 'REPORT_MANAGER'];

const ALL = ['SUPER_ADMIN', 'ADMIN', 'REGISTRATION_MANAGER', 'REPORT_MANAGER', 'CHECKIN_STAFF'];
const PERMISSIONS = {
  'dashboard.view': ALL,
  'participants.view': ['SUPER_ADMIN', 'ADMIN', 'REGISTRATION_MANAGER', 'REPORT_MANAGER'],
  'participants.manage': ['SUPER_ADMIN', 'ADMIN', 'REGISTRATION_MANAGER'],
  'documents.print': ['SUPER_ADMIN', 'ADMIN', 'REGISTRATION_MANAGER'],
  'checkin.perform': ['SUPER_ADMIN', 'ADMIN', 'REGISTRATION_MANAGER', 'CHECKIN_STAFF'],
  'reports.view': ['SUPER_ADMIN', 'ADMIN', 'REGISTRATION_MANAGER', 'REPORT_MANAGER'],
  'event.manage': ['SUPER_ADMIN', 'ADMIN'],
  'users.manage': ['SUPER_ADMIN', 'ADMIN'],
  'audit.view': ['SUPER_ADMIN', 'ADMIN'],
};

export const ROLE_INFO = {
  SUPER_ADMIN: 'Everything, including other super admins.',
  ADMIN: 'Everything except managing super admins.',
  REGISTRATION_MANAGER: 'Participants, bookings, card printing, check-in and reports.',
  CHECKIN_STAFF: 'Scan QR codes, look up participants at the desk and check them in.',
  REPORT_MANAGER: 'View participants and download reports. Cannot change anything.',
};

export function can(user, permission) {
  return !!user && (PERMISSIONS[permission] || []).includes(user.role);
}

export function requireLogin(req, res, next) {
  if (req.session.admin) return next();
  req.session.returnTo = req.originalUrl;
  res.redirect('/admin/login');
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.session.admin) {
      req.session.returnTo = req.originalUrl;
      return res.redirect('/admin/login');
    }
    if (can(req.session.admin, permission)) return next();
    res.status(403).render('error', { title: 'Not allowed', message: 'Your account does not have permission for this page.' });
  };
}
