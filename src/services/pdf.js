import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { config, ROOT } from '../config.js';
import { eventContent } from '../content.js';
import { dayLabel, displayName, fullName, shortDate, timeRange } from '../lib/format.js';

const MM = 72 / 25.4;
export const CARD_W = 54 * MM;
export const CARD_H = 85.6 * MM;

const INK = '#1b1d24';
const MUTED = '#5d6272';
const LINE = '#dcdfe8';

// ---------------------------------------------------------------- fonts (embedded)

const FONT_DIR = path.join(ROOT, 'node_modules', '@fontsource');
const FONT_FILES = {
  Display: 'roboto-slab/files/roboto-slab-latin-900-normal.woff',
  Heading: 'roboto-slab/files/roboto-slab-latin-700-normal.woff',
  HeadingMed: 'roboto-slab/files/roboto-slab-latin-700-normal.woff',
  Body: 'roboto/files/roboto-latin-400-normal.woff',
  BodyMed: 'roboto/files/roboto-latin-500-normal.woff',
  BodyBold: 'roboto/files/roboto-latin-700-normal.woff',
};
const fontCache = {};

function newDoc(options) {
  const doc = new PDFDocument({ autoFirstPage: false, ...options });
  for (const [name, file] of Object.entries(FONT_FILES)) {
    fontCache[name] ??= fs.readFileSync(path.join(FONT_DIR, file));
    doc.registerFont(name, fontCache[name]);
  }
  return doc;
}

function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function colors(event) {
  const { theme } = eventContent(event);
  return { primary: theme.primary, secondary: theme.secondary };
}

// ---------------------------------------------------------------- images

export const checkinUrl = (p) => `${config.baseUrl}/checkin/${p.qr_token}`;

function storageFile(rel) {
  if (!rel) return null;
  const file = path.join(config.storageDir, rel);
  return fs.existsSync(file) ? file : null;
}

function logoFile(event) {
  return storageFile(event.logo_path) || (fs.existsSync(path.join(ROOT, 'public/img/logo.png')) ? path.join(ROOT, 'public/img/logo.png') : null);
}

/** Draws the QR code as vector squares, so it stays sharp at any print size. */
function drawQr(doc, text, x, y, size) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const quiet = 1;
  const cell = size / (n + quiet * 2);
  doc.save().rect(x, y, size, size).fill('#ffffff');
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.modules.get(r, c)) { c++; continue; }
      const start = c;
      while (c < n && qr.modules.get(r, c)) c++;
      doc.rect(x + (start + quiet) * cell, y + (r + quiet) * cell, (c - start) * cell + 0.02, cell + 0.02);
    }
  }
  doc.fill('#000000').restore();
}

function drawPhoto(doc, p, x, y, w, h, accent) {
  doc.save().roundedRect(x, y, w, h, 5).clip();
  const file = storageFile(p.profile_photo_path);
  let drawn = false;
  if (file) {
    try {
      doc.image(file, x, y, { cover: [w, h], align: 'center', valign: 'center' });
      drawn = true;
    } catch {
      // unreadable image: placeholder below
    }
  }
  if (!drawn) {
    doc.rect(x, y, w, h).fill('#eceef4');
    doc.fillColor(MUTED).font('Body').fontSize(6.5).text('PHOTO', x, y + h / 2 - 4, { width: w, align: 'center' });
  }
  doc.restore();
  doc.roundedRect(x, y, w, h, 5).lineWidth(1.2).stroke(accent);
}

// ---------------------------------------------------------------- ID card (CR80, 54 × 85.6 mm portrait)

// labelled detail rows on the card; a long value may use two lines when `wrap` is set
function detailRows(doc, x, y, width) {
  let cy = y;
  return {
    row(label, value, { wrap = false } = {}) {
      doc.fillColor(MUTED).font('BodyMed').fontSize(4.8).text(label.toUpperCase(), x, cy, { width, characterSpacing: 0.3, lineBreak: false });
      doc.fillColor(INK).font('BodyBold').fontSize(6.6);
      const text = value || '—';
      const lines = wrap && doc.heightOfString(text, { width }) > 10 ? 2 : 1;
      doc.text(text, x, cy + 5.6, lines === 2
        ? { width, height: 17, ellipsis: true }
        : { width, height: 9, ellipsis: true, lineBreak: false });
      cy += 15 + (lines - 1) * 8;
    },
    get y() { return cy; },
  };
}

