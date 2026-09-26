// Tabular reports with CSV, Excel and PDF export.
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { query } from '../db.js';
import { dateTime, fullName, timeRange, dayLabel, time } from '../lib/format.js';
import { filterSql } from './participants.js';

const col = (key, label, width = 18) => ({ key, label, width });

const PARTICIPANT_SELECT = `p.*, e.name AS em_name, e.relationship AS em_relationship, e.mobile AS em_mobile,
  (SELECT c.checked_in_at FROM checkins c WHERE c.dedupe_key = CONCAT(p.id, ':EVENT')) AS checked_in_at,
  (SELECT GROUP_CONCAT(CONCAT(a.name, ' ', DATE_FORMAT(s.start_at, '%d %b %H:%i')) ORDER BY s.start_at SEPARATOR '; ')
     FROM participant_slots ps JOIN activity_slots s ON s.id = ps.slot_id JOIN activities a ON a.id = s.activity_id
    WHERE ps.participant_id = p.id AND ps.status = 'confirmed') AS activities`;

async function participantRows(event, filters) {
  const { where, params } = filterSql(event.id, filters);
  return query(`SELECT ${PARTICIPANT_SELECT} FROM participants p LEFT JOIN emergency_contacts e ON e.participant_id = p.id
                 WHERE ${where} ORDER BY p.registration_number`, params);
}

const groupReport = (column, label) => async (event) => ({
  columns: [col('value', label, 40), col('total', 'Registrations', 14), col('approved', 'Approved', 12), col('checked_in', 'Checked in', 12)],
  rows: await query(
    `SELECT COALESCE(NULLIF(p.${column}, ''), '(not given)') AS value, COUNT(*) AS total,
            SUM(p.status = 'approved') AS approved,
            SUM(EXISTS (SELECT 1 FROM checkins c WHERE c.dedupe_key = CONCAT(p.id, ':EVENT'))) AS checked_in
       FROM participants p WHERE p.event_id = ? AND p.status NOT IN ('cancelled', 'rejected')
      GROUP BY value ORDER BY total DESC, value`, [event.id]),
});

