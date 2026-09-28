import path from 'node:path';
import bcrypt from 'bcryptjs';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { COUNTRY_CODES, SECTIONS, formFields } from '../fields.js';
import { one, query } from '../db.js';
import { nowLocal, shiftLocal } from '../lib/format.js';
import { requirePermission, verifyCsrf } from '../lib/security.js';
import { imageUpload, removeStored, saveImage, uploadedFile } from '../lib/uploads.js';
import { audit } from '../services/audit.js';
import { CheckinError, checkIn, eventCheckin } from '../services/checkin.js';
import { filterOptions, listParticipants, markCardsPrinted, parseFilters, STATUSES } from '../services/participants.js';
import { activityCardPdf, idCardPdf } from '../services/pdf.js';
import {
  RegistrationError, addBooking, changeStatus, deleteParticipant, getParticipantBy, getParticipantSlots, getSchedule, newId,
  removeBooking, updateParticipant, validateRegistration,
} from '../services/registration.js';
import { openProgrammeItems } from './public.js';

const router = express.Router();
const flash = (req, type, text) => { req.session.flash = { type, text }; };
const isUuid = (v) => /^[0-9a-f-]{36}$/i.test(v || '');

// ---------------------------------------------------------------- auth

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (req, res) => res.status(429).render('admin/login', {
    title: 'Staff login', error: 'Too many failed attempts. Please wait 15 minutes and try again.', email: req.body?.email || '',
  }),
});

// compared against when the email is unknown, so response time does not reveal which emails exist
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

router.get('/admin/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.render('admin/login', { title: 'Staff login', error: null, email: '' });
});

router.get('/admin/forgot-password', (req, res) => res.render('admin/forgot', { title: 'Forgot password' }));

router.post('/admin/login', loginLimiter, verifyCsrf, async (req, res, next) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = await one('SELECT * FROM admin_users WHERE email = ? AND active = 1', [email]);
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    return res.status(401).render('admin/login', { title: 'Staff login', error: 'Incorrect email or password.', email });
  }
  const returnTo = req.session.returnTo;
  // new session id on login prevents session fixation
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.admin = { id: user.id, name: user.name, email: user.email, role: user.role };
    // "remember me" keeps volunteers' phones signed in for the whole event
    req.session.cookie.maxAge = req.body.remember === 'on' ? 7 * 24 * 3600 * 1000 : 12 * 3600 * 1000;
    query('UPDATE admin_users SET last_login_at = NOW() WHERE id = ?', [user.id]).catch(() => {});
    audit(null, { adminId: user.id, action: 'ADMIN_LOGIN', ip: req.ip }).catch(() => {});
    const dest = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : null;
    const home = user.role === 'CHECKIN_STAFF' ? '/admin/checkin' : '/admin';
    req.session.save(() => res.redirect(303, dest || home));
  });
});

router.post('/admin/logout', verifyCsrf, (req, res) => {
  req.session.destroy(() => res.redirect(303, '/admin/login'));
});

// ---------------------------------------------------------------- dashboard

router.get('/admin', requirePermission('dashboard.view'), async (req, res) => {
  if (req.session.admin.role === 'CHECKIN_STAFF') return res.redirect('/admin/checkin');
  const eventId = req.event.id;
  const totals = await one(
    `SELECT COUNT(*) AS total,
            SUM(status = 'approved') AS approved, SUM(status = 'pending') AS pending,
            SUM(status IN ('cancelled', 'rejected')) AS cancelled,
            SUM(accommodation_required = 1 AND status NOT IN ('cancelled','rejected')) AS accommodation,
            SUM(food_required = 1 AND status NOT IN ('cancelled','rejected')) AS food,
            SUM(card_printed_at IS NOT NULL AND status = 'approved') AS printed
       FROM participants WHERE event_id = ?`, [eventId]);
  const checked = await one(
    `SELECT COUNT(*) AS n FROM checkins c JOIN participants p ON p.id = c.participant_id
      WHERE p.event_id = ? AND c.checkin_type = 'EVENT_ENTRY'`, [eventId]);
  const recent = await query(
    `SELECT id, registration_number, first_name, last_name, parish, status, created_at FROM participants
      WHERE event_id = ? ORDER BY created_at DESC LIMIT 6`, [eventId]);
  const daily = await query(
    `SELECT DATE(created_at) AS day, COUNT(*) AS n FROM participants WHERE event_id = ?
      GROUP BY day ORDER BY day DESC LIMIT 14`, [eventId]);
  const schedule = await getSchedule(eventId, { bookableOnly: true });
  const n = (v) => Number(v || 0);
  res.render('admin/dashboard', {
    title: 'Dashboard',
    stats: {
      total: n(totals.total), approved: n(totals.approved), pending: n(totals.pending), cancelled: n(totals.cancelled),
      checkedIn: n(checked.n), accommodation: n(totals.accommodation), food: n(totals.food), printed: n(totals.printed),
    },
    schedule,
    recent,
    daily: daily.reverse(),
  });
});