function cardHeader(doc, event, x, y, W, h) {
  const { primary, secondary } = colors(event);
  doc.rect(x, y, W, h).fill(primary);
  doc.rect(x, y + h, W, 1.8).fill(secondary);
  const logo = logoFile(event);
  let tx = x;
  let tw = W;
  if (logo) {
    try { doc.image(logo, x + 6, y + 4, { fit: [22, h - 8], align: 'center', valign: 'center' }); tx = x + 26; tw = W - 30; } catch { /* no logo */ }
  }
  doc.fillColor('#ffffff').font('Display').fontSize(11.5).text('9 to 9 meet', tx, y + 5.5, { width: tw, align: 'center', lineBreak: false });
  doc.fillColor(secondary).font('HeadingMed').fontSize(5.2)
    .text('24 HOUR GOD EXPERIENCE', tx, y + 20, { width: tw, align: 'center', characterSpacing: 0.5, lineBreak: false });
}

function cardFooter(doc, event, x, y, W, H, text) {
  const { primary } = colors(event);
  doc.rect(x, y + H - 12, W, 12).fill(primary);
  doc.fillColor('#ffffff').font('HeadingMed').fontSize(5.6)
    .text(text, x + 4, y + H - 8.6, { width: W - 8, align: 'center', characterSpacing: 0.3, lineBreak: false, ellipsis: true });
}

// Front: photo and QR code side by side, then name, registration number, place and other details.
function drawIdFront(doc, event, p, x, y) {
  const { primary, secondary } = colors(event);
  const W = CARD_W;
  const H = CARD_H;
  const pad = 9;
  doc.save();
  doc.rect(x, y, W, H).clip();
  doc.rect(x, y, W, H).fill('#ffffff');
  cardHeader(doc, event, x, y, W, 30);

  // photo left, QR right
  const top = y + 38;
  drawPhoto(doc, p, x + pad, top, 54, 66, secondary);
  const qr = 62;
  drawQr(doc, checkinUrl(p), x + W - pad - qr, top + 2, qr);

  // name: shrink until it fits on two lines
  const name = displayName(p).toUpperCase();
  let size = 10;
  doc.font('Heading').fontSize(size);
  while (size > 6.5 && doc.heightOfString(name, { width: W - 14 }) > 2.6 * size) doc.fontSize(size -= 0.5);
  const nameH = Math.min(23, doc.heightOfString(name, { width: W - 14 }));
  doc.fillColor(INK).text(name, x + 7, top + 70 + (23 - nameH) / 2, { width: W - 14, align: 'center', height: 24, ellipsis: true });
  doc.fillColor(primary).font('BodyBold').fontSize(7.5)
    .text(p.registration_number, x, top + 95, { width: W, align: 'center', characterSpacing: 0.6, lineBreak: false });

  let cy = top + 107;
  doc.moveTo(x + pad, cy).lineTo(x + W - pad, cy).lineWidth(0.5).stroke(LINE);
  const rows = detailRows(doc, x + pad, cy + 4, W - pad * 2);
  rows.row('Place', [p.locality, p.district].filter(Boolean).join(', '));
  // parish and organization are optional form fields: only print them when collected
  if (p.parish) rows.row('Parish', p.parish);
  const org = p.organization || p.institution || p.youth_group;
  if (org) rows.row('Organization', org);
  rows.row('Emergency contact', [p.emergency_name, p.emergency_relationship && `(${p.emergency_relationship})`].filter(Boolean).join(' '));
  rows.row('Emergency phone', [p.emergency_mobile, p.emergency_alternate_mobile].filter(Boolean).join(' / '));

  cardFooter(doc, event, x, y, W, H,
    `${shortDate(event.start_at).toUpperCase()} – ${shortDate(event.end_at).toUpperCase()}${event.venue ? ` · ${event.venue.toUpperCase()}` : ''}`);
  doc.restore();
}