export const REPORTS = {
  participants: {
    title: 'Participant report',
    description: 'Every registration with contact, organization, requirements and bookings. Uses the participant filters.',
    filters: true,
    async build(event, filters) {
      const rows = await participantRows(event, filters);
      return {
        columns: [col('registration_number', 'Reg. no', 14), col('name', 'Name', 26), col('status', 'Status', 11), col('gender', 'Gender', 9),
          col('age', 'DOB', 11), col('mobile', 'Mobile', 14), col('email', 'Email', 24), col('parish', 'Parish', 24), col('diocese', 'Diocese', 18),
          col('organization', 'Organization', 20), col('district', 'District', 14), col('emergency', 'Emergency contact', 28),
          col('accommodation', 'Accommodation', 12), col('food', 'Food', 16), col('activities', 'Activities', 50),
          col('checked_in', 'Checked in', 16), col('registered', 'Registered', 18)],
        rows: rows.map((p) => ({
          registration_number: p.registration_number, name: fullName(p), status: p.status, gender: p.gender, age: p.date_of_birth,
          mobile: p.mobile, email: p.email, parish: p.parish, diocese: p.diocese, organization: p.organization, district: p.district,
          emergency: [p.em_name, p.em_relationship && `(${p.em_relationship})`, p.em_mobile].filter(Boolean).join(' '),
          accommodation: p.accommodation_required ? 'Yes' : 'No', food: p.food_required ? p.food_preference || 'Yes' : 'No',
          activities: p.activities || '', checked_in: p.checked_in_at ? dateTime(p.checked_in_at) : '', registered: dateTime(p.created_at),
        })),
      };
    },
  },
  activities: {
    title: 'Activity report',
    description: 'Bookings and attendance per activity.',
    async build(event) {
      const rows = await query(
        // subqueries rather than GROUP BY a.id: MariaDB's ONLY_FULL_GROUP_BY rejects the grouped form
        `SELECT a.name, a.venue,
                (SELECT COUNT(*) FROM activity_slots s WHERE s.activity_id = a.id) AS slots,
                (SELECT SUM(s.capacity) FROM activity_slots s WHERE s.activity_id = a.id) AS capacity,
                (SELECT SUM(s.registration_count) FROM activity_slots s WHERE s.activity_id = a.id) AS booked,
                (SELECT COUNT(*) FROM checkins c JOIN activity_slots s ON s.id = c.slot_id WHERE s.activity_id = a.id) AS attended,
                (SELECT COUNT(*) FROM activity_slots s WHERE s.activity_id = a.id AND s.capacity IS NULL) AS unlimited
           FROM activities a
          WHERE a.event_id = ? AND a.requires_slot = 1 ORDER BY a.sort_order`, [event.id]);
      return {
        columns: [col('name', 'Activity', 30), col('venue', 'Venue', 20), col('slots', 'Slots', 8), col('capacity', 'Capacity', 10),
          col('booked', 'Booked', 10), col('fill', 'Filled', 9), col('attended', 'Checked in', 11)],
        rows: rows.map((r) => ({
          ...r, capacity: Number(r.unlimited) ? 'No limit' : Number(r.capacity || 0), booked: Number(r.booked || 0), attended: Number(r.attended || 0),
          fill: r.capacity && !Number(r.unlimited) ? `${Math.round((100 * r.booked) / r.capacity)}%` : '',
        })),
      };
    },
  },
  slots: {
    title: 'Slot occupancy',
    description: 'Every time slot with capacity, bookings, places left and check-ins.',
    async build(event) {
      const rows = await query(
        `SELECT a.name, a.venue, s.label, s.start_at, s.end_at, s.capacity, s.registration_count, s.status,
                (SELECT COUNT(*) FROM checkins c WHERE c.slot_id = s.id) AS attended
           FROM activity_slots s JOIN activities a ON a.id = s.activity_id
          WHERE a.event_id = ? AND a.requires_slot = 1 ORDER BY a.sort_order, s.start_at`, [event.id]);
      return {
        columns: [col('name', 'Activity', 26), col('day', 'Day', 12), col('time', 'Time', 20), col('label', 'Detail', 30),
          col('capacity', 'Capacity', 10), col('booked', 'Booked', 9), col('left', 'Left', 8), col('attended', 'Checked in', 11), col('status', 'Status', 9)],
        rows: rows.map((r) => ({
          name: r.name, day: dayLabel(r.start_at), time: timeRange(r.start_at, r.end_at), label: r.label || '',
          capacity: r.capacity ?? 'No limit', booked: r.registration_count,
          left: r.capacity == null ? '' : Math.max(0, r.capacity - r.registration_count),
          attended: Number(r.attended), status: r.capacity != null && r.registration_count >= r.capacity ? 'full' : r.status,
        })),
      };
    },
  },
  roster: {
    title: 'Slot participant list',
    description: 'Names booked into one slot — print it for the volunteers at that activity.',
    needsSlot: true,
    async build(event, filters) {
      const rows = await query(
        `SELECT p.registration_number, p.first_name, p.middle_name, p.last_name, p.mobile, p.parish, p.status, c.checked_in_at
           FROM participant_slots ps JOIN participants p ON p.id = ps.participant_id
           LEFT JOIN checkins c ON c.dedupe_key = CONCAT(p.id, ':', ps.slot_id)
          WHERE ps.slot_id = ? AND ps.status = 'confirmed' AND p.event_id = ? ORDER BY p.first_name, p.last_name`,
        [filters.slot, event.id]);
      return {
        columns: [col('n', '#', 5), col('registration_number', 'Reg. no', 14), col('name', 'Name', 30), col('mobile', 'Mobile', 14),
          col('parish', 'Parish', 26), col('status', 'Status', 10), col('checked_in', 'Checked in', 12)],
        rows: rows.map((r, i) => ({ n: i + 1, ...r, name: fullName(r), checked_in: r.checked_in_at ? time(r.checked_in_at) : '' })),
      };
    },
  },
  checkins: {
    title: 'Attendance (check-in) report',
    description: 'Every check-in at the entrance and at activities, with time and staff member.',
    async build(event) {
      const rows = await query(
        `SELECT c.checked_in_at, c.checkin_type, p.registration_number, p.first_name, p.middle_name, p.last_name,
                a.name AS activity, s.start_at, s.end_at, u.name AS staff
           FROM checkins c JOIN participants p ON p.id = c.participant_id
           LEFT JOIN activity_slots s ON s.id = c.slot_id LEFT JOIN activities a ON a.id = s.activity_id
           LEFT JOIN admin_users u ON u.id = c.scanned_by
          WHERE p.event_id = ? ORDER BY c.checked_in_at`, [event.id]);
      return {
        columns: [col('when', 'Time', 18), col('registration_number', 'Reg. no', 14), col('name', 'Name', 28), col('where', 'Checked in at', 36), col('staff', 'Staff', 18)],
        rows: rows.map((r) => ({
          when: dateTime(r.checked_in_at), registration_number: r.registration_number, name: fullName(r),
          where: r.checkin_type === 'EVENT_ENTRY' ? 'Event entrance (card handed over)' : `${r.activity} ${timeRange(r.start_at, r.end_at)}`,
          staff: r.staff || '',
        })),
      };
    },
  },
  accommodation: {
    title: 'Accommodation report',
    description: 'Participants who need accommodation, with arrival and departure.',
    async build(event) {
      const rows = await query(
        `SELECT * FROM participants WHERE event_id = ? AND accommodation_required = 1 AND status NOT IN ('cancelled', 'rejected')
          ORDER BY gender, first_name`, [event.id]);
      return {
        columns: [col('registration_number', 'Reg. no', 14), col('name', 'Name', 28), col('gender', 'Gender', 9), col('mobile', 'Mobile', 14),
          col('arrival', 'Arrival', 18), col('departure', 'Departure', 18), col('notes', 'Notes', 36)],
        rows: rows.map((p) => ({
          registration_number: p.registration_number, name: fullName(p), gender: p.gender, mobile: p.mobile,
          arrival: dateTime(p.arrival_at), departure: dateTime(p.departure_at), notes: p.accommodation_notes || '',
        })),
      };
    },
  },
  food: {
    title: 'Food report',
    description: 'Food requirement totals by preference, followed by special dietary notes.',
    async build(event) {
      const totals = await query(
        `SELECT COALESCE(food_preference, 'No preference') AS preference, COUNT(*) AS n FROM participants
          WHERE event_id = ? AND food_required = 1 AND status NOT IN ('cancelled', 'rejected') GROUP BY preference ORDER BY n DESC`, [event.id]);
      const notes = await query(
        `SELECT registration_number, first_name, middle_name, last_name, food_preference, dietary_notes FROM participants
          WHERE event_id = ? AND food_required = 1 AND status NOT IN ('cancelled', 'rejected') AND dietary_notes IS NOT NULL AND dietary_notes <> ''
          ORDER BY first_name`, [event.id]);
      return {
        columns: [col('a', 'Preference / Reg. no', 24), col('b', 'Count / Name', 28), col('c', 'Dietary notes', 50)],
        rows: [
          ...totals.map((t) => ({ a: t.preference, b: Number(t.n), c: '' })),
          ...(notes.length ? [{ a: '', b: '', c: '' }] : []),
          ...notes.map((p) => ({ a: p.registration_number, b: fullName(p), c: `${p.food_preference || ''}: ${p.dietary_notes}` })),
        ],
      };
    },
  },
  organizations: { title: 'Organization report', description: 'Registrations per organization / movement.', build: groupReport('organization', 'Organization') },
  parishes: { title: 'Parish report', description: 'Registrations per parish.', build: groupReport('parish', 'Parish') },
  districts: { title: 'District report', description: 'Registrations per district.', build: groupReport('district', 'District') },
};

