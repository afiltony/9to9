import path from 'node:path';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { eventContent } from '../content.js';
import { COUNTRY_CODES, CONSENTS, LATIN_NAME_PATTERN, SECTIONS, formFields } from '../fields.js';
import { OTHER_FORANE, PARISHES_BY_FORANE } from '../parishes.js';
import { verifyCsrf } from '../lib/security.js';
import { imageUpload, removeStored, saveImage, storedExists, uploadedFile } from '../lib/uploads.js';
import { idCardPdf, qrDataUrl } from '../services/pdf.js';
import {
  RegistrationError, getEvent, getParticipantBy, getParticipantSlots, getSchedule,
  parseSlotIds, registerParticipant, registrationState, validateRegistration,
} from '../services/registration.js';

const router = express.Router();

const registerLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'Too many registration attempts from this network. Please wait a few minutes and try again.',
});

export async function loadEvent(req, res, next) {
  const event = await getEvent();
  if (!event) {
    return res.status(503).render('error', { title: 'Not available', message: 'The event has not been set up yet.' });
  }
  req.event = event;
  res.locals.event = event;
  res.locals.content = eventContent(event);
  res.locals.state = registrationState(event);
  next();
}

/** Non-bookable programme items that have times (e.g. Holy Qurbana), for the activity card. */
export function openProgrammeItems(schedule) {
  return schedule.filter((a) => !a.requiresSlot).flatMap((a) =>
    a.slots.map((s) => ({ activity_name: a.name, venue: a.venue, label: s.label, start_at: s.start_at, end_at: s.end_at })));
}

/** All slots of all activities as one time-ordered list, grouped by day, for the timeline. */
function timeline(schedule) {
  const items = schedule.flatMap((a) => a.slots.map((s) => ({ ...s, activity: a })));
  items.sort((x, y) => (x.start_at < y.start_at ? -1 : x.start_at > y.start_at ? 1 : x.activity.name.localeCompare(y.activity.name)));
  const days = [];
  for (const it of items) {
    const day = it.start_at.slice(0, 10);
    let d = days.at(-1);
    if (!d || d.date !== day) days.push(d = { date: day, groups: [] });
    // group activities that start at the same time
    let g = d.groups.at(-1);
    if (!g || g.start_at !== it.start_at) d.groups.push(g = { start_at: it.start_at, items: [] });
    g.items.push(it);
  }
  return days;
}

// ---------------------------------------------------------------- pages

router.get('/', async (req, res) => {
  const schedule = await getSchedule(req.event.id);
  res.render('home', { title: null, schedule, bookable: schedule.filter((a) => a.requiresSlot && a.slots.length) });
});

router.get('/about', (req, res) => res.render('about', { title: 'About' }));

router.get('/schedule', async (req, res) => {
  const schedule = await getSchedule(req.event.id);
  res.render('schedule', { title: 'Schedule', days: timeline(schedule) });
});

router.get('/activities', async (req, res) => {
  const schedule = await getSchedule(req.event.id);
  res.render('activities', { title: 'Activities', schedule });
});

router.get('/contact', (req, res) => res.render('contact', { title: 'Contact' }));
router.get('/privacy', (req, res) => res.render('text-page', { title: 'Privacy policy', body: res.locals.content.privacy_text }));
router.get('/terms', (req, res) => res.render('text-page', { title: 'Terms of participation', body: res.locals.content.terms_text }));