// Back: "My experience" — the booked activities with day, time and venue — and the QR code.
function drawIdBack(doc, event, p, bookings, x, y) {
  const { primary } = colors(event);
  const W = CARD_W;
  const H = CARD_H;
  const pad = 8;
  const qr = 54;
  doc.save();
  doc.rect(x, y, W, H).clip();
  doc.rect(x, y, W, H).fill('#ffffff');
  doc.rect(x, y, W, 20).fill(primary);
  doc.fillColor('#ffffff').font('Heading').fontSize(7.5).text('MY EXPERIENCE', x + pad, y + 6.5, { characterSpacing: 0.8, lineBreak: false });
  doc.fillColor('#ffffff').font('BodyBold').fontSize(6)
    .text(p.registration_number, x + pad, y + 7.5, { width: W - pad * 2, align: 'right', lineBreak: false });

  const qrTop = y + H - 14 - qr - 8;
  const bottom = qrTop - 6;
  let cy = y + 26;
  if (!bookings.length) {
    doc.fillColor(MUTED).font('Body').fontSize(6.3)
      .text('No activity bookings. You are welcome at all open programmes — see the schedule at the help desk.', x + pad, cy, { width: W - pad * 2, align: 'center' });
  } else {
    let lastDay = null;
    for (let i = 0; i < bookings.length; i++) {
      const b = bookings[i];
      const day = dayLabel(b.start_at);
      const activity = b.label ? `${b.activity_name} — ${b.label}` : b.activity_name;
      const need = (day !== lastDay ? 9 : 0) + 18;
      if (cy + need > bottom) {
        doc.fillColor(MUTED).font('BodyMed').fontSize(5.5)
          .text(`+ ${bookings.length - i} more — ask at the help desk`, x + pad, cy, { width: W - pad * 2, lineBreak: false });
        break;
      }
      if (day !== lastDay) {
        doc.fillColor(primary).font('BodyBold').fontSize(5.3).text(day.toUpperCase(), x + pad, cy, { characterSpacing: 0.5, lineBreak: false });
        cy += 8;
        lastDay = day;
      }
      doc.fillColor(INK).font('BodyBold').fontSize(6.2)
        .text(activity, x + pad, cy, { width: W - pad * 2, height: 8, ellipsis: true, lineBreak: false });
      doc.fillColor(MUTED).font('Body').fontSize(5.5)
        .text(`${timeRange(b.start_at, b.end_at)}${b.venue ? ` · ${b.venue}` : ''}`, x + pad, cy + 7.6, { width: W - pad * 2, height: 7, ellipsis: true, lineBreak: false });
      cy += 18;
    }
  }

  doc.moveTo(x + pad, qrTop - 3).lineTo(x + W - pad, qrTop - 3).lineWidth(0.5).stroke(LINE);
  drawQr(doc, checkinUrl(p), x + (W - qr) / 2, qrTop + 1, qr);
  doc.fillColor(MUTED).font('Body').fontSize(5)
    .text('Show this QR code at each activity', x, qrTop + qr + 1.5, { width: W, align: 'center', lineBreak: false });
  cardFooter(doc, event, x, y, W, H, event.contact_phone ? `HELP DESK: ${event.contact_phone}` : 'EVENT HELP DESK');
  doc.restore();
}

/** One participant's ID card for a card printer: page 1 front, page 2 back (with their bookings). */
export async function idCardPdf(event, p, bookings = []) {
  return idCardsPdf(event, [p], { layout: 'card', bookings: new Map([[p.id, bookings]]) });
}

function cropMarks(doc, x0, y0, cols, rows) {
  const len = 5 * MM;
  const off = 1.5 * MM;
  doc.save().lineWidth(0.3).strokeColor('#000000');
  for (let c = 0; c <= cols; c++) {
    const x = x0 + c * CARD_W;
    doc.moveTo(x, y0 - off - len).lineTo(x, y0 - off).stroke();
    doc.moveTo(x, y0 + rows * CARD_H + off).lineTo(x, y0 + rows * CARD_H + off + len).stroke();
  }
  for (let r = 0; r <= rows; r++) {
    const y = y0 + r * CARD_H;
    doc.moveTo(x0 - off - len, y).lineTo(x0 - off, y).stroke();
    doc.moveTo(x0 + cols * CARD_W + off, y).lineTo(x0 + cols * CARD_W + off + len, y).stroke();
  }
  doc.restore();
}

/**
 * ID cards for many participants.
 *  layout 'card': one card per page (front, back, front, back…) for PVC card printers.
 *  layout 'a4':   9 cards per A4 sheet with crop marks; each front sheet is followed by its
 *                 back sheet, mirrored left-to-right for long-edge duplex printing.
 * bookings: Map(participantId → confirmed bookings), printed on the back as "My experience".
 */
