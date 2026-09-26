// Admin: activities, slots, settings, staff users, audit log.
import express from 'express';
import { eventContent } from '../content.js';
import { FIELDS, SECTIONS } from '../fields.js';
import { ROLE_INFO, ROLES, requirePermission, verifyCsrf } from '../lib/security.js';
import { imageUpload, removeStored, saveImage, uploadedFile } from '../lib/uploads.js';
import {
  ValidationError, deleteActivity, deleteSlot, getActivity, listActivities, listSlots, saveActivity, saveSlot,
} from '../services/catalog.js';
import { RegistrationError } from '../services/registration.js';
import { auditLog, saveSettings } from '../services/settings.js';
import { getUser, listUsers, saveUser } from '../services/users.js';

const router = express.Router();
const flash = (req, type, text) => { req.session.flash = { type, text }; };
const isUuid = (v) => /^[0-9a-f-]{36}$/i.test(v || '');
const actor = (req) => ({ adminId: req.session.admin.id, ip: req.ip });

// ---------------------------------------------------------------- activities

router.get('/admin/activities', requirePermission('event.manage'), async (req, res) => {
  res.render('admin/activities', { title: 'Activities', activities: await listActivities(req.event.id) });
});

async function activityForm(req, res, { activity = null, values = null, errors = {}, status = 200 } = {}) {
  res.status(status).render('admin/activity-form', {
    title: activity ? `Edit ${activity.name}` : 'New activity',
    activity,
    values: values || activity || { active: 1, requires_slot: 1 },
    errors,
    slots: activity ? await listSlots(req.event.id, activity.id) : [],
  });
}

router.get('/admin/activities/new', requirePermission('event.manage'), (req, res) => activityForm(req, res));

router.get('/admin/activities/:id', requirePermission('event.manage'), async (req, res) => {
  const activity = isUuid(req.params.id) ? await getActivity(req.event.id, req.params.id) : null;
  if (!activity) return res.status(404).render('error', { title: 'Not found', message: 'Activity not found.' });
  activityForm(req, res, { activity });
});

router.post(['/admin/activities/new', '/admin/activities/:id'], requirePermission('event.manage'), imageUpload(['image']), verifyCsrf, async (req, res) => {
  const id = isUuid(req.params.id) ? req.params.id : null;
  const activity = id ? await getActivity(req.event.id, id) : null;
  if (id && !activity) return res.status(404).render('error', { title: 'Not found', message: 'Activity not found.' });
  const toForm = (v) => ({ ...v, requires_slot: v.requires_slot === 'on' ? 1 : 0, active: v.active === 'on' ? 1 : 0 });
  let imagePath = null;
  try {
    const file = uploadedFile(req, 'image');
    if (req.uploadError) throw new ValidationError({ image: req.uploadError });
    if (file) {
      const saved = await saveImage(file, 'activities');
      if (saved.error) throw new ValidationError({ image: saved.error });
      imagePath = saved.path;
    }
    const savedId = await saveActivity(req.event.id, id, req.body, { imagePath, ...actor(req) });
    if (activity && (imagePath || req.body.remove_image === 'on')) await removeStored(activity.image_path);
    flash(req, 'success', id ? 'Activity saved.' : 'Activity created. Now add its time slots.');
    res.redirect(303, `/admin/activities/${savedId}`);
  } catch (err) {
    await removeStored(imagePath);
    if (!(err instanceof ValidationError)) throw err;
    activityForm(req, res, { activity, values: { ...activity, ...toForm(req.body) }, errors: err.errors, status: 422 });
  }
});

router.post('/admin/activities/:id/delete', requirePermission('event.manage'), verifyCsrf, async (req, res) => {
  try {
    await deleteActivity(req.event.id, req.params.id, actor(req));
    flash(req, 'success', 'Activity deleted.');
    res.redirect(303, '/admin/activities');
  } catch (err) {
    if (!(err instanceof RegistrationError)) throw err;
    flash(req, 'error', err.message);
    res.redirect(303, `/admin/activities/${req.params.id}`);
  }
});

// ---------------------------------------------------------------- slots

router.get('/admin/slots', requirePermission('event.manage'), async (req, res) => {
  const [slots, activities] = await Promise.all([listSlots(req.event.id), listActivities(req.event.id)]);
  res.render('admin/slots', { title: 'Time slots', slots, activities, errors: {}, values: {} });
});

router.post('/admin/slots', requirePermission('event.manage'), verifyCsrf, async (req, res) => {
  const activityId = isUuid(req.body.activity_id) ? req.body.activity_id : null;
  const slotId = isUuid(req.body.slot_id) ? req.body.slot_id : null;
  const back = req.body.back === 'activity' && activityId ? `/admin/activities/${activityId}` : '/admin/slots';
  try {
    if (!activityId) throw new ValidationError({ activity_id: 'Choose an activity.' });
    await saveSlot(req.event.id, activityId, slotId, req.body, actor(req));
    flash(req, 'success', slotId ? 'Slot updated.' : 'Slot added.');
  } catch (err) {
    if (err instanceof ValidationError) flash(req, 'error', Object.values(err.errors).join(' '));
    else if (err instanceof RegistrationError) flash(req, 'error', err.message);
    else throw err;
  }
  res.redirect(303, back);
});