/** Branding and activity images are public; participant photos are never served from here. */
router.get('/media/:dir/:file', (req, res) => {
  const { dir, file } = req.params;
  if (!['branding', 'activities'].includes(dir) || !/^[0-9a-f-]{36}\.(jpg|png)$/.test(file)) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(config.storageDir, dir, file), (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

// ---------------------------------------------------------------- registration

async function renderForm(req, res, { values = {}, errors = {}, message = null, selected = [], badSlots = [], status = 200 } = {}) {
  const schedule = await getSchedule(req.event.id, { bookableOnly: true });
  const fields = formFields(req.event);
  const preselect = parseSlotIds(req.query.slot);
  res.status(status).render('register', {
    title: 'Register',
    sections: SECTIONS.map((s) => ({ ...s, fields: fields.filter((f) => f.section === s.key) })).filter((s) => s.fields.length),
    consents: CONSENTS,
    countryCodes: COUNTRY_CODES,
    schedule,
    values,
    errors,
    message,
    selected: new Set(selected.length ? selected : preselect),
    badSlots: new Set(badSlots),
    keptPhoto: !!req.session.pendingPhoto,
    latinPattern: LATIN_NAME_PATTERN,
    parishesByForane: PARISHES_BY_FORANE,
    otherForane: OTHER_FORANE,
    maxPhotoMb: Math.round(config.maxPhotoBytes / 1024 / 1024),
    maxPhotoBytes: config.maxPhotoBytes,
    maxUploadMb: Math.round(config.maxUploadBytes / 1024 / 1024),
  });
}

router.get('/register', (req, res) => renderForm(req, res));

router.post('/register', registerLimiter, imageUpload(['profile_photo']), verifyCsrf, async (req, res) => {
  const state = registrationState(req.event);
  if (!state.open) return renderForm(req, res, { message: state.reason, status: 409 });

  const body = req.body;
  const selected = parseSlotIds(body.slots);
  const file = uploadedFile(req, 'profile_photo');

  // The photo is saved as soon as it arrives and kept in the session, so a form that comes
  // back with an error (phone number, full slot…) never asks for the photograph again.
  let photoError = req.uploadError || null;
  if (file && !photoError) {
    const saved = await saveImage(file, 'photos');
    if (saved.error) photoError = saved.error;
    else {
      if (req.session.pendingPhoto) await removeStored(req.session.pendingPhoto);
      req.session.pendingPhoto = saved.path;
    }
  }
  if (req.session.pendingPhoto && !(await storedExists(req.session.pendingPhoto))) delete req.session.pendingPhoto;
  const photoPath = req.session.pendingPhoto || null;
  const { values, errors } = validateRegistration(req.event, body, { hasPhoto: !!photoPath });
  if (photoError) errors.profile_photo = photoError;

  if (Object.keys(errors).length) {
    return renderForm(req, res, { values: body, errors, selected, status: 422, message: 'Please correct the highlighted fields.' });
  }

  try {
    const p = await registerParticipant(req.event.id, values, selected, { photoPath, ip: req.ip });
    delete req.session.pendingPhoto; // now belongs to the participant
    res.redirect(303, `/r/${p.access_token}`);
  } catch (err) {
    if (!(err instanceof RegistrationError)) throw err;
    renderForm(req, res, {
      values: body, selected: selected.filter((id) => !err.slotIds.includes(id)),
      badSlots: err.slotIds, status: 409, message: err.message,
    });
  }
});

/** The photo kept from an earlier attempt in this browser session, for the form preview. */
router.get('/register/photo', (req, res) => {
  const rel = req.session.pendingPhoto;
  if (!rel || !/^photos\/[0-9a-f-]{36}\.(jpg|png)$/.test(rel)) return res.status(404).end();
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(path.join(config.storageDir, rel), (err) => {
    if (err && !res.headersSent) { delete req.session.pendingPhoto; res.status(404).end(); }
  });
});

/** Live seat counts, polled by the registration page. */
router.get('/api/availability', async (req, res) => {
  const schedule = await getSchedule(req.event.id, { bookableOnly: true });
  const slots = {};
  for (const a of schedule) for (const s of a.slots) slots[s.id] = { available: s.available, capacity: s.capacity, open: s.open };
  res.set('Cache-Control', 'no-store').json({ slots });
});

// ---------------------------------------------------------------- participant's own documents

async function loadOwnParticipant(req, res, next) {
  const p = /^[A-Za-z0-9_-]{43}$/.test(req.params.token) ? await getParticipantBy('access_token', req.params.token) : null;
  if (!p || p.event_id !== req.event.id) {
    return res.status(404).render('error', { title: 'Registration not found', message: 'This link is not valid. Please check the link you received.' });
  }
  req.participant = p;
  next();
}

router.get('/r/:token', loadOwnParticipant, async (req, res) => {
  const bookings = await getParticipantSlots(req.participant.id);
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex');
  res.render('success', { title: 'Registration successful', p: req.participant, bookings, qr: await qrDataUrl(req.participant) });
});

// sent as an attachment: phones (and WhatsApp/Instagram in-app browsers) often can't show a PDF
// inline or open it in a new tab, so tapping the button would do nothing
function sendPdf(res, buffer, filename) {
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'private, no-store',
  });
  res.send(buffer);
}

router.get('/r/:token/id-card.pdf', loadOwnParticipant, async (req, res) => {
  const bookings = await getParticipantSlots(req.participant.id);
  sendPdf(res, await idCardPdf(req.event, req.participant, bookings), `${req.participant.registration_number}-id-card.pdf`);
});

export default router;