export async function idCardsPdf(event, participants, { layout = 'card', bookings = new Map() } = {}) {
  const booked = (p) => bookings.get(p.id) || [];
  const doc = newDoc({ info: { Title: `${event.name} — ID cards`, Author: event.name } });
  if (layout === 'a4') {
    const cols = 3;
    const rows = 3;
    const pageW = 595.28;
    const pageH = 841.89;
    const x0 = (pageW - cols * CARD_W) / 2;
    const y0 = (pageH - rows * CARD_H) / 2;
    for (let i = 0; i < participants.length; i += cols * rows) {
      const batch = participants.slice(i, i + cols * rows);
      doc.addPage({ size: 'A4', margin: 0 });
      batch.forEach((p, k) => drawIdFront(doc, event, p, x0 + (k % cols) * CARD_W, y0 + Math.floor(k / cols) * CARD_H));
      cropMarks(doc, x0, y0, cols, rows);
      doc.addPage({ size: 'A4', margin: 0 });
      batch.forEach((p, k) => drawIdBack(doc, event, p, booked(p), x0 + (cols - 1 - (k % cols)) * CARD_W, y0 + Math.floor(k / cols) * CARD_H));
      cropMarks(doc, x0, y0, cols, rows);
    }
  } else {
    for (const p of participants) {
      doc.addPage({ size: [CARD_W, CARD_H], margin: 0 });
      drawIdFront(doc, event, p, 0, 0);
      doc.addPage({ size: [CARD_W, CARD_H], margin: 0 });
      drawIdBack(doc, event, p, booked(p), 0, 0);
    }
  }
  return toBuffer(doc);
}

// ---------------------------------------------------------------- activity card (A5)

