// Event settings, editable content and branding.
import { eventContent } from '../content.js';
import { query, tx } from '../db.js';
import { FIELDS } from '../fields.js';
import { audit } from './audit.js';
import { ValidationError } from './catalog.js';

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const toDb = (v) => (DT_RE.test(v || '') ? `${v.replace('T', ' ')}:00` : null);
const HEX_RE = /^#[0-9a-f]{6}$/i;

/**
 * Saves the settings form. When the event start moves to a different day and `shift_slots`
 * is ticked, every slot moves by the same number of days (e.g. to reuse the programme next year).
 */
export async function saveSettings(event, body, { heroPath, logoPath, adminId, ip } = {}) {
  const errors = {};
  const v = {
    name: str(body.name, 255),
    subtitle: str(body.subtitle, 255) || null,
    venue: str(body.venue, 255) || null,
    start_at: toDb(body.start_at),
    end_at: toDb(body.end_at),
    registration_open_at: toDb(body.registration_open_at),
    registration_close_at: toDb(body.registration_close_at),
    status: ['open', 'closed', 'draft'].includes(body.status) ? body.status : event.status,
    auto_approve: body.auto_approve === 'on' ? 1 : 0,
    allow_overlapping_bookings: body.allow_overlapping_bookings === 'on' ? 1 : 0,
    duplicate_rule: ['mobile_name', 'mobile', 'email', 'none'].includes(body.duplicate_rule) ? body.duplicate_rule : event.duplicate_rule,
    contact_phone: str(body.contact_phone, 50) || null,
    contact_email: str(body.contact_email, 255) || null,
    help_desk_text: str(body.help_desk_text, 255) || null,
  };
  if (!v.name) errors.name = 'Event name is required.';
  if (!v.start_at) errors.start_at = 'Start is required.';
  if (!v.end_at) errors.end_at = 'End is required.';
  if (v.start_at && v.end_at && v.end_at <= v.start_at) errors.end_at = 'End must be after the start.';
  if (body.registration_open_at && !v.registration_open_at) errors.registration_open_at = 'Invalid date.';
  if (body.registration_close_at && !v.registration_close_at) errors.registration_close_at = 'Invalid date.';

  const current = eventContent(event);
  const content = {
    ...current,
    theme: {
      primary: HEX_RE.test(body.theme_primary || '') ? body.theme_primary : current.theme.primary,
      secondary: HEX_RE.test(body.theme_secondary || '') ? body.theme_secondary : current.theme.secondary,
    },
  };
  for (const key of ['hero_kicker', 'hero_theme', 'intro_title', 'organizers', 'card_instruction']) {
    if (key in body) content[key] = str(body[key], 500);
  }
  for (const key of ['intro_text', 'privacy_text', 'terms_text']) {
    if (key in body) content[key] = str(body[key], 10000);
  }
  if ('feature_title_0' in body) {
    content.features = [0, 1, 2, 3]
      .map((i) => ({ title: str(body[`feature_title_${i}`], 60), text: str(body[`feature_text_${i}`], 300) }))
      .filter((f) => f.title);
  }
  if ('food_options' in body) {
    const opts = String(body.food_options).split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean).slice(0, 10);
    content.food_options = opts.length ? opts : undefined;
  }

  const formConfig = {};
  for (const f of FIELDS) {
    const mode = body[`field_${f.name}`];
    if (!f.locked && ['required', 'optional', 'hidden'].includes(mode) && mode !== f.mode) formConfig[f.name] = mode;
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);

  const update = { ...v, content: JSON.stringify(content), form_config: JSON.stringify(formConfig) };
  if (heroPath) update.hero_image_path = heroPath;
  if (logoPath) update.logo_path = logoPath;
  if (body.remove_hero === 'on' && !heroPath) update.hero_image_path = null;
  if (body.remove_logo === 'on' && !logoPath) update.logo_path = null;

  const dayShift = Math.round((Date.parse(`${v.start_at.slice(0, 10)}T00:00:00Z`) - Date.parse(`${event.start_at.slice(0, 10)}T00:00:00Z`)) / 86400000);
  await tx(async (conn) => {
    await conn.query('UPDATE events SET ? WHERE id = ?', [update, event.id]);
    if (dayShift && body.shift_slots === 'on') {
      await conn.query(
        `UPDATE activity_slots s JOIN activities a ON a.id = s.activity_id
            SET s.start_at = s.start_at + INTERVAL ? DAY, s.end_at = s.end_at + INTERVAL ? DAY
          WHERE a.event_id = ?`, [dayShift, dayShift, event.id]);
    }
    await audit(conn, {
      adminId, action: 'SETTINGS_UPDATED', ip,
      oldValue: { name: event.name, start_at: event.start_at, status: event.status },
      newValue: { name: v.name, start_at: v.start_at, status: v.status, slotsShiftedDays: body.shift_slots === 'on' ? dayShift : 0 },
    });
  });
  return { dayShift };
}

export async function auditLog({ page = 1, pageSize = 50, action = '', adminId = '' } = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (action) { where.push('l.action = ?'); params.push(action); }
  if (adminId) { where.push('l.admin_user_id = ?'); params.push(adminId); }
  const rows = await query(
    `SELECT l.*, u.name AS admin_name, p.registration_number, p.first_name, p.last_name
       FROM audit_logs l LEFT JOIN admin_users u ON u.id = l.admin_user_id LEFT JOIN participants p ON p.id = l.participant_id
      WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC, l.id LIMIT ? OFFSET ?`,
    [...params, pageSize + 1, (page - 1) * pageSize]);
  const actions = (await query('SELECT DISTINCT action FROM audit_logs ORDER BY action')).map((r) => r.action);
  return { rows: rows.slice(0, pageSize), hasMore: rows.length > pageSize, actions };
}