// ---------------------------------------------------------------- export formats

const cell = (v) => (v == null ? '' : v);

export function toCsv(report) {
  const esc = (v) => {
    const s = String(cell(v));
    // leading = + - @ would be run as a formula by Excel
    const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [report.columns.map((c) => esc(c.label)).join(',')];
  for (const r of report.rows) lines.push(report.columns.map((c) => esc(r[c.key])).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

export async function toXlsx(report, title) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title.slice(0, 31));
  ws.columns = report.columns.map((c) => ({ header: c.label, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of report.rows) ws.addRow(Object.fromEntries(report.columns.map((c) => [c.key, cell(r[c.key])])));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toPdf(report, title, event) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, info: { Title: title } });
  const W = doc.page.width - 60;
  const total = report.columns.reduce((s, c) => s + c.width, 0);
  const widths = report.columns.map((c) => (c.width / total) * W);
  let y = 30;
  const header = () => {
    doc.rect(30, y, W, 16).fill('#1c2a5e');
    let x = 30;
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7);
    report.columns.forEach((c, i) => { doc.text(c.label, x + 3, y + 5, { width: widths[i] - 6, lineBreak: false, ellipsis: true }); x += widths[i]; });
    y += 18;
  };
  doc.fillColor('#1c2a5e').font('Helvetica-Bold').fontSize(13).text(title, 30, y);
  doc.fillColor('#5d6272').font('Helvetica').fontSize(8).text(`${event.name} · ${report.rows.length} rows`, 30, y + 17);
  y += 36;
  header();
  doc.font('Helvetica').fontSize(7);
  report.rows.forEach((r, n) => {
    const texts = report.columns.map((c) => String(cell(r[c.key])));
    const h = Math.max(13, ...texts.map((t, i) => doc.heightOfString(t, { width: widths[i] - 6 }) + 5));
    if (y + h > doc.page.height - 30) { doc.addPage(); y = 30; header(); doc.font('Helvetica').fontSize(7); }
    if (n % 2) doc.rect(30, y - 1, W, h).fill('#f3f5fa');
    let x = 30;
    doc.fillColor('#1b1d24');
    texts.forEach((t, i) => { doc.text(t, x + 3, y + 2, { width: widths[i] - 6 }); x += widths[i]; });
    y += h;
  });
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