function drawActivityCard(doc, event, p, bookings, openItems) {
  const { primary, secondary } = colors(event);
  const content = eventContent(event);
  doc.addPage({ size: 'A5', margins: { top: 36, bottom: 20, left: 36, right: 36 } });
  const W = doc.page.width;
  const H = doc.page.height;
  const L = 36;
  const R = W - 36;

  // header
  doc.rect(0, 0, W, 96).fill(primary);
  doc.rect(0, 96, W, 4).fill(secondary);
  const logo = logoFile(event);
  if (logo) { try { doc.image(logo, L, 18, { fit: [58, 58] }); } catch { /* no logo */ } }
  doc.fillColor('#ffffff').font('Display').fontSize(26).text('9 to 9 meet', 0, 17, { width: W, align: 'center', lineBreak: false });
  doc.fillColor(secondary).font('Heading').fontSize(9).text('24 HOUR GOD EXPERIENCE', 0, 48, { width: W, align: 'center', characterSpacing: 1.2, lineBreak: false });
  doc.fillColor('#cfd5ea').font('BodyMed').fontSize(7.5)
    .text((event.subtitle || '').toUpperCase(), 0, 64, { width: W, align: 'center', characterSpacing: 0.6, lineBreak: false });
  doc.fillColor('#cfd5ea').font('Body').fontSize(7)
    .text(`${shortDate(event.start_at)} 9 AM – ${shortDate(event.end_at)} 9 AM${event.venue ? ` · ${event.venue}` : ''}`, 0, 77, { width: W, align: 'center', lineBreak: false });

  doc.fillColor(primary).font('Heading').fontSize(10).text('PARTICIPANT ACTIVITY CARD', L, 114, { characterSpacing: 1, lineBreak: false });

  const qrSize = 94;
  drawQr(doc, checkinUrl(p), R - qrSize, 108, qrSize);
  doc.fillColor(MUTED).font('BodyMed').fontSize(7).text('PARTICIPANT', L, 136, { characterSpacing: 0.5 });
  doc.fillColor(INK).font('Heading').fontSize(14).text(fullName(p).toUpperCase(), L, 146, { width: R - qrSize - L - 10, height: 36, ellipsis: true });
  doc.fillColor(MUTED).font('BodyMed').fontSize(7).text('REGISTRATION', L, 180, { characterSpacing: 0.5 });
  doc.fillColor(primary).font('Heading').fontSize(12).text(p.registration_number, L, 189, { characterSpacing: 0.6, lineBreak: false });

  let y = 220;
  const cols = [
    { title: 'TIME', x: L, w: 104 },
    { title: 'ACTIVITY', x: L + 106, w: 146 },
    { title: 'VENUE', x: L + 254, w: R - (L + 254) - 22 },
    { title: '✓', x: R - 20, w: 20 },
  ];
  const header = () => {
    doc.rect(L, y, R - L, 17).fill('#eef1f8');
    doc.fillColor(primary).font('Heading').fontSize(7);
    for (const c of cols.slice(0, 3)) doc.text(c.title, c.x + 4, y + 5.5, { width: c.w - 4, lineBreak: false });
    y += 21;
  };
  const ensureRoom = (h) => {
    if (y + h > H - 64) {
      doc.addPage({ size: 'A5', margins: { top: 36, bottom: 20, left: 36, right: 36 } });
      y = 36;
      header();
    }
  };

  const section = (title, items, emptyText, withBox) => {
    ensureRoom(44);
    doc.fillColor(INK).font('Heading').fontSize(9.5).text(title, L, y, { lineBreak: false });
    y += 15;
    header();
    if (!items.length) {
      doc.fillColor(MUTED).font('Body').fontSize(8.5).text(emptyText, L + 4, y);
      y += 20;
      return;
    }
    let lastDay = null;
    for (const b of items) {
      const day = dayLabel(b.start_at);
      if (day !== lastDay) {
        ensureRoom(34);
        doc.fillColor(MUTED).font('BodyBold').fontSize(6.8).text(day.toUpperCase(), L + 4, y, { characterSpacing: 0.6, lineBreak: false });
        y += 11;
        lastDay = day;
      }
      const activity = b.label ? `${b.activity_name} — ${b.label}` : b.activity_name;
      doc.font('BodyBold').fontSize(8.5);
      const h = Math.max(17, doc.heightOfString(activity, { width: cols[1].w - 4 }) + 7);
      ensureRoom(h);
      doc.fillColor(INK).font('BodyMed').fontSize(8.3).text(timeRange(b.start_at, b.end_at), cols[0].x + 4, y + 3.5, { width: cols[0].w - 4 });
      doc.font('BodyBold').fontSize(8.5).text(activity, cols[1].x + 4, y + 3.5, { width: cols[1].w - 4 });
      doc.font('Body').fontSize(8.3).text(b.venue || '—', cols[2].x + 4, y + 3.5, { width: cols[2].w - 4 });
      if (withBox) {
        // stamped or ticked by staff at the activity
        doc.roundedRect(cols[3].x + 5, y + 3, 10, 10, 2).lineWidth(0.8).stroke(b.checked_in_at ? primary : '#9aa0b4');
        if (b.checked_in_at) doc.moveTo(cols[3].x + 7, y + 8).lineTo(cols[3].x + 9.5, y + 10.5).lineTo(cols[3].x + 13.5, y + 5).lineWidth(1.3).stroke(primary);
      }
      y += h;
      doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).stroke(LINE);
      y += 2;
    }
    y += 10;
  };

  section('MY EXPERIENCE', bookings, 'No slot bookings. You are welcome at all open programmes.', true);
  if (openItems.length) section('OPEN TO ALL PARTICIPANTS', openItems, '', false);

  doc.fillColor(MUTED).font('Body').fontSize(7.3)
    .text(`Show the QR code on this card or your ID card at each activity. ${event.help_desk_text || 'For assistance please contact the EVENT HELP DESK.'}`,
      L, H - 54, { width: R - L, align: 'center' });
}

/** Card 2: A5 personal activity card with the participant's bookings. */
export async function activityCardPdf(event, p, bookings, openItems = []) {
  return activityCardsPdf(event, [{ participant: p, bookings }], openItems);
}

/** Activity cards for many participants in one PDF. items: [{ participant, bookings }] */
export async function activityCardsPdf(event, items, openItems = []) {
  const doc = newDoc({ info: { Title: `${event.name} — Activity cards`, Author: event.name } });
  for (const { participant, bookings } of items) drawActivityCard(doc, event, participant, bookings, openItems);
  return toBuffer(doc);
}

/** PNG data URL of the check-in QR for showing on web pages. */
export function qrDataUrl(p) {
  return QRCode.toDataURL(checkinUrl(p), { errorCorrectionLevel: 'M', margin: 1, width: 320 });
}
