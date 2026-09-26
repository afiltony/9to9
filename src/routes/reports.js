// Admin: reports/exports and bulk card printing.
import express from 'express';
import { requirePermission, verifyCsrf } from '../lib/security.js';
import { audit } from '../services/audit.js';
import {
  bookingsFor, countForPrint, filterOptions, markCardsPrinted, parseFilters, participantsForPrint, STATUSES,
} from '../services/participants.js';
import { activityCardsPdf, idCardsPdf } from '../services/pdf.js';
import { getSchedule, newId } from '../services/registration.js';
import { REPORTS, toCsv, toPdf, toXlsx } from '../services/reports.js';
import { query } from '../db.js';
import { openProgrammeItems } from './public.js';

const router = express.Router();

// PDFs are built in the request; this keeps each download well inside shared-hosting time limits
export const MAX_BATCH = 150;

// ---------------------------------------------------------------- reports

router.get('/admin/reports', requirePermission('reports.view'), async (req, res) => {
  const schedule = await getSchedule(req.event.id, { bookableOnly: true });
  res.render('admin/reports', { title: 'Reports', reports: REPORTS, schedule, options: await filterOptions(req.event.id), statuses: STATUSES });
});

router.get('/admin/reports/:key', requirePermission('reports.view'), async (req, res) => {
  const def = REPORTS[req.params.key];
  if (!def) return res.status(404).render('error', { title: 'Not found', message: 'Unknown report.' });
  const filters = parseFilters(req.query);
  if (def.needsSlot && !filters.slot) {
    req.session.flash = { type: 'error', text: 'Choose a slot for the participant list.' };
    return res.redirect('/admin/reports');
  }
  const report = await def.build(req.event, filters);
  let title = def.title;
  if (def.needsSlot) {
    const [s] = await query(`SELECT a.name, s.start_at FROM activity_slots s JOIN activities a ON a.id = s.activity_id WHERE s.id = ?`, [filters.slot]);
    if (s) title = `${s.name} — ${res.locals.fmt.dayLabel(s.start_at)} ${res.locals.fmt.time(s.start_at)}`;
  }
  const format = req.query.format;
  const base = `${req.params.key}-${new Date().toISOString().slice(0, 10)}`;
  if (format && format !== 'html') {
    await audit(null, { adminId: req.session.admin.id, action: 'REPORT_EXPORTED', newValue: { report: req.params.key, format }, ip: req.ip });
  }
  if (format === 'csv') {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${base}.csv"` });
    return res.send(toCsv(report));
  }
  if (format === 'xlsx') {
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${base}.xlsx"` });
    return res.send(await toXlsx(report, def.title));
  }
  if (format === 'pdf') {
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${base}.pdf"` });
    return res.send(await toPdf(report, title, req.event));
  }
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v && v !== 'newest')).toString();
  res.render('admin/report', { title, def, key: req.params.key, report, qs });
});

// ---------------------------------------------------------------- bulk card printing

router.get('/admin/documents', requirePermission('documents.print'), async (req, res) => {
  const filters = parseFilters({ printed: 'no', status: 'approved', ...req.query });
  const [count, options, schedule, printedStats] = await Promise.all([
    countForPrint(req.event.id, filters),
    filterOptions(req.event.id),
    getSchedule(req.event.id, { bookableOnly: true }),
    query(`SELECT SUM(card_printed_at IS NULL) AS waiting, SUM(card_printed_at IS NOT NULL) AS printed
             FROM participants WHERE event_id = ? AND status = 'approved'`, [req.event.id]),
  ]);
  res.render('admin/documents', {
    title: 'Print cards', filters, count, options, schedule, statuses: STATUSES, maxBatch: MAX_BATCH,
    waiting: Number(printedStats[0].waiting || 0), printed: Number(printedStats[0].printed || 0),
  });
});

router.post('/admin/documents', requirePermission('documents.print'), verifyCsrf, async (req, res) => {
  const filters = parseFilters(req.body);
  const ids = [].concat(req.body.ids || []).filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, MAX_BATCH);
  const kind = req.body.kind === 'activity' ? 'activity' : 'id';
  const layout = req.body.layout === 'a4' ? 'a4' : 'card';
  // printing by filter happens only from the Print cards page; elsewhere a selection is required
  if (!ids.length && req.body.scope !== 'filter') {
    req.session.flash = { type: 'warning', text: 'Select at least one participant first.' };
    return res.redirect(303, '/admin/participants');
  }
  const participants = await participantsForPrint(req.event.id, filters, { ids: ids.length ? ids : null, limit: MAX_BATCH });
  if (!participants.length) {
    req.session.flash = { type: 'warning', text: 'No participants match — nothing to print.' };
    return res.redirect(303, '/admin/documents');
  }

  let buffer;
  if (kind === 'id') {
    buffer = await idCardsPdf(req.event, participants, { layout });
    if (req.body.mark !== 'no') await markCardsPrinted(participants.map((p) => p.id));
  } else {
    const bookings = await bookingsFor(participants.map((p) => p.id));
    const open = openProgrammeItems(await getSchedule(req.event.id));
    buffer = await activityCardsPdf(req.event, participants.map((p) => ({ participant: p, bookings: bookings.get(p.id) })), open);
  }

  const docType = kind === 'id' ? 'ID_CARD' : 'ACTIVITY_CARD';
  const values = participants.map((p) => [newId(), p.id, docType, req.session.admin.id]);
  await query('INSERT INTO participant_documents (id, participant_id, document_type, generated_by) VALUES ?', [values]);
  const first = participants[0].registration_number;
  const last = participants.at(-1).registration_number;
  await audit(null, {
    adminId: req.session.admin.id, action: 'PDF_BULK_GENERATED', ip: req.ip,
    newValue: { kind: docType, layout, count: participants.length, from: first, to: last },
  });
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${kind === 'id' ? 'id-cards' : 'activity-cards'}-${first}-to-${last}.pdf"`,
    'Cache-Control': 'private, no-store',
  });
  res.send(buffer);
});

export default router;
