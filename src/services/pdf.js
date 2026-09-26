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

function drawIdFront(doc, event, p, x, y) {
  const { primary, secondary } = colors(event);
  const W = CARD_W;
  const H = CARD_H;
  doc.save();
  doc.rect(x, y, W, H).clip();
  doc.rect(x, y, W, H).fill('#ffffff');

  // header band
  doc.rect(x, y, W, 42).fill(primary);
  doc.rect(x, y + 42, W, 2.2).fill(secondary);
  const logo = logoFile(event);
  let tx = x;
  let tw = W;
  if (logo) {
    try { doc.image(logo, x + 6, y + 7, { fit: [26, 28], align: 'center', valign: 'center' }); tx = x + 30; tw = W - 34; } catch { /* no logo */ }
  }
  doc.fillColor('#ffffff').font('Display').fontSize(13).text('9 to 9 meet', tx, y + 9, { width: tw, align: 'center', lineBreak: false });
  doc.fillColor(secondary).font('HeadingMed').fontSize(5.6)
    .text('24 HOUR GOD EXPERIENCE', tx, y + 26, { width: tw, align: 'center', characterSpacing: 0.5, lineBreak: false });

  drawPhoto(doc, p, x + (W - 60) / 2, y + 51, 60, 74, secondary);

  const name = displayName(p).toUpperCase();
  doc.font('Heading').fontSize(10);
  const nameH = Math.min(25, doc.heightOfString(name, { width: W - 14 }));
  doc.fillColor(INK).text(name, x + 7, y + 130 + (25 - nameH) / 2, { width: W - 14, align: 'center', height: 26, ellipsis: true });
  doc.fillColor(primary).font('BodyBold').fontSize(8)
    .text(p.registration_number, x, y + 157, { width: W, align: 'center', characterSpacing: 0.6, lineBreak: false });

  drawQr(doc, checkinUrl(p), x + (W - 58) / 2, y + 168, 58);

  doc.rect(x, y + H - 13, W, 13).fill(primary);
  doc.fillColor('#ffffff').font('HeadingMed').fontSize(6)
    .text(`${shortDate(event.start_at).toUpperCase()} – ${shortDate(event.end_at).toUpperCase()}${event.venue ? ` · ${event.venue.toUpperCase()}` : ''}`,
      x, y + H - 9.3, { width: W, align: 'center', characterSpacing: 0.4, lineBreak: false });
  doc.restore();
}

function drawIdBack(doc, event, p, x, y) {
  const { primary, secondary } = colors(event);
  const content = eventContent(event);
  const W = CARD_W;
  const H = CARD_H;
  const pad = 9;
  doc.save();
  doc.rect(x, y, W, H).clip();
  doc.rect(x, y, W, H).fill('#ffffff');
  doc.rect(x, y, W, 21).fill(primary);
  doc.rect(x, y + 21, W, 1.6).fill(secondary);
  doc.fillColor('#ffffff').font('Heading').fontSize(7.5).text('PARTICIPANT', x + pad, y + 6.5, { characterSpacing: 0.8, lineBreak: false });

  let cy = y + 29;
  const row = (label, value) => {
    doc.fillColor(MUTED).font('BodyMed').fontSize(5).text(label.toUpperCase(), x + pad, cy, { width: W - pad * 2, characterSpacing: 0.3, lineBreak: false });
    doc.fillColor(INK).font('BodyBold').fontSize(6.8).text(value || '—', x + pad, cy + 6, { width: W - pad * 2, height: 9, ellipsis: true, lineBreak: false });
    cy += 17;
  };
  row('Name', fullName(p));
  row('Registration', p.registration_number);
  row('Place', [p.locality, p.district].filter(Boolean).join(', '));
  row('Parish', p.parish);
  row('Organization', p.organization || p.institution || p.youth_group);

  cy += 1;
  doc.moveTo(x + pad, cy).lineTo(x + W - pad, cy).lineWidth(0.5).stroke(LINE);
  cy += 5;
  doc.roundedRect(x + pad - 3, cy - 2, W - pad * 2 + 6, 44, 4).fill('#eef0f3');
  doc.fillColor(primary).font('Heading').fontSize(6).text('EMERGENCY CONTACT', x + pad, cy + 2, { characterSpacing: 0.4, lineBreak: false });
  cy += 11;
  row('Name', [p.emergency_name, p.emergency_relationship && `(${p.emergency_relationship})`].filter(Boolean).join(' '));
  row('Phone', [p.emergency_mobile, p.emergency_alternate_mobile].filter(Boolean).join(' / '));

  doc.fillColor(MUTED).font('Body').fontSize(5.3)
    .text(content.card_instruction, x + pad, y + H - 29, { width: W - pad * 2, align: 'center' });
  if (event.contact_phone) {
    doc.fillColor(primary).font('BodyBold').fontSize(5.5)
      .text(`Help desk: ${event.contact_phone}`, x + pad, y + H - 14, { width: W - pad * 2, align: 'center', lineBreak: false });
  }
  doc.restore();
}

/** One participant's ID card for a card printer: page 1 front, page 2 back. */
export async function idCardPdf(event, p) {
  return idCardsPdf(event, [p], { layout: 'card' });
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
 */
export async function idCardsPdf(event, participants, { layout = 'card' } = {}) {
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
      batch.forEach((p, k) => drawIdBack(doc, event, p, x0 + (cols - 1 - (k % cols)) * CARD_W, y0 + Math.floor(k / cols) * CARD_H));
      cropMarks(doc, x0, y0, cols, rows);
    }
  } else {
    for (const p of participants) {
      doc.addPage({ size: [CARD_W, CARD_H], margin: 0 });
      drawIdFront(doc, event, p, 0, 0);
      doc.addPage({ size: [CARD_W, CARD_H], margin: 0 });
      drawIdBack(doc, event, p, 0, 0);
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