router.post('/admin/slots/:id/delete', requirePermission('event.manage'), verifyCsrf, async (req, res) => {
  try {
    await deleteSlot(req.event.id, req.params.id, actor(req));
    flash(req, 'success', 'Slot deleted.');
  } catch (err) {
    if (!(err instanceof RegistrationError)) throw err;
    flash(req, 'error', err.message);
  }
  res.redirect(303, req.body.back && req.body.back.startsWith('/admin/') ? req.body.back : '/admin/slots');
});

// ---------------------------------------------------------------- settings

function settingsForm(req, res, { errors = {}, values = null, status = 200 } = {}) {
  const e = req.event;
  let formConfig = e.form_config || {};
  if (typeof formConfig === 'string') { try { formConfig = JSON.parse(formConfig); } catch { formConfig = {}; } }
  res.status(status).render('admin/settings', {
    title: 'Settings',
    values: values || e,
    c: eventContent(e),
    errors,
    fields: SECTIONS.map((s) => ({ ...s, fields: FIELDS.filter((f) => f.section === s.key) })),
    formConfig,
  });
}

router.get('/admin/settings', requirePermission('event.manage'), (req, res) => settingsForm(req, res));

router.post('/admin/settings', requirePermission('event.manage'), imageUpload(['hero_image', 'logo'], { maxBytes: 5 * 1024 * 1024 }), verifyCsrf, async (req, res) => {
  const saved = [];
  try {
    if (req.uploadError) throw new ValidationError({ hero_image: req.uploadError });
    const store = async (field) => {
      const file = uploadedFile(req, field);
      if (!file) return null;
      // branding keeps its own 5 MB limit so logos stay PNG with transparency
      const r = await saveImage(file, 'branding', { maxBytes: 5 * 1024 * 1024 });
      if (r.error) throw new ValidationError({ [field]: r.error });
      saved.push(r.path);
      return r.path;
    };
    const heroPath = await store('hero_image');
    const logoPath = await store('logo');
    const { dayShift } = await saveSettings(req.event, req.body, { heroPath, logoPath, ...actor(req) });
    if (heroPath || req.body.remove_hero === 'on') await removeStored(req.event.hero_image_path);
    if (logoPath || req.body.remove_logo === 'on') await removeStored(req.event.logo_path);
    flash(req, 'success', `Settings saved.${dayShift && req.body.shift_slots === 'on' ? ` All activity slots moved by ${dayShift} day(s).` : ''}`);
    res.redirect(303, '/admin/settings');
  } catch (err) {
    for (const p of saved) await removeStored(p);
    if (!(err instanceof ValidationError)) throw err;
    settingsForm(req, res, { errors: err.errors, status: 422 });
  }
});

// ---------------------------------------------------------------- users

router.get('/admin/users', requirePermission('users.manage'), async (req, res) => {
  res.render('admin/users', { title: 'Staff users', users: await listUsers(), roles: ROLES, roleInfo: ROLE_INFO });
});

async function userForm(req, res, { user = null, values = null, errors = {}, status = 200 } = {}) {
  res.status(status).render('admin/user-form', {
    title: user ? `Edit ${user.name}` : 'New staff user', user, values: values || user || { active: 1, role: 'CHECKIN_STAFF' },
    errors, roles: ROLES, roleInfo: ROLE_INFO,
  });
}

router.get('/admin/users/new', requirePermission('users.manage'), (req, res) => userForm(req, res));
router.get('/admin/users/:id', requirePermission('users.manage'), async (req, res) => {
  const user = isUuid(req.params.id) ? await getUser(req.params.id) : null;
  if (!user) return res.status(404).render('error', { title: 'Not found', message: 'User not found.' });
  userForm(req, res, { user });
});

router.post(['/admin/users/new', '/admin/users/:id'], requirePermission('users.manage'), verifyCsrf, async (req, res) => {
  const id = isUuid(req.params.id) ? req.params.id : null;
  try {
    await saveUser(id, req.body, { actor: req.session.admin, ip: req.ip });
    flash(req, 'success', id ? 'User saved.' : 'User created. Share the password with them securely.');
    res.redirect(303, '/admin/users');
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    const user = id ? await getUser(id) : null;
    userForm(req, res, { user, values: { ...req.body, active: req.body.active === 'on' ? 1 : 0 }, errors: err.errors, status: 422 });
  }
});

// ---------------------------------------------------------------- audit log

router.get('/admin/audit', requirePermission('audit.view'), async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const action = /^[A-Z_]{1,100}$/.test(req.query.action || '') ? req.query.action : '';
  const data = await auditLog({ page, action });
  res.render('admin/audit', { title: 'Audit log', ...data, page, action });
});

export default router;