// ---------------------------------------------------------------- participants

router.get('/admin/participants', requirePermission('participants.view'), async (req, res) => {
  const filters = parseFilters(req.query);
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const [{ rows, total, pages }, options, schedule] = await Promise.all([
    listParticipants(req.event.id, filters, { page }),
    filterOptions(req.event.id),
    getSchedule(req.event.id, { bookableOnly: true }),
  ]);
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  res.render('admin/participants', { title: 'Participants', rows, total, pages, page, filters, options, schedule, statuses: STATUSES, qs });
});

async function loadParticipant(req, res, next) {
  const p = isUuid(req.params.id) ? await getParticipantBy('id', req.params.id) : null;
  if (!p || p.event_id !== req.event.id) {
    return res.status(404).render('error', { title: 'Not found', message: 'Participant not found.' });
  }
  req.participant = p;
  next();
}

router.get('/admin/participants/:id', requirePermission('participants.view'), loadParticipant, async (req, res) => {
  const p = req.participant;
  const [bookings, entry, logs, checkins, documents, schedule] = await Promise.all([
    getParticipantSlots(p.id),
    eventCheckin(p.id),
    query(`SELECT l.action, l.created_at, l.old_value, l.new_value, l.ip_address, u.name AS admin_name
             FROM audit_logs l LEFT JOIN admin_users u ON u.id = l.admin_user_id
            WHERE l.participant_id = ? ORDER BY l.created_at DESC LIMIT 100`, [p.id]),
    query(`SELECT c.checked_in_at, c.checkin_type, a.name AS activity, s.start_at, s.end_at, u.name AS staff
             FROM checkins c LEFT JOIN activity_slots s ON s.id = c.slot_id LEFT JOIN activities a ON a.id = s.activity_id
             LEFT JOIN admin_users u ON u.id = c.scanned_by WHERE c.participant_id = ? ORDER BY c.checked_in_at`, [p.id]),
    query(`SELECT d.document_type, d.generated_at, u.name AS admin_name FROM participant_documents d
             LEFT JOIN admin_users u ON u.id = d.generated_by WHERE d.participant_id = ? ORDER BY d.generated_at DESC LIMIT 30`, [p.id]),
    getSchedule(req.event.id, { bookableOnly: true }),
  ]);
  const tab = ['overview', 'contact', 'emergency', 'activities', 'documents', 'checkins', 'history'].includes(req.query.tab) ? req.query.tab : 'overview';
  res.render('admin/participant', { title: p.registration_number, p, bookings, entry, logs, checkins, documents, schedule, tab });
});

router.post('/admin/participants/:id/status', requirePermission('participants.manage'), verifyCsrf, loadParticipant, async (req, res) => {
  try {
    const next = await changeStatus(req.participant.id, String(req.body.action), { adminId: req.session.admin.id, ip: req.ip });
    flash(req, 'success', `Registration is now ${next}.`);
  } catch (err) {
    if (!(err instanceof RegistrationError)) throw err;
    flash(req, 'error', err.message);
  }
  res.redirect(303, req.body.back === 'list' ? '/admin/participants?status=pending' : `/admin/participants/${req.participant.id}`);
});

router.post('/admin/participants/:id/delete', requirePermission('participants.delete'), verifyCsrf, loadParticipant, async (req, res) => {
  const { registrationNumber, photoPath } = await deleteParticipant(req.participant.id, { adminId: req.session.admin.id, ip: req.ip });
  await removeStored(photoPath);
  flash(req, 'success', `Registration ${registrationNumber} deleted.`);
  res.redirect(303, '/admin/participants');
});

router.post('/admin/participants/:id/bookings',requirePermission('participants.manage'), verifyCsrf, loadParticipant, async (req, res) => {
  const slotId = isUuid(req.body.slot_id) ? req.body.slot_id : null;
  try {
    if (!slotId) throw new RegistrationError('Choose a slot.');
    const opts = { adminId: req.session.admin.id, ip: req.ip };
    if (req.body.remove === '1') {
      await removeBooking(req.participant.id, slotId, opts);
      flash(req, 'success', 'Booking cancelled and the place released.');
    } else {
      await addBooking(req.participant.id, slotId, { ...opts, force: req.body.force === 'on' });
      flash(req, 'success', 'Booking added. Reprint the activity card if it was already printed.');
    }
  } catch (err) {
    if (!(err instanceof RegistrationError)) throw err;
    flash(req, 'error', err.message);
  }
  res.redirect(303, `/admin/participants/${req.participant.id}?tab=activities`);
});

function editForm(req, res, { values, errors = {}, status = 200, message = null }) {
  const fields = formFields(req.event);
  res.status(status).render('admin/participant-edit', {
    title: `Edit ${req.participant.registration_number}`, p: req.participant, values, errors, message, countryCodes: COUNTRY_CODES,
    sections: SECTIONS.map((s) => ({ ...s, fields: fields.filter((f) => f.section === s.key) })).filter((s) => s.fields.length),
  });
}

function participantToForm(p) {
  const v = {};
  for (const [k, val] of Object.entries(p)) {
    if (val == null) continue;
    if (['accommodation_required', 'food_required'].includes(k)) { if (val) v[k] = 'on'; continue; }
    v[k] = /_at$/.test(k) && /^\d{4}-\d{2}-\d{2} /.test(val) ? val.slice(0, 16).replace(' ', 'T') : String(val);
  }
  return v;
}

router.get('/admin/participants/:id/edit', requirePermission('participants.manage'), loadParticipant, (req, res) => {
  editForm(req, res, { values: participantToForm(req.participant) });
});

router.post('/admin/participants/:id/edit', requirePermission('participants.manage'), imageUpload(['profile_photo']), verifyCsrf, loadParticipant, async (req, res) => {
  const { values, errors } = validateRegistration(req.event, req.body, { adminEdit: true });
  const file = uploadedFile(req, 'profile_photo');
  if (req.uploadError) errors.profile_photo = req.uploadError;
  let photoPath = null;
  if (file && !Object.keys(errors).length) {
    const saved = await saveImage(file, 'photos');
    if (saved.error) errors.profile_photo = saved.error;
    else photoPath = saved.path;
  }
  if (Object.keys(errors).length) {
    return editForm(req, res, { values: req.body, errors, status: 422, message: 'Please correct the highlighted fields.' });
  }
  const { changed, oldPhoto } = await updateParticipant(req.participant.id, values, { photoPath, adminId: req.session.admin.id, ip: req.ip });
  await removeStored(oldPhoto);
  flash(req, 'success', changed.length
    ? `Saved. ${req.participant.card_printed_at ? 'The card was already printed — reprint it if printed details changed.' : ''}`
    : 'No changes.');
  res.redirect(303, `/admin/participants/${req.participant.id}`);
});

router.get('/admin/participants/:id/photo', requirePermission('checkin.perform'), loadParticipant, (req, res) => {
  const rel = req.participant.profile_photo_path;
  if (!rel) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(path.join(config.storageDir, rel), (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

async function sendAdminPdf(req, res, kind) {
  const p = req.participant;
  let buffer;
  if (kind === 'ID_CARD') {
    buffer = await idCardPdf(req.event, p, await getParticipantSlots(p.id));
    if (req.query.mark !== '0') await markCardsPrinted([p.id]);
  } else {
    const bookings = await getParticipantSlots(p.id);
    buffer = await activityCardPdf(req.event, p, bookings, openProgrammeItems(await getSchedule(req.event.id)));
  }
  await query('INSERT INTO participant_documents (id, participant_id, document_type, generated_by) VALUES (?, ?, ?, ?)',
    [newId(), p.id, kind, req.session.admin.id]);
  await audit(null, { adminId: req.session.admin.id, participantId: p.id, action: `PDF_${kind}_GENERATED`, ip: req.ip });
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${p.registration_number}-${kind === 'ID_CARD' ? 'id-card' : 'activity-card'}.pdf"`,
    'Cache-Control': 'private, no-store',
  });
  res.send(buffer);
}

router.get('/admin/participants/:id/id-card.pdf', requirePermission('documents.print'), loadParticipant,
  (req, res) => sendAdminPdf(req, res, 'ID_CARD'));
router.get('/admin/participants/:id/activity-card.pdf', requirePermission('documents.print'), loadParticipant,
  (req, res) => sendAdminPdf(req, res, 'ACTIVITY_CARD'));

// ---------------------------------------------------------------- check-in / reception

const stationParam = (v) => (/^(EVENT|[0-9a-f-]{36})$/i.test(v || '') ? v : '');

router.get('/admin/checkin', requirePermission('checkin.perform'), async (req, res) => {
  const schedule = await getSchedule(req.event.id, { bookableOnly: true });
  res.render('admin/scanner', { title: 'Check-in', schedule, results: null, q: '' });
});

/**
 * Reception lookup when a participant has no card with them: registration number, mobile or name.
 * One match jumps straight to the check-in screen.
 */
async function lookup(req, res) {
  const raw = String(req.body?.registration_number ?? req.query.q ?? '').trim().slice(0, 100);
  const station = stationParam(req.body?.station ?? req.query.station);
  const suffix = station ? `?station=${station}` : '';
  if (!raw) return res.redirect(303, `/admin/checkin${suffix}`);
  let rows;
  if (/^\d{1,6}$/.test(raw) || /^[A-Z0-9]+-\d+$/i.test(raw)) {
    const reg = /^\d+$/.test(raw) ? `${req.event.event_code}-${raw.padStart(6, '0')}` : raw.toUpperCase();
    rows = await query('SELECT id, qr_token, registration_number, first_name, middle_name, last_name, parish, mobile, status FROM participants WHERE event_id = ? AND registration_number = ?', [req.event.id, reg]);
  }
  if (!rows?.length) {
    const { rows: found } = await listParticipants(req.event.id, parseFilters({ q: raw, sort: 'name' }), { pageSize: 30 });
    rows = found.length ? await query('SELECT id, qr_token, registration_number, first_name, middle_name, last_name, parish, mobile, status FROM participants WHERE id IN (?) ORDER BY first_name, last_name', [found.map((r) => r.id)]) : [];
  }
  if (rows.length === 1) return res.redirect(303, `/checkin/${rows[0].qr_token}${suffix}`);
  const schedule = await getSchedule(req.event.id, { bookableOnly: true });
  res.render('admin/scanner', { title: 'Check-in', schedule, results: rows, q: raw, station });
}

router.post('/admin/checkin/lookup', requirePermission('checkin.perform'), verifyCsrf, lookup);
router.get('/admin/checkin/lookup', requirePermission('checkin.perform'), lookup);

async function loadByQr(req, res, next) {
  const p = /^[A-Za-z0-9_-]{43}$/.test(req.params.token) ? await getParticipantBy('qr_token', req.params.token) : null;
  if (!p || p.event_id !== req.event.id) {
    return res.status(404).render('admin/checkin', { title: 'Invalid QR code', p: null, bookings: [], entry: null, station: stationParam(req.query.station), stationSlot: null });
  }
  req.participant = p;
  next();
}

// The QR code on every card points here; staff phones' camera apps can open it directly.
router.get('/checkin/:token', requirePermission('checkin.perform'), loadByQr, async (req, res) => {
  const p = req.participant;
  const [bookings, entry] = await Promise.all([getParticipantSlots(p.id), eventCheckin(p.id)]);
  const now = nowLocal(config.tzOffset);
  // bookings starting within the next 30 minutes also count as current
  const soon = shiftLocal(now, 30);
  for (const b of bookings) b.current = b.start_at <= soon && b.end_at > now;

  const station = stationParam(req.query.station) || null;
  let stationSlot = null;
  if (station && station !== 'EVENT') {
    stationSlot = await one(
      `SELECT s.id, s.start_at, s.end_at, s.label, a.name AS activity_name, a.venue
         FROM activity_slots s JOIN activities a ON a.id = s.activity_id WHERE s.id = ? AND a.event_id = ?`,
      [station, req.event.id]);
  }
  res.set('Cache-Control', 'no-store');
  res.render('admin/checkin', { title: 'Check-in', p, bookings, entry, station, stationSlot });
});

router.post('/checkin/:token', requirePermission('checkin.perform'), verifyCsrf, loadByQr, async (req, res) => {
  const slotId = isUuid(req.body.slot_id) ? req.body.slot_id : null;
  const station = stationParam(req.body.station);
  try {
    await checkIn(req.participant.id, slotId, { adminId: req.session.admin.id, ip: req.ip, userAgent: req.get('user-agent') });
    flash(req, 'success', `${req.participant.first_name} checked in at ${nowLocal(config.tzOffset).slice(11, 16)}.`);
  } catch (err) {
    if (!(err instanceof CheckinError)) throw err;
    flash(req, err.code === 'DUPLICATE' ? 'warning' : 'error', err.message);
  }
  res.redirect(303, `/checkin/${req.params.token}${station ? `?station=${station}` : ''}`);
});

export default router;
